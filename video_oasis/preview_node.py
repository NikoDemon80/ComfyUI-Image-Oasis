"""
Video Oasis Viewer -- a preview-first Save Video node for ComfyUI.

Renders the incoming VIDEO to the *temp* directory and shows it in a rich
in-node viewer (scrub, frame-step, loop/cycle, clip, create-movie, lightbox,
scene-bar history). Nothing touches your output folder until you press Save,
which copies the already-encoded temp file (lossless, instant, and the
embedded workflow metadata comes along with it).
"""

import os
import json
import math
import random
import shutil
import logging
from fractions import Fraction

import av
import numpy as np

import folder_paths
from comfy.cli_args import args
from oasis_csrf import require_same_origin

log = logging.getLogger("VideoOasis")


def _ltx_latent_cache():
    """LTX Oasis registers as oasis_suite_ltx23_oasis. Optional: Viewer-only
    encodes have nothing pending."""
    import sys
    pkg = sys.modules.get("oasis_suite_ltx23_oasis")
    if pkg is None:
        return None
    return getattr(pkg, "latent_cache", None) or sys.modules.get(
        "oasis_suite_ltx23_oasis.latent_cache")

# --------------------------------------------------------------------------
# Encoding tables
# --------------------------------------------------------------------------

# Container -> codecs that make sense inside it (first = auto choice)
CONTAINER_CODECS = {
    "mp4":  ["h264", "hevc", "av1"],
    "webm": ["vp9", "av1"],
    "mkv":  ["h264", "hevc", "vp9", "av1", "ffv1", "prores"],
    "mov":  ["h264", "hevc", "prores"],
}

# Codec chosen, container auto: the natural home.
CODEC_HOME = {
    "vp9": "webm", "av1": "webm",
    "ffv1": "mkv", "prores": "mov",
}

# No CRF. FFV1 is bit-exact 8-bit RGB; ProRes 422 HQ is visually lossless.
LOSSLESS_CODECS = ("ffv1", "prores")

# PyAV encoder names
ENCODER_MAP = {
    "h264": "h264",        # libx264
    "hevc": "hevc",        # libx265
    "vp9":  "libvpx-vp9",
    "av1":  "libsvtav1",
    "ffv1": "ffv1",
    "prores": "prores_ks",
}

# quality preset -> CRF, per codec family
QUALITY_CRF = {
    "h264": {"high": 17, "balanced": 20, "small": 26},
    "hevc": {"high": 19, "balanced": 23, "small": 28},
    "vp9":  {"high": 24, "balanced": 32, "small": 40},
    "av1":  {"high": 24, "balanced": 32, "small": 42},
}


def _resolve_encode_plan(fmt: str, codec: str, quality: str, crf: int):
    """Return (container, codec, crf, use_stock_path)."""
    # Stock path: exactly what core SaveVideo does (fast remux when possible).
    if codec == "auto" and fmt in ("auto", "mp4"):
        return ("mp4", "auto", None, True)

    if fmt == "auto":
        fmt = CODEC_HOME.get(codec, "mp4")
    if codec == "auto":
        codec = CONTAINER_CODECS.get(fmt, CONTAINER_CODECS["mp4"])[0]
    allowed = CONTAINER_CODECS.get(fmt)
    if not allowed or codec not in allowed:
        # Keep the codec the user picked; move the container to its home.
        home = CODEC_HOME.get(codec)
        if home and codec in CONTAINER_CODECS.get(home, ()):
            log.warning("VideoOasis: %s not valid in %s, using %s",
                        codec, fmt, home)
            fmt = home
        else:
            fallback = (allowed or CONTAINER_CODECS["mp4"])[0]
            log.warning("VideoOasis: %s not valid in %s, using %s",
                        codec, fmt, fallback)
            codec = fallback

    if codec in LOSSLESS_CODECS:
        return (fmt, codec, None, False)
    if quality == "custom":
        chosen_crf = int(crf)
    else:
        chosen_crf = QUALITY_CRF[codec].get(quality, QUALITY_CRF[codec]["balanced"])
    return (fmt, codec, chosen_crf, False)


