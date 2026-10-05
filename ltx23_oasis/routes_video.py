"""
LTX2.3 Oasis — server routes (Image Oasis-style surface): model lists + arch
definitions from the registry, preset CRUD + reorder, input_info for reference
slots, in-node help, flush_cache, theme library, and prompt enhance.

Route prefix: /ltx23_oasis/*. Theme overrides are scoped to .iov-widget so
Image Oasis can keep a different palette on the same canvas.
"""

import os
import sys
import json
import uuid
import tempfile
from datetime import datetime

import folder_paths
from server import PromptServer
from aiohttp import web
from oasis_csrf import require_same_origin

try:
    import oasis_nvenc          # shared GPU encode helper (pack root)
except Exception:               # missing helper just means CPU encoders only
    oasis_nvenc = None

routes = PromptServer.instance.routes

_PKG_DIR = os.path.dirname(os.path.abspath(__file__))
_USER_DIR = os.path.join(folder_paths.base_path, "user", "ltx23_oasis")
_PRESETS_FILE = os.path.join(_USER_DIR, "presets.json")
_THEME_FILE = os.path.join(_USER_DIR, "theme.json")
_NAMED_THEMES_FILE = os.path.join(_USER_DIR, "named_themes.json")
_HELP_FILE = os.path.join(_PKG_DIR, "ltx23_oasis_help_content.md")
os.makedirs(_USER_DIR, exist_ok=True)


# Palette variables LTX Oasis recognizes. Anything else in a POSTed payload is
# silently dropped so we don't accumulate stale keys across upgrades.
_THEME_KEYS = {
    "--io-accent", "--io-accent-dim",
    "--io-bg", "--io-bg2", "--io-bd", "--io-dim",
}

def _registry():
    from . import registry_video as rv
    return rv


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def _atomic_write_json(path, data):
    try:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
        return True
    except Exception as e:
        print(f"[LTX Oasis] Failed to write {os.path.basename(path)}: {e}")
        return False


def _resolve_under(base, *parts):
    resolved = os.path.realpath(os.path.join(base, *parts))
    root = os.path.realpath(base)
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    return resolved


def _rtx_vsr_available():
    try:
        from .comfy_bridge_video import node_registered
        return node_registered("RTXVideoSuperResolution")
    except Exception:
        return False


def _list_folder(*names):
    files, seen = [], set()
    for name in names:
        try:
            for f in folder_paths.get_filename_list(name):
                if f not in seen:
                    seen.add(f)
                    files.append(f)
        except Exception:
            continue
    return files


def _client_archs(rv):
    """Serialize the registry for the frontend: dropdown order, per-arch UI
    shaping (slots, modes, quanta, defaults) and the values that seed editable
    fields. The registry is the single source of truth — the frontend keeps
    no hand-synced mirror."""
    out = []
    for key, a in rv.ARCH_REGISTRY.items():
        up = a.get("upscale_native") or None
        out.append({
            "key": key,
            "label": a.get("label", key),
            "modes": list(a.get("modes", ())),
            "model_slots": list(a.get("model_slots", ("model",))),
            "clip_slots": int((a.get("clip") or {}).get("slots", 1)),
            "vae_slots": list(a.get("vae_slots", ("video",))),
            "frame_quantum": int(a.get("frame_quantum", 4)),
            "fps_default": float(a.get("fps_default", 24.0)),
            "defaults": dict(a.get("defaults", {})),
            "sampling": dict(a.get("sampling", {})),
            "prompt_relay": bool((a.get("prompt_relay") or {}).get("video")),
            "guides": (dict(a.get("guides")) if a.get("guides") else None),
            "audio": bool(a.get("audio")),
            # Drives the Generation > Attention row. Only architectures that
            # declare the Sage patch get a toggle for it.
            "sage": "sage_auto" in tuple(a.get("attention_patches") or ()),
            "upscale_native": ({
                "label": up.get("label", "Upscale"),
                "kind": "latent_upsample",
                "latent_upsampler": up.get("latent_upsampler", ""),
                "cfg": up.get("cfg", 1.0),
                "sigmas": up.get("sigmas", ""),
                "sampler": up.get("sampler", "euler"),
                "scheduler": up.get("scheduler", "simple"),
            } if up else None),
        })
    return out


@routes.get("/ltx23_oasis/models")
async def vog_models(request):
    unet = _list_folder("unet", "diffusion_models", "unet_gguf")
    te = _list_folder("text_encoders", "clip", "clip_gguf")
    try:
        rv = _registry()
        archs = _client_archs(rv)
    except Exception as e:
        print(f"[LTX Oasis] Could not read arch registry: {e}")
        archs = []
    def _sorted(names):
        try:
            return sorted(folder_paths.get_filename_list(names))
        except Exception:
            return []
    return web.json_response({
        "diffusion":   sorted(f for f in unet if not f.lower().endswith(".gguf")),
        "gguf_unet":   sorted(f for f in unet if     f.lower().endswith(".gguf")),
        "clip_std":    sorted(f for f in te   if not f.lower().endswith(".gguf")),
        "clip_gguf":   sorted(f for f in te   if     f.lower().endswith(".gguf")),
        "vaes":        _sorted("vae"),
        # LatentUpscaleModelLoader resolves against models/latent_upscale_models/
        # ONLY. Do not merge upscale_models (ESRGAN pixel upscalers) in here —
        # they are the wrong folder AND the wrong model type.
        "latent_upsamplers": sorted(_list_folder("latent_upscale_models")),
        "loras":       _sorted("loras"),
        "archs":       archs,
        # comfyui_nvidia_rtx_nodes — RTX Video Super Resolution. UI shows a
        # warning if the toggle is on and this is false.
        "rtx_vsr":     _rtx_vsr_available(),
    })


@routes.get("/ltx23_oasis/nvenc")
async def vog_nvenc(request):
    """Which codecs NVENC can encode here. The frontend hides the GPU Encode
    toggle when the list is empty. First call runs the one-time probe off
    the event loop."""
    codecs = []
    if oasis_nvenc is not None:
        try:
            import asyncio
            codecs = await asyncio.get_running_loop().run_in_executor(
                None, oasis_nvenc.available_codecs)
        except Exception:
            codecs = []
    return web.json_response({"available": bool(codecs), "codecs": codecs})


@routes.post("/ltx23_oasis/flush_cache")
@require_same_origin
async def vog_flush_cache(request):
    try:
        from . import nodes_video
        nodes_video.clear_caches()
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return web.json_response({"ok": True})


# ── Theme (VO's own palette + named-themes library) ─────────────────────────
#
# Storage shape matches Image Oasis's so tooling that inspects palette JSON
# works across the suite; LTX Oasis writes to its own files under user/ltx23_oasis/.
# theme.json    : {"--io-bg": "#000", ...} — active palette. Only non-default
#                 keys are stored (defaults filled in client-side on load).
# named_themes.json : [{"id": "uuid", "name": "…", "colors": {...}}, ...]

def _load_theme():
    data = _read_json(_THEME_FILE, {})
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items()
            if k in _THEME_KEYS and isinstance(v, str)}


def _save_theme(colors):
    return _atomic_write_json(_THEME_FILE, colors)


def _load_named_themes():
    data = _read_json(_NAMED_THEMES_FILE, [])
    return data if isinstance(data, list) else []


def _save_named_themes(themes):
    return _atomic_write_json(_NAMED_THEMES_FILE, themes)


@routes.get("/ltx23_oasis/theme")
async def vog_get_theme(request):
    return web.json_response(_load_theme())


