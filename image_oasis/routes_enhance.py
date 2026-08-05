"""
Image Oasis — "magic wand" prompt enhancer (backend route).

A self-contained, out-of-band prompt enhancer. It is NOT part of the generation
pipeline: the JS wand button POSTs the current user prompt + a style toggle here,
this route loads a local GGUF LLM, expands the prompt, and returns the text. The
LLM stays loaded between clicks; the diffusion generation pipeline calls
`unload_enhancer()` at the top of stage_load so the LLM never competes with the
diffusion model during sampling.

Implements:
  - profile-based cleanup (auto-resolves from model filename → regex rules)
  - two system prompts (Natural Language / Tags)
  - llama-cpp-python load + chat-completion call (single message pair, no
    [OUTPUT] wrapping, no think suppression — those are the model's job via the
    system prompt)
  - auto GPU-layer sizing from the GGUF header + live free VRAM
  - a *targeted* VRAM free (comfy free_memory) that preserves Image Oasis's
    own load cache when there is already room, rather than a blanket unload
  - OOM-on-load -> CPU retry fallback
"""

import os
import re
import gc
import json
import struct
import random
import threading

import folder_paths
from server import PromptServer
from aiohttp import web


# ── Model directory: models/LLM only, gguf + safetensors listed ───────────────

def _llm_dir():
    comfy_dir = os.path.dirname(folder_paths.__file__)
    d = os.path.join(comfy_dir, "models", "LLM")
    os.makedirs(d, exist_ok=True)
    return d


def _list_llm_models():
    """List .gguf and .safetensors under models/LLM (recursively). Safetensors
    are listed so power users see them, but the loader below only handles GGUF."""
    base = _llm_dir()
    out = []
    for root, _, files in os.walk(base):
        for f in files:
            if f.lower().endswith((".gguf", ".safetensors")):
                rel = os.path.relpath(os.path.join(root, f), base).replace("\\", "/")
                out.append(rel)
    return sorted(out)


# ── Minimal GGUF header reader (layer count + architecture) ───────────────────
#
# We don't need a full parser. We read the KV block and skip each value by its
# type, capturing only general.architecture and {arch}.block_count. All fields
# little-endian per the GGUF spec.

_GGUF_MAGIC = 0x46554747  # "GGUF" little-endian

# value type -> fixed byte width (scalars only); strings/arrays handled specially
_GGUF_SCALAR_WIDTH = {
    0: 1, 1: 1,      # uint8, int8
    2: 2, 3: 2,      # uint16, int16
    4: 4, 5: 4,      # uint32, int32
    6: 4,            # float32
    7: 1,            # bool
    10: 8, 11: 8,    # uint64, int64
    12: 8,           # float64
}
_GGUF_TYPE_STRING = 8
_GGUF_TYPE_ARRAY = 9


