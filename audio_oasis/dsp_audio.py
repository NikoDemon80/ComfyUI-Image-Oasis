"""
Audio Oasis DSP -- decode, chop, re-encode, and analyze.

Trimming uses PyAV (already a suite dependency via video_oasis) rather than
a bitstream copy: cutting compressed audio at arbitrary times by copying
packets only lands on the nearest frame boundary (~26ms for mp3, ~23ms for
AAC), which is fine for video but not for "the chop point is exactly where
I dropped it." Decoding the whole file to float samples once, slicing by
sample index, and re-encoding each piece with the source's own codec gives
sample-accurate cuts while still landing on disk as the same format
("match source format").

BPM/key detection needs librosa, which is NOT a hard dependency of the
Oasis Suite (see requirements.txt) -- everything else in this module and
in nodes_audio.py/routes_audio.py works without it. First call after a server start
pays librosa/numba's JIT warm-up (several seconds); it's cached after that
for the life of the process.
"""

import os
import logging

import av
import numpy as np

log = logging.getLogger("AudioOasis")

# Extension -> (container name for av.open, encoder name). Probed against
# av.codec.codecs_available at use-time rather than assumed -- FFmpeg
# builds vary by install, and a missing encoder should be a clear error,
# not a silent wrong-format write.
FORMAT_MAP = {
    ".mp3":  ("mp3",  "libmp3lame"),
    ".wav":  ("wav",  "pcm_s16le"),
    ".flac": ("flac", "flac"),
    ".m4a":  ("ipod", "aac"),
    ".aac":  ("adts", "aac"),
}


def supported_ext(filename):
    ext = os.path.splitext(filename)[1].lower()
    return ext if ext in FORMAT_MAP else None


def encoder_available(ext):
    _container, codec = FORMAT_MAP[ext]
    try:
        return codec in av.codec.codecs_available
    except Exception:
        return True  # best-effort; let the actual encode surface the real error


def probe(path):
    """Cheap metadata read (no full decode): duration, sample rate, channels."""
    container = av.open(path)
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("No audio stream found in file.")
        sr = int(stream.codec_context.sample_rate)
        channels = int(stream.codec_context.channels or len(stream.codec_context.layout.channels))
        duration = float(container.duration / av.time_base) if container.duration else None
        if duration is None and stream.duration and stream.time_base:
            duration = float(stream.duration * stream.time_base)
        return {"duration": duration, "sample_rate": sr, "channels": channels}
    finally:
        container.close()


def decode_full(path):
    """Decode an entire audio file to (samples[channels, N] float32, sample_rate)."""
    container = av.open(path)
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("No audio stream found in file.")
        sr = stream.codec_context.sample_rate
        layout = stream.codec_context.layout
        resampler = av.audio.resampler.AudioResampler(format="fltp", layout=layout, rate=sr)

        chunks = []
        for frame in container.decode(stream):
            for rframe in (resampler.resample(frame) or []):
                chunks.append(rframe.to_ndarray())
        for rframe in (resampler.resample(None) or []):
            chunks.append(rframe.to_ndarray())
    finally:
        container.close()

    if not chunks:
        raise ValueError("Decoded zero audio frames -- unsupported or empty file.")
    samples = np.concatenate(chunks, axis=1)  # [channels, N]
    return samples, sr


def encode_segment(samples, sr, out_path, codec_name):
    """Write samples[channels, N] float32 (-1..1) to out_path with codec_name.
    Forces the layout onto the stream itself (not just the resampler target)
    -- add_stream() defaults every codec to stereo regardless of source
    channel count, and skipping this silently upmixes mono into duplicated
    "stereo" output."""
    channels = samples.shape[0]
    output = av.open(out_path, mode="w")
    try:
        stream = output.add_stream(codec_name, rate=sr)
        if channels == 1:
            layout = "mono"
        elif channels == 2:
            layout = "stereo"
        else:
            layout = av.AudioLayout(channels)
        stream.layout = layout
        resampler = av.audio.resampler.AudioResampler(format=stream.format, layout=layout, rate=sr)

        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(samples), format="fltp", layout=layout)
        frame.sample_rate = sr
        frame.pts = None

        for rframe in (resampler.resample(frame) or []):
            for packet in stream.encode(rframe):
                output.mux(packet)
        for rframe in (resampler.resample(None) or []):
            for packet in stream.encode(rframe):
                output.mux(packet)
        for packet in stream.encode(None):
            output.mux(packet)
    finally:
        output.close()


def cut_segments(source_path, boundaries_s, out_paths, ext):
    """boundaries_s: sorted list of N+1 cut points in seconds (0 and the
    track end included). out_paths: N destination paths, one per segment.
    Decodes once and slices in memory -- much cheaper than N separate
    decode passes for a track with many chop points."""
    _container_fmt, codec = FORMAT_MAP[ext]
    samples, sr = decode_full(source_path)
    total_n = samples.shape[1]

    results = []
    for i in range(len(out_paths)):
        start_s, end_s = boundaries_s[i], boundaries_s[i + 1]
        i0 = max(0, min(total_n, int(round(start_s * sr))))
        i1 = max(i0, min(total_n, int(round(end_s * sr))))
        seg = samples[:, i0:i1]
        if seg.shape[1] == 0:
            raise ValueError(f"Segment {i + 1} is empty (start >= end or past the track's end).")
        encode_segment(seg, sr, out_paths[i], codec)
        results.append({"start": i0 / sr, "end": i1 / sr, "duration": (i1 - i0) / sr})
    return results


# ── Analysis: BPM + musical key ────────────────────────────────────────────
#
# Krumhansl-Kessler key profiles, correlated against the track's mean chroma
# vector across all 24 rotations (12 major + 12 minor). Standard, well-known
# approach -- not a substitute for a trained key detector on complex mixes,
# but a solid, dependency-light estimate.

_MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def analyze(path):
    """Returns {duration, sample_rate, channels, bpm, key}. Raises ImportError
    if librosa isn't installed -- caller turns that into a clear route error
    without breaking anything else in the node."""
    import librosa  # deferred: optional dependency, see requirements.txt

    info = probe(path)
    y, sr = librosa.load(path, sr=None, mono=True)

    tempo, _beats = librosa.beat.beat_track(y=y, sr=sr)
    bpm = float(np.atleast_1d(tempo)[0]) if tempo is not None else 0.0

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    profile = chroma.mean(axis=1)
    norm = np.linalg.norm(profile)
    key_name = None
    if norm > 1e-9:
        profile = profile / norm
        best = None
        for mode_name, template in (("major", _MAJOR_PROFILE), ("minor", _MINOR_PROFILE)):
            t = template / np.linalg.norm(template)
            for shift in range(12):
                score = float(np.dot(profile, np.roll(t, shift)))
                if best is None or score > best[0]:
                    best = (score, _NOTE_NAMES[shift], mode_name)
        if best:
            key_name = f"{best[1]} {best[2]}"

    return {
        "duration": info["duration"],
        "sample_rate": info["sample_rate"],
        "channels": info["channels"],
        "bpm": round(bpm, 1),
        "key": key_name,
    }
