"""
Stage 1 of the pipeline: load models, apply the architecture sampling patch,
encode conditioning, and build the empty latent.

Configuration arrives as explicit function arguments (from the node's
INPUT_TYPES widgets / DOM widget blob), so this stage is self-contained.
"""

import sys

import torch
import folder_paths
import comfy.sd
import comfy.utils


# ---------------------------------------------------------------------------
# Folder discovery
# ---------------------------------------------------------------------------

def _find_in_folders(filename, *folder_names):
    import os
    for name in folder_names:
        try:
            dirs = folder_paths.get_folder_paths(name)
        except Exception:
            continue
        for base in dirs:
            p = os.path.join(base, filename.replace("/", os.sep))
            if os.path.exists(p):
                return p
    return None


def _find_unet_path(f):
    return _find_in_folders(f, "unet", "diffusion_models")


def _find_text_encoder_path(f):
    return _find_in_folders(f, "text_encoders", "clip")


def _require_text_encoder_path(f):
    """Resolve a selected CLIP/TE filename or fail naming the file. A selected
    file that can't be resolved must NOT fall through to the generic "No CLIP
    available" error — that message tells the user to do what they already did.
    Typical cause: the file was moved/renamed after the dropdown populated."""
    p = _find_text_encoder_path(f)
    if not p:
        raise FileNotFoundError(
            f"[Image Oasis] CLIP/text-encoder file not found: {f}. "
            "Check your text_encoders / clip folders — the file may have been "
            "moved or renamed since the list was loaded.")
    return p


# ---------------------------------------------------------------------------
# GGUF loader bridge
# ---------------------------------------------------------------------------

def _load_gguf_node(class_name, **explicit_kwargs):
    """Load a GGUF node from ComfyUI's registry, filling required args from
    INPUT_TYPES defaults. Raises a clear error if ComfyUI-GGUF isn't installed."""
    import nodes as _n
    Cls = _n.NODE_CLASS_MAPPINGS.get(class_name)
    if not Cls:
        raise RuntimeError(
            f"[Image Oasis] {class_name} not found — is ComfyUI-GGUF installed?"
        )
    loader = Cls()
    kwargs = dict(explicit_kwargs)
    for k, v in Cls.INPUT_TYPES().get("required", {}).items():
        if k in kwargs:
            continue
        d = (v[1] if len(v) > 1 else {}).get(
            "default", v[0][0] if isinstance(v[0], list) else None
        )
        if d is not None:
            kwargs[k] = d
    if class_name == "UnetLoaderGGUF":
        return loader.load_unet(**kwargs)[0]
    return loader.load_clip(**kwargs)[0]


# ---------------------------------------------------------------------------
# Model loading (checkpoint / diffusion / gguf)
# ---------------------------------------------------------------------------

def unload_enhancer_if_loaded():
    """Free the prompt-enhancer LLM (if one is cached) at the start of image
    generation, so it doesn't compete with the diffusion model for VRAM. No-op
    when no LLM is loaded, so iterating without re-enhancing doesn't trigger a
    reload cycle. Routes_enhance is loaded under a fixed sys.modules key by
    __init__.py — look it up there to avoid relative-import fragility.

    Called from nodes_image.py before the diffusion cache check, so it fires on
    every generation regardless of whether load_models() runs."""
    m = sys.modules.get("image_oasis_routes_enhance")
    if m is None:
        return
    fn = getattr(m, "unload_enhancer", None)
    if fn is None:
        return
    try:
        fn()
    except Exception as e:
        # Never let an enhancer-side failure block image generation.
        print(f"[Image Oasis] Enhancer unload skipped: {e!r}")


