"""
Backend HTTP routes for Audio Oasis.

Both routes are synchronous-feeling from the widget's point of view (plain
fetch + await, no queued graph run, no WebSocket) -- chopping and analyzing
a track is fast enough that it doesn't need the async result-delivery
pattern LTX2.3 Oasis and Video Oasis Viewer use for slow video encodes.

    POST /audio_oasis/analyze        {filename} -> duration/sr/channels/bpm/key
    POST /audio_oasis/save_segments  {filename, track_name, points} -> saved segment list
    GET  /audio_oasis/help           -> audio_oasis_help_content.md (raw markdown)
    GET  /audio_oasis/saved_tracks   -> saved segment sets found on disk
    GET  /audio_oasis/load_manifest  ?track=NAME -> that set's manifest.json
    GET  /audio_oasis/theme          -> active palette (CSS var overrides)
    POST /audio_oasis/theme          -> save active palette
    GET  /audio_oasis/themes         -> named palette library
    POST /audio_oasis/save_named_theme
    DELETE /audio_oasis/themes/{id}

The saved_tracks/load_manifest pair exists because a saved segment set
outlives the browser session: the files and their manifest.json live under
input/audio_oasis/<track>/ and survive ComfyUI restarts, but until v1.6 the
only state that could FIND them again was the workflow JSON. These routes
let the widget restore a saved set into a fresh node without re-chopping.

The theme routes are Audio Oasis's own, stored in user/audio_oasis/ beside
its other state. Image Oasis (user/image_oasis/) and LTX2.3 Oasis keep
separate files, so the three nodes can run different palettes at once; the
storage helpers here are vendored from routes_image.py for the same
standalone reason comfy_bridge_audio.py vendors its node-call helpers.

Path safety mirrors Image Oasis's routes_image.py: every filename/subfolder that
reaches the filesystem is resolved with _resolve_under() and rejected if it
escapes its base directory.
"""

import os
import json
import time
import asyncio
import logging

import folder_paths
from server import PromptServer
from aiohttp import web
from oasis_csrf import require_same_origin

from . import dsp_audio as dsp

log = logging.getLogger("AudioOasis")

routes = PromptServer.instance.routes


async def _run_blocking(builder):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, builder)


def _resolve_under(base, *parts):
    """Join `parts` onto `base` and resolve; None unless the result stays
    inside `base`. Blocks `..` traversal and absolute-path components."""
    resolved = os.path.realpath(os.path.join(base, *parts))
    root = os.path.realpath(base)
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    return resolved


def _resolve_input_file(qualified_name):
    """qualified_name may be 'subfolder/name.mp3' or bare 'name.mp3', same
    convention ComfyUI's own /view and LoadAudio use."""
    qualified_name = (qualified_name or "").strip().replace("\\", "/")
    if not qualified_name:
        return None
    subfolder, _, name = qualified_name.rpartition("/")
    base = folder_paths.get_input_directory()
    parts = [p for p in (subfolder, name) if p]
    return _resolve_under(base, *parts)


def _slugify(name, fallback="Track"):
    cleaned = "".join(c if (c.isalnum() or c in "-_") else "_" for c in (name or "")).strip("_")
    return cleaned or fallback


# ── In-node help content ─────────────────────────────────────────────────
# Serves audio_oasis_help_content.md from the package directory as raw
# markdown. The JS side converts it to HTML (same pattern as Image Oasis).

_HELP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "audio_oasis_help_content.md")


