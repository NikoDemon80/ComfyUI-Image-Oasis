"""
Backend HTTP route for Image Oasis dropdowns.

Mirrors the /control_architect/models route: returns categorized file lists so
the JS widget can repopulate the model_file dropdown reactively when the user
changes source_type. Source-type -> category mapping (matching Control
Architect exactly):

    checkpoint -> checkpoints folder
    diffusion  -> (unet + diffusion_models), files NOT ending .gguf
    gguf       -> (unet + diffusion_models), files ending .gguf

The diffusion/gguf split is by file extension across both folders, not by
folder, because the ecosystem places these inconsistently between unet/ and
diffusion_models/ and the .gguf extension is the reliable discriminator.

Standalone: the small folder-scan / cache / off-thread helpers are vendored
here rather than imported from the Architect suite.
"""

import os
import sys
import time
import asyncio

import folder_paths
from server import PromptServer
from aiohttp import web


# ── Vendored helpers (from architect_shared) ──────────────────────────────────

_TTL_CACHE = {}


def _ttl_cached(key, ttl_s, builder):
    item = _TTL_CACHE.get(key)
    if item and time.time() < item[0]:
        return item[1]
    value = builder()
    _TTL_CACHE[key] = (time.time() + float(ttl_s), value)
    return value


async def _run_blocking(builder):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, builder)


def _list_folder(*folder_names):
    """Deduped union of files across multiple ComfyUI folder types."""
    seen, files = set(), []
    for name in folder_names:
        try:
            dirs = folder_paths.get_folder_paths(name)
        except Exception:
            continue
        for base in dirs:
            if not os.path.isdir(base):
                continue
            for root, _, fnames in os.walk(base):
                for f in fnames:
                    rel = os.path.relpath(os.path.join(root, f), base).replace("\\", "/")
                    if rel not in seen:
                        seen.add(rel)
                        files.append(rel)
    return files


# ── Route ─────────────────────────────────────────────────────────────────────

routes = PromptServer.instance.routes


@routes.get("/image_oasis/models")
async def image_oasis_models(request):
    def compute():
        try:
            ckpts = sorted(folder_paths.get_filename_list("checkpoints"))
        except Exception:
            ckpts = []
        try:
            vaes = sorted(folder_paths.get_filename_list("vae"))
        except Exception:
            vaes = []
        try:
            upscales = sorted(folder_paths.get_filename_list("upscale_models"))
        except Exception:
            upscales = []
        try:
            loras = sorted(folder_paths.get_filename_list("loras"))
        except Exception:
            loras = []

        unet = _list_folder("unet", "diffusion_models")
        te = _list_folder("text_encoders", "clip")

        # Arch definitions straight from the registry — the frontend builds
        # its dropdown and image-cond gating from these, so adding an arch is
        # a registry.py-only change.
        try:
            reg = _get_registry()
            archs = [{
                "key": k,
                "label": v.get("label", k),
                "image_cond": bool(v.get("accepts_image_cond")),
                "clip_slots": int(v.get("clip_slots", 1)),
            } for k, v in reg.ARCH_REGISTRY.items()]
            clip_types = list(getattr(reg, "CLIP_TYPE_CHOICES", ()))
        except Exception as e:
            print(f"[Image Oasis] Could not read arch registry: {e}")
            archs = []
            clip_types = []

        return {
            "checkpoints": ckpts,
            "diffusion":   sorted(f for f in unet if not f.lower().endswith(".gguf")),
            "gguf_unet":   sorted(f for f in unet if     f.lower().endswith(".gguf")),
            "clip_std":    sorted(f for f in te   if not f.lower().endswith(".gguf")),
            "clip_gguf":   sorted(f for f in te   if     f.lower().endswith(".gguf")),
            "vaes":        vaes,
            "upscale_models": upscales,
            "loras":       loras,
            "archs":       archs,
            "clip_types":  clip_types,
        }

    data = await _run_blocking(lambda: _ttl_cached("image_oasis_models_v3", 5.0, compute))
    return web.json_response(data)


@routes.post("/image_oasis/flush_cache")
async def image_oasis_flush_cache(request):
    """Drop all cached models/conditioning/latents across every node instance.
    The per-instance LRU bounds growth automatically; this is the manual big
    hammer for reclaiming RAM mid-session without restarting ComfyUI."""
    nodes_mod = sys.modules.get("image_oasis_nodes")
    if nodes_mod is None or not hasattr(nodes_mod, "clear_caches"):
        return web.json_response({"error": "Node module not loaded."}, status=500)
    nodes_mod.clear_caches()
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return web.json_response({"ok": True})