def load_models(source_type, model_file, clip_file, vae_file,
                clip_bundled, vae_bundled, weight_dtype, clip_type,
                clip_file_2="", clip_file_3=""):
    """Return (model, clip, vae).

    clip_file_2 and clip_file_3 are optional. Empty = single-CLIP behavior
    (today's path). One extra set = dual-CLIP, both extras set = triple-CLIP
    (item 7). Dual/triple routed to either stock comfy.sd.load_clip (all
    safetensors) or ComfyUI-GGUF's DualCLIPLoaderGGUF / TripleCLIPLoaderGGUF
    (any GGUF — those loaders' load_data path handles mixed safetensors+GGUF
    transparently).
    """
    if not model_file:
        raise ValueError("[Image Oasis] No model file specified.")

    model_obj = clip_obj = vae_obj = None

    # ── Model ──────────────────────────────────────────────────────────────
    if source_type == "checkpoint":
        ckpt_path = folder_paths.get_full_path("checkpoints", model_file)
        if not ckpt_path:
            raise FileNotFoundError(f"[Image Oasis] Checkpoint not found: {model_file}")
        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path, output_vae=True, output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"))
        model_obj, clip_obj, vae_obj = out[0], out[1], out[2]

    elif source_type == "diffusion":
        unet_path = _find_unet_path(model_file)
        if not unet_path:
            raise FileNotFoundError(f"[Image Oasis] Diffusion model not found: {model_file}")
        opts = {}
        if weight_dtype == "fp8_e4m3fn":
            opts["dtype"] = torch.float8_e4m3fn
        elif weight_dtype == "fp8_e4m3fn_fast":
            opts["dtype"] = torch.float8_e4m3fn
            opts["fp8_optimizations"] = True
        elif weight_dtype == "fp8_e5m2":
            opts["dtype"] = torch.float8_e5m2
        model_obj = comfy.sd.load_diffusion_model(unet_path, model_options=opts)

    elif source_type == "gguf":
        unet_path = _find_unet_path(model_file)
        if not unet_path:
            raise FileNotFoundError(f"[Image Oasis] GGUF model not found: {model_file}")
        model_obj = _load_gguf_node("UnetLoaderGGUF", unet_name=model_file)
    else:
        raise ValueError(f"[Image Oasis] Unknown source type: {source_type}")

    # ── CLIP ────────────────────────────────────────────────────────────────
    # Multi-CLIP routing (item 7). When 2 or 3 slots are filled, dispatch to
    # the right stock or GGUF loader. Any GGUF in the set → use ComfyUI-GGUF's
    # dual/triple loader (its load_data path handles mixed safetensors+GGUF).
    # All-safetensors → comfy.sd.load_clip with the full ckpt_paths list.
    clip_type_enum = getattr(
        comfy.sd.CLIPType, clip_type.upper(), comfy.sd.CLIPType.STABLE_DIFFUSION)

    if not clip_bundled:
        slots = [f for f in (clip_file, clip_file_2, clip_file_3) if f]
        if len(slots) == 1:
            cf = slots[0]
            if cf.lower().endswith(".gguf"):
                clip_obj = _load_gguf_node("CLIPLoaderGGUF", clip_name=cf, type=clip_type)
            else:
                te_path = _require_text_encoder_path(cf)
                clip_obj = comfy.sd.load_clip(
                    ckpt_paths=[te_path],
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                    clip_type=clip_type_enum)
        elif len(slots) == 2:
            any_gguf = any(f.lower().endswith(".gguf") for f in slots)
            if any_gguf:
                # GGUF dual loader handles mixed safetensors+GGUF natively.
                # Only refusal is scaled-fp8 + GGUF (raises NotImplementedError).
                clip_obj = _load_gguf_node(
                    "DualCLIPLoaderGGUF",
                    clip_name1=slots[0], clip_name2=slots[1], type=clip_type,
                )
            else:
                te_paths = [_require_text_encoder_path(f) for f in slots]
                clip_obj = comfy.sd.load_clip(
                    ckpt_paths=te_paths,
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                    clip_type=clip_type_enum)
        elif len(slots) == 3:
            any_gguf = any(f.lower().endswith(".gguf") for f in slots)
            if any_gguf:
                clip_obj = _load_gguf_node(
                    "TripleCLIPLoaderGGUF",
                    clip_name1=slots[0], clip_name2=slots[1], clip_name3=slots[2],
                    type=clip_type,
                )
            else:
                te_paths = [_require_text_encoder_path(f) for f in slots]
                clip_obj = comfy.sd.load_clip(
                    ckpt_paths=te_paths,
                    embedding_directory=folder_paths.get_folder_paths("embeddings"),
                    clip_type=clip_type_enum)

    # ── VAE ──────────────────────────────────────────────────────────────────
    if vae_file and not vae_bundled:
        vae_path = folder_paths.get_full_path("vae", vae_file)
        if vae_path:
            sd, meta = comfy.utils.load_torch_file(vae_path, return_metadata=True)
            vae_obj = comfy.sd.VAE(sd=sd, metadata=meta)
            vae_obj.throw_exception_if_invalid()

    if model_obj is None:
        raise RuntimeError("[Image Oasis] Model failed to load.")
    if clip_obj is None:
        raise RuntimeError(
            "[Image Oasis] No CLIP available — select a CLIP file, "
            "or use a checkpoint with bundled CLIP.")
    if vae_obj is None:
        raise RuntimeError(
            "[Image Oasis] No VAE available — select a VAE file, "
            "or use a checkpoint with bundled VAE.")

    return model_obj, clip_obj, vae_obj