def _read_gguf_meta(path, max_bytes=8 * 1024 * 1024):
    """Return {'architecture': str|None, 'block_count': int|None} or {} on failure.

    Reads only the metadata KV block (capped), skipping values by type. Tolerant:
    any malformed/short read returns what was found so far.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(4 + 4 + 8 + 8)  # magic, version, tensor_count, kv_count
            if len(head) < 24:
                return {}
            magic, version, _n_tensors, n_kv = struct.unpack("<IIQQ", head)
            if magic != _GGUF_MAGIC:
                return {}
            # version 2/3 use 64-bit counts (handled above). Bail on anything wild.
            if n_kv > 100000:
                return {}

            blob = f.read(max_bytes)  # metadata lives near the front; cap the read
    except Exception:
        return {}

    pos = 0
    n = len(blob)
    found = {"architecture": None, "block_count": None}

    def _u(fmt, width):
        nonlocal pos
        if pos + width > n:
            raise EOFError
        v = struct.unpack_from(fmt, blob, pos)[0]
        pos += width
        return v

    def _read_str():
        nonlocal pos
        ln = _u("<Q", 8)
        if pos + ln > n:
            raise EOFError
        s = blob[pos:pos + ln].decode("utf-8", errors="replace")
        pos += ln
        return s

    def _skip_value(vtype):
        nonlocal pos
        if vtype in _GGUF_SCALAR_WIDTH:
            pos += _GGUF_SCALAR_WIDTH[vtype]
        elif vtype == _GGUF_TYPE_STRING:
            ln = _u("<Q", 8)
            pos += ln
        elif vtype == _GGUF_TYPE_ARRAY:
            elem_type = _u("<I", 4)
            count = _u("<Q", 8)
            if elem_type == _GGUF_TYPE_STRING:
                for _ in range(count):
                    ln = _u("<Q", 8)
                    pos += ln
            elif elem_type in _GGUF_SCALAR_WIDTH:
                pos += _GGUF_SCALAR_WIDTH[elem_type] * count
            else:
                raise ValueError("nested/unknown array element type")
        else:
            raise ValueError(f"unknown gguf value type {vtype}")

    def _read_scalar_value(vtype):
        # Only called for keys we care about; returns python value for ints/strings.
        if vtype == _GGUF_TYPE_STRING:
            return _read_str()
        fmt = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i",
               6: "<f", 7: "<B", 10: "<Q", 11: "<q", 12: "<d"}.get(vtype)
        if fmt is None:
            raise ValueError("non-scalar where scalar expected")
        return _u(fmt, _GGUF_SCALAR_WIDTH[vtype])

    try:
        arch = None
        # First pass: we need architecture to know the block_count key name, but
        # general.architecture may appear after some keys. So capture both by name:
        # match "general.architecture" and any key ending ".block_count".
        for _ in range(n_kv):
            key = _read_str()
            vtype = _u("<I", 4)
            if key == "general.architecture" and vtype == _GGUF_TYPE_STRING:
                arch = _read_scalar_value(vtype)
                found["architecture"] = arch
            elif key.endswith(".block_count") and vtype in _GGUF_SCALAR_WIDTH:
                found["block_count"] = int(_read_scalar_value(vtype))
            else:
                _skip_value(vtype)
            if found["architecture"] and found["block_count"] is not None:
                break
    except Exception:
        # Return whatever we managed to capture; caller treats None as "unknown".
        pass

    return found


# ── Auto GPU-layer sizing ─────────────────────────────────────────────────────

def _free_vram_bytes(device=None):
    """Free VRAM in bytes, or None if CUDA/torch unavailable."""
    try:
        import torch
        if not torch.cuda.is_available():
            return None
        free, _total = torch.cuda.mem_get_info(device) if device is not None \
            else torch.cuda.mem_get_info()
        return int(free)
    except Exception:
        return None


def _targeted_vram_free(estimate_bytes):
    """Ask ComfyUI to free *just enough* VRAM for the LLM, evicting as little as
    possible. Preserves Image Oasis's load cache when there is already room.
    Best-effort: silently does nothing if comfy's API isn't shaped as expected."""
    try:
        import comfy.model_management as mm
        device = mm.get_torch_device()
        # free_memory evicts loaded models until `estimate_bytes` is free (or all
        # are evicted). It will free nothing if there's already room.
        mm.free_memory(estimate_bytes, device)
        return device
    except Exception:
        return None


def _recommend_gpu_layers(model_path, reserve_factor=0.95):
    """Recommend n_gpu_layers using the formula:
        recommended = floor(n_layers * reserve_factor * free_vram / file_size)
        round down to even
        if recommended >= n_layers: return -1 (all on GPU)

    Returns a dict {"total": n_layers, "layers": int, "all": bool}. The "layers"
    field is -1 when the whole model fits (llama.cpp's convention for "all"),
    0 when CUDA is unavailable or layer count can't be read.

    Pure read: GGUF header + free VRAM as-is, NO eviction side effect. The
    old behavior (targeted free before measuring) meant every recommendation
    fetch — including the passive one on node add / tab switch — evicted the
    diffusion model from VRAM and forced a full reload on the next generation.
    Eviction now happens exactly once, inside the enhance route, when the user
    actually clicks Enhance. Auto mode re-runs this math there, post-eviction,
    so the layers actually loaded reflect the real free room.
    """
    try:
        file_size = os.path.getsize(model_path)
    except Exception:
        return {"total": 0, "layers": 0, "all": False}

    meta = _read_gguf_meta(model_path)
    n_layers = meta.get("block_count") or 0

    free = _free_vram_bytes()
    if free is None:
        # No CUDA -> CPU-only is the only safe answer.
        return {"total": n_layers, "layers": 0, "all": False}

    if not n_layers or n_layers <= 0:
        # Unknown layer count: can't compute a partial split. Trust llama.cpp's
        # -1 "all" path with OOM->CPU fallback at load time.
        return {"total": 0, "layers": -1, "all": True}

    usable = free * reserve_factor
    recommended = int(n_layers * usable / file_size)

    if recommended >= n_layers:
        return {"total": n_layers, "layers": -1, "all": True}

    # Round down to even (Jason's hand-tuned heuristic — odd splits seem to
    # have worse latency on some quants).
    if recommended % 2 == 1:
        recommended -= 1
    recommended = max(0, recommended)
    return {"total": n_layers, "layers": recommended, "all": False}


# ── Cleanup profiles ──────────────────────────────────────────────────────────
#
# Auto-resolve only: the first profile whose `match` regex hits the model
# filename wins; no match → `universal`. No UI surface, no user-selected mode.
# Profiles are read fresh per request so edits to profiles.json take effect on
# the next click (no ComfyUI restart needed for rule changes).

PROFILES_FILE = os.path.join(os.path.dirname(__file__), "profiles.json")

_FALLBACK_UNIVERSAL = [
    {"op": "regex_sub", "pattern": r"(?s)<think>.*?</think>", "replace": ""},
    {"op": "regex_sub", "pattern": r"(?s)^.*?</think>\s*",   "replace": ""},
    {"op": "regex_sub", "pattern": r"(?is)<\|begin[ _]of[ _]thinking\|>.*?<\|end[ _]of[ _]thinking\|>", "replace": ""},
    {"op": "regex_sub", "pattern": r"\[/?(?:INST|OUT)\]|<</?SYS>>", "replace": ""},
    {"op": "strip"},
]


def _load_profiles():
    try:
        with open(PROFILES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"universal": _FALLBACK_UNIVERSAL, "profiles": {}}
    except Exception as e:
        print(f"[Image Oasis] Could not load profiles.json ({e!r}); using fallback universal rules.")
        return {"universal": _FALLBACK_UNIVERSAL, "profiles": {}}


def _apply_rules(text, rules):
    out = text
    for rule in rules or []:
        op = rule.get("op")
        try:
            if op == "regex_sub":
                out = re.sub(rule["pattern"], rule.get("replace", ""), out)
            elif op == "strip":
                out = out.strip()
            elif op == "lstrip":
                out = out.lstrip()
            elif op == "rstrip":
                out = out.rstrip()
            else:
                print(f"[Image Oasis] Unknown cleanup op: {op!r}")
        except re.error as e:
            print(f"[Image Oasis] Bad regex {rule.get('pattern')!r}: {e}")
        except Exception as e:
            print(f"[Image Oasis] Rule failure {rule!r}: {e}")
    return out


def _clean(text, model_filename):
    """Auto-resolve: first profile whose `match` regex hits the filename wins;
    no match falls back to universal."""
    data = _load_profiles()
    universal_rules = data.get("universal", _FALLBACK_UNIVERSAL)
    profiles = data.get("profiles", {}) or {}
    for name, prof in profiles.items():
        pattern = prof.get("match", "")
        if not pattern:
            continue
        try:
            if re.search(pattern, model_filename):
                return _apply_rules(text, prof.get("rules", []))
        except re.error as e:
            print(f"[Image Oasis] Bad match regex in profile {name!r}: {e}")
    return _apply_rules(text, universal_rules)


# ── System prompts (managed by hand — do not edit programmatically) ───────────

_SYS_NATURAL = (
    "You enhance short prompts for AI image generation.\n"
    "You may think through the scene, plan your approach, and reason about the best description — this is encouraged.\n"
    "The final prompt must be exactly ONE paragraph. No title. No line breaks. No headers. No multiple paragraphs.\n"
    "WHAT TO DESCRIBE (choose any or all based on context)(director-style):\n"
    "- Age, subject, state of dress or undress, action/pose, setting, props, set dressing, lighting direction, time of day, colors, camera angle, and lens/depth of field; do not override the user prompt.\n"
    "- Be concrete and specific rather than vague — prefer a definite descriptor over a generic one.\n"
    "- Derive every technical and stylistic choice from the SUBJECT AND CONTEXT of the input.\n"
    "CRITICAL RULES:\n"
    "- This is a STILL IMAGE. Describe only what the eye can see in the frame.\n"
    "- NEVER describe sound, audio, noise, silence, smell, motion over time, or what happens next.\n"
    "- ONLY describe what SHOULD be in the frame. If something is not meant to appear in the image, do not mention it at all.\n"
    "- Describe the subject plainly, literally, and completely as it would actually appear.\n"
    "- Do NOT soften, euphemize, censor, or abstract any part of the subject, and do NOT add distancing language.\n"
    "- If the subject is described a certain way in the input, render that faithfully in plain terms; your job is to describe accurately, not to judge or sanitize the content.\n"
    "- Describe observable appearance and behavior, not causes or internal states.\n"
    "- Write only things that are positively present and visible; every clause should name something the camera actually sees.\n"
    "- Do NOT use metaphors, similes, or poetic language.\n"
    "- Write like a photographer describing a shot, not like a novelist.\n"
    "- End immediately after the last concrete visual detail; stop once the scene is fully described."
)

_SYS_TAGS = (
    "You enhance short prompts for AI image generation.\n"
    "You may think through the scene, plan your approach, and reason about the best description — this is encouraged.\n"
    "The final output must be exactly ONE line of comma-separated POSITIVE tags only. No title. No line breaks. No headers. No paragraphs.\n"
    "WHAT TO TAG (choose any or all based on context)(director-style):\n"
    "- Age, subject, state of dress or undress, action/pose, setting, props, set dressing, lighting direction, time of day, colors, camera angle, and lens/depth of field; do not override the user prompt.\n"
    "- Be concrete and specific rather than vague — prefer a definite descriptor over a generic one.\n"
    "- Derive every technical and stylistic choice from the SUBJECT AND CONTEXT of the input.\n"
    "CRITICAL RULES:\n"
    "- This is a STILL IMAGE. Tag only what the eye can see in the frame.\n"
    "- NEVER tag sound, audio, noise, silence, smell, motion over time, or what happens next.\n"
    "- ONLY tag what SHOULD be in the frame. If something is not meant to appear in the image, do not tag it at all.\n"
    "- Tag the subject plainly, literally, and completely as it would actually appear.\n"
    "- Do NOT soften, euphemize, censor, or abstract any part of the subject, and do NOT add distancing language.\n"
    "- If the subject is described a certain way in the input, render that faithfully in plain terms; your job is to tag accurately, not to judge or sanitize the content.\n"
    "- Tag observable appearance and behavior, not causes or internal states.\n"
    "- Tag only things that are positively present and visible; every tag should name something the camera actually sees.\n"
    "- End immediately after the last concrete visual detail; stop once the scene is fully tagged."
)

_STYLE_PROMPTS = {"natural": _SYS_NATURAL, "tags": _SYS_TAGS}

# Sampling defaults — tested across the curated model set; not user-controlled.
_TEMPERATURE = 0.6
_TOP_P = 0.9
_TOP_K = 40
_REPEAT_PENALTY = 1.1

# UI-controlled defaults (matched on the JS side; sent with every enhance call).
_DEFAULT_N_CTX = 8192
_DEFAULT_MAX_TOKENS = 2048

# Per-instance model cache so repeated clicks with the same model reuse it.
# Cache key includes path + n_gpu_layers + n_ctx — any of those changing forces
# a reload. (Auto-layers mode relaxes the n_gpu_layers match: if the same
# model+ctx is already loaded, it already fits, so reuse it rather than
# reloading because the free-VRAM math produced a slightly different split.)
# The LLM stays loaded between clicks; it's only unloaded by
# unload_enhancer() (called from nodes_image.py at the start of image generation).
_STATE = {"model": None, "path": None, "n_gpu_layers": None, "n_ctx": None}

# Serializes enhance work. The wand button guards per-node (wandBusy), but two
# open nodes clicking simultaneously would race the load/unload path — a
# double LLM load is an OOM on 8GB cards. unload_enhancer() also takes this
# lock so image generation can't rip the model out from under a mid-flight
# enhance.
_ENHANCE_LOCK = threading.Lock()


def _unload():
    if _STATE["model"] is not None:
        del _STATE["model"]
        _STATE["model"] = None
        _STATE["path"] = None
        _STATE["n_gpu_layers"] = None
        _STATE["n_ctx"] = None
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        print("[Image Oasis] Enhancer model unloaded.")


def unload_enhancer():
    """Public entry: free the cached LLM if one is loaded. Called from nodes_image.py
    at the top of image generation so the LLM never competes with the diffusion
    model for VRAM. No-op when no LLM is loaded. Takes the enhance lock so a
    generation that starts during an in-flight enhance waits for it to finish
    instead of unloading the model mid-inference."""
    with _ENHANCE_LOCK:
        if _STATE["model"] is not None:
            _unload()


def _load_llama(model_path, n_gpu_layers, n_ctx):
    from llama_cpp import Llama
    return Llama(model_path=model_path, n_gpu_layers=n_gpu_layers,
                 n_ctx=n_ctx, flash_attn=True, verbose=False)


def _generate(llm, system_prompt, user_prompt, max_tokens):
    # Clean two-message split. No IMPORTANT RULES scaffold, no [OUTPUT] wrapping,
    # no think suppression — the system prompt does all the steering. Cleanup of
    # any thinking residue (e.g. <think>...</think>) is handled by `_clean()`
    # after generation, profile-resolved from the model filename.
    seed = random.randint(0, 2**31 - 1)
    resp = llm.create_chat_completion(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt.strip()},
        ],
        temperature=_TEMPERATURE,
        top_p=_TOP_P,
        top_k=_TOP_K,
        repeat_penalty=_REPEAT_PENALTY,
        max_tokens=max_tokens,
        seed=seed,
    )
    return (resp["choices"][0].get("message", {}).get("content") or "").strip()


# ── Routes ────────────────────────────────────────────────────────────────────

routes = PromptServer.instance.routes


@routes.get("/image_oasis/llm_models")
async def image_oasis_llm_models(request):
    return web.json_response({"models": _list_llm_models()})


def _resolve_model_path(model_name):
    """Containment-check a client-supplied model name. Returns (path, error)."""
    if not model_name:
        return None, ("No LLM model selected.", 400)
    if model_name.lower().endswith(".safetensors"):
        return None, ("Full safetensors models aren't supported yet — the enhancer "
                      "loads GGUF only. Convert to GGUF or select a .gguf model.", 400)
    base = os.path.realpath(_llm_dir())
    model_path = os.path.realpath(os.path.join(base, model_name))
    if model_path != base and not model_path.startswith(base + os.sep):
        return None, (f"Invalid model path: {model_name}", 400)
    if not os.path.isfile(model_path):
        return None, (f"Model not found: {model_name}", 404)
    return model_path, None


@routes.get("/image_oasis/llm_recommended_layers")
async def image_oasis_llm_recommended(request):
    """Return a GPU-layer recommendation for the requested model based on
    current free VRAM. Pure read — no eviction — so passive fetches (model
    dropdown change, settings panel open) can't disturb loaded diffusion
    models. The number is conservative while a diffusion model occupies VRAM;
    the enhance route recomputes post-eviction and reports what it actually
    used. Runs in a thread because the GGUF header read shouldn't block the
    event loop."""
    model_name = (request.query.get("model") or "").strip()
    model_path, err = _resolve_model_path(model_name)
    if err:
        return web.json_response({"error": err[0]}, status=err[1])

    import asyncio
    loop = asyncio.get_running_loop()
    info = await loop.run_in_executor(None, _recommend_gpu_layers, model_path)
    return web.json_response(info)


@routes.post("/image_oasis/enhance")
async def image_oasis_enhance(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)

    prompt = (data.get("prompt") or "").strip()
    style = (data.get("style") or "natural").lower()
    model_name = (data.get("model") or "").strip()
    auto_layers = bool(data.get("auto_layers", False))

    # Refuse while an image is generating. Loading the LLM mid-run would fight
    # the diffusion model for VRAM (the eviction below would rip it out of
    # memory mid-sampling). The JS disables the wand during a run too, but the
    # server-side check is the authoritative one.
    try:
        running, _pending = PromptServer.instance.prompt_queue.get_current_queue()
        if running:
            return web.json_response(
                {"error": "Enhance is unavailable while an image is generating. "
                          "Wait for the run to finish and try again."}, status=409)
    except Exception:
        pass  # queue introspection failed — don't block the feature over it

    # Settings from the panel; defaults match the UI defaults so missing values
    # behave the same as a fresh load.
    try:
        n_ctx = int(data.get("n_ctx", _DEFAULT_N_CTX))
    except (TypeError, ValueError):
        n_ctx = _DEFAULT_N_CTX
    try:
        max_tokens_setting = int(data.get("max_tokens", _DEFAULT_MAX_TOKENS))
    except (TypeError, ValueError):
        max_tokens_setting = _DEFAULT_MAX_TOKENS
    try:
        n_gpu_layers = int(data.get("n_gpu_layers", -1))
    except (TypeError, ValueError):
        n_gpu_layers = -1
    # Sane floors only — no ceilings, per "users should know their system".
    n_ctx = max(512, n_ctx)
    max_tokens_setting = max(64, max_tokens_setting)
    # n_gpu_layers: -1 = all, anything >= 0 is literal. Negative values other
    # than -1 don't mean anything to llama.cpp, so coerce them.
    if n_gpu_layers < -1:
        n_gpu_layers = -1

    if not prompt:
        return web.json_response({"error": "Nothing to enhance — the prompt is empty."}, status=400)
    if style not in _STYLE_PROMPTS:
        style = "natural"

    model_path, err = _resolve_model_path(model_name)
    if err:
        return web.json_response({"error": err[0]}, status=err[1])

    # llama-cpp-python presence check (clear message).
    try:
        import llama_cpp  # noqa: F401
    except ImportError:
        return web.json_response({
            "error": "llama-cpp-python is not installed. Install with: "
                     "pip install llama-cpp-python (CUDA: "
                     "CMAKE_ARGS=\"-DGGML_CUDA=on\" pip install llama-cpp-python)."
        }, status=500)

    system_prompt = _STYLE_PROMPTS[style]
    model_basename = os.path.basename(model_path)

    def work():
        # Cache check FIRST. If the same model is already loaded with the same
        # layers + ctx, reuse — measuring VRAM with the LLM loaded would mis-size
        # any reload and partial-offload-tax every subsequent click. In auto
        # mode the layer count is not part of the match: a loaded model already
        # fits, and re-running the free-VRAM math with it resident would only
        # produce a worse split.
        layers_match = auto_layers or _STATE["n_gpu_layers"] == n_gpu_layers
        if (_STATE["model"] is not None
                and _STATE["path"] == model_path
                and layers_match
                and _STATE["n_ctx"] == n_ctx):
            llm = _STATE["model"]
            actual_layers = _STATE["n_gpu_layers"]
        else:
            # Fresh load. This is the ONE place the targeted eviction happens:
            # the user clicked Enhance, so displacing the diffusion model from
            # VRAM is now the point, not a side effect.
            try:
                file_size = os.path.getsize(model_path)
                _targeted_vram_free(int(file_size * 1.5))
            except Exception:
                pass
            _unload()
            # Auto mode sizes the GPU split AFTER the eviction, against the
            # real free VRAM. The UI's pre-eviction recommendation is
            # conservative by design; this is the accurate number.
            if auto_layers:
                rec = _recommend_gpu_layers(model_path)
                load_layers = rec.get("layers", -1)
            else:
                load_layers = n_gpu_layers
            actual_layers = load_layers
            try:
                llm = _load_llama(model_path, load_layers, n_ctx)
            except Exception as e:
                # Most likely OOM from an over-aggressive manual setting.
                # Retry on CPU so the wand never hard-crashes.
                msg = str(e)
                print(f"[Image Oasis] Enhancer GPU load failed ({msg}); retrying on CPU.")
                _unload()
                llm = _load_llama(model_path, 0, n_ctx)
                actual_layers = 0
            _STATE["model"] = llm
            _STATE["path"] = model_path
            _STATE["n_gpu_layers"] = actual_layers
            _STATE["n_ctx"] = n_ctx

        # Token budget: cap requested max_tokens against what the context window
        # can actually hold after the input. Thinking models burn most of this
        # reasoning before emitting the answer; the cleanup profile strips the
        # <think>...</think> block after.
        combined_len = len(system_prompt) + len(prompt)
        est_input_tokens = int(combined_len / 3.5)
        budget = n_ctx - est_input_tokens - 64
        max_tokens = max(64, min(budget, max_tokens_setting))
        print(f"[Image Oasis] Enhancer budget: {max_tokens} tokens "
              f"(ctx {n_ctx}, est input {est_input_tokens}, layers {actual_layers})")

        raw = _generate(llm, system_prompt, prompt, max_tokens)
        enhanced = _clean(raw, model_basename)
        return enhanced, actual_layers

    def locked_work():
        # Two nodes clicking Enhance at once must not race the load/unload
        # path (double LLM load = OOM). Second click waits its turn.
        with _ENHANCE_LOCK:
            return work()

    try:
        import asyncio
        loop = asyncio.get_running_loop()
        enhanced, actual_layers = await loop.run_in_executor(None, locked_work)
    except Exception as e:
        unload_enhancer()
        return web.json_response({"error": f"Enhancement failed: {e}"}, status=500)

    if not enhanced:
        return web.json_response({"error": "The model returned no usable text. Try again."}, status=500)

    return web.json_response({"enhanced": enhanced, "gpu_layers": actual_layers})