@routes.get("/audio_oasis/help")
async def audio_oasis_get_help(request):
    try:
        with open(_HELP_FILE, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        text = ("# Help unavailable\n\nCouldn't read "
                "`audio_oasis_help_content.md` from the package directory.")
    return web.Response(text=text, content_type="text/markdown", charset="utf-8")


# ── Saved segment sets (manifest discovery / reload) ─────────────────────

def _read_manifest(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            m = json.load(f)
        return m if isinstance(m, dict) else None
    except Exception:
        return None


@routes.get("/audio_oasis/saved_tracks")
async def audio_oasis_saved_tracks(request):
    """List every saved segment set under input/audio_oasis/ that has a
    readable manifest.json. Unreadable manifests are skipped, not fatal."""
    base = _resolve_under(folder_paths.get_input_directory(), "audio_oasis")
    sets = []
    if base and os.path.isdir(base):
        for name in sorted(os.listdir(base)):
            mpath = _resolve_under(base, name, "manifest.json")
            if not mpath or not os.path.isfile(mpath):
                continue
            m = _read_manifest(mpath)
            if not m:
                continue
            src = _resolve_input_file(m.get("source_filename") or "")
            sets.append({
                # The directory name is the load key -- it's what save wrote,
                # and manifest track_name always matches it, but the dir name
                # is what load_manifest resolves against.
                "track_name": name,
                "saved_at": m.get("saved_at"),
                "fps": m.get("fps"),
                "segments": len(m.get("segments") or []),
                "source_exists": bool(src and os.path.isfile(src)),
            })
    return web.json_response({"sets": sets})


@routes.get("/audio_oasis/load_manifest")
async def audio_oasis_load_manifest(request):
    track = (request.query.get("track") or "").strip()
    if not track:
        return web.json_response({"error": "Missing track name."}, status=400)
    mpath = _resolve_under(folder_paths.get_input_directory(),
                           "audio_oasis", track, "manifest.json")
    if not mpath or not os.path.isfile(mpath):
        return web.json_response({"error": "No saved set with that name."},
                                 status=404)
    m = _read_manifest(mpath)
    if not m:
        return web.json_response({"error": "Manifest is unreadable."},
                                 status=500)

    # Per-segment existence lets the widget grey out anything deleted from
    # disk by hand; source_exists decides whether the waveform can reload.
    seg_dir = os.path.dirname(mpath)
    for seg in (m.get("segments") or []):
        fname = seg.get("filename") or ""
        fpath = _resolve_under(seg_dir, fname) if fname else None
        seg["exists"] = bool(fpath and os.path.isfile(fpath))

    src = _resolve_input_file(m.get("source_filename") or "")
    return web.json_response({
        "manifest": m,
        "source_exists": bool(src and os.path.isfile(src)),
    })


# ── Theme storage (Audio Oasis's own palette) ────────────────────────────
#
# Vendored from routes_image.py's helpers so Audio Oasis stands alone. The
# palette is a per-install appearance preference, not workflow state, so it
# lives in user/audio_oasis/ rather than in any node blob. Image Oasis keeps
# user/image_oasis/theme.json and LTX2.3 Oasis its own; nothing is shared,
# which is what lets the three nodes show different palettes at once.

import json as _pjson
import uuid as _uuid
import tempfile
from datetime import datetime

_AO_DIR = os.path.join(folder_paths.base_path, "user", "audio_oasis")
_THEME_FILE = os.path.join(_AO_DIR, "theme.json")
_THEMES_FILE = os.path.join(_AO_DIR, "themes.json")
os.makedirs(_AO_DIR, exist_ok=True)

# The six editable CSS variables. Names match Image Oasis and LTX2.3 Oasis
# on purpose: it's the CSS SCOPE (.ao-widget vs :root vs .iov-widget) that
# keeps the palettes independent, not the variable naming.
_THEME_VAR_KEYS = {"--io-accent", "--io-accent-dim", "--io-bg",
                   "--io-bg2", "--io-bd", "--io-dim"}


def _read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return _pjson.load(f)
    except Exception:
        return default


def _atomic_write_json(path, data):
    """Write to a temp file then replace, so a crash mid-write can't corrupt.
    Returns True on success so callers can report a failed save instead of
    silently claiming ok."""
    try:
        d = os.path.dirname(path)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            _pjson.dump(data, f, indent=2)
        os.replace(tmp, path)
        return True
    except Exception as e:
        log.warning("AudioOasis: failed to write %s: %s", os.path.basename(path), e)
        return False


def _clean_colors(colors):
    """Keep only known variable keys with string values, length-capped, so a
    malformed or oversized payload can't write junk into the theme file."""
    return {k: str(v)[:32] for k, v in (colors or {}).items()
            if k in _THEME_VAR_KEYS and isinstance(v, str)}


@routes.get("/audio_oasis/theme")
async def audio_oasis_get_theme(request):
    # {} means "no override saved" -- the JS falls back to the CSS defaults.
    return web.json_response(_read_json(_THEME_FILE, {}))


@routes.post("/audio_oasis/theme")
@require_same_origin
async def audio_oasis_save_theme(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    # An empty dict is valid and means "reset to defaults".
    clean = _clean_colors(data)
    if not _atomic_write_json(_THEME_FILE, clean):
        return web.json_response({"error": "Could not write theme.json."}, status=500)
    return web.json_response({"ok": True, "theme": clean})


def _load_named_themes():
    return _read_json(_THEMES_FILE, [])


def _save_named_themes(t):
    return _atomic_write_json(_THEMES_FILE, t)


@routes.get("/audio_oasis/themes")
async def audio_oasis_get_named_themes(request):
    return web.json_response(_load_named_themes())


@routes.post("/audio_oasis/save_named_theme")
@require_same_origin
async def audio_oasis_save_named_theme(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    name = (data.get("name", "") or "").strip()[:60]
    if not name:
        return web.json_response({"error": "Name required."}, status=400)
    themes = _load_named_themes()
    # Match by name (case-sensitive); overwriting preserves the existing id so
    # any frontend "active" reference stays stable across a re-save.
    idx = next((i for i, t in enumerate(themes) if t.get("name") == name), None)
    entry = {
        "id": themes[idx]["id"] if idx is not None else str(_uuid.uuid4()),
        "name": name,
        "timestamp": datetime.now().isoformat(),
        "colors": _clean_colors(data.get("colors")),
    }
    if idx is not None:
        themes[idx] = entry
    else:
        themes.insert(0, entry)
    if not _save_named_themes(themes):
        return web.json_response({"error": "Could not write themes.json."}, status=500)
    return web.json_response({"ok": True, "id": entry["id"]})


@routes.delete("/audio_oasis/themes/{theme_id}")
@require_same_origin
async def audio_oasis_delete_named_theme(request):
    tid = request.match_info["theme_id"]
    _save_named_themes([t for t in _load_named_themes() if t.get("id") != tid])
    return web.json_response({"ok": True})


# ── Analysis ─────────────────────────────────────────────────────────────

@routes.post("/audio_oasis/analyze")
@require_same_origin
async def audio_oasis_analyze(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Malformed request body."}, status=400)

    filename = (data.get("filename") or "").strip()
    if not filename:
        return web.json_response({"error": "Missing filename."}, status=400)
    path = _resolve_input_file(filename)
    if not path or not os.path.isfile(path):
        return web.json_response({"error": "Audio file not found."}, status=404)

    try:
        result = await _run_blocking(lambda: dsp.analyze(path))
        return web.json_response(result)
    except ImportError:
        return web.json_response({
            "error": "BPM/key detection needs librosa. Install it (see "
                     "audio_oasis/audio_oasis_README.md) and restart ComfyUI. "
                     "Loading, chopping, and saving segments don't need it.",
        }, status=501)
    except Exception as e:
        log.exception("AudioOasis: analyze failed")
        return web.json_response({"error": f"Analysis failed: {e}"}, status=500)


# ── Segment saving ───────────────────────────────────────────────────────

@routes.post("/audio_oasis/save_segments")
@require_same_origin
async def audio_oasis_save_segments(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Malformed request body."}, status=400)

    filename = (data.get("filename") or "").strip()
    track_name = _slugify(data.get("track_name") or os.path.splitext(os.path.basename(filename))[0])
    points = data.get("points") or []
    try:
        fps = float(data.get("fps") or 0) or None
        if fps is not None and not (0 < fps <= 240):
            fps = None
    except (TypeError, ValueError):
        fps = None

    snap = data.get("snap")
    if snap not in ("off", "frame", "8n1", "17k5"):
        snap = None

    if not filename:
        return web.json_response({"error": "Missing filename."}, status=400)
    src_path = _resolve_input_file(filename)
    if not src_path or not os.path.isfile(src_path):
        return web.json_response({"error": "Audio file not found."}, status=404)

    ext = dsp.supported_ext(filename)
    if not ext:
        return web.json_response({
            "error": f"Unsupported source format '{os.path.splitext(filename)[1]}'. "
                     "Audio Oasis saves segments matching the source format; "
                     "supported: mp3, wav, flac, m4a/aac.",
        }, status=400)
    if not dsp.encoder_available(ext):
        return web.json_response({
            "error": f"This ComfyUI's FFmpeg build has no '{ext}' encoder available.",
        }, status=501)

    try:
        points = sorted(set(float(p) for p in points if float(p) > 0))
    except (TypeError, ValueError):
        return web.json_response({"error": "Points must be numbers (seconds)."}, status=400)

    def _do_save():
        info = dsp.probe(src_path)
        duration = info["duration"] or 0.0
        # Drop points at/past the end (nothing to cut there) and dedupe
        # anything the client already snapped together.
        clean_points = [p for p in points if 0 < p < duration]
        boundaries = [0.0] + clean_points + [duration]

        out_dir = _resolve_under(folder_paths.get_input_directory(), "audio_oasis", track_name)
        if out_dir is None:
            raise ValueError("Invalid track name.")
        os.makedirs(out_dir, exist_ok=True)

        # Re-saving replaces the previous numbered set for this track name
        # rather than accumulating stale files alongside new ones.
        for existing in os.listdir(out_dir):
            if existing.startswith(f"{track_name}_seg") or existing == "manifest.json":
                try:
                    os.remove(os.path.join(out_dir, existing))
                except OSError:
                    pass

        n = len(boundaries) - 1
        out_names = [f"{track_name}_seg{i + 1:03d}{ext}" for i in range(n)]
        out_paths = [os.path.join(out_dir, name) for name in out_names]
        cut_info = dsp.cut_segments(src_path, boundaries, out_paths, ext)

        segments = []
        subfolder = f"audio_oasis/{track_name}"
        for i, (name, cinfo) in enumerate(zip(out_names, cut_info)):
            entry = {
                "index": i + 1,
                "filename": name,
                "subfolder": subfolder,
                "qualified": f"{subfolder}/{name}",
                "start": round(cinfo["start"], 4),
                "end": round(cinfo["end"], 4),
                "duration": round(cinfo["duration"], 4),
            }
            # Frame accounting for LTX: clip length must be 8n+1. Recorded
            # here so the manifest is usable without re-deriving it from
            # float times, where rounding could flip a length by one frame.
            if fps:
                start_f = int(round(cinfo["start"] * fps))
                end_f = int(round(cinfo["end"] * fps))
                frames = end_f - start_f
                entry.update({
                    "fps": fps,
                    "start_frame": start_f,
                    "end_frame": end_f,
                    "frames": frames,
                    "ltx_8n1": frames > 0 and frames % 8 == 1,
                    "h3_17k5": frames >= 5 and (frames - 5) % 17 == 0,
                })
            segments.append(entry)

        manifest = {
            "track_name": track_name,
            "source_filename": filename,
            "fps": fps,
            "snap": snap,
            "saved_at": time.time(),
            "segments": segments,
        }
        with open(os.path.join(out_dir, "manifest.json"), "w") as f:
            json.dump(manifest, f, indent=2)

        return segments

    try:
        segments = await _run_blocking(_do_save)
        return web.json_response({"track_name": track_name, "segments": segments})
    except Exception as e:
        log.exception("AudioOasis: save_segments failed")
        return web.json_response({"error": f"Save failed: {e}"}, status=500)