@routes.post("/ltx23_oasis/theme")
@require_same_origin
async def vog_set_theme(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    if not isinstance(data, dict):
        return web.json_response({"error": "Expected object."}, status=400)
    # Whitelist known keys; drop anything else. Empty payload = reset to
    # defaults (frontend fills defaults on load).
    filtered = {k: v for k, v in data.items()
                if k in _THEME_KEYS and isinstance(v, str) and v.startswith("#")}
    if not _save_theme(filtered):
        return web.json_response({"error": "Could not write theme.json."}, status=500)
    return web.json_response({"ok": True})


@routes.get("/ltx23_oasis/themes")
async def vog_get_named_themes(request):
    return web.json_response(_load_named_themes())


@routes.post("/ltx23_oasis/save_named_theme")
@require_same_origin
async def vog_save_named_theme(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    name = (data.get("name") or "").strip()
    colors_in = data.get("colors") or {}
    if not name:
        return web.json_response({"error": "Missing name."}, status=400)
    if not isinstance(colors_in, dict):
        return web.json_response({"error": "colors must be an object."}, status=400)
    colors = {k: v for k, v in colors_in.items()
              if k in _THEME_KEYS and isinstance(v, str) and v.startswith("#")}
    themes = _load_named_themes()
    # Same-name replaces (matches IO's behavior — no duplicates by display name).
    idx = next((i for i, t in enumerate(themes)
                if (t.get("name") or "") == name), None)
    entry = {
        "id": themes[idx]["id"] if idx is not None else str(uuid.uuid4()),
        "name": name,
        "timestamp": datetime.now().isoformat(),
        "colors": colors,
    }
    if idx is not None:
        themes[idx] = entry
    else:
        themes.insert(0, entry)
    if not _save_named_themes(themes):
        return web.json_response({"error": "Could not write named_themes.json."}, status=500)
    return web.json_response({"ok": True, "id": entry["id"]})


@routes.delete("/ltx23_oasis/themes/{theme_id}")
@require_same_origin
async def vog_delete_named_theme(request):
    tid = request.match_info["theme_id"]
    _save_named_themes([t for t in _load_named_themes() if t.get("id") != tid])
    return web.json_response({"ok": True})


# ── Continue-from-viewed: register the viewer's current entry ───────────
#
# The frontend POSTs a /view-style descriptor for whatever clip is in the
# viewer; we record it against the io_id and bump _TAIL_VER so the
# sampled-latent cache invalidates on the next run.
#
# This is a reference, not pixels. The tail frames (and, for generated-audio
# continuity, the tail waveform) are decoded off disk inside generate() by
# stage_context_video, which means the motion-context window can be any size
# without the browser having to seek and canvas-encode frame by frame, and
# entries from earlier sessions work exactly like fresh ones.

@routes.post("/ltx23_oasis/set_tail")
@require_same_origin
async def vog_set_tail(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Expected a JSON body."}, status=400)

    io_id = str(body.get("io_id") or "").strip()
    video = str(body.get("video") or body.get("filename") or "").strip()
    if not io_id:
        return web.json_response({"error": "Missing io_id."}, status=400)
    if not video:
        return web.json_response({"error": "Missing video."}, status=400)
    subfolder = str(body.get("subfolder") or "").strip()
    type_ = str(body.get("type") or "temp").strip()

    from . import stage_context_video as sctx
    from . import latent_cache as lcache
    entry_id = lcache.entry_id_for(video, subfolder, type_)
    if not sctx.resolve_entry_path(video, subfolder, type_) and not lcache.has(entry_id):
        shown = f"{subfolder}/{video}" if subfolder else video
        return web.json_response(
            {"error": f"Missing on disk: {shown}"}, status=404)

    try:
        from . import nodes_video
        nodes_video._TAIL_SRC[io_id] = {"video": video,
                                        "subfolder": subfolder,
                                        "type": type_}
        nodes_video._TAIL_VER[io_id] = nodes_video._TAIL_VER.get(io_id, 0) + 1
        has_latent = lcache.has(entry_id)
    except Exception as e:
        return web.json_response(
            {"error": f"Could not store tail source: {e}"}, status=500)

    return web.json_response({
        "ok": True,
        "video": video,
        "tail_ver": int(nodes_video._TAIL_VER[io_id]),
        "has_latent": has_latent,
        "entry_id": entry_id,
    })


@routes.post("/ltx23_oasis/drop_latent")
@require_same_origin
async def vog_drop_latent(request):
    """Forget one entry's cached latent. The video file stays on disk."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Expected a JSON body."}, status=400)
    from . import latent_cache as lcache
    entry_id = str(body.get("entry_id") or "").strip()
    if not entry_id:
        entry_id = lcache.entry_id_for(body.get("video") or body.get("filename"),
                                       body.get("subfolder"),
                                       body.get("type"))
    if not entry_id:
        return web.json_response({"error": "Missing entry_id or video."},
                                 status=400)
    removed = lcache.drop(entry_id)
    return web.json_response({"ok": True, "entry_id": entry_id,
                              "removed": removed})


@routes.post("/ltx23_oasis/sweep_latents")
@require_same_origin
async def vog_sweep_latents(request):
    """Drop latents for scene-bar entries the frontend no longer has."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "Expected a JSON body."}, status=400)
    from . import latent_cache as lcache
    entries = body.get("entry_ids")
    if entries is None and body.get("entries") is not None:
        entries = [lcache.entry_id_for(e.get("video") or e.get("filename"),
                                       e.get("subfolder"),
                                       e.get("type"))
                   for e in (body.get("entries") or [])]
    if entries is not None:
        entries = [e for e in entries if e]
    removed = lcache.sweep(known_entry_ids=entries)
    return web.json_response({"ok": True, "removed": removed})


# ── Load-from-disk (external videos, output/ only) ──────────────────────────
#
# The "+" tile in the scene bar opens a picker that lists videos under
# output/ and lets the user drop one into the strip as a saved entry.
# list_output_videos does the cheap directory walk (name + size + mtime);
# probe_video runs PyAV on demand to fetch the full metadata the frontend
# needs to build a strip entry that matches the fresh-generation shape.

_VIDEO_EXTS = (".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi")
_LIST_CAP = 500


def _walk_output_videos():
    out_root = folder_paths.get_output_directory()
    if not os.path.isdir(out_root):
        return []
    results = []
    for dirpath, _, filenames in os.walk(out_root):
        for name in filenames:
            if not name.lower().endswith(_VIDEO_EXTS):
                continue
            full = os.path.join(dirpath, name)
            try:
                stat = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(dirpath, out_root)
            subfolder = "" if rel == "." else rel.replace(os.sep, "/")
            results.append({
                "filename": name,
                "subfolder": subfolder,
                "size_bytes": int(stat.st_size),
                "mtime": float(stat.st_mtime),
            })
    results.sort(key=lambda r: r["mtime"], reverse=True)
    return results[:_LIST_CAP]


@routes.get("/ltx23_oasis/list_output_videos")
async def vog_list_output_videos(request):
    try:
        return web.json_response(_walk_output_videos())
    except Exception as e:
        return web.json_response({"error": f"List failed: {e}"}, status=500)


@routes.post("/ltx23_oasis/probe_video")
@require_same_origin
async def vog_probe_video(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    filename = (data.get("filename") or "").strip()
    subfolder = (data.get("subfolder") or "").strip()
    if not filename:
        return web.json_response({"error": "Missing filename."}, status=400)
    out_root = folder_paths.get_output_directory()
    # _resolve_under prevents traversal via .. or absolute paths.
    path = _resolve_under(out_root, subfolder, filename) if subfolder \
           else _resolve_under(out_root, filename)
    if not path or not os.path.isfile(path):
        return web.json_response(
            {"error": "Not found under output/."}, status=404)
    try:
        import av
    except ImportError:
        return web.json_response(
            {"error": "PyAV not installed."}, status=500)
    try:
        with av.open(path) as container:
            vs = None
            has_audio = False
            for stream in container.streams:
                if stream.type == "video" and vs is None:
                    vs = stream
                elif stream.type == "audio":
                    has_audio = True
            if vs is None:
                return web.json_response(
                    {"error": "No video stream in file."}, status=400)
            width = int(vs.codec_context.width or 0)
            height = int(vs.codec_context.height or 0)
            codec_name = vs.codec_context.name or ""
            # average_rate is a Fraction; base_rate is a fallback. Some
            # files report neither (rare); default to 24 in that case.
            fps = float(vs.average_rate) if vs.average_rate \
                  else (float(vs.base_rate) if vs.base_rate else 24.0)
            # container.duration is in AV_TIME_BASE units (microseconds).
            duration_s = (float(container.duration) / 1_000_000.0
                          if container.duration else 0.0)
            # vs.frames may be zero for streams that don't advertise it;
            # derive from duration in that case.
            frames = int(vs.frames) if vs.frames \
                     else max(0, int(round(duration_s * fps)))
        try:
            size_bytes = int(os.path.getsize(path))
        except OSError:
            size_bytes = 0
        ext = os.path.splitext(filename)[1].lstrip(".").lower() or "mp4"
        return web.json_response({
            "width": width, "height": height,
            "fps": fps, "frames": frames,
            "duration_s": duration_s,
            "codec": codec_name,
            "format": ext,
            "size_bytes": size_bytes,
            "has_audio": has_audio,
        })
    except Exception as e:
        return web.json_response(
            {"error": f"Probe failed: {e}"}, status=500)


# ── Create Movie: fast-path stream-copy concat ──────────────────────────────
#
# Video: stream-copy when every input shares codec + extradata (SPS/PPS);
# otherwise re-encode. Mixing originals with Clip outputs used to pass the
# old codec/size/fps check then corrupt after the first cut.
#
# Audio: always re-encoded to AAC when requested, with silence synthesized
# for clips that have no audio stream.
#
# The output is written to output/video/create_movie_NNNNN.{mp4|webm|mkv|mov}.
# The movie keeps the clips' codec and its natural container.

_MOVIE_PREFIX = "create_movie_"

_COPY_CONTAINER = {
    "h264": "mp4", "avc1": "mp4",
    "hevc": "mp4", "h265": "mp4", "hev1": "mp4", "hvc1": "mp4",
    "vp8": "webm", "vp9": "webm",
    "av1": "webm",   # auto home; mp4 is also legal and kept when the clip is mp4
    "ffv1": "mkv",
    "prores": "mov",
}

_CONTAINER_CODECS = {
    "mp4":  ("h264", "avc1", "hevc", "h265", "hev1", "hvc1", "av1"),
    "webm": ("vp8", "vp9", "av1"),
    "mkv":  ("h264", "hevc", "vp8", "vp9", "av1", "ffv1", "prores"),
    "mov":  ("h264", "hevc", "prores"),
}


def _codec_key(name):
    n = (name or "").lower()
    for prefix in ("libvpx-", "libsvt", "lib"):
        if n.startswith(prefix):
            n = n[len(prefix):]
            break
    return n


def _canonical_codec(name):
    k = _codec_key(name)
    return {"avc1": "h264", "h265": "hevc", "hev1": "hevc", "hvc1": "hevc",
            "av01": "av1"}.get(k, k)


def _copy_container(codec):
    return _COPY_CONTAINER.get(_canonical_codec(codec))


def _movie_container(codec, src_path=None):
    """Container for a Create Movie of this clip codec.

    AV1 is legal in both mp4 and webm. Prefer the first clip's own
    extension when that pairing is valid, so an AV1 mp4 bar does not get
    remuxed into webm.
    """
    c = _canonical_codec(codec)
    ext = os.path.splitext(src_path or "")[1].lstrip(".").lower()
    allowed = _CONTAINER_CODECS.get(ext)
    if allowed and c in allowed:
        return ext
    return _copy_container(codec) or "mkv"


def _nvenc_supports(codec):
    if oasis_nvenc is None:
        return False
    try:
        return oasis_nvenc.supports(_canonical_codec(codec))
    except Exception:
        return False


def _reencode_profile(codec, gpu=False):
    c = _canonical_codec(codec)
    if gpu and oasis_nvenc is not None:
        # Same quality intent as the CPU rows below (crf 18 for h264/hevc,
        # 32 for av1).
        try:
            nv = oasis_nvenc.plan(c, "balanced" if c == "av1" else "high")
        except Exception:
            nv = None
        if nv is not None:
            return nv[0], "yuv420p", nv[1], 0
    if c == "hevc":
        return "hevc", "yuv420p", {"crf": "18", "preset": "veryfast"}, None
    if c == "vp9":
        return "libvpx-vp9", "yuv420p", {"crf": "32"}, 0
    if c == "vp8":
        return "libvpx", "yuv420p", {"crf": "32"}, 0
    if c == "av1":
        return "libsvtav1", "yuv420p", {"crf": "32", "preset": "8"}, 0
    if c == "ffv1":
        return "ffv1", "bgr0", {}, None
    if c == "prores":
        return "prores_ks", "yuv422p10le", {"profile": "3"}, None
    return "libx264", "yuv420p", {"crf": "18", "preset": "veryfast"}, None


def _concat_audio_codec(video_codec, container_ext, src_rate, layout):
    c = _canonical_codec(video_codec)
    ext = (container_ext or "").lstrip(".").lower()
    if c == "ffv1":
        return "flac", src_rate, layout
    if c == "prores":
        return "pcm_s16le", src_rate, layout
    if ext == "webm" or c in ("vp9", "vp8"):
        return "libopus", 48000, layout
    return "aac", src_rate, layout


def _add_concat_audio_stream(out, output_path, params, video_codec=None):
    layout = params.get("layout") or "stereo"
    src_rate = int(params.get("rate") or 48000)
    ext = os.path.splitext(output_path)[1]
    acodec, rate, layout = _concat_audio_codec(
        video_codec, ext, src_rate, layout)
    stream = out.add_stream(acodec, rate=rate, layout=layout)
    return stream, rate


def _next_movie_path(ext="mp4"):
    """Pick output/video/create_movie_NNNNN.<ext> - the smallest unused N >= 1."""
    ext = (ext or "mp4").lstrip(".").lower()
    out_root = folder_paths.get_output_directory()
    video_dir = os.path.join(out_root, "video")
    os.makedirs(video_dir, exist_ok=True)
    used = set()
    plen = len(_MOVIE_PREFIX)
    for name in os.listdir(video_dir):
        if not name.startswith(_MOVIE_PREFIX):
            continue
        stem, _, _e = name[plen:].rpartition(".")
        if stem.isdigit():
            used.add(int(stem))
    n = 1
    while n in used:
        n += 1
    filename = f"{_MOVIE_PREFIX}{n:05d}.{ext}"
    return os.path.join(video_dir, filename), f"video/{filename}"


# ── Create Movie: audio seam handling ───────────────────────────────────────
#
# Each clip on disk carries its own AAC encode, and an AAC encode always pads
# the end of the stream out to a whole 1024-sample block. Decoding gives that
# padding back as real zeros, so a naive concat drops ~23 ms of silence into
# the middle of continuous ambience at every join. The clip files also come
# out fractionally longer than their own video, which walks audio late against
# picture as the clips accumulate. Both go away by cutting each clip's decoded
# audio to exactly the length its frame count says it should be.
#
# That leaves the other half of the artifact: the first ~25 ms of a clip comes
# in weak (the generator's audio settles over the opening frames), which a trim
# cannot recover because it is real audio, just quiet. So the samples either
# side of a join are rebuilt by crossfading between the two clips' own
# interiors played backwards. Reversed ambience is indistinguishable from
# forwards ambience, and reversing makes the patch start on the exact sample it
# replaces, so the splice cannot click. Sample count is unchanged, so sync
# holds.
#
# Cost of the reversal trick: at a join that lands on speech or a distinct
# musical event, ~36 ms of reversed material may be audible. Widen or narrow
# via the two constants below.

_SEAM_PRE_MS = 10.0     # rebuilt at the end of the outgoing clip
_SEAM_POST_MS = 26.0    # rebuilt at the start of the incoming clip

# Diagnostic: Create Movie prints what it did with the audio to the ComfyUI
# console. Cheap, and the only way to tell a fix that did nothing from a fix
# that never ran.
_MV_TAG = "[LTXO Movie]"


def _mv_log(msg):
    try:
        print(f"{_MV_TAG} {msg}", flush=True)
    except Exception:
        pass


def _decode_clip_audio(path, layout_name, rate):
    """Decode a clip's whole audio track to float32 (channels, samples).

    Returns None when the file has no audio stream or decodes to nothing.
    """
    import av
    import numpy as np
    chunks = []
    with av.open(path) as container:
        a_in = next((s for s in container.streams if s.type == "audio"), None)
        if a_in is None:
            return None
        resampler = av.AudioResampler(
            format="fltp", layout=layout_name, rate=rate)
        for frame in container.decode(a_in):
            for out_frame in (resampler.resample(frame) or []):
                chunks.append(out_frame.to_ndarray())
        # Flushing the resampler matters when rates differ: the tail sits in
        # its internal buffer and is otherwise dropped. Older PyAV builds
        # reject a None frame here, hence the guard.
        try:
            for out_frame in (resampler.resample(None) or []):
                chunks.append(out_frame.to_ndarray())
        except Exception:
            pass
    if not chunks:
        return None
    return np.concatenate(chunks, axis=1).astype(np.float32, copy=False)


def _fit_audio_length(arr, n_target):
    """Cut or zero-pad to exactly n_target samples.

    Cutting is the point: it removes the AAC block padding at the end of the
    clip, which is what puts the hole in the join. Padding is only a guard for
    a clip whose audio genuinely stops early.
    """
    import numpy as np
    if n_target <= 0:
        return arr[:, :0]
    n = int(arr.shape[1])
    if n > n_target:
        return arr[:, :n_target]
    if n < n_target:
        pad = np.zeros((arr.shape[0], n_target - n), dtype=np.float32)
        return np.concatenate([arr, pad], axis=1)
    return arr


def _repair_seam(a, b, rate, label=""):
    """Rebuild the samples either side of a join. Returns (a, b) rewritten.

    Builds one continuous block spanning the join out of two donors, each the
    clip's own clean interior reversed:

      donor_a[0]    is exactly a's last sample before the rebuilt region
      donor_b[-1]   is exactly b's first sample after the rebuilt region

    so the block joins both neighbours with no amplitude step. An equal-power
    crossfade carries it from one to the other, which holds level across the
    join for uncorrelated material such as ambience.

    Left alone when either clip is too short to donate, or when either side is
    silent (a deliberately quiet clip should stay quiet).
    """
    import numpy as np
    npre = max(1, int(round(_SEAM_PRE_MS * rate / 1000.0)))
    npost = max(1, int(round(_SEAM_POST_MS * rate / 1000.0)))
    n = npre + npost
    len_a, len_b = int(a.shape[1]), int(b.shape[1])
    if len_a < npre + n or len_b < npost + n:
        _mv_log(f"  seam {label}: SKIPPED, clip too short to donate "
                f"(need {npre + n}/{npost + n}, have {len_a}/{len_b})")
        return a, b
    if not np.any(a[:, -(npre + n):]) or not np.any(b[:, :npost + n]):
        _mv_log(f"  seam {label}: SKIPPED, one side is silent")
        return a, b

    quiet_b = float(np.sqrt(np.mean(b[:, :npost] ** 2)))
    ref_b = float(np.sqrt(np.mean(b[:, npost:npost + n] ** 2)))
    _mv_log(f"  seam {label}: repaired {npre}+{npost} samples "
            f"({_SEAM_PRE_MS:.0f}+{_SEAM_POST_MS:.0f} ms); "
            f"incoming head was {quiet_b:.5f} vs {ref_b:.5f} just after")

    donor_a = a[:, len_a - npre - n:len_a - npre][:, ::-1]
    donor_b = b[:, npost:npost + n][:, ::-1]
    t = np.linspace(0.0, 1.0, n, dtype=np.float32)
    seam = donor_a * np.sqrt(1.0 - t)[None, :] + donor_b * np.sqrt(t)[None, :]

    a = a.copy()
    b = b.copy()
    a[:, len_a - npre:] = seam[:, :npre]
    b[:, :npost] = seam[:, npre:]
    return a, b


def _encode_audio_array(out_container, audio_stream, arr, pts):
    """Encode a float32 (channels, samples) array. Returns the new pts.

    PTS units are the stream's time_base (samples for typical AAC streams).
    """
    import av
    import numpy as np
    codec_ctx = audio_stream.codec_context
    layout_name = codec_ctx.layout.name
    sample_rate = codec_ctx.sample_rate
    frame_size = codec_ctx.frame_size or 1024
    sample_fmt = getattr(getattr(codec_ctx, "format", None), "name", None) or "fltp"
    total = int(arr.shape[1])
    i = 0
    while i < total:
        block = np.ascontiguousarray(arr[:, i:i + frame_size])
        frame = av.AudioFrame.from_ndarray(
            block, format="fltp", layout=layout_name)
        frame.sample_rate = sample_rate
        frame.pts = pts
        n = int(block.shape[1])
        pts += n
        i += n
        frames = [frame]
        if sample_fmt != "fltp":
            resampler = av.AudioResampler(
                format=sample_fmt, layout=layout_name, rate=sample_rate)
            frames = list(resampler.resample(frame) or [])
            try:
                frames += list(resampler.resample(None) or [])
            except Exception:
                pass
        for f in frames:
            if f.pts is None:
                f.pts = frame.pts
            for packet in audio_stream.encode(f):
                out_container.mux(packet)
    return pts


class _AudioSeamWriter:
    """Encodes clip audio one clip behind, so each join can be repaired.

    A join touches the end of the outgoing clip and the start of the incoming
    one, so a clip cannot be encoded until its successor has been decoded.
    Holding one clip back is enough; memory stays at two clips of audio rather
    than the whole movie.
    """

    def __init__(self, out_container, audio_stream, rate):
        self.out = out_container
        self.stream = audio_stream
        self.rate = rate
        self.pending = None
        self.pts = 0
        self.index = 0

    def add(self, arr):
        if self.pending is not None:
            self.index += 1
            prev, arr = _repair_seam(
                self.pending, arr, self.rate, f"{self.index}")
            self.pts = _encode_audio_array(
                self.out, self.stream, prev, self.pts)
        self.pending = arr

    def close(self):
        if self.pending is not None:
            self.pts = _encode_audio_array(
                self.out, self.stream, self.pending, self.pts)
            self.pending = None
        for packet in self.stream.encode(None):
            self.out.mux(packet)


def _clip_audio_for_concat(path, has_audio, frames, fps, audio_stream,
                           layout_name, rate):
    """Decoded, length-corrected audio for one clip, or synthesized silence.

    Length comes from the clip's own frame count rather than its container
    duration, so audio and video are measured off the same ruler and no drift
    accumulates down a long scene bar.
    """
    import numpy as np
    name = os.path.basename(path)
    n_target = int(round((float(frames) / float(fps)) * rate)) if fps else 0
    arr = _decode_clip_audio(path, layout_name, rate) if has_audio else None
    if arr is None:
        n_channels = len(audio_stream.codec_context.layout.channels)
        _mv_log(f"  {name}: no audio, {n_target} samples of silence "
                f"({frames} frames @ {fps:g} fps)")
        return np.zeros((n_channels, max(0, n_target)), dtype=np.float32)
    n_dec = int(arr.shape[1])
    _mv_log(f"  {name}: {frames} frames @ {fps:g} fps -> want {n_target}, "
            f"decoded {n_dec}, trimming {n_dec - n_target:+d} "
            f"({(n_dec - n_target) / float(rate) * 1000.0:+.1f} ms)")
    return _fit_audio_length(arr, n_target)


def _probe_movie_inputs(input_paths):
    """Probe clips for Create Movie. Raises ValueError on size/fps mismatch."""
    import av
    from fractions import Fraction
    if len(input_paths) < 2:
        raise ValueError("Need at least two clips.")
    ref = None
    probes = []
    for p in input_paths:
        with av.open(p) as c:
            v = next((s for s in c.streams if s.type == "video"), None)
            a = next((s for s in c.streams if s.type == "audio"), None)
            if v is None:
                raise ValueError(f"{os.path.basename(p)}: no video stream.")
            width = int(v.codec_context.width or 0)
            height = int(v.codec_context.height or 0)
            codec = v.codec_context.name or ""
            if v.average_rate and float(v.average_rate) > 0:
                fps_frac = Fraction(v.average_rate).limit_denominator(1001)
            elif v.base_rate and float(v.base_rate) > 0:
                fps_frac = Fraction(v.base_rate).limit_denominator(1001)
            else:
                fps_frac = Fraction(25, 1)
            fps = float(fps_frac)
            duration_s = (float(c.duration) / 1_000_000.0) if c.duration else 0.0
            # Audio is trimmed to frames/fps, so the frame count has to come
            # along. v.frames is 0 on streams that do not advertise it.
            frames = int(v.frames) if v.frames \
                else max(0, int(round(duration_s * fps)))
            extradata = bytes(v.codec_context.extradata or b"")
            probe = {
                "path": p, "width": width, "height": height,
                "codec": codec, "fps": fps, "fps_frac": fps_frac,
                "duration_s": duration_s, "frames": frames,
                "has_audio": a is not None,
                "audio_rate": (a.codec_context.sample_rate if a else 0),
                "audio_layout": (a.codec_context.layout.name if a else ""),
                "extradata": extradata,
            }
            if ref is None:
                ref = probe
            else:
                if (probe["width"] != ref["width"] or
                        probe["height"] != ref["height"] or
                        abs(probe["fps"] - ref["fps"]) > 0.01):
                    raise ValueError(
                        f"{os.path.basename(p)} is incompatible with "
                        f"{os.path.basename(ref['path'])} (size/fps mismatch).")
            probes.append(probe)
    return probes, ref


def _stream_copy_viable(probes):
    """True when every clip shares codec + SPS/PPS and that codec has a
    container we can mux without transcoding.
    """
    if not probes:
        return False
    ref = probes[0]
    if not _copy_container(ref["codec"]):
        return False
    for p in probes[1:]:
        if p["codec"] != ref["codec"] or p["extradata"] != ref["extradata"]:
            return False
    return True


def _stream_copy_concat(input_paths, output_path, use_audio, probes=None):
    """Concatenate when bitstream params match. Prefer _reencode_concat for
    mixed sources (e.g. original + Clip outputs)."""
    import av
    probes, ref = (probes, probes[0]) if probes else _probe_movie_inputs(input_paths)

    out_audio_params = None
    if use_audio:
        for p in probes:
            if p["has_audio"]:
                out_audio_params = {
                    "rate": p["audio_rate"] or 48000,
                    "layout": p["audio_layout"] or "stereo",
                }
                break

    with av.open(input_paths[0]) as tmpl_c:
        tmpl_v = next(s for s in tmpl_c.streams if s.type == "video")
        with av.open(output_path, mode="w") as out:
            if hasattr(out, "add_stream_from_template"):
                v_out = out.add_stream_from_template(tmpl_v)
            else:
                v_out = out.add_stream(template=tmpl_v)
            a_out = None
            seam = None
            if out_audio_params:
                a_out, audio_rate = _add_concat_audio_stream(
                    out, output_path, out_audio_params, ref.get("codec"))
                out_audio_params = dict(out_audio_params, rate=audio_rate)
                seam = _AudioSeamWriter(out, a_out, audio_rate)

            v_pts_offset = 0

            for probe in probes:
                path = probe["path"]
                with av.open(path) as in_c:
                    v_in = next(s for s in in_c.streams if s.type == "video")

                    first_pts = None
                    last_end = 0
                    for packet in in_c.demux(v_in):
                        if packet.dts is None:
                            continue
                        p_pts = packet.pts if packet.pts is not None else packet.dts
                        if first_pts is None:
                            first_pts = p_pts
                        packet.stream = v_out
                        if packet.pts is not None:
                            packet.pts = (packet.pts - first_pts) + v_pts_offset
                        if packet.dts is not None:
                            packet.dts = (packet.dts - first_pts) + v_pts_offset
                        if packet.duration:
                            last_end = max(last_end, packet.pts + packet.duration)
                        out.mux(packet)
                    v_pts_offset = last_end if last_end > 0 else v_pts_offset

                # Audio is decoded from its own container handle: the demux
                # loop above runs `in_c` to EOF and PyAV does not rewind, so
                # decoding audio from that same handle yields zero frames -- an
                # aac stream is declared, never fed, and the movie is silent.
                if seam is not None:
                    seam.add(_clip_audio_for_concat(
                        path, probe["has_audio"], probe["frames"],
                        probe["fps"], a_out,
                        out_audio_params["layout"], out_audio_params["rate"]))

            if seam is not None:
                seam.close()

    try:
        size_bytes = int(os.path.getsize(output_path))
    except OSError:
        size_bytes = 0
    return {
        "size_bytes": size_bytes,
        "duration_s": sum(p["duration_s"] for p in probes),
        "method": "stream_copy",
    }


def _reencode_concat(input_paths, output_path, use_audio, probes=None, gpu=False):
    """Re-encode concat on the GPU when asked and able, CPU otherwise. Any
    GPU failure (other than a plain input error) retries once on the CPU."""
    if not probes:
        probes, _ref = _probe_movie_inputs(input_paths)
    if gpu and _nvenc_supports(probes[0]["codec"]):
        try:
            info = _reencode_concat_once(
                input_paths, output_path, use_audio, probes, True)
            info["encoder"] = "nvenc"
            return info
        except Exception as e:
            if type(e) is ValueError:
                raise
            _mv_log("GPU re-encode failed (%r); retrying on CPU" % (e,))
            try:
                if os.path.exists(output_path):
                    os.remove(output_path)
            except OSError:
                pass
    info = _reencode_concat_once(input_paths, output_path, use_audio, probes, False)
    info["encoder"] = "cpu"
    return info


def _reencode_concat_once(input_paths, output_path, use_audio, probes=None, gpu=False):
    """Decode/re-encode concat — safe for mixed originals + Clip outputs."""
    import av
    from fractions import Fraction
    probes, ref = (probes, probes[0]) if probes else _probe_movie_inputs(input_paths)
    fps = ref["fps_frac"]
    width, height = ref["width"], ref["height"]
    v_tb = Fraction(1, int(round(ref["fps"])) or 25)

    out_audio_params = None
    if use_audio:
        for p in probes:
            if p["has_audio"]:
                out_audio_params = {
                    "rate": p["audio_rate"] or 48000,
                    "layout": p["audio_layout"] or "stereo",
                }
                break

    encoder, pix_fmt, vopts, bit_rate = _reencode_profile(ref["codec"], gpu)
    with av.open(output_path, mode="w") as out:
        v_out = out.add_stream(encoder, rate=fps)
        v_out.width = width
        v_out.height = height
        v_out.pix_fmt = pix_fmt
        v_out.time_base = v_tb
        try:
            v_out.codec_context.time_base = v_tb
        except Exception:
            pass
        if vopts:
            try:
                v_out.options = dict(vopts)
            except Exception:
                pass
        if bit_rate is not None:
            try:
                v_out.bit_rate = bit_rate
            except Exception:
                pass
        if (_canonical_codec(ref["codec"]) == "hevc"
                and output_path.lower().endswith((".mp4", ".mov"))):
            # "hvc1" is the hevc label browsers and Apple players expect.
            try:
                v_out.codec_context.codec_tag = "hvc1"
            except Exception:
                pass

        a_out = None
        seam = None
        if out_audio_params:
            a_out, audio_rate = _add_concat_audio_stream(
                out, output_path, out_audio_params, ref.get("codec"))
            out_audio_params = dict(out_audio_params, rate=audio_rate)
            seam = _AudioSeamWriter(out, a_out, audio_rate)

        v_pts = 0
        for probe in probes:
            written = 0
            with av.open(probe["path"]) as in_c:
                v_in = next(s for s in in_c.streams if s.type == "video")
                for frame in in_c.decode(v_in):
                    out_frame = frame.reformat(
                        width=width, height=height, format=pix_fmt)
                    out_frame.pts = v_pts
                    out_frame.time_base = v_tb
                    v_pts += 1
                    written += 1
                    for pkt in v_out.encode(out_frame):
                        out.mux(pkt)
            if seam is not None:
                # Length off the frames actually written, not the probe: a
                # container that under-reports its frame count would otherwise
                # leave audio and video on different rulers.
                seam.add(_clip_audio_for_concat(
                    probe["path"], probe["has_audio"],
                    written or probe["frames"], ref["fps"], a_out,
                    out_audio_params["layout"], out_audio_params["rate"]))

        for pkt in v_out.encode(None):
            out.mux(pkt)
        if seam is not None:
            seam.close()

    try:
        size_bytes = int(os.path.getsize(output_path))
    except OSError:
        size_bytes = 0
    return {
        "size_bytes": size_bytes,
        "duration_s": (v_pts / float(fps)) if float(fps) else sum(
            p["duration_s"] for p in probes),
        "method": "reencode",
        "frames": v_pts,
    }


def _concat_movie(input_paths, use_audio, gpu=False):
    """Create Movie: keep the clips' codec and container."""
    probes, ref = _probe_movie_inputs(input_paths)
    copy_ok = _stream_copy_viable(probes)
    keys = {_canonical_codec(p["codec"]) for p in probes}
    if len(keys) > 1:
        _mv_log("clips disagree on codec (%s); movie follows the first clip (%s)"
                % (", ".join(sorted(keys)), _canonical_codec(ref["codec"])))
    ext = _movie_container(ref["codec"], ref.get("path"))
    output_path, rel_path = _next_movie_path(ext)
    _mv_log(f"seam-repair build: {len(probes)} clips, "
            f"codec={_canonical_codec(ref['codec'])} container={ext}, "
            f"audio={'on' if use_audio else 'OFF'}, "
            f"path={'stream_copy' if copy_ok else 'reencode'}, "
            f"gpu={'on' if gpu else 'off'} "
            f"-> {os.path.basename(output_path)}")
    try:
        if copy_ok:
            try:
                info = _stream_copy_concat(
                    input_paths, output_path, use_audio, probes)
            except Exception as e:
                _mv_log("stream_copy failed (%r); re-encoding in the same codec"
                        % (e,))
                try:
                    if os.path.exists(output_path):
                        os.remove(output_path)
                except OSError:
                    pass
                output_path, rel_path = _next_movie_path(ext)
                info = _reencode_concat(
                    input_paths, output_path, use_audio, probes, gpu)
        else:
            info = _reencode_concat(
                input_paths, output_path, use_audio, probes, gpu)
    except Exception:
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass
        raise
    _mv_log("done")
    info["path"] = rel_path
    return info


@routes.post("/ltx23_oasis/create_movie")
@require_same_origin
async def vog_create_movie(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    entries = data.get("entries") or []
    use_audio = bool(data.get("use_audio"))
    gpu = data.get("gpu_encode", True) is not False
    if not isinstance(entries, list) or len(entries) < 2:
        return web.json_response(
            {"error": "Need at least two saved clips."}, status=400)

    # Resolve every entry to an absolute path under output/. Any that
    # can't be resolved (moved / deleted since the strip was populated)
    # abort the whole operation — a partial movie would be confusing.
    out_root = folder_paths.get_output_directory()
    paths = []
    for e in entries:
        fn = (e.get("filename") or "").strip().replace("\\", "/")
        sf = (e.get("subfolder") or "").strip().replace("\\", "/").strip("/")
        if not fn:
            return web.json_response(
                {"error": "Entry missing filename."}, status=400)
        p = _resolve_under(out_root, sf, fn) if sf \
            else _resolve_under(out_root, fn)
        if not p or not os.path.isfile(p):
            shown = f"{sf}/{fn}" if sf else fn
            return web.json_response(
                {"error": f"Missing on disk: {shown}"}, status=404)
        paths.append(p)

    try:
        import av  # noqa: F401
    except ImportError:
        return web.json_response(
            {"error": "PyAV not installed."}, status=500)

    try:
        info = _concat_movie(paths, use_audio, gpu)
    except ValueError as e:
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        return web.json_response(
            {"error": f"Concat failed: {e}"}, status=500)

    # filename/subfolder are split out (not just the joined rel_path) so the
    # frontend can hand the finished movie straight to loadExternalVideo and
    # have it land in the scene bar, exactly the way Clip already does.
    rel_path = info["path"]
    subfolder, _, filename = rel_path.rpartition("/")
    return web.json_response({
        "ok": True,
        "path": rel_path,
        "filename": filename,
        "subfolder": subfolder,
        "size_bytes": info["size_bytes"],
        "duration_s": info["duration_s"],
        "encoder": info.get("encoder", "copy" if info.get("method") != "reencode" else "cpu"),
    })


_CLIP_PREFIX = "clip_"


def _next_clip_path():
    """Pick output/video/clip_NNNNN.mp4 — smallest unused N ≥ 1."""
    out_root = folder_paths.get_output_directory()
    video_dir = os.path.join(out_root, "video")
    os.makedirs(video_dir, exist_ok=True)
    used = set()
    for name in os.listdir(video_dir):
        if not name.startswith(_CLIP_PREFIX) or not name.lower().endswith(".mp4"):
            continue
        stem = name[len(_CLIP_PREFIX):-4]
        if stem.isdigit():
            used.add(int(stem))
    n = 1
    while n in used:
        n += 1
    filename = f"{_CLIP_PREFIX}{n:05d}.mp4"
    return os.path.join(video_dir, filename), f"video/{filename}", filename


def _resolve_view_path(filename, subfolder, type_):
    """Resolve a /view-style entry under temp/ or output/."""
    fn = (filename or "").strip().replace("\\", "/")
    sf = (subfolder or "").strip().replace("\\", "/").strip("/")
    if not fn:
        return None
    kind = (type_ or "temp").strip().lower()
    if kind == "output":
        root = folder_paths.get_output_directory()
    else:
        root = folder_paths.get_temp_directory()
    return _resolve_under(root, sf, fn) if sf else _resolve_under(root, fn)


def _frame_time_s(frame, stream):
    if getattr(frame, "time", None) is not None:
        return float(frame.time)
    if frame.pts is None or stream.time_base is None:
        return None
    return float(frame.pts * stream.time_base)


def _trim_video(input_path, output_path, start_s, end_s, gpu=False):
    """Trim on the GPU (h264_nvenc) when asked and able, CPU libx264
    otherwise. Any GPU failure other than a plain input error (bad range,
    no frames) retries once on the CPU."""
    if gpu and _nvenc_supports("h264"):
        try:
            info = _trim_video_once(input_path, output_path, start_s, end_s, True)
            info["encoder"] = "nvenc"
            return info
        except Exception as e:
            if type(e) is ValueError:
                raise
            print(f"[Oasis] GPU clip encode failed ({e!r}); retrying on CPU")
            try:
                if os.path.exists(output_path):
                    os.remove(output_path)
            except OSError:
                pass
    info = _trim_video_once(input_path, output_path, start_s, end_s, False)
    info["encoder"] = "cpu"
    return info


def _trim_video_once(input_path, output_path, start_s, end_s, gpu=False):
    """Re-encode [start_s, end_s) of input into output_path (H.264 + AAC).

    Stream-copy is unreliable for arbitrary cut points (keyframe alignment),
    so we decode/re-encode. Returns {duration_s, frames, size_bytes, fps}.

    Decoded frames keep the *source* time_base. Assigning pts = 0,1,2 on
    those frames makes PyAV rescale as if the values were still in the source
    time_base, collapsing every frame onto one instant (1-frame playback;
    probe reports absurd fps like frames/duration ~ 2525). Fix: reformat to
    yuv420p and stamp pts in the encoder time_base (1 tick per frame).
    """
    import av
    from fractions import Fraction

    if end_s <= start_s:
        raise ValueError("Clip out must be after clip in.")
    start_s = max(0.0, float(start_s))
    end_s = float(end_s)

    with av.open(input_path) as inn:
        v_in = next((s for s in inn.streams if s.type == "video"), None)
        a_in = next((s for s in inn.streams if s.type == "audio"), None)
        if v_in is None:
            raise ValueError("No video stream.")

        if v_in.average_rate and float(v_in.average_rate) > 0:
            fps = Fraction(v_in.average_rate).limit_denominator(1001)
        elif v_in.base_rate and float(v_in.base_rate) > 0:
            fps = Fraction(v_in.base_rate).limit_denominator(1001)
        else:
            fps = Fraction(25, 1)
        src_fps = float(fps)
        width = int(v_in.codec_context.width or 0)
        height = int(v_in.codec_context.height or 0)
        # 1 tick per frame at the source rate.
        v_tb = Fraction(1, int(round(src_fps)) or 25)

        with av.open(output_path, mode="w") as out:
            nv = oasis_nvenc.plan("h264", "high") if (gpu and oasis_nvenc) else None
            v_out = out.add_stream(nv[0] if nv else "libx264", rate=fps)
            v_out.width = width
            v_out.height = height
            v_out.pix_fmt = "yuv420p"
            v_out.time_base = v_tb
            try:
                v_out.codec_context.time_base = v_tb
            except Exception:
                pass
            if nv:
                oasis_nvenc.apply(v_out, nv[1])
            else:
                try:
                    v_out.options = {"crf": "18", "preset": "veryfast"}
                except Exception:
                    pass

            a_out = None
            resampler = None
            if a_in is not None:
                audio_rate = int(a_in.codec_context.sample_rate or 48000)
                layout = (
                    a_in.codec_context.layout.name
                    if a_in.codec_context.layout else "stereo"
                )
                a_out = out.add_stream("aac", rate=audio_rate)
                a_out.layout = layout
                resampler = av.AudioResampler(
                    format="fltp", layout=layout, rate=audio_rate)

            try:
                inn.seek(int(start_s * av.time_base), backward=True)
            except Exception:
                pass

            frames = 0
            a_pts = 0
            streams = [v_in] + ([a_in] if a_in is not None else [])
            video_done = False
            audio_done = a_in is None

            for packet in inn.demux(*streams):
                # Timestamp-less packets are skipped, except the empty
                # end-of-stream packet: decoding it flushes the frames the
                # decoder is still holding (B-frame sources), so a range
                # that runs to the end keeps its last frames.
                if packet.dts is None and packet.pts is None and packet.size:
                    continue
                try:
                    decoded = packet.decode()
                except Exception:
                    continue
                for frame in decoded:
                    if packet.stream.type == "video":
                        if video_done:
                            continue
                        t = _frame_time_s(frame, v_in)
                        if t is None or t < start_s:
                            continue
                        if t >= end_s:
                            video_done = True
                            continue
                        out_frame = frame.reformat(
                            width=width, height=height, format="yuv420p")
                        out_frame.pts = frames
                        out_frame.time_base = v_tb
                        frames += 1
                        for pkt in v_out.encode(out_frame):
                            out.mux(pkt)
                    elif a_out is not None and packet.stream.type == "audio":
                        if audio_done:
                            continue
                        t = _frame_time_s(frame, a_in)
                        if t is None or t < start_s:
                            continue
                        if t >= end_s:
                            audio_done = True
                            continue
                        for out_frame in (resampler.resample(frame) or []):
                            out_frame.pts = a_pts
                            a_pts += out_frame.samples
                            for pkt in a_out.encode(out_frame):
                                out.mux(pkt)
                if video_done and audio_done:
                    break

            for pkt in v_out.encode(None):
                out.mux(pkt)
            if a_out is not None:
                for pkt in a_out.encode(None):
                    out.mux(pkt)

    try:
        size_bytes = int(os.path.getsize(output_path))
    except OSError:
        size_bytes = 0
    if frames <= 0:
        raise ValueError("No frames in the selected range.")
    return {
        "duration_s": frames / src_fps if src_fps else 0.0,
        "frames": frames,
        "size_bytes": size_bytes,
        "fps": src_fps,
    }


@routes.post("/ltx23_oasis/clip_video")
@require_same_origin
async def vog_clip_video(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)

    filename = (data.get("filename") or "").strip()
    subfolder = (data.get("subfolder") or "").strip()
    type_ = (data.get("type") or "temp").strip()
    try:
        start_s = float(data.get("start_s"))
        end_s = float(data.get("end_s"))
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "start_s and end_s are required numbers."}, status=400)
    if end_s <= start_s:
        return web.json_response(
            {"error": "Clip out must be after clip in."}, status=400)

    path = _resolve_view_path(filename, subfolder, type_)
    if not path or not os.path.isfile(path):
        shown = f"{subfolder}/{filename}" if subfolder else filename
        return web.json_response(
            {"error": f"Missing on disk: {shown}"}, status=404)

    try:
        import av  # noqa: F401
    except ImportError:
        return web.json_response(
            {"error": "PyAV not installed."}, status=500)

    output_path, rel_path, out_name = _next_clip_path()
    try:
        gpu = data.get("gpu_encode", True) is not False
        info = _trim_video(path, output_path, start_s, end_s, gpu)
    except ValueError as e:
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass
        return web.json_response(
            {"error": f"Clip failed: {e}"}, status=500)

    return web.json_response({
        "ok": True,
        "path": rel_path,
        "filename": out_name,
        "subfolder": "video",
        "frames": info["frames"],
        "duration_s": info["duration_s"],
        "size_bytes": info["size_bytes"],
        "fps": info["fps"],
        "encoder": info.get("encoder", "cpu"),
    })


# ── Presets (identical storage shape to Image Oasis) ─────────────────────────

def _load_presets():
    return _read_json(_PRESETS_FILE, [])


def _save_presets(p):
    return _atomic_write_json(_PRESETS_FILE, p)


@routes.get("/ltx23_oasis/presets")
async def vog_get_presets(request):
    return web.json_response(_load_presets())


@routes.post("/ltx23_oasis/save_preset")
@require_same_origin
async def vog_save_preset(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    name = (data.get("name", "Untitled") or "Untitled").strip() or "Untitled"
    cfg = data.get("config", {})
    presets = _load_presets()
    idx = next((i for i, p in enumerate(presets) if p.get("name") == name), None)
    entry = {
        "id": presets[idx]["id"] if idx is not None else str(uuid.uuid4()),
        "name": name,
        "timestamp": datetime.now().isoformat(),
        "config": cfg,
    }
    if idx is not None:
        presets[idx] = entry
    else:
        presets.insert(0, entry)
    if not _save_presets(presets):
        return web.json_response({"error": "Could not write presets.json."}, status=500)
    return web.json_response({"ok": True})


@routes.delete("/ltx23_oasis/presets/{preset_id}")
@require_same_origin
async def vog_delete_preset(request):
    pid = request.match_info["preset_id"]
    _save_presets([p for p in _load_presets() if p.get("id") != pid])
    return web.json_response({"ok": True})


@routes.post("/ltx23_oasis/reorder_presets")
@require_same_origin
async def vog_reorder_presets(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    ids = data.get("ids") or []
    presets = _load_presets()
    by_id = {p.get("id"): p for p in presets}
    seen, reordered = set(), []
    for i in ids:
        if i in by_id and i not in seen:
            reordered.append(by_id[i])
            seen.add(i)
    for p in presets:
        if p.get("id") not in seen:
            reordered.append(p)
    _save_presets(reordered)
    return web.json_response({"ok": True})


# ── Reference-slot info (IO parity) ─────────────────────────────────────────

@routes.get("/ltx23_oasis/input_info")
async def vog_input_info(request):
    fn = (request.rel_url.query.get("filename") or "").strip()
    if not fn:
        return web.json_response({"error": "Missing filename."}, status=400)
    path = _resolve_under(folder_paths.get_input_directory(), fn)
    if not path or not os.path.isfile(path):
        return web.json_response({"error": "Not found."}, status=404)
    try:
        size = os.path.getsize(path)
        from PIL import Image as _PILImage
        with _PILImage.open(path) as im:
            w, h = im.size
        return web.json_response({"width": int(w), "height": int(h), "size": int(size)})
    except Exception as e:
        return web.json_response({"error": f"Could not read image info: {e}"}, status=500)


# ── CivitAI LoRA page lookup (hash → model URL) ─────────────────────────────

_LORA_SHA_MEMO = {}       # path -> (mtime_ns, size, sha256_hex)
_CIVITAI_URL_MEMO = {}    # sha256_hex -> url string (or "" for known miss)


def _sha256_file(path):
    import hashlib
    stt = os.stat(path)
    hit = _LORA_SHA_MEMO.get(path)
    if hit and hit[0] == stt.st_mtime_ns and hit[1] == stt.st_size:
        return hit[2]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    if len(_LORA_SHA_MEMO) > 256:
        for k in list(_LORA_SHA_MEMO)[:128]:
            _LORA_SHA_MEMO.pop(k, None)
    _LORA_SHA_MEMO[path] = (stt.st_mtime_ns, stt.st_size, digest)
    return digest


async def _civitai_model_url_for_hash(sha256_hex):
    """Resolve SHA256 → CivitAI model page URL, or None if unknown."""
    import aiohttp
    cached = _CIVITAI_URL_MEMO.get(sha256_hex)
    if cached is not None:
        return cached or None
    timeout = aiohttp.ClientTimeout(total=20)
    headers = {"User-Agent": "ltx23-oasis/1.0"}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        # Full SHA256 first; AutoV2 (first 10 hex chars) as fallback for older index.
        for key in (sha256_hex, sha256_hex[:10].upper()):
            api = f"https://civitai.com/api/v1/model-versions/by-hash/{key}"
            async with session.get(api) as resp:
                if resp.status == 404:
                    continue
                if resp.status >= 400:
                    text = await resp.text()
                    raise RuntimeError(f"CivitAI HTTP {resp.status}: {text[:200]}")
                data = await resp.json(content_type=None)
            model_id = data.get("modelId")
            version_id = data.get("id")
            if not model_id:
                continue
            url = f"https://civitai.com/models/{int(model_id)}"
            if version_id is not None:
                url += f"?modelVersionId={int(version_id)}"
            _CIVITAI_URL_MEMO[sha256_hex] = url
            return url
    _CIVITAI_URL_MEMO[sha256_hex] = ""
    return None


async def _lookup_civitai_lora(name):
    path = folder_paths.get_full_path("loras", name)
    if not path or not os.path.isfile(path):
        raise FileNotFoundError(f"LoRA not found: {name}")
    import asyncio
    loop = asyncio.get_running_loop()
    digest = await loop.run_in_executor(None, _sha256_file, path)
    url = await _civitai_model_url_for_hash(digest)
    if not url:
        raise LookupError("No CivitAI page for this file hash.")
    return {"url": url, "sha256": digest}


@routes.get("/ltx23_oasis/civitai_lora")
async def vog_civitai_lora(request):
    name = (request.rel_url.query.get("name") or "").strip().replace("\\", "/")
    if not name or ".." in name.split("/"):
        return web.json_response({"error": "Missing LoRA name."}, status=400)
    try:
        info = await _lookup_civitai_lora(name)
    except FileNotFoundError as e:
        return web.json_response({"error": str(e)}, status=404)
    except LookupError as e:
        return web.json_response({"error": str(e)}, status=404)
    except Exception as e:
        return web.json_response({"error": f"CivitAI lookup failed: {e}"}, status=502)
    return web.json_response(info)


@routes.get("/ltx23_oasis/help")
async def vog_help(request):
    try:
        with open(_HELP_FILE, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        text = "# Help unavailable\n\nCouldn't read `ltx23_oasis_help_content.md` from the package directory."
    return web.Response(text=text, content_type="text/markdown", charset="utf-8")


# ── Prompt enhancer (video-flavored) ─────────────────────────────────────────
#
# Reuses Image Oasis's enhancer MACHINERY (model cache, targeted VRAM
# eviction, llama-cpp load, cleanup profiles) by locating its already-loaded
# routes_enhance module at runtime — one enhancer suite-wide, zero duplicated
# VRAM logic. SYSTEM PROMPTS are LTX Oasis's own: IO's route
# hard-maps style -> image prompts, so video styles need their own endpoint.

# T2V: Image Oasis's natural-language prompt, verbatim, renamed — edit the
# text below to fit Text-to-Video (motion, camera moves, what happens over
# the clip's duration).
_SYS_T2V = (
	"You enhance short prompts for AI text-to-video generation.\n"
    "Your task is to expand the user's prompt into a complete production specification while faithfully preserving the user's intent. Fill in information only where the prompt is open-ended or incomplete. Every addition must naturally follow from the subject and context of the user's prompt.\n"
    "You may think through the scene, plan your approach, and reason about the best description. The final output MUST be one flowing paragraph that consists only of the finished prompt. No multiple paragraphs, no sections, no headers, no title.\n"

    "GENERAL PRINCIPLES:\n"

    "- This prompt is a production specification for a generated video.\n"
    "- Write like a director describing a shot.\n"
    "- Every sentence must contribute concrete production information."
    "- Derive every descriptive, technical, and stylistic choice from the subject and context of the user's prompt.\n"
    "- Prefer precise, concrete descriptions over broad or generic ones.\n"
    "- Describe the scene literally and objectively.\n"
    "- Represent the scene exactly as it is intended to appear.\n"
    "- Describe the subject plainly, literally, and completely as it would actually appear.\n"
    "- Do NOT soften, euphemize, censor, or abstract any part of the subject or scene.\n"
    "- Do NOT add distancing language.\n"

    "SCENE REPRESENTATION:\n"

    "- Describe the scene as a continuous sequence of observable events.\n"
    "- Present actions in the order they occur."
    "- Synchronize subject movement, camera movement, environmental changes, sound, and dialogue within the same chronological sequence.\n"
    "- Maintain continuity throughout the scene.\n"
    "- Preserve consistent appearance, clothing, props, lighting, spatial relationships, and subject identity unless the scene visibly changes.\n"

    "VISUAL DESCRIPTION:\n"

    "- Describe only observable reality.\n"
    "- Describe what the camera sees as the scene unfolds.\n"
    "- Describe age, appearance, pose, state of dress or undress, motion, physical interaction, lighting, composition, framing, perspective, scale, texture, material, color, and environmental conditions whenever they are relevant.\n"
    "- Describe observable motion, appearance, and behavior rather than causes or internal states.\n"
    "- Describe emotion through observable physical performance.\n"
    "- Describe only externally visible behavior.\n"

    "PERSPECTIVE:\n"

    "- Define the visual perspective of the scene based on the intended viewer experience.\n"
    "- Establish whether the scene is observed through a physical recording device, through the eyes of a person within the scene, or from an external cinematic viewpoint.\n"
    "- Match camera language to the chosen perspective.\n"
    "- When the viewer is experiencing the scene through a person's eyes, describe the perspective as direct human perception rather than a recorded image.\n"
    "- When the scene is presented as a recording, describe the capture perspective and behavior of the recording device.\n"
    "- Maintain a consistent perspective throughout the scene unless the viewpoint visibly changes.\n"

    "CAMERA:\n"

    "- For scenes recorded by a physical device: describe camera position, framing, angle, movement, focus, and composition as they evolve naturally throughout the shot.\n"
    "- Keep camera behavior synchronized with the progression of the scene.\n"

    "AUDIO:\n"

    "- Integrate audio naturally into the chronological description of the scene.\n"
    "- Describe audio at the moment it becomes audible or relevant.\n"
    "- Represent every audible event as part of the unfolding scene.\n"

    "DIALOGUE:\n"

    "- You may be asked to generate dialogue either explicitly, or insinuated by the mention of conversation or discussion.\n"
    "- Represent all dialogue enclosed in quotation marks and identify the speaker and manner of speaking.\n"
    "- Place dialogue at the point in the timeline where it occurs.\n"

    "STYLE:\n"

    "- Use direct, literal language.\n"
    "- Use complete descriptive sentences.\n"
    "- Write with consistent specificity from beginning to end.\n"
    "- End immediately after the final observable event of the scene."
)

# I2V: assumes a starting frame already exists and steers the model toward
# describing the MOTION and evolution from that frame (camera movement,
# subject action, audio if enabled), not re-describing the static scene.
_SYS_I2V = (
    "You enhance short prompts for AI image-to-video generation.\n"
    "Always assume that a first frame is active and that the user's prompt describes that frame and the evolution of the video from that point.\n"
    "If additional frames are provided, describe the visible transformation and progression from one frame to the next.\n"
    "Your task is to expand the user's prompt into a complete production specification while faithfully preserving the user's intent. Fill in information only where the prompt is open-ended or incomplete. Every addition must naturally follow from the subject and context of the user's prompt.\n"
    "You may think through the scene, plan your approach, and reason about the best description. The final output MUST be one flowing paragraph that consists only of the finished prompt. No multiple paragraphs, no sections, no headers, no title.\n"

    "GENERAL PRINCIPLES:\n"

    "- This prompt is a production specification for a generated video.\n"
    "- Write like a director describing a shot.\n"
    "- Every sentence must contribute concrete production information.\n"
    "- Derive every descriptive, technical, and stylistic choice from the subject and context of the user's prompt.\n"
    "- Prefer precise, concrete descriptions over broad or generic ones.\n"
    "- Describe the scene literally and objectively.\n"
    "- Represent the scene exactly as it is intended to appear.\n"
    "- Describe the subject plainly, literally, and completely as it would actually appear.\n"
    "- Do NOT soften, euphemize, censor, or abstract any part of the subject or scene.\n"
    "- Do NOT add distancing language.\n"
    "- If the subject is described a certain way in the input, render that faithfully in plain terms; the purpose is accurate description, not interpretation or judgment.\n"

    "SCENE REPRESENTATION:\n"

    "- Describe the scene as a continuous sequence of observable events.\n"
    "- Present actions in the order they occur.\n"
    "- Describe the evolution from the active frame to the final state of the video.\n"
    "- Synchronize subject movement, camera movement, environmental changes, sound, and dialogue within the same chronological sequence.\n"
    "- Maintain continuity throughout the scene.\n"
    "- Preserve consistent appearance, clothing, props, lighting, spatial relationships, and subject identity unless the scene visibly changes.\n"

    "VISUAL DESCRIPTION:\n"

    "- Describe only observable reality.\n"
    "- Describe what the viewer sees in the frame as the scene unfolds.\n"
    "- Describe age, appearance, pose, state of dress or undress, motion, physical interaction, lighting, composition, framing, perspective, scale, texture, material, color, and environmental conditions whenever they are relevant.\n"
    "- Describe observable motion, appearance, and behavior rather than causes or internal states.\n"
    "- Describe emotion through observable physical performance.\n"
    "- Describe only externally visible behavior.\n"

    "PERSPECTIVE:\n"

    "- Define the visual perspective of the scene based on the intended viewer experience.\n"
    "- Establish whether the scene is observed through a physical recording device, through the eyes of a person within the scene, or from an external cinematic viewpoint.\n"
    "- Match camera language to the chosen perspective.\n"
    "- When the viewer is experiencing the scene through a person's eyes, describe the perspective as direct human perception rather than a recorded image.\n"
    "- When the scene is presented as a recording, describe the capture perspective and behavior of the recording device.\n"
    "- Maintain a consistent perspective throughout the scene unless the viewpoint visibly changes.\n"

    "CAMERA:\n"

    "- For scenes recorded by a physical device: describe camera position, framing, angle, movement, focus, and composition as they evolve naturally throughout the shot.\n"
    "- For image-to-video transitions: describe how the camera and subject evolve from the starting frame into the resulting motion.\n"
    "- Keep camera behavior synchronized with the progression of the scene.\n"

    "AUDIO:\n"

    "- Integrate audio naturally into the chronological description of the scene.\n"
    "- Describe audio at the moment it becomes audible or relevant.\n"
    "- Represent every audible event as part of the unfolding scene.\n"

    "DIALOGUE:\n"

    "- Represent every spoken utterance explicitly as dialogue.\n"
    "- Enclose every spoken utterance in quotation marks.\n"
    "- Identify the speaker for every spoken utterance.\n"
    "- Describe the manner of speaking for every spoken utterance.\n"
    "- Place each spoken utterance at the point in the sequence where it occurs.\n"
    "- Represent every spoken word intended to be heard in the finished video as dialogue.\n"

    "STYLE:\n"

    "- Use direct, literal language.\n"
    "- Use complete descriptive sentences.\n"
    "- Write with consistent specificity from beginning to end.\n"
    "- Do NOT use metaphors, similes, or poetic language.\n"
    "- End immediately after the final observable event of the scene."
)

_VIDEO_STYLE_PROMPTS = {"t2v": _SYS_T2V, "i2v": _SYS_I2V}


def _io_enhance_module():
    """Find Image Oasis's routes_enhance module in sys.modules (it self-loads
    when IO is installed). Returns None when IO is absent."""
    for mod in list(sys.modules.values()):
        f = getattr(mod, "__file__", "") or ""
        if f.replace("\\", "/").endswith("/routes_enhance.py"):
            return mod
    return None


@routes.post("/ltx23_oasis/enhance")
@require_same_origin
async def vog_enhance(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)

    eio = _io_enhance_module()
    if eio is None:
        return web.json_response({"error": (
            "The prompt enhancer is provided by Image Oasis — install/enable "
            "the Image Oasis node pack to use \u2728 Enhance.")}, status=501)

    prompt = (data.get("prompt") or "").strip()
    style = (data.get("style") or "t2v").lower()
    model_name = (data.get("model") or "").strip()
    auto_layers = bool(data.get("auto_layers", False))
    if not prompt:
        return web.json_response({"error": "Nothing to enhance — the prompt is empty."}, status=400)
    if style not in _VIDEO_STYLE_PROMPTS:
        style = "t2v"

    # Same run-guard as IO: loading the LLM mid-generation would evict the
    # diffusion model out from under the sampler.
    try:
        running, _pending = PromptServer.instance.prompt_queue.get_current_queue()
        if running:
            return web.json_response(
                {"error": "Enhance is unavailable while a video is generating. "
                          "Wait for the run to finish and try again."}, status=409)
    except Exception:
        pass

    try:
        n_ctx = max(512, int(data.get("n_ctx", eio._DEFAULT_N_CTX)))
    except (TypeError, ValueError):
        n_ctx = eio._DEFAULT_N_CTX
    try:
        max_tokens_setting = max(64, int(data.get("max_tokens", eio._DEFAULT_MAX_TOKENS)))
    except (TypeError, ValueError):
        max_tokens_setting = eio._DEFAULT_MAX_TOKENS
    try:
        n_gpu_layers = int(data.get("n_gpu_layers", -1))
    except (TypeError, ValueError):
        n_gpu_layers = -1
    if n_gpu_layers < -1:
        n_gpu_layers = -1

    model_path, err = eio._resolve_model_path(model_name)
    if err:
        return web.json_response({"error": err[0]}, status=err[1])
    try:
        import llama_cpp  # noqa: F401
    except ImportError:
        return web.json_response({"error": (
            "llama-cpp-python is not installed. Install the package via your "
            "ComfyUI Python environment (CUDA builds need "
            "CMAKE_ARGS=\"-DGGML_CUDA=on\" during install).")}, status=500)

    system_prompt = _VIDEO_STYLE_PROMPTS[style]
    model_basename = os.path.basename(model_path)

    def work():
        # Mirrors IO's cache-first flow against the SHARED _STATE, so IO and
        # LTX Oasis reuses the same resident LLM instead of thrashing loads.
        layers_match = auto_layers or eio._STATE["n_gpu_layers"] == n_gpu_layers
        if (eio._STATE["model"] is not None
                and eio._STATE["path"] == model_path
                and layers_match
                and eio._STATE["n_ctx"] == n_ctx):
            llm = eio._STATE["model"]
            actual_layers = eio._STATE["n_gpu_layers"]
        else:
            try:
                file_size = os.path.getsize(model_path)
                eio._targeted_vram_free(int(file_size * 1.5))
            except Exception:
                pass
            eio._unload()
            if auto_layers:
                rec = eio._recommend_gpu_layers(model_path)
                load_layers = rec.get("layers", -1)
            else:
                load_layers = n_gpu_layers
            actual_layers = load_layers
            try:
                llm = eio._load_llama(model_path, load_layers, n_ctx)
            except Exception as e:
                print(f"[LTX Oasis] Enhancer GPU load failed ({e}); retrying on CPU.")
                eio._unload()
                llm = eio._load_llama(model_path, 0, n_ctx)
                actual_layers = 0
            eio._STATE["model"] = llm
            eio._STATE["path"] = model_path
            eio._STATE["n_gpu_layers"] = actual_layers
            eio._STATE["n_ctx"] = n_ctx

        combined_len = len(system_prompt) + len(prompt)
        est_input_tokens = int(combined_len / 3.5)
        budget = n_ctx - est_input_tokens - 64
        max_tokens = max(64, min(budget, max_tokens_setting))
        raw = eio._generate(llm, system_prompt, prompt, max_tokens)
        enhanced = eio._clean(raw, model_basename)
        return enhanced, actual_layers

    def locked_work():
        with eio._ENHANCE_LOCK:
            return work()

    try:
        import asyncio
        loop = asyncio.get_running_loop()
        enhanced, actual_layers = await loop.run_in_executor(None, locked_work)
    except Exception as e:
        try:
            eio.unload_enhancer()
        except Exception:
            pass
        return web.json_response({"error": f"Enhancement failed: {e}"}, status=500)

    if not enhanced:
        return web.json_response({"error": "The model returned no usable text. Try again."}, status=500)
    return web.json_response({"enhanced": enhanced, "gpu_layers": actual_layers})
