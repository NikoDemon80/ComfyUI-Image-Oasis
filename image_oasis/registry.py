"""
Architecture capability registry for the All-in-One Image Generation node.

Each entry declares how an architecture differs from the others: which model
source types are valid, which model-sampling patch to apply (and its defaults),
which text-conditioning path to use, and whether it can consume image inputs
(Qwen-Image-Edit). This single dict replaces every "Switch (Any)" node in the
original graph — selecting an architecture selects a row here.

To add a new architecture later, add one entry. No new branching code required.

Sampling patch values:
  - "flux"      -> ModelSamplingFlux + CONST, set_parameters(shift=shift_val)
  - "sd3"       -> ModelSamplingDiscreteFlow + CONST, multiplier=1000
  - "auraflow"  -> ModelSamplingDiscreteFlow + CONST, multiplier=1.0
  - "none"      -> no patch
"""

# Valid model source types (must match loader keys in stage_load.py)
SOURCE_CHECKPOINT = "checkpoint"
SOURCE_DIFFUSION = "diffusion"
SOURCE_GGUF = "gguf"

ALL_SOURCES = (SOURCE_CHECKPOINT, SOURCE_DIFFUSION, SOURCE_GGUF)


ARCH_REGISTRY = {
    "auraflow": {
        "label": "AuraFlow / Z-Image",
        "loaders": ALL_SOURCES,
        "sampling": "auraflow",
        "shift_default": 3.0,
        "accepts_image_cond": False,
        "default_clip_type": "stable_diffusion",
        "clip_slots": 1,                # single TE (Pile-T5 family)
    },
    "boogu": {
        "label": "Boogu-Image 0.1 (Base / Turbo)",
        "loaders": ALL_SOURCES,
        "sampling": "none",             # 3.16 shift is baked into the model config
        "shift_default": 3.0,           # unused (sampling: none) — kept for state consistency
        "accepts_image_cond": False,    # the Edit variant uses Omnigen-style
                                        # ref_latents, a different mechanism than
                                        # IO's Qwen edit path — unsupported for now
        "default_clip_type": "boogu",   # Qwen3-VL-8B via ComfyUI's Boogu tokenizer;
                                        # attaches the attention mask the model's
                                        # num_tokens argument is derived from — a
                                        # generic clip type crashes the forward
        "clip_slots": 1,                # single Qwen3-VL-8B TE
    },
    "flux": {
        "label": "Flux.1 / Flux.2",
        "loaders": ALL_SOURCES,
        "sampling": "flux",            # key consumed by apply_model_sampling()
        "shift_default": 1.15,          # Flux uses a max_shift-style value
        "accepts_image_cond": False,
        "default_clip_type": "flux",
        "clip_slots": 2,                # clip_l + t5xxl (Flux.2 Klein users leave slot 2 empty)
    },
    "krea2": {
        "label": "Krea 2 (Turbo / Raw)",
        "loaders": ALL_SOURCES,
        "sampling": "none",             # 1.15 shift is baked into the model config
        "shift_default": 3.0,           # unused (sampling: none) — kept for state consistency
        "accepts_image_cond": False,
        "default_clip_type": "krea2",
        "clip_slots": 1,                # single Qwen3-VL-4B TE
        # Startup flags that corrupt this architecture. nodes_image.py checks these
        # against comfy.cli_args and refuses the run BEFORE loading anything —
        # sage-attention breaks Krea 2's attention layout and produces silent
        # NaN latents (black images) with no error.
        "incompatible_flags": ("use_sage_attention",),
        # Automatic conditioning rebalance, applied post-encode in nodes_image.py.
        # Krea 2 conditions on 12 stacked Qwen3-VL hidden-state taps (shallow
        # -> deep, packed into one (B, seq, 12*2560) tensor); alignment
        # training under-weights the deep taps that carry fine detail and
        # identity. These per-layer gains restore them (the community
        # "balanced" profile), RMS-renormalized in stage_load so tap RATIOS
        # shift while overall conditioning magnitude is held — the validated
        # quality-preserving configuration. Positive conditioning only.
        # Technique: nova452/ComfyUI-ConditioningKrea2Rebalance, refined by
        # huwhitememes/comfyui-krea2-conditioning (both Apache-2.0).
        "cond_rebalance": {
            "taps": 12,
            "weights": (1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0,
                        2.5, 5.0, 1.1, 4.0, 1.0),
        },
    },
    "qwen_image_edit": {
        "label": "Qwen-Image-Edit",
        "loaders": ALL_SOURCES,         # incl. AIO checkpoints (e.g. Phr00t Rapid-AIO)
        "sampling": "auraflow",         # Qwen-Image uses AuraFlow-style discrete flow
        "shift_default": 3.0,
        "accepts_image_cond": True,     # the 1-3 image edit inputs
        "default_clip_type": "qwen_image",
        "clip_slots": 1,                # single Qwen2VL TE
    },
    "other": {
        # Escape hatch: load as-is, no sampling patch, plain CLIP encode.
        # Correct choice for SDXL, SD1/SD1.5, and any other model that doesn't
        # need a flow-matching patch.
        "label": "SD1 / SD1.5 / No Patch",
        "loaders": ALL_SOURCES,
        "sampling": "none",
        "shift_default": 3.0,
        "accepts_image_cond": False,
        "default_clip_type": "stable_diffusion",
        "clip_slots": 2,                # covers SDXL (clip_l + clip_g); SD1.5 leaves slot 2 empty
    },
    "sd3": {
        "label": "SD3 / SD3.5",
        "loaders": ALL_SOURCES,
        "sampling": "sd3",
        "shift_default": 3.0,
        "accepts_image_cond": False,
        "default_clip_type": "sd3",
        "clip_slots": 3,                # clip_l + clip_g + t5xxl (triple TE for best quality)
    },
}

ARCH_KEYS = list(ARCH_REGISTRY.keys())

# CLIP type choices for the frontend dropdown, served via /image_oasis/models
# (empty string = "use the architecture's default_clip_type"). Curated on
# purpose: comfy.sd.CLIPType has 30+ entries, mostly video-model types that
# would only confuse an image node's users. Add here when a new image model
# needs a type — registry-only change, no frontend edit.
CLIP_TYPE_CHOICES = ("", "stable_diffusion", "sd3", "flux", "qwen_image",
                     "lumina2", "hidream", "chroma", "flux2", "krea2", "boogu")


def get_arch(name):
    spec = ARCH_REGISTRY.get(name)
    if spec is None:
        raise ValueError(
            f"[Image Oasis] Unknown architecture '{name}'. "
            f"Valid options: {', '.join(ARCH_KEYS)}"
        )
    return spec


def validate_combo(arch_name, source_type):
    """Fail loudly on an illegal architecture/source pairing before any loading."""
    spec = get_arch(arch_name)
    if source_type not in spec["loaders"]:
        valid = ", ".join(spec["loaders"])
        raise ValueError(
            f"[Image Oasis] Architecture '{arch_name}' cannot use source "
            f"type '{source_type}'. Valid sources for this architecture: {valid}."
        )
    return spec
