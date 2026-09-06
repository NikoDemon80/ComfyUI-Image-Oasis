"""
Motion context extraction for continue-from-viewed.

The tail that seeds the next segment comes from whatever clip is sitting in
the Video Oasis Viewer. Generate prefers a cached sampled latent for that
entry (VAE-decoded to pixels, then pinned). Clips with no latent — loaded
from disk, Clip, Create Movie — fall back to decoding the file with PyAV.
"""

import os
import logging

log = logging.getLogger("LTXOasis")


def _resolve_under(base, *parts):
    """Join under base and refuse anything that escapes it."""
    base = os.path.abspath(base)
    p = os.path.abspath(os.path.join(base, *parts))
    if p != base and not p.startswith(base + os.sep):
        return None
    return p


def context_span_px(ctx_latent_frames, quantum):
    """Pixel frames occupied by a context window of N latent frames.

    LTX's first latent frame of a sequence decodes to ONE pixel frame and
    every later one to `quantum`, so N latent frames span quantum*(N-1)+1
    pixels -- 17 for a 3-frame window, not 24. This is the number of frames
    to drop off the FRONT after decode. It is deliberately not the same as
    the sampled overhead (quantum*N); the difference is a constant 7 frames
    of real content that comes off the back instead.
    """
    n = int(ctx_latent_frames)
    return (int(quantum) * (n - 1) + 1) if n > 0 else 0


def resolve_entry_path(video, subfolder, type_):
    """Resolve a /view-style entry (temp/ or output/) to an on-disk path."""
    import folder_paths
    fn = (video or "").strip().replace("\\", "/")
    sf = (subfolder or "").strip().replace("\\", "/").strip("/")
    if not fn:
        return None
    kind = (type_ or "temp").strip().lower()
    root = folder_paths.get_output_directory() if kind == "output" \
        else folder_paths.get_temp_directory()
    path = _resolve_under(root, sf, fn) if sf else _resolve_under(root, fn)
    return path if path and os.path.isfile(path) else None


def _decode_tail_frames(container, vs, n_frames, fps):
    """Decode to EOF keeping a rolling window of the last n_frames."""
    from collections import deque
    keep = deque(maxlen=int(n_frames))
    # Seek back far enough to be sure we land on a keyframe before the window
    # starts. Duration may be unknown for some containers -- decoding from the
    # start is slower but always correct, and the deque bounds memory either
    # way.
    duration = None
    if container.duration:
        import av
        duration = float(container.duration) / float(av.time_base)
    if duration:
        seek_s = max(0.0, duration - (float(n_frames) / fps) - 2.0)
        try:
            container.seek(int(seek_s * 1_000_000), backward=True,
                           any_frame=False)
        except Exception:
            pass
    for fr in container.decode(vs):
        keep.append(fr.to_ndarray(format="rgb24"))
    return list(keep)


def _decode_tail_audio(path, n_samples):
    """Decode the audio stream and return its last n_samples as
    (samples[channels, N] float32, sample_rate), or (None, 0)."""
    import av
    import numpy as np
    container = av.open(path)
    try:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            return None, 0
        sr = int(stream.codec_context.sample_rate)
        layout = stream.codec_context.layout
        resampler = av.audio.resampler.AudioResampler(
            format="fltp", layout=layout, rate=sr)
        chunks = []
        for frame in container.decode(stream):
            for rframe in (resampler.resample(frame) or []):
                chunks.append(rframe.to_ndarray())
        for rframe in (resampler.resample(None) or []):
            chunks.append(rframe.to_ndarray())
    finally:
        container.close()
    if not chunks:
        return None, 0
    samples = np.concatenate(chunks, axis=1)        # [channels, N]
    if n_samples and samples.shape[1] > n_samples:
        samples = samples[:, -int(n_samples):]
    return samples, sr


