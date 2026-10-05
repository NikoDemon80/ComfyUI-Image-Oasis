"""
Oasis Suite - NVENC (NVIDIA GPU) video encoding helper.

Shared by Video Oasis Viewer and LTX Oasis: the main preview encode, Clip
(trim) and the Create Movie re-encode fallback all ask this module whether
NVENC can be used and how to configure it.

Detection runs once, lazily, and is cached for the session. An encoder only
counts as available when a real test encode succeeds: PyAV can list
h264_nvenc even when the driver, the GPU generation or the FFmpeg build
cannot actually open it.

Everything here fails soft. Callers try NVENC first and fall back to the
CPU encoder on any error, so a missing or broken NVENC never breaks a render.
"""

import logging
import threading
from fractions import Fraction

log = logging.getLogger("OasisNVENC")

# Codec family -> FFmpeg NVENC encoder. vp9, ffv1 and prores have no NVENC
# version. av1_nvenc needs an RTX 40-series or newer card.
NVENC_ENCODERS = {
    "h264": "h264_nvenc",
    "hevc": "hevc_nvenc",
    "av1":  "av1_nvenc",
}

# Quality preset -> NVENC constant-quality level (cq, lower = better).
# NVENC looks a little softer than x264/x265 at the same number, so these sit
# slightly under the CPU CRF tables to land at about the same visual quality.
QUALITY_CQ = {
    "h264": {"high": 18, "balanced": 21, "small": 27},
    "hevc": {"high": 20, "balanced": 24, "small": 29},
    "av1":  {"high": 24, "balanced": 30, "small": 38},
}

# Newer FFmpeg builds (NVENC SDK 10+) use p1..p7; older builds only know the
# legacy names. The probe records whichever one works per encoder.
_PRESET_CANDIDATES = ("p5", "slow")

_lock = threading.Lock()
_probed = False
_working = {}          # codec family -> preset that passed the test encode


def _options(preset, cq):
    opts = {"preset": preset, "rc": "vbr", "cq": str(int(cq)), "b": "0"}
    if preset.startswith("p"):
        opts["tune"] = "hq"      # only valid alongside the p1..p7 presets
    return opts


def _quiet_ffmpeg():
    """Swallow FFmpeg log messages from this thread for the duration of the
    block. Only used around the probe; real encodes still log normally."""
    try:
        import av.logging
        return av.logging.Capture(local=True)
    except Exception:
        import contextlib
        return contextlib.nullcontext()


def _test_encode(encoder, preset):
    """Encode two tiny frames. True only if packets actually come out."""
    import av
    import numpy as np
    ctx = av.CodecContext.create(encoder, "w")
    ctx.width = 256
    ctx.height = 256
    ctx.pix_fmt = "yuv420p"
    ctx.time_base = Fraction(1, 24)
    ctx.framerate = Fraction(24, 1)
    ctx.bit_rate = 0
    ctx.options = _options(preset, 23)
    img = np.zeros((256, 256, 3), dtype=np.uint8)
    packets = []
    for i in range(2):
        frame = av.VideoFrame.from_ndarray(img, format="rgb24").reformat(format="yuv420p")
        frame.pts = i
        packets.extend(ctx.encode(frame))
    packets.extend(ctx.encode(None))
    return len(packets) > 0


def probe():
    """Run detection once; return {codec_family: preset} for what works."""
    global _probed
    if _probed:
        return dict(_working)
    with _lock:
        if _probed:
            return dict(_working)
        try:
            import av  # noqa: F401
        except Exception:
            _probed = True
            return {}
        for family, encoder in NVENC_ENCODERS.items():
            for preset in _PRESET_CANDIDATES:
                try:
                    # The driver answers "can't do this" loudly (e.g. av1 on a
                    # pre-RTX 40 card logs "No capable devices found" as
                    # CRITICAL). Expected here, so keep it out of the console.
                    with _quiet_ffmpeg():
                        ok = _test_encode(encoder, preset)
                    if ok:
                        _working[family] = preset
                        break
                except Exception as e:
                    log.debug("OasisNVENC: %s preset %s unavailable: %r",
                              encoder, preset, e)
        if _working:
            log.info("OasisNVENC: GPU encode available for %s",
                     ", ".join(sorted(_working)))
        else:
            log.info("OasisNVENC: GPU encode not available, CPU encoders only")
        _probed = True
    return dict(_working)


def available_codecs():
    """Sorted list of codec families NVENC can encode on this machine."""
    return sorted(probe())


def supports(codec):
    return codec in probe()


def cq_for(codec, quality, crf=None):
    """Quality preset (or custom CRF) -> NVENC cq value."""
    table = QUALITY_CQ.get(codec, QUALITY_CQ["h264"])
    if quality == "custom" and crf is not None:
        try:
            # cq 0 means "automatic" to NVENC, so custom values start at 1.
            return max(1, min(51, int(crf)))
        except (TypeError, ValueError):
            pass
    return table.get(quality, table["balanced"])


def plan(codec, quality="balanced", crf=None):
    """(encoder_name, options, cq) for this codec, or None if NVENC can't do it."""
    preset = probe().get(codec)
    if not preset:
        return None
    cq = cq_for(codec, quality, crf)
    return NVENC_ENCODERS[codec], _options(preset, cq), cq


def apply(stream, options):
    """Put NVENC settings on a PyAV output stream (bit_rate 0 = pure cq mode)."""
    stream.options = dict(options)
    try:
        stream.bit_rate = 0
    except Exception:
        pass
