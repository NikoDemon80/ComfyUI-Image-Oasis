"""Read ComfyUI prompt/workflow tags off a saved Oasis image or video.

Core Load Image / Load Video discard those tags (they only return pixels).
This node opens the file, pulls `prompt` + `workflow`, and pretty-prints the
Oasis widget blob when one is present.
"""

import json
import os

import folder_paths

_NONE = "(none)"
_IMAGE_EXT = {".png", ".webp", ".jpg", ".jpeg"}
_VIDEO_EXT = {".mp4", ".webm", ".mkv", ".mov"}
_WIDGET = {
    "ImageOasis": "image_oasis_ui",
    "LTX23Oasis": "ltx23_oasis_ui",
    "VideoOasisPreview": "video_oasis_ui",
}


def _list_dir_files(root, rel_prefix, exts):
    try:
        names = os.listdir(root)
    except OSError:
        return []
    out = []
    for name in names:
        path = os.path.join(root, name)
        if not os.path.isfile(path):
            continue
        if os.path.splitext(name)[1].lower() not in exts:
            continue
        rel = f"{rel_prefix}{name}" if rel_prefix else name
        out.append(rel.replace("\\", "/"))
    return out


def _choices(exts, extra_output_subdir=None):
    input_dir = folder_paths.get_input_directory()
    output_dir = folder_paths.get_output_directory()
    choices = list(_list_dir_files(input_dir, "", exts))
    for rel in _list_dir_files(output_dir, "", exts):
        choices.append(f"{rel} [output]")
    if extra_output_subdir:
        sub = os.path.join(output_dir, extra_output_subdir)
        prefix = extra_output_subdir.replace("\\", "/").strip("/") + "/"
        for rel in _list_dir_files(sub, prefix, exts):
            choices.append(f"{rel} [output]")
    seen, ordered = set(), []
    for c in sorted(choices, key=str.lower):
        if c not in seen:
            seen.add(c)
            ordered.append(c)
    return ordered


def _picked(*values):
    picks = [v for v in values if v and v != _NONE]
    if not picks:
        return None
    if len(picks) > 1:
        raise ValueError("Pick Image or File, not both.")
    return picks[0]


def _load_json_field(value):
    """Crystools-style: json.loads prompt/workflow strings, including double-encoding."""
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, bytes):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if s.startswith("Prompt:"):
        s = s[7:].strip()
    elif s.startswith("Workflow:"):
        s = s[9:].strip()
    parsed = s
    for _ in range(2):
        if not isinstance(parsed, str):
            return parsed
        try:
            parsed = json.loads(parsed)
        except Exception:
            return parsed if parsed != s else (s if s[:1] in "{[" else s)
    return parsed


def _as_data(value):
    parsed = _load_json_field(value)
    if parsed is not None:
        return parsed
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _keep_better(old, new):
    if old is None:
        return new
    if isinstance(new, dict) and not isinstance(old, dict):
        return new
    if isinstance(old, dict) and not isinstance(new, dict):
        return old
    if isinstance(old, (dict, list)) and isinstance(new, (dict, list)):
        return new if len(json.dumps(new)) > len(json.dumps(old)) else old
    if isinstance(old, str) and isinstance(new, str):
        return new if len(new) > len(old) else old
    return new


def _read_png_tags(path):
    from PIL import Image
    tags = {}
    with Image.open(path) as img:
        info = img.info or {}
    for k, v in info.items():
        key = str(k)
        if key in ("prompt", "workflow"):
            parsed = _load_json_field(v)
            if parsed is not None:
                tags[key] = parsed
            continue
        parsed = _as_data(v)
        if parsed is not None:
            tags[key] = parsed
    return tags


def _read_video_tags(path):
    import av
    tags = {}
    with av.open(path) as container:
        sources = [container.metadata]
        for stream in container.streams:
            sources.append(stream.metadata)
        for meta in sources:
            if not meta:
                continue
            for k, v in meta.items():
                key = str(k)
                leaf = key.split(".")[-1] if "." in key else key
                parsed = _load_json_field(v) if leaf in ("prompt", "workflow") else _as_data(v)
                if parsed is None:
                    continue
                tags[key] = _keep_better(tags.get(key), parsed)
                tags[leaf] = _keep_better(tags.get(leaf), parsed)
    return tags