def extract_tail(path, n_frames, want_audio=False):
    """Decode the last `n_frames` of `path`.

    Returns (images, audio, info):
        images  IMAGE tensor [N,H,W,C] float32 0..1 -- N may be < n_frames on
                a clip shorter than the requested window.
        audio   {"waveform": [1,C,S], "sample_rate": sr} or None
        info    {"fps", "width", "height"}
    """
    import av
    import numpy as np
    import torch

    n_frames = max(1, int(n_frames))
    container = av.open(path)
    try:
        vs = next((s for s in container.streams if s.type == "video"), None)
        if vs is None:
            raise ValueError("No video stream in the tail source.")
        fps = float(vs.average_rate) if vs.average_rate \
            else (float(vs.base_rate) if vs.base_rate else 25.0)
        frames = _decode_tail_frames(container, vs, n_frames, fps)
    finally:
        container.close()

    if not frames:
        raise ValueError("No decodable frames in the tail source.")

    arr = np.stack(frames, axis=0).astype(np.float32) / 255.0   # [N,H,W,C]
    images = torch.from_numpy(arr)

    audio = None
    if want_audio:
        n_samples_hint = 0
        try:
            probe = av.open(path)
            try:
                ast = next((s for s in probe.streams if s.type == "audio"), None)
                if ast is not None:
                    n_samples_hint = int(round(
                        (len(frames) / fps) * int(ast.codec_context.sample_rate)))
            finally:
                probe.close()
        except Exception:
            n_samples_hint = 0
        try:
            samples, sr = _decode_tail_audio(path, n_samples_hint)
        except Exception as e:
            log.debug("[LTX Oasis] tail audio decode failed: %s", e)
            samples, sr = None, 0
        if samples is not None and sr:
            audio = {"waveform": torch.from_numpy(
                         np.ascontiguousarray(samples)).unsqueeze(0),
                     "sample_rate": int(sr)}

    return images, audio, {"fps": fps,
                           "width": int(images.shape[2]),
                           "height": int(images.shape[1])}


def extract_tail_from_latent(pair, n_frames, want_audio=False, vae=None,
                             audio_vae=None):
    """VAE-decode a cached sampled latent and return its delivered tail.

    Same return shape as extract_tail. The decode is required: LTX's first
    latent frame of a sequence is an anchor and the rest are deltas, so the
    tail cannot be copied into a new clip's head as tensors. Decoding and
    handing pixels to LTXVImgToVideoInplace is the proven pin; this just
    skips the h264 file so a long chain does not soften.
    """
    from .comfy_bridge_video import first
    from .stage_sample_video import _trim_audio_window

    if vae is None or pair is None or pair.get("video") is None:
        raise ValueError("Cached latent is missing its video stream.")

    ctx = int(pair.get("ctx_latent_frames") or 0)
    deliver = int(pair.get("deliver_frames") or 0)
    q = int(pair.get("quantum") or 8)
    fps = float(pair.get("fps") or 25.0)
    ctx_span = context_span_px(ctx, q)

    images = first("VAEDecode", samples={"samples": pair["video"]}, vae=vae)
    if ctx_span or deliver:
        end = (int(deliver) + ctx_span) if deliver else None
        images = images[ctx_span:end] if end is not None else images[ctx_span:]
    if int(images.shape[0]) < 1:
        raise ValueError("Cached latent decoded to no delivered frames.")

    n_frames = max(1, int(n_frames))
    got = int(images.shape[0])
    if got > n_frames:
        images = images[-n_frames:]

    audio = None
    if want_audio and pair.get("audio") is not None and audio_vae is not None:
        try:
            decoded = first("LTXVAudioVAEDecode",
                            samples={"samples": pair["audio"]},
                            audio_vae=audio_vae)
            if ctx_span or deliver:
                decoded = _trim_audio_window(decoded, ctx_span,
                                             deliver or got, fps)
            wave = decoded.get("waveform") if isinstance(decoded, dict) else None
            sr = int((decoded or {}).get("sample_rate") or 0) if isinstance(decoded, dict) else 0
            if wave is not None and sr:
                n_samples = int(round((float(int(images.shape[0])) / fps) * sr))
                if n_samples and int(wave.shape[-1]) > n_samples:
                    decoded = {"waveform": wave[..., -n_samples:].contiguous(),
                               "sample_rate": sr}
                audio = decoded
        except Exception as e:
            log.debug("[LTX Oasis] cached latent audio decode failed: %s", e)

    return images, audio, {"fps": fps,
                           "width": int(images.shape[2]),
                           "height": int(images.shape[1]),
                           "from_latent": True}


def fit_context_images(images, width, height):
    """Resize decoded context frames to the render's target resolution.

    The viewer entry can be any resolution (a clip from an earlier session, a
    different aspect, an upscaled render). The frozen latent region has to
    match the target latent's spatial shape or the write is a shape error.
    """
    import torch
    if int(images.shape[2]) == int(width) and int(images.shape[1]) == int(height):
        return images
    x = images.permute(0, 3, 1, 2)                  # [N,C,H,W]
    x = torch.nn.functional.interpolate(
        x, size=(int(height), int(width)), mode="bilinear", align_corners=False)
    return x.permute(0, 2, 3, 1).contiguous().clamp(0.0, 1.0)