# ---------------------------------------------------------------------------
# LoRA stack — applied on top of the loaded model/clip
# ---------------------------------------------------------------------------

def load_loras(model_obj, clip_obj, loras):
    """Apply a stack of LoRAs to (model, clip), in order.

    `loras` is a list of {"name", "strength_model", "strength_clip"}. Each is
    loaded from the ComfyUI "loras" folder via comfy.sd.load_lora_for_models,
    which CLONES model/clip before patching — so the caller's originals are
    untouched. That matters here: the node caches the un-patched objects and
    re-applies LoRAs on top, so a strength tweak must not mutate them. Entries
    with a blank name or both strengths 0 are skipped; a missing file warns and
    is skipped rather than aborting the run.

    Works on GGUF-quantized UNets too (ComfyUI-GGUF supports it); patched layers
    give back some of the quant's memory saving, which is expected, not a fault.
    """
    import os
    import comfy.sd

    model_out, clip_out = model_obj, clip_obj
    for spec in (loras or []):
        name = (spec.get("name") or "").strip()
        if not name or name == "(none)":
            continue
        sm = float(spec.get("strength_model", 0.0))
        sc = float(spec.get("strength_clip", 0.0))
        if sm == 0.0 and sc == 0.0:
            continue
        lora_path = folder_paths.get_full_path("loras", name)
        if not lora_path or not os.path.exists(lora_path):
            print(f"[Image Oasis] LoRA not found, skipping: {name}")
            continue
        lora = comfy.utils.load_torch_file(lora_path, safe_load=True)
        model_out, clip_out = comfy.sd.load_lora_for_models(
            model_out, clip_out, lora, sm, sc)
        print(f"[Image Oasis] Applied LoRA: {name} (model {sm}, clip {sc})")
    return model_out, clip_out


# ---------------------------------------------------------------------------
# Model-sampling patch (flux / sd3 / auraflow)
# ---------------------------------------------------------------------------

def apply_model_sampling(model_obj, sampling, shift_val):
    """Patch the model's sampling discretization. 'sampling' is one of
    'flux' | 'sd3' | 'auraflow' | 'none'.

    Failures raise. Falling back to the unpatched model would let a Flux/SD3
    model sample with the wrong discretization — garbage images with no
    user-visible error, which is strictly worse than failing the run.
    """
    if sampling == "none":
        return model_obj

    try:
        import comfy.model_sampling as cms
        m = model_obj.clone()

        if sampling in ("auraflow", "sd3"):
            class _MS(cms.ModelSamplingDiscreteFlow, cms.CONST):
                pass
            ms = _MS(m.model.model_config)
            ms.set_parameters(
                shift=shift_val,
                multiplier=1.0 if sampling == "auraflow" else 1000)
            m.add_object_patch("model_sampling", ms)

        elif sampling == "flux":
            class _MS(cms.ModelSamplingFlux, cms.CONST):
                pass
            ms = _MS(m.model.model_config)
            ms.set_parameters(shift=shift_val)
            m.add_object_patch("model_sampling", ms)

        return m
    except Exception as e:
        raise RuntimeError(
            f"[Image Oasis] Sampling patch '{sampling}' failed: {e}. "
            f"Check that the selected architecture matches the model.") from e