def _read_tags(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in _IMAGE_EXT:
        return _read_png_tags(path)
    if ext in _VIDEO_EXT:
        return _read_video_tags(path)
    raise ValueError(f"Unsupported file type: {ext}")


def _exec_blob(raw):
    data = _as_data(raw)
    if not isinstance(data, dict):
        return {}
    for key in ("execState", "exec"):
        ex = data.get(key)
        if isinstance(ex, dict):
            return ex
    return data


def _oasis_from_prompt(prompt):
    if not isinstance(prompt, dict):
        return []
    found = []
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        widget = _WIDGET.get(ct)
        if not widget:
            continue
        raw = (node.get("inputs") or {}).get(widget)
        found.append((ct, _exec_blob(raw)))
    return found


def _oasis_from_workflow(workflow):
    if not isinstance(workflow, dict):
        return []
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return []
    found = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        ct = node.get("type") or node.get("class_type")
        widget = _WIDGET.get(ct)
        if not widget:
            continue
        raw = None
        wv = node.get("widgets_values")
        if isinstance(wv, list) and wv:
            raw = wv[0]
        if raw is None:
            raw = (node.get("inputs") or {}).get(widget)
        found.append((ct, _exec_blob(raw)))
    return found


def _add(lines, label, value, skip_empty=True):
    if value is None:
        return
    if isinstance(value, str):
        value = value.strip()
        if skip_empty and not value:
            return
    elif skip_empty and value in ("", [], {}, False):
        return
    lines.append(f"{label}: {value}")


def _fmt_loras(loras):
    if not isinstance(loras, list) or not loras:
        return ""
    parts = []
    for item in loras:
        if not isinstance(item, dict):
            continue
        if item.get("enabled") is False:
            continue
        name = (item.get("name") or "").strip()
        if not name or name == "(none)":
            continue
        sm = item.get("strength_model", 1.0)
        sc = item.get("strength_clip", item.get("strength_model", 1.0))
        parts.append(f"{name} (model {sm}, clip {sc})")
    return "; ".join(parts)


def _fmt_image(ex):
    lines = ["Image Oasis"]
    _add(lines, "Prompt", ex.get("positive"))
    _add(lines, "Negative", ex.get("negative"))
    _add(lines, "Architecture", ex.get("architecture"))
    _add(lines, "Source", ex.get("source_type"))
    _add(lines, "Model", ex.get("model_file"))
    clips = [ex.get("clip_file"), ex.get("clip_file_2"), ex.get("clip_file_3")]
    clips = [c for c in clips if c]
    if clips:
        _add(lines, "CLIP", ", ".join(str(c) for c in clips))
    if not ex.get("vae_bundled"):
        _add(lines, "VAE", ex.get("vae_file"))
    _add(lines, "Size", f"{ex.get('width')}x{ex.get('height')}")
    _add(lines, "Batch", ex.get("batch_size"), skip_empty=False)
    _add(lines, "Seed", ex.get("seed"), skip_empty=False)
    _add(lines, "Seed control", ex.get("seed_control"))
    _add(lines, "Steps", ex.get("steps"))
    _add(lines, "CFG", ex.get("cfg"))
    samp = ex.get("sampler_name")
    sched = ex.get("scheduler")
    if samp and sched:
        _add(lines, "Sampler", f"{samp} / {sched}")
    else:
        _add(lines, "Sampler", samp or sched)
    _add(lines, "Denoise", ex.get("denoise"))
    if float(ex.get("variety") or 0) > 0:
        _add(lines, "Variety", ex.get("variety"))
    _add(lines, "LoRAs", _fmt_loras(ex.get("loras")))
    if ex.get("enable_refiner"):
        _add(lines, "Refiner",
             f"steps {ex.get('refiner_steps')}, cfg {ex.get('refiner_cfg')}, "
             f"denoise {ex.get('refiner_denoise')}")
    if ex.get("enable_upscale"):
        _add(lines, "Upscale",
             f"{ex.get('upscale_mode')} {ex.get('upscale_multiplier')}x "
             f"{ex.get('upscale_method') or ex.get('upscale_model_file') or ''}".strip())
    _add(lines, "Init", ex.get("init_image"))
    refs = [ex.get("ref_image1"), ex.get("ref_image2"), ex.get("ref_image3")]
    refs = [r for r in refs if r]
    if refs:
        _add(lines, "Refs", ", ".join(str(r) for r in refs))
    return lines


def _fmt_ltx(ex):
    lines = ["LTX Oasis"]
    _add(lines, "Prompt", ex.get("positive") or ex.get("user_prompt"))
    if ex.get("user_prompt") and ex.get("positive") and ex.get("user_prompt") != ex.get("positive"):
        _add(lines, "User prompt", ex.get("user_prompt"))
    _add(lines, "Negative", ex.get("negative"))
    _add(lines, "Architecture", ex.get("architecture"))
    _add(lines, "Mode", ex.get("mode"))
    _add(lines, "Source", ex.get("source_type"))
    _add(lines, "Model", ex.get("model_file"))
    clips = [ex.get("clip_file"), ex.get("clip_file_2")]
    clips = [c for c in clips if c]
    if clips:
        _add(lines, "CLIP", ", ".join(str(c) for c in clips))
    _add(lines, "VAE", ex.get("vae_file"))
    _add(lines, "Size", f"{ex.get('width')}x{ex.get('height')}")
    _add(lines, "Frames", ex.get("frames"))
    _add(lines, "FPS", ex.get("fps"))
    _add(lines, "Seed", ex.get("seed"), skip_empty=False)
    _add(lines, "CFG", ex.get("cfg"))
    _add(lines, "Sampler", ex.get("sampler_name"))
    _add(lines, "Sigmas", ex.get("sigmas"))
    _add(lines, "LoRAs", _fmt_loras(ex.get("loras")))
    _add(lines, "Audio", ex.get("audio_mode"))
    _add(lines, "Audio file", ex.get("audio_file"))
    _add(lines, "Start frame", ex.get("start_image"))
    beats = ex.get("relay_segments") or []
    if isinstance(beats, list) and beats:
        _add(lines, "Prompt beats", f"{len(beats)} segments")
    if ex.get("sage") is False:
        _add(lines, "Sage attention", "off")
    if ex.get("continue_last"):
        _add(lines, "Continue", f"context {ex.get('context_frames', 0)} frames")
    if ex.get("enable_upscale"):
        _add(lines, "Latent upscale", ex.get("upscale_upsampler") or "on")
    if ex.get("enable_vsr"):
        _add(lines, "RTX VSR",
             f"{ex.get('vsr_resize_type')} {ex.get('vsr_scale')}x "
             f"{ex.get('vsr_quality')}")
    enc = []
    if ex.get("format"):
        enc.append(str(ex.get("format")))
    if ex.get("codec"):
        enc.append(str(ex.get("codec")))
    if ex.get("quality"):
        enc.append(str(ex.get("quality")))
    if enc:
        _add(lines, "Encode", " / ".join(enc))
    return lines


def _fmt_viewer(ex):
    lines = ["Video Oasis Viewer"]
    _add(lines, "Format", ex.get("format"))
    _add(lines, "Codec", ex.get("codec"))
    _add(lines, "Quality", ex.get("quality"))
    if str(ex.get("quality")) == "custom":
        _add(lines, "CRF", ex.get("crf"), skip_empty=False)
    _add(lines, "Save prefix", ex.get("save_prefix"))
    return lines


_TEXT_KEYS = (
    "text", "t5xxl", "clip_l", "clip_g", "positive", "prompt",
    "string", "string_a", "string_b", "value", "user_prompt",
)
_SKIP_KEYS = {
    "clip", "vae", "model", "latent", "image", "pixels", "samples",
    "noise_mask", "audio", "video", "mask", "control_net", "conditioning",
    "ckpt_name", "unet_name", "vae_name", "lora_name", "sampler_name",
    "scheduler", "filename", "file", "image_upload",
}


def _positive_from_exec(ct, ex):
    if ct == "ImageOasis":
        return (ex.get("positive") or "").strip()
    if ct == "LTX23Oasis":
        return (ex.get("positive") or ex.get("user_prompt") or "").strip()
    return ""


def _is_link(value):
    return (isinstance(value, (list, tuple)) and len(value) == 2
            and isinstance(value[0], (str, int)) and isinstance(value[1], int))


def _prompt_node(prompt, nid):
    return prompt.get(str(nid)) or prompt.get(nid)


def _looks_like_filename(text):
    lower = text.lower()
    return lower.endswith((".safetensors", ".gguf", ".ckpt", ".pt", ".pth",
                           ".sft", ".bin", ".onnx"))


def _resolve_text(prompt, value, seen=None):
    """Follow [node_id, slot] links until a string widget value is found."""
    if isinstance(value, str):
        return value.strip()
    if not isinstance(prompt, dict) or not _is_link(value):
        return ""
    seen = seen if seen is not None else set()
    nid = str(value[0])
    if nid in seen:
        return ""
    seen.add(nid)
    node = _prompt_node(prompt, nid)
    if not isinstance(node, dict):
        return ""
    inputs = node.get("inputs") or {}
    if not isinstance(inputs, dict):
        return ""
    for key in _TEXT_KEYS:
        if key not in inputs:
            continue
        got = _resolve_text(prompt, inputs[key], seen)
        if got and not _looks_like_filename(got):
            return got
    for key, raw in inputs.items():
        if key in _SKIP_KEYS or key in _TEXT_KEYS:
            continue
        got = _resolve_text(prompt, raw, seen)
        if got and len(got) > 8 and not _looks_like_filename(got):
            return got
    return ""


def _encode_texts_from_prompt(prompt):
    if not isinstance(prompt, dict):
        return [], []
    texts, settings = [], []
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type") or "")
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        if "TextEncode" in ct or ct.endswith("TextEncode"):
            chunk = ""
            for key in _TEXT_KEYS:
                if key not in inputs:
                    continue
                got = _resolve_text(prompt, inputs[key])
                if got and not _looks_like_filename(got):
                    chunk = got
                    if key in ("text", "t5xxl", "positive", "prompt"):
                        break
            if chunk:
                texts.append(chunk)
        elif "KSampler" in ct:
            bits = []
            for k in ("seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"):
                if k in inputs and not _is_link(inputs[k]):
                    bits.append(f"{k} {inputs[k]}")
            if bits:
                settings.append(f"{ct}: " + ", ".join(bits))
        elif ct in ("CheckpointLoaderSimple", "UNETLoader", "CheckpointLoader",
                    "UNETLoaderGGUF", "UnetLoaderGGUF"):
            name = inputs.get("ckpt_name") or inputs.get("unet_name")
            if isinstance(name, str) and name:
                settings.append(f"Model: {name}")
    return texts, settings


def _encode_texts_from_workflow(workflow):
    if not isinstance(workflow, dict):
        return []
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return []
    texts = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        ct = str(node.get("type") or node.get("class_type") or "")
        if "TextEncode" not in ct and not ct.endswith("TextEncode"):
            continue
        wv = node.get("widgets_values")
        if not isinstance(wv, list):
            continue
        for item in wv:
            if isinstance(item, str) and item.strip() and not _looks_like_filename(item):
                texts.append(item.strip())
                break
    return texts


def _dumps(obj):
    if obj is None or obj == "" or obj == {}:
        return ""
    if isinstance(obj, str):
        return obj
    return json.dumps(obj, indent=2, ensure_ascii=False)


def _flatten_strings(prompt):
    """Every string widget on every node — same source Crystools dumps as JSON."""
    if not isinstance(prompt, dict):
        return []
    lines = []
    for node in prompt.values():
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type") or "")
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        for key, raw in inputs.items():
            if key in _SKIP_KEYS:
                continue
            text = _resolve_text(prompt, raw)
            if not text or _looks_like_filename(text):
                continue
            if key in ("sampler_name", "scheduler", "weight_dtype", "mode"):
                continue
            lines.append(f"{ct}.{key}: {text}")
    return lines


def _generic_text(prompt, workflow=None):
    texts = _flatten_strings(prompt)
    if not texts:
        texts = _encode_texts_from_workflow(workflow)
        texts = [f"text: {t}" for t in texts]
    _, sampler_lines = _encode_texts_from_prompt(prompt)
    positive = ""
    for line in texts:
        _, _, rest = line.partition(": ")
        if rest and not _looks_like_filename(rest):
            positive = rest
            break
    extra = list(texts)
    extra.extend(sampler_lines)
    return positive, extra


def _split_prompt_workflow(prompt, workflow):
    """Some files store the LiteGraph workflow under the prompt key."""
    if (isinstance(prompt, dict) and isinstance(prompt.get("nodes"), list)
            and not any(isinstance(v, dict) and "class_type" in v
                        for v in prompt.values() if isinstance(v, dict))):
        return None, (workflow or prompt)
    return prompt, workflow


def _summarize(tags):
    prompt, workflow = _split_prompt_workflow(tags.get("prompt"), tags.get("workflow"))
    oasis = _oasis_from_prompt(prompt) or _oasis_from_workflow(workflow)
    generic_pos, extra = _generic_text(prompt, workflow)
    prompt_json = _dumps(prompt)

    if oasis:
        blocks, positives = [], []
        for ct, ex in oasis:
            if not ex:
                continue
            if ct == "ImageOasis":
                blocks.append(_fmt_image(ex))
            elif ct == "LTX23Oasis":
                blocks.append(_fmt_ltx(ex))
            elif ct == "VideoOasisPreview":
                blocks.append(_fmt_viewer(ex))
            pos = _positive_from_exec(ct, ex)
            if pos:
                positives.append(pos)
        human = positives[0] if positives else generic_pos
        settings = "\n\n".join("\n".join(b) for b in blocks if b)
        if extra:
            settings = (settings + "\n" if settings else "") + "\n".join(extra)
        return human or prompt_json, settings or prompt_json

    if generic_pos or extra:
        lines = []
        if generic_pos:
            lines.append(f"Prompt: {generic_pos}")
        lines.extend(extra)
        return generic_pos or prompt_json, "\n".join(lines) if lines else prompt_json

    if prompt_json:
        return prompt_json, prompt_json
    if tags:
        keys = ", ".join(sorted(tags.keys()))
        return "", f"Metadata keys present, but no prompt graph: {keys}"
    return "", "No ComfyUI prompt/workflow metadata in this file."


class OasisMetadata:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ([_NONE] + _choices(_IMAGE_EXT), {
                    "image_upload": True,
                    "tooltip": "PNG from input/ or output/. Leave File on (none).",
                }),
                "file": ([_NONE] + _choices(_VIDEO_EXT, "video"), {
                    "video_upload": True,
                    "tooltip": "Video from input/, output/, or output/video/. Leave Image on (none).",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "settings")
    FUNCTION = "extract"
    OUTPUT_NODE = True
    CATEGORY = "Image Oasis"
    DESCRIPTION = (
        "Read embedded ComfyUI metadata from a saved PNG or video. "
        "The prompt output is the execution-graph JSON (same as Crystools "
        "Metadata Extractor). Settings is the human-readable pass."
    )
    SEARCH_ALIASES = [
        "extract prompt", "image metadata", "video metadata",
        "pnginfo", "workflow metadata", "oasis metadata",
    ]

    @classmethod
    def IS_CHANGED(cls, image=_NONE, file=_NONE):
        try:
            pick = _picked(image, file)
        except ValueError:
            return f"{image}|{file}"
        if not pick:
            return _NONE
        try:
            path = folder_paths.get_annotated_filepath(pick)
            st = os.stat(path)
            return f"{st.st_mtime_ns}:{st.st_size}"
        except OSError:
            return pick

    @classmethod
    def VALIDATE_INPUTS(cls, image=_NONE, file=_NONE):
        try:
            pick = _picked(image, file)
        except ValueError as e:
            return str(e)
        if not pick:
            return True
        if not folder_paths.exists_annotated_filepath(pick):
            return f"Missing file: {pick}"
        return True

    def extract(self, image=_NONE, file=_NONE):
        try:
            pick = _picked(image, file)
        except ValueError as e:
            return {"ui": {"text": (str(e),)}, "result": ("", str(e))}
        if not pick:
            msg = "Pick an Image or a File."
            return {"ui": {"text": (msg,)}, "result": ("", msg)}
        path = folder_paths.get_annotated_filepath(pick)
        tags = _read_tags(path)
        prompt_json = _dumps(tags.get("prompt"))
        human, settings = _summarize(tags)
        if not settings:
            settings = "No ComfyUI prompt/workflow metadata in this file."
        # Crystools Metadata Extractor: the prompt socket is the execution
        # graph JSON. Settings stays the human-readable pass.
        return {"ui": {"text": (settings,)}, "result": (prompt_json or human, settings)}


NODE_CLASS_MAPPINGS = {"OasisMetadata": OasisMetadata}
NODE_DISPLAY_NAME_MAPPINGS = {"OasisMetadata": "Oasis Metadata \U0001f334"}