def _build_metadata(prompt, extra_pnginfo):
    if args.disable_metadata:
        return None
    metadata = {}
    if extra_pnginfo is not None:
        metadata.update(extra_pnginfo)
    if prompt is not None:
        metadata["prompt"] = prompt
    return metadata or None


def _video_pix_fmt(codec):
    if codec == "ffv1":
        return "bgr0"          # packed BGR; bit-exact vs decoded 8-bit RGB
    if codec == "prores":
        return "yuv422p10le"   # 422 HQ
    return "yuv420p"


def _apply_video_options(vstream, codec, crf):
    if codec == "ffv1":
        vstream.options = {}
        return
    if codec == "prores":
        vstream.options = {"profile": "3"}   # 422 HQ
        return
    vstream.options = {"crf": str(crf)}
    if codec in ("vp9", "av1"):
        vstream.bit_rate = 0            # required for CRF mode on vpx/svt
    if codec == "av1":
        vstream.options["preset"] = "6"
    if codec == "h264":
        vstream.options["preset"] = "medium"


def _audio_plan(container_fmt, codec, src_rate, layout):
    """(encoder, out_rate, sample_fmt) for the audio sidecar."""
    if codec == "ffv1":
        return "flac", src_rate, "s16"
    if codec == "prores":
        return "pcm_s16le", src_rate, "s16"
    if container_fmt == "webm":
        return "libopus", 48000, "fltp"      # opus requires 48k
    return "aac", src_rate, "fltp"


def _encode_with_pyav(video, path, container_fmt, codec, crf, metadata):
    """Custom encode path: real CRF control + audio muxing, mirroring
    core's VideoFromComponents.save_to but with more codecs."""
    components = video.get_components()
    images = components.images                      # [N, H, W, C] float 0..1
    frame_rate = components.frame_rate
    pix_fmt = _video_pix_fmt(codec)

    options = {}
    if container_fmt in ("mp4", "mov"):
        options["movflags"] = "use_metadata_tags"

    with av.open(path, mode="w", options=options) as output:
        if metadata is not None:
            for key, value in metadata.items():
                output.metadata[key] = json.dumps(value)

        rate = Fraction(round(float(frame_rate) * 1000), 1000)

        vstream = output.add_stream(ENCODER_MAP[codec], rate=rate)
        vstream.width = images.shape[2]
        vstream.height = images.shape[1]
        vstream.pix_fmt = pix_fmt
        _apply_video_options(vstream, codec, crf)

        # Audio stream must be declared before packets are written.
        astream = None
        waveform = None
        layout = "stereo"
        src_rate = out_rate = 0
        audio_fmt = "fltp"
        if components.audio:
            src_rate = int(components.audio["sample_rate"])
            waveform = components.audio["waveform"][0]      # [C, T]
            needed = math.ceil(src_rate / float(frame_rate) * images.shape[0])
            waveform = waveform[:, :needed]
            layout = {1: "mono", 2: "stereo", 6: "5.1"}.get(waveform.shape[0], "stereo")
            acodec, out_rate, audio_fmt = _audio_plan(
                container_fmt, codec, src_rate, layout)
            astream = output.add_stream(acodec, rate=out_rate, layout=layout)

        # ---- video ----
        # Surface corruption BEFORE clamping it away (same rationale as the
        # Image Oasis preview: nan_to_num keeps the encode from producing
        # garbage bytes, but silently masking NaN/Inf hides upstream bugs --
        # e.g. an incompatible attention backend producing NaN latents shows
        # up only as a black video).
        nan_warning = None
        for frame in images:
            img = frame[..., :3].float().cpu().numpy()
            if nan_warning is None and not np.isfinite(img).all():
                nan_warning = ("NaN/Inf values in decoded frames -- the latents were "
                               "corrupted upstream (check for an incompatible attention "
                               "backend, e.g. --use-sage-attention). Values were clamped "
                               "for preview; this video is not trustworthy.")
                log.warning("VideoOasis: %s", nan_warning)
            img = np.nan_to_num(img, nan=0.0, posinf=1.0, neginf=0.0)
            img = np.clip(img * 255.0, 0, 255).astype(np.uint8)
            vframe = av.VideoFrame.from_ndarray(img, format="rgb24")
            vframe = vframe.reformat(format=pix_fmt)
            for packet in vstream.encode(vframe):
                output.mux(packet)
        for packet in vstream.encode(None):
            output.mux(packet)

        # ---- audio ----
        if astream is not None and waveform is not None:
            aframe = av.AudioFrame.from_ndarray(
                waveform.float().cpu().contiguous().numpy(),
                format="fltp", layout=layout)
            aframe.sample_rate = src_rate
            aframe.pts = 0
            need_resample = (out_rate != src_rate) or (audio_fmt != "fltp")
            if need_resample:
                resampler = av.AudioResampler(format=audio_fmt, layout=layout, rate=out_rate)
                frames = resampler.resample(aframe)
                frames += resampler.resample(None)           # flush resampler
            else:
                frames = [aframe]
            for f in frames:
                for packet in astream.encode(f):
                    output.mux(packet)
            for packet in astream.encode(None):
                output.mux(packet)

    return nan_warning