# ---------------------------------------------------------------------------
# Conditioning — text vs Qwen-Image-Edit branch
# ---------------------------------------------------------------------------

def _img_bhwc(image):
    """Normalize IMAGE tensors to [N,H,W,C] (flattens 5D video batches)."""
    if image is None or not isinstance(image, torch.Tensor):
        return image
    if image.ndim == 4:
        return image
    if image.ndim == 5:
        b, t, h, w, c = image.shape
        return image.reshape(b * t, h, w, c)
    raise ValueError(
        f"[Image Oasis] IMAGE must be 4D or 5D, got {tuple(image.shape)}")


def encode_conditioning(clip_obj, vae_obj, pos_text, neg_text,
                        accepts_image_cond,
                        image1=None, image2=None, image3=None):
    """Return (positive_cond, negative_cond).

    Routes through TextEncodeQwenImageEditPlus only when the architecture
    accepts image conditioning and at least one image is wired in. Otherwise
    plain CLIP text encode.
    """
    has_images = any(i is not None for i in (image1, image2, image3))

    if has_images:
        image1 = _img_bhwc(image1)
        image2 = _img_bhwc(image2)
        image3 = _img_bhwc(image3)

    use_qwen = bool(accepts_image_cond and has_images)

    if use_qwen:
        from comfy_extras.nodes_qwen import TextEncodeQwenImageEditPlus

        def encode(text, use_vae=True):
            result = TextEncodeQwenImageEditPlus.execute(
                clip=clip_obj,
                prompt=text or "",
                vae=vae_obj if use_vae else None,
                image1=image1, image2=image2, image3=image3)
            return result[0]
    else:
        def encode(text, use_vae=True):
            # encode_from_tokens_scheduled returns ComfyUI's full conditioning
            # structure — including every extra the text encoder attaches
            # (pooled output, attention mask, etc.) — exactly like stock
            # CLIPTextEncode. The previous manual encode_from_tokens +
            # hand-built [[cond, {"pooled_output": ...}]] silently DROPPED
            # those extras. That was survivable for arches that treat the
            # attention mask as optional (Qwen-Image, Krea 2), but fatal for
            # the Boogu/Omnigen2 family, whose model derives its required
            # num_tokens forward argument from the mask: no mask in the
            # conditioning, no num_tokens, TypeError at the first step.
            tokens = clip_obj.tokenize(text or "")
            return clip_obj.encode_from_tokens_scheduled(tokens)

    pos_cond = encode(pos_text, use_vae=True)
    neg_cond = encode(neg_text, use_vae=False)
    return pos_cond, neg_cond


# ---------------------------------------------------------------------------
# Empty latent — VAE-derived, generic across architectures
# ---------------------------------------------------------------------------