# ── Presets (mirrors Control Architect's preset routes/storage) ───────────────

import json as _pjson
import uuid as _uuid
import tempfile
from datetime import datetime

_OASIS_DIR = os.path.join(folder_paths.base_path, "user", "image_oasis")
_PRESETS_FILE = os.path.join(_OASIS_DIR, "presets.json")
os.makedirs(_OASIS_DIR, exist_ok=True)


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
        print(f"[Image Oasis] Failed to write {os.path.basename(path)}: {e}")
        return False


def _get_registry():
    """Return the registry module, reusing nodes_image.py's sibling-module namespace
    (image_oasis_registry) when it's already loaded — same file either way.
    Lets the /models route serve arch definitions straight from the registry
    so the frontend has no hand-synced mirror to drift."""
    key = "image_oasis_registry"
    if key in sys.modules:
        return sys.modules[key]
    import importlib.util
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "registry.py")
    spec = importlib.util.spec_from_file_location(key, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


def _resolve_under(base, *parts):
    """Join `parts` onto `base` and resolve; None unless the result stays
    inside `base`. Blocks both `..` traversal and absolute-path components
    (os.path.join discards everything before an absolute segment)."""
    resolved = os.path.realpath(os.path.join(base, *parts))
    root = os.path.realpath(base)
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    return resolved


def _load_presets():
    return _read_json(_PRESETS_FILE, [])


def _save_presets(p):
    return _atomic_write_json(_PRESETS_FILE, p)


@routes.get("/image_oasis/presets")
async def image_oasis_get_presets(request):
    return web.json_response(_load_presets())


@routes.post("/image_oasis/save_preset")
async def image_oasis_save_preset(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    name = (data.get("name", "Untitled") or "Untitled").strip() or "Untitled"
    cfg = data.get("config", {})
    presets = _load_presets()
    idx = next((i for i, p in enumerate(presets) if p.get("name") == name), None)
    entry = {
        "id": presets[idx]["id"] if idx is not None else str(_uuid.uuid4()),
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


@routes.delete("/image_oasis/presets/{preset_id}")
async def image_oasis_delete_preset(request):
    pid = request.match_info["preset_id"]
    _save_presets([p for p in _load_presets() if p.get("id") != pid])
    return web.json_response({"ok": True})


@routes.post("/image_oasis/reorder_presets")
async def image_oasis_reorder_presets(request):
    """Rewrite presets.json in the order specified by `ids` in the request body.
    Any presets on disk not present in `ids` are appended at the end (defensive
    — shouldn't happen in practice, but means a stale frontend can't drop a
    preset on the floor by omitting its id)."""
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    ids = data.get("ids") or []
    presets = _load_presets()
    by_id = {p.get("id"): p for p in presets}
    seen = set()
    reordered = []
    for i in ids:
        if i in by_id and i not in seen:
            reordered.append(by_id[i])
            seen.add(i)
    for p in presets:
        if p.get("id") not in seen:
            reordered.append(p)
    _save_presets(reordered)
    return web.json_response({"ok": True})


# ── Global theme (one palette shared by every Image Oasis node) ───────────────
#
# Unlike presets (a list of named configs), the theme is a single dict of CSS
# variable overrides stored globally. It is intentionally NOT part of any
# workflow / node blob: it's a per-install appearance preference, so it lives in
# the same user/image_oasis dir as presets and applies to every node at once.

_THEME_FILE = os.path.join(_OASIS_DIR, "theme.json")


@routes.get("/image_oasis/theme")
async def image_oasis_get_theme(request):
    # {} means "no override saved" — the JS falls back to the CSS defaults.
    return web.json_response(_read_json(_THEME_FILE, {}))


@routes.post("/image_oasis/theme")
async def image_oasis_save_theme(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    # Persist only a known set of variable keys, each a string, so a malformed
    # or oversized payload can't write junk into the theme file. An empty dict
    # is valid and means "reset to defaults".
    allowed = {"--io-accent", "--io-accent-dim", "--io-bg",
               "--io-bg2", "--io-bd", "--io-dim"}
    clean = {k: str(v)[:32] for k, v in (data or {}).items()
             if k in allowed and isinstance(v, str)}
    if not _atomic_write_json(_THEME_FILE, clean):
        return web.json_response({"error": "Could not write theme.json."}, status=500)
    return web.json_response({"ok": True, "theme": clean})


# ── Named theme library ──────────────────────────────────────────────────────
#
# Separate from the single-active /image_oasis/theme (which holds the currently
# applied palette). This is a LIST of named palettes the user can switch
# between from the Theme section. Storage is parallel to presets (themes.json
# beside presets.json) and the route names use the plural to disambiguate.
# Loading a named theme writes its colors into theme.json so the choice
# survives restarts.

_THEMES_FILE = os.path.join(_OASIS_DIR, "themes.json")
_THEME_VAR_KEYS = {"--io-accent", "--io-accent-dim", "--io-bg",
                   "--io-bg2", "--io-bd", "--io-dim"}


def _load_named_themes():
    return _read_json(_THEMES_FILE, [])


def _save_named_themes(t):
    return _atomic_write_json(_THEMES_FILE, t)


@routes.get("/image_oasis/themes")
async def image_oasis_get_named_themes(request):
    return web.json_response(_load_named_themes())


@routes.post("/image_oasis/save_named_theme")
async def image_oasis_save_named_theme(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    name = (data.get("name", "") or "").strip()[:60]
    if not name:
        return web.json_response({"error": "Name required."}, status=400)
    colors = data.get("colors") or {}
    clean = {k: str(v)[:32] for k, v in colors.items()
             if k in _THEME_VAR_KEYS and isinstance(v, str)}
    themes = _load_named_themes()
    # Match by name (case-sensitive); overwrite preserves the existing id so
    # any front-end "loaded" reference remains stable across rename-overwrite.
    idx = next((i for i, t in enumerate(themes) if t.get("name") == name), None)
    entry = {
        "id": themes[idx]["id"] if idx is not None else str(_uuid.uuid4()),
        "name": name,
        "timestamp": datetime.now().isoformat(),
        "colors": clean,
    }
    if idx is not None:
        themes[idx] = entry
    else:
        themes.insert(0, entry)
    if not _save_named_themes(themes):
        return web.json_response({"error": "Could not write themes.json."}, status=500)
    return web.json_response({"ok": True, "id": entry["id"]})


@routes.delete("/image_oasis/themes/{theme_id}")
async def image_oasis_delete_named_theme(request):
    tid = request.match_info["theme_id"]
    _save_named_themes([t for t in _load_named_themes() if t.get("id") != tid])
    return web.json_response({"ok": True})


# ── Checkpoint bundle / VAE detection (vendored from architect_shared) ─────────

import struct as _struct

_BUNDLE_CACHE_FILE = os.path.join(_OASIS_DIR, "bundle_cache.json")


def _peek_safetensors_keys(path, max_header_bytes=100 * 1024 * 1024):
    """Read safetensors header keys without loading tensors. Empty set on failure."""
    try:
        with open(path, "rb") as f:
            n = _struct.unpack("<Q", f.read(8))[0]
            if n > max_header_bytes:
                return set()
            return set(_pjson.loads(f.read(n).decode("utf-8", errors="replace")).keys())
    except Exception:
        return set()


def _check_checkpoint_bundles(filename):
    """Detect whether a checkpoint bundles CLIP and/or VAE by peeking header keys."""
    ext = os.path.splitext(filename)[1].lower()
    if ext in (".ckpt", ".pt", ".pth"):
        return {"has_clip": True, "has_vae": True}
    full_path = folder_paths.get_full_path("checkpoints", filename)
    if not full_path or not os.path.exists(full_path):
        return {"has_clip": False, "has_vae": False}

    cache = _read_json(_BUNDLE_CACHE_FILE, {})
    cache_key = f"v2::{filename}::{os.path.getmtime(full_path)}"
    if cache_key in cache:
        return cache[cache_key]

    keys = _peek_safetensors_keys(full_path)
    has_clip = any(k.startswith(p) for k in keys for p in (
        "cond_stage_model.", "conditioner.embedders.", "text_encoders.", "text_model.", "clip."))
    has_vae = any(k.startswith(p) for k in keys for p in (
        "first_stage_model.", "vae.", "decoder."))
    result = {"has_clip": has_clip, "has_vae": has_vae}

    if len(cache) > 500:
        cache = dict(list(cache.items())[-400:])
    cache[cache_key] = result
    _atomic_write_json(_BUNDLE_CACHE_FILE, cache)
    return result


@routes.post("/image_oasis/check_bundle")
async def image_oasis_check_bundle(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    fn = data.get("filename", "")
    if not fn:
        return web.json_response({"has_clip": False, "has_vae": False})
    result = await _run_blocking(lambda: _check_checkpoint_bundles(fn))
    return web.json_response(result)


# ── In-node help content (item 2) ────────────────────────────────────────────
#
# Serves image_oasis_help_content.md from the package directory as raw markdown. The JS
# fetches once on node setup and renders inline via a tiny markdown parser.
# Layman-style content authored separately from the README so the in-node tone
# can be friendlier than the GitHub readme.

_HELP_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "image_oasis_help_content.md")


@routes.get("/image_oasis/input_info")
async def image_oasis_input_info(request):
    """Resolution + file size for an image in ComfyUI's input folder. Powers
    the info line under each reference slot's upload button. PIL reads only
    the header (no pixel decode), so this is effectively free even for large
    files. Missing/invalid names 404 and the UI simply omits the line."""
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


# ── Output image listing (history-bar "+" picker) ───────────────────────────

_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff")
_LIST_CAP = 500


def _walk_output_images():
    out_root = folder_paths.get_output_directory()
    if not os.path.isdir(out_root):
        return []
    results = []
    for dirpath, _, filenames in os.walk(out_root):
        for name in filenames:
            if not name.lower().endswith(_IMAGE_EXTS):
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


@routes.get("/image_oasis/list_output_images")
async def image_oasis_list_output_images(request):
    try:
        return web.json_response(await _run_blocking(_walk_output_images))
    except Exception as e:
        return web.json_response({"error": f"List failed: {e}"}, status=500)


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
    headers = {"User-Agent": "image-oasis/1.0"}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
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
    digest = await _run_blocking(lambda: _sha256_file(path))
    url = await _civitai_model_url_for_hash(digest)
    if not url:
        raise LookupError("No CivitAI page for this file hash.")
    return {"url": url, "sha256": digest}


@routes.get("/image_oasis/civitai_lora")
async def image_oasis_civitai_lora(request):
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


@routes.get("/image_oasis/help")
async def image_oasis_get_help(request):
    try:
        with open(_HELP_FILE, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        text = "# Help unavailable\n\nCouldn't read `image_oasis_help_content.md` from the package directory."
    return web.Response(text=text, content_type="text/markdown", charset="utf-8")



# ── Save generated image temp -> output folder (mirrors Preview Architect) ────

from PIL import Image as _PILImage
from PIL.PngImagePlugin import PngInfo as _PngInfo


@routes.post("/image_oasis/save")
async def image_oasis_save(request):
    try:
        data = await request.json()
        images_to_save = data.get("images", [])
        filename_prefix = data.get("filename_prefix", "ImageOasis")
        output_dir = folder_paths.get_output_directory()
        temp_dir = folder_paths.get_temp_directory()
        os.makedirs(output_dir, exist_ok=True)
        full_out, base_filename, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, output_dir)

        saved = []
        for img_info in images_to_save:
            src_filename = img_info.get("filename", "")
            src_subfolder = img_info.get("subfolder", "")
            src_type = (img_info.get("type") or "temp").strip().lower()
            # Containment check: filename/subfolder come from the client, and
            # this server has no auth — without it, `..` or an absolute path
            # could copy ANY readable image on disk into the output folder.
            # type=output allows "save another copy" of a history entry that
            # already lives under output/.
            src_root = output_dir if src_type == "output" else temp_dir
            src_path = _resolve_under(src_root, src_subfolder, src_filename)
            if not src_path or not os.path.isfile(src_path):
                continue
            out_filename = f"{base_filename}_{counter:05}_.png"
            out_path = os.path.join(full_out, out_filename)
            # Close the handle promptly — Windows keeps the temp file locked
            # while a PIL Image holds it open.
            with _PILImage.open(src_path) as img:
                pnginfo = img.info if hasattr(img, "info") else {}
                metadata = None
                if pnginfo:
                    metadata = _PngInfo()
                    for k, v in pnginfo.items():
                        if isinstance(v, str):
                            metadata.add_text(k, v)
                img.save(out_path, pnginfo=metadata, compress_level=4)
            size_kb = round(os.path.getsize(out_path) / 1024)
            saved.append({"filename": out_filename, "subfolder": subfolder, "type": "output", "size_kb": size_kb})
            counter += 1
        return web.json_response({"saved": saved})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