def _resolve_under(base, *parts):
    """Join `parts` onto `base` and resolve; None unless the result stays
    inside `base`. Blocks `..` traversal, absolute-path components
    (os.path.join discards everything before an absolute segment), and
    symlink escapes (realpath resolves them before the containment check)."""
    resolved = os.path.realpath(os.path.join(base, *parts))
    root = os.path.realpath(base)
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    return resolved


def _probe(path):
    """Cheap uniform metadata for the JS viewer, read back off the temp file."""
    info = {"size_bytes": os.path.getsize(path)}
    try:
        with av.open(path, mode="r") as c:
            vs = next((s for s in c.streams if s.type == "video"), None)
            if vs is not None:
                info["width"] = vs.width
                info["height"] = vs.height
                fps = float(vs.average_rate) if vs.average_rate else 0.0
                info["fps"] = round(fps, 3)
                if c.duration:
                    info["duration"] = round(float(c.duration / av.time_base), 3)
                if vs.frames:
                    info["frames"] = int(vs.frames)
                elif fps and info.get("duration"):
                    info["frames"] = int(round(info["duration"] * fps))
            info["has_audio"] = any(s.type == "audio" for s in c.streams)
    except Exception:
        log.exception("VideoOasis: probe failed for %s", path)
    return info


# --------------------------------------------------------------------------
# The node
# --------------------------------------------------------------------------