def make_latent(vae_obj, width, height, batch):
    """Build an empty latent sized from the VAE's own channel count and spatial
    compression — works for 4ch SD, 16ch Flux/SD3, etc. without hardcoding."""
    latent_ch = getattr(vae_obj, "latent_channels", 4)
    spatial = (vae_obj.spacial_compression_encode()
               if hasattr(vae_obj, "spacial_compression_encode") else 8)

    w = max(spatial, (int(width) // spatial) * spatial)
    h = max(spatial, (int(height) // spatial) * spatial)
    batch = max(1, int(batch))

    return {"samples": torch.zeros([batch, latent_ch, h // spatial, w // spatial])}


# ---------------------------------------------------------------------------
# Image conforming (Fit Method) + img2img init latent
# ---------------------------------------------------------------------------

def conform_image(image, width, height, fit_mode="crop"):
    """Conform a BHWC image to exactly (width, height) using the Fit Method.
    Shared by the img2img init path and the Qwen edit-reference path — one
    sizing policy for every image that enters generation.

      - "stretch": scale to exactly WxH. Ignores aspect; distorts on mismatch.
      - "crop":    scale to fill WxH preserving aspect, center-crop overflow.
      - "pad":     scale to fit inside WxH preserving aspect, pad the
                   remainder with edge-replication. Replicated edges give the
                   model something continuable — flat black padding survives
                   low-denoise passes as literal black bars.

    Returns BHWC. Raises on a non-tensor input or an unknown mode.
    """
    image = _img_bhwc(image)
    if image is None or not isinstance(image, torch.Tensor):
        raise ValueError("[Image Oasis] Image to conform is not a valid IMAGE tensor.")

    w, h = int(width), int(height)
    src_h, src_w = int(image.shape[1]), int(image.shape[2])
    samples = image.movedim(-1, 1)  # BHWC -> BCHW for common_upscale / pad

    if fit_mode == "stretch" or (src_w == w and src_h == h):
        samples = comfy.utils.common_upscale(samples, w, h, "lanczos", crop="disabled")
    elif fit_mode == "crop":
        # comfy's crop="center" scales to cover and center-crops — this mode.
        samples = comfy.utils.common_upscale(samples, w, h, "lanczos", crop="center")
    elif fit_mode == "pad":
        scale = min(w / src_w, h / src_h)
        fw = max(1, round(src_w * scale))
        fh = max(1, round(src_h * scale))
        samples = comfy.utils.common_upscale(samples, fw, fh, "lanczos", crop="disabled")
        pad_l = (w - fw) // 2
        pad_r = w - fw - pad_l
        pad_t = (h - fh) // 2
        pad_b = h - fh - pad_t
        if pad_l or pad_r or pad_t or pad_b:
            samples = torch.nn.functional.pad(
                samples, (pad_l, pad_r, pad_t, pad_b), mode="replicate")
    else:
        raise ValueError(f"[Image Oasis] Unknown fit method: {fit_mode}")

    return samples.movedim(1, -1)


def encode_init_latent(vae_obj, image, width, height, batch, fit_mode="crop"):
    """VAE-encode a reference image into the starting latent for img2img.

    The Latent section's width/height stay authoritative: the image is
    conformed to the target size by the Fit Method BEFORE encoding, so the
    output geometry is identical to the txt2img case and the base cache key's
    geometry component keeps meaning the same thing.

    Batch > 1 repeats the encoded latent along the batch dim (each batch
    entry still gets its own noise from the shared seed at sampling time).
    """
    spatial = (vae_obj.spacial_compression_encode()
               if hasattr(vae_obj, "spacial_compression_encode") else 8)
    w = max(spatial, (int(width) // spatial) * spatial)
    h = max(spatial, (int(height) // spatial) * spatial)

    pixels = conform_image(image, w, h, fit_mode)
    lat = vae_obj.encode(pixels[:, :, :, :3])
    batch = max(1, int(batch))
    if batch > 1 and lat.shape[0] == 1:
        lat = lat.repeat(batch, *([1] * (lat.ndim - 1)))
    return {"samples": lat}


# ---------------------------------------------------------------------------
# Conditioning rebalance — per-tap reweighting of stacked hidden states
# ---------------------------------------------------------------------------
# Technique vendored from huwhitememes/comfyui-krea2-conditioning
# (Apache-2.0), a fork of nova452/ComfyUI-ConditioningKrea2Rebalance
# (Apache-2.0) which introduced per-layer conditioning reweighting for
# Krea 2. This is the fork's quality-preserving configuration, fixed:
# RMS-renormalized (tap ratios shift, overall magnitude held), no global
# multiplier. Registry entries opt in via "cond_rebalance"; there is no
# user-facing control.

def _rebalance_tensor(t, weights):
    """Reweight one stacked-tap conditioning tensor. Returns None when the
    feature dim isn't divisible by the tap count (not a stacked-tap tensor),
    so the caller can warn instead of silently no-opping."""
    flat = int(t.shape[-1])
    n = len(weights)
    if n < 2 or flat % n != 0:
        return None
    orig_dtype = t.dtype
    x = t.float()
    ref_rms = x.pow(2).mean(dim=tuple(range(1, x.dim()))).sqrt()
    x = x.view(*x.shape[:-1], n, flat // n)
    gains = torch.tensor(list(weights), dtype=x.dtype, device=x.device)
    x = x * gains.view(*([1] * (x.dim() - 2)), n, 1)
    x = x.view(*x.shape[:-2], flat)
    new_rms = x.pow(2).mean(dim=tuple(range(1, x.dim()))).sqrt().clamp_min(1e-8)
    x = x * (ref_rms / new_rms).view(-1, *([1] * (x.dim() - 1)))
    return x.to(orig_dtype)


def rebalance_conditioning(cond, weights):
    """Apply per-tap reweighting to every tensor in a CONDITIONING structure.

    Masks, pooled outputs, and non-tensor payloads pass through untouched. A
    tensor whose width doesn't match the tap count is left unchanged with a
    loud one-time warning — a silent no-op here would mean the arch quietly
    stopped getting its rebalance if the TE stack shape ever changes upstream.
    """
    out = []
    warned = False
    for item in (cond or []):
        if (isinstance(item, (list, tuple)) and len(item) == 2
                and isinstance(item[0], torch.Tensor)
                and isinstance(item[1], dict)):
            reb = _rebalance_tensor(item[0], weights)
            if reb is None:
                if not warned:
                    warned = True
                    print("[Image Oasis] WARNING: conditioning rebalance "
                          f"skipped — tensor width {int(item[0].shape[-1])} "
                          f"is not divisible by {len(weights)} taps. The "
                          "conditioning is unmodified; if this appears after "
                          "a ComfyUI update, the TE stack layout may have "
                          "changed.")
                out.append([item[0], dict(item[1])])
            else:
                out.append([reb, dict(item[1])])
        else:
            out.append(item)
    return out


# ---------------------------------------------------------------------------
# Variety — seeded conditioning noise for seed-diversity on distilled models
# ---------------------------------------------------------------------------

def apply_variety_noise(cond, strength, seed, split=0.35):
    """Increase composition diversity between seeds by adding small seeded
    gaussian noise to the text embeddings during the EARLY part of the
    schedule only.

    Why this works: on few-step distilled flow models (Z-Image Turbo, Krea 2
    Turbo, Boogu Turbo, ...) the latent noise barely steers composition — the
    conditioning dominates, so most seeds funnel into the same layout.
    Shifting the conditioning point slightly lands the trajectory in a
    different basin. The noise applies only for the first `split` fraction of
    sampling (composition is decided early); the clean conditioning takes
    over after, so prompt adherence and fine detail stay faithful.

    Independent implementation of a widely used community technique — no
    third-party code. Design notes:
      - Noise is seeded from the generation seed (mixed with a constant so it
        decorrelates from the latent noise), so same seed + same strength
        reproduces the same image.
      - Noise is scaled by each tensor's own RMS, keeping the strength dial
        meaningful across text encoders with very different magnitudes.
      - All-zero token rows (zero-padded embeddings, e.g. umt5-style padding)
        are left untouched — noising padding is a known artifact source.
      - Masks/pooled extras pass through; non-standard items pass through
        unsplit.
    """
    strength = float(strength)
    if strength <= 0.0 or not cond:
        return cond
    gen = torch.Generator(device="cpu")
    gen.manual_seed((int(seed) ^ 0x5DEECE66D) & 0x7FFFFFFFFFFFFFFF)

    out = []
    for item in cond:
        if (isinstance(item, (list, tuple)) and len(item) == 2
                and isinstance(item[0], torch.Tensor)
                and isinstance(item[1], dict)):
            t = item[0]
            rms = t.float().pow(2).mean().sqrt().item()
            noise = torch.randn(t.shape, generator=gen, dtype=torch.float32)
            noise = noise.to(device=t.device, dtype=t.dtype)
            # Leave zero-padded token rows untouched.
            nonzero = (t.float().abs().sum(dim=-1, keepdim=True) > 0).to(t.dtype)
            noised = t + noise * (strength * rms) * nonzero
            out.append([noised, {**item[1],
                                 "start_percent": 0.0, "end_percent": split}])
            out.append([t, {**item[1],
                            "start_percent": split, "end_percent": 1.0}])
        else:
            out.append(item)
    return out