class VideoOasisPreview:
    """Video Oasis Viewer -- encodes to temp, full scene-bar player, saves on demand."""

    def __init__(self):
        self.temp_dir = folder_paths.get_temp_directory()
        # Short collision-avoidance suffix (not a brand token). Basename comes
        # from save_prefix so LTX2.3 Oasis and other callers don't all encode
        # as VideoOasis_oasis_XXXXX.mp4.
        self.prefix_append = "_" + "".join(
            random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(5))

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "video": ("VIDEO", {"tooltip": "The video to preview (and save when you press Save)."}),
            },
            "optional": {
                # The entire node config (format/codec/quality/crf/save_prefix)
                # plus the stable io_id and the preview-pane state is serialized
                # by the frontend into this single widget as JSON (same pattern
                # as Image Oasis's "image_oasis_ui"). Read via _read_widget_state.
                "video_oasis_ui": ("STRING", {"default": "{}"}),
            },
            "hidden": {
                "prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO",
            },
        }

    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("video",)
    FUNCTION = "preview"
    OUTPUT_NODE = True
    CATEGORY = "video"
    DESCRIPTION = ("Preview video with scrubbing, frame-stepping, loop, lightbox and a session "
                   "history strip. Encodes to the temp directory; press Save in the node to keep "
                   "a result (copied losslessly to your output directory, workflow metadata included).")
    SEARCH_ALIASES = ["preview video", "save video", "video viewer", "video oasis"]

    @staticmethod
    def _read_widget_state(raw):
        """Parse the serialized frontend widget (JSON). Returns ({}, "") on
        any failure so a malformed payload degrades to defaults instead of
        failing the run."""
        try:
            state = json.loads(raw) if raw else {}
            if not isinstance(state, dict):
                return {}, ""
            ex = state.get("exec")
            io_id = state.get("io_id", "")
            return (ex if isinstance(ex, dict) else {}), \
                   (io_id if isinstance(io_id, str) else "")
        except Exception:
            log.exception("VideoOasis: bad video_oasis_ui payload, using defaults")
            return {}, ""

    def preview(self, video, video_oasis_ui="{}", prompt=None, extra_pnginfo=None):
        ex, io_id = self._read_widget_state(video_oasis_ui)
        format = str(ex.get("format", "auto"))
        codec = str(ex.get("codec", "auto"))
        quality = str(ex.get("quality", "balanced"))
        try:
            crf = max(0, min(63, int(ex.get("crf", 20))))
        except (TypeError, ValueError):
            crf = 20
        save_prefix = str(ex.get("save_prefix", "video/VideoOasis")) or "video/VideoOasis"

        container_fmt, chosen_codec, chosen_crf, use_stock = _resolve_encode_plan(
            format, codec, quality, crf)

        width, height = video.get_dimensions()
        # Temp basename = leaf of save_prefix (e.g. video/LTX23Oasis → LTX23Oasis)
        leaf = os.path.basename(save_prefix.replace("\\", "/").rstrip("/")) or "VideoOasis"
        leaf = "".join(c if (c.isalnum() or c in "-_") else "_" for c in leaf).strip("_") or "VideoOasis"
        full_folder, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            leaf + self.prefix_append, self.temp_dir, width, height)

        file = f"{filename}_{counter:05}_.{container_fmt}"
        path = os.path.join(full_folder, file)
        metadata = _build_metadata(prompt, extra_pnginfo)
        warning = None

        if use_stock:
            try:
                video.save_to(path, metadata=metadata)   # format/codec AUTO, core behavior
            except Exception:
                log.exception("VideoOasis: stock save_to failed, falling back to h264 encode")
                chosen_codec, chosen_crf = "h264", QUALITY_CRF["h264"]["balanced"]
                warning = _encode_with_pyav(video, path, container_fmt,
                                            chosen_codec, chosen_crf, metadata)
        else:
            warning = _encode_with_pyav(video, path, container_fmt,
                                        chosen_codec, chosen_crf, metadata)

        info = _probe(path)
        info.update({
            "filename": file,
            "subfolder": subfolder,
            "type": "temp",
            "format": container_fmt,
            "codec": chosen_codec,
            "crf": chosen_crf,
            "save_prefix": save_prefix,
        })
        if warning:
            info["warning"] = warning

        # Results are delivered ONLY by stable io_id over the dedicated WS
        # event (the ui["..."] payload routes by raw numeric node id against
        # the active graph and misdelivers to same-id nodes on other
        # workflows -- same fix as Image Oasis). No io_id means the frontend
        # widget never ran; there is nothing listening, so just log it.
        if io_id:
            try:
                from server import PromptServer
                PromptServer.instance.send_sync(
                    "video-oasis/result", {"io_id": io_id, "results": [info]})
            except Exception:
                log.exception("VideoOasis: WS result delivery failed")
            try:
                lcache = _ltx_latent_cache()
                if lcache is not None:
                    lcache.commit_pending(io_id, file, subfolder, "temp")
            except Exception:
                log.debug("VideoOasis: LTX latent commit skipped", exc_info=True)
        else:
            log.warning("VideoOasis: no io_id in widget state; preview not delivered")
        return {"ui": {}, "result": (video,)}


# --------------------------------------------------------------------------
# Save endpoint (the Save button)
# --------------------------------------------------------------------------

try:
    from server import PromptServer
    from aiohttp import web

    @PromptServer.instance.routes.post("/video_oasis/save")
    @require_same_origin
    async def video_oasis_save(request):
        try:
            data = await request.json()

            # Batch form: {"videos": [{filename, subfolder}, ...]}.
            # Legacy single form ({"filename": ..., "subfolder": ...}) is
            # wrapped into a one-item batch.
            videos = data.get("videos")
            if not videos:
                videos = [{"filename": data.get("filename", ""),
                           "subfolder": data.get("subfolder", "")}]

            save_prefix = str(data.get("save_prefix", "video/VideoOasis")) or "video/VideoOasis"
            width = int(data.get("width", 0) or 0)
            height = int(data.get("height", 0) or 0)

            temp_dir = folder_paths.get_temp_directory()
            output_dir = folder_paths.get_output_directory()
            os.makedirs(output_dir, exist_ok=True)
            full_folder, out_name, counter, out_subfolder, _ = folder_paths.get_save_image_path(
                save_prefix, output_dir, width, height)

            saved, skipped = [], []
            for item in videos:
                src_filename = str(item.get("filename", ""))
                src_subfolder = str(item.get("subfolder", ""))
                src_type = str(item.get("type", "temp") or "temp").strip().lower()
                # Containment check: filename/subfolder come from the client,
                # and this server has no auth -- without it, `..` or an
                # absolute path could copy ANY readable file on disk into
                # the output folder. type=output allows "save another copy"
                # of a scene-bar entry that already lives under output/.
                src_root = output_dir if src_type == "output" else temp_dir
                src = _resolve_under(src_root, src_subfolder, src_filename)
                if not src or not os.path.isfile(src):
                    # Skip rather than fail the batch: temp previews expire
                    # on restart, and one expired entry shouldn't block the rest.
                    skipped.append({"source": src_filename,
                                    "reason": "Preview file no longer exists "
                                              "(temp is cleared on restart). Re-run the workflow."})
                    continue
                ext = os.path.splitext(src_filename)[1].lstrip(".") or "mp4"
                out_file = f"{out_name}_{counter:05}_.{ext}"
                dest = os.path.join(full_folder, out_file)
                shutil.copy2(src, dest)   # lossless, instant, keeps embedded workflow metadata
                try:
                    lcache = _ltx_latent_cache()
                    if lcache is not None:
                        lcache.copy_to(
                            lcache.entry_id_for(src_filename, src_subfolder, src_type),
                            lcache.entry_id_for(out_file, out_subfolder, "output"))
                except Exception:
                    log.debug("VideoOasis: LTX latent copy skipped", exc_info=True)
                saved.append({
                    "source": src_filename,
                    "filename": out_file,
                    "subfolder": out_subfolder,
                    "type": "output",
                    "size_kb": round(os.path.getsize(dest) / 1024),
                    "path": os.path.join(out_subfolder, out_file) if out_subfolder else out_file,
                })
                counter += 1

            if not saved and skipped:
                return web.json_response(
                    {"saved": [], "skipped": skipped, "error": skipped[0]["reason"]},
                    status=404)
            return web.json_response({"saved": saved, "skipped": skipped})
        except Exception as e:
            log.exception("VideoOasis: save failed")
            return web.json_response({"error": str(e)}, status=500)

except Exception:  # running outside a server context (tests, docs builds)
    log.info("VideoOasis: PromptServer unavailable, save route not registered")


NODE_CLASS_MAPPINGS = {
    "VideoOasisPreview": VideoOasisPreview,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VideoOasisPreview": "Video Oasis Viewer \U0001f334",
}
