"""
Architecture capability registry for LTX2.3 Oasis.

The video sibling of registry.py. Each entry declares how a video architecture
differs from the others: valid model sources, generation modes, text-encoder
layout, VAE slots, latent geometry rules (frame quantum / fps), the shape of
its sampling chain, and which optional subsystems it supports (PromptRelay
multi-prompt, keyframe guides, audio, native second-stage
upscale). Selecting an architecture selects a row here — the stages branch on
registry data, never on architecture name literals.

To add a new architecture later, add one entry. No new branching code required.

Where the numbers come from (source workflows the defaults were derived
from): LTX2_3_Custom.json (author's production workflow — distilled
single-stage) and video_ltx2_3_i2v.json (LTX dev template — two-stage; its
second stage informs the Upscale section defaults, which ship OFF).

`sampling` kinds (consumed by stage_sample_video.run_video_sampling_chain):
    distilled_manual_sigmas LTX 2.3 distilled: SamplerCustomAdvanced with an
                           explicit sigma list, CFG 1 (guider still CFGGuider
                           for uniformity). The sigma string is user-editable
                           in Generation; this row only supplies the default.
"""

# Valid model source types (must match loader keys in stage_load_video.py —
# same tri-source contract as IO's stage_load).
SOURCE_DIFFUSION = "diffusion"   # UNETLoader path (state-dict diffusion model)
SOURCE_GGUF = "gguf"             # ComfyUI-GGUF UnetLoaderGGUF path

ALL_SOURCES = (SOURCE_DIFFUSION, SOURCE_GGUF)

# Generation modes. A mode is a (latent construction + conditioning) recipe in
# stage_condition_video; the Start Frame section reshapes itself around the
# active mode (start slot for i2v, none for t2v).
MODE_T2V = "t2v"     # text -> video, empty latent
MODE_I2V = "i2v"     # start image conditions the first frame


ARCH_REGISTRY = {

    "ltx23": {
        "label": "LTX 2.3 22B (Distilled)",
        "loaders": ALL_SOURCES,     # author's production path is GGUF Q8_0
        "modes": (MODE_T2V, MODE_I2V),

        "model_slots": ("model",),

        # Dual TE: Gemma-3-12B + LTX text projection via
        # DualCLIPLoader(type="ltxv"). (The template's LTXAVTextEncoderLoader
        # route also exists in core, but the production workflow uses the
        # DualCLIP path — one loader family for all three arches.)
        "clip": {"loader": "dual_clip", "type": "ltxv", "slots": 2},
        "clip_vision": {},

        # Separate video and audio VAE files. Audio VAE only loads when the
        # audio toggle is on.
        "vae_slots": ("video", "audio"),

        # LTX VAE temporal compression = 8 -> frames are 8n+1.
        "frame_quantum": 8,
        "fps_default": 25.0,
        "defaults": {"width": 1280, "height": 720, "frames": 121},

        "latent_recipes": {
            MODE_T2V: "ltxv_empty_av",         # empty video latent + empty audio latent
            MODE_I2V: "ltxv_img_inplace_av",   # LTXVImgToVideoInplace + audio latent
        },

        "sampling": {
            "kind": "distilled_manual_sigmas",
            "sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
            "cfg": 1.0,
            "sampler": "euler_ancestral",
            # LTXVConditioning stamps the frame rate into cond; kept equal to
            # the working fps unless the user overrides it.
            "conditioning_fps": 25.0,
        },

        "speed_mode": None,          # the arch entry IS the distilled config
        # Full PromptRelay support including the audio cross-attn stream
        # (audio_attn2 wrapper with independent strength/window knobs).
        "prompt_relay": {"video": True, "audio": True},

        # Keyframe guides ride on Prompt Beats (PromptRelay rows): each beat
        # may carry an optional guide_image pinned at the start of its slice.
        # No hard slot count — AddGuide is chainable; cost is VRAM/latent size.
        "guides": {"from_beats": True},

        "audio": True,

        # LTX's native second stage (dev-template style): x2 spatial latent
        # upsampler, then a short re-noise pass on the upsampled latent.
        # OFF by default — this is the stage that destroys character identity
        # from source images (author-verified); the References-active warning
        # exists for exactly this section.
        "upscale_native": {
            "label": "Spatial Upsample (x2)",
            "latent_upsampler": "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
            "sigmas": "0.85, 0.7250, 0.4219, 0.0",
            "cfg": 1.0,
            "sampler": "euler",
        },

        # SageAttention per-model patch (kjnodes technique), defaulted ON to
        # match the production workflow. PromptRelay's masked-attention
        # fallback (patches.py) keeps its temporal masks correct even with
        # sage active — sage silently drops attention masks otherwise.
        "attention_patches": ("sage_auto",),
        "incompatible_flags": (),
    },

    "ltx25": {
        "label": "LTX 2.5 22B (Distilled)",
        "loaders": ALL_SOURCES,
        "modes": (MODE_T2V, MODE_I2V),

        "model_slots": ("model",),

        # SINGLE text encoder. 2.5 ships Gemma-4-12B with the LTX projection
        # already baked into one file (gemma4-12b-with-proj-ltx-2.5-bf16),
        # where 2.3 needed Gemma-3 plus a separate projection file. Feeding
        # the combined file to a two-slot DualCLIPLoader builds a mismatched
        # encoder and dies inside sd1_clip with an unpack error, so the slot
        # count is load-bearing, not cosmetic. _load_clip already handles the
        # 1-file case; "slots" drives the UI picker count via routes_video.
        "clip": {"loader": "clip", "type": "ltxv", "slots": 1},
        "clip_vision": {},

        "vae_slots": ("video", "audio"),

        # Unchanged from 2.3: same 8x temporal compression, same 8n+1 grid.
        "frame_quantum": 8,
        # 2.5's reference workflow runs at 24; 2.3's native rhythm is 25.
        "fps_default": 24.0,
        # Reference default from LTX-2.5_T2V_I2V_Single_Stage_Distilled.
        "defaults": {"width": 960, "height": 544, "frames": 121},

        "latent_recipes": {
            MODE_T2V: "ltxv_empty_av",
            MODE_I2V: "ltxv_img_inplace_av",
        },

        # Byte-identical to 2.3's schedule - verified against the official 2.5
        # single-stage and two-stage workflows, both of which ship the same
        # nine values, euler_ancestral, and CFG 1.
        "sampling": {
            "kind": "distilled_manual_sigmas",
            "sigmas": "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
            "cfg": 1.0,
            "sampler": "euler_ancestral",
            "conditioning_fps": 24.0,
        },

        "speed_mode": None,
        "prompt_relay": {"video": True, "audio": True},
        "guides": {"from_beats": True},

        "audio": True,

        # 2.5 has no upscaler of its own yet: the official two-stage 2.5
        # workflow loads the 2.3 spatial upscaler with the same second-stage
        # sigmas. Still OFF by default for the same identity-drift reason.
        "upscale_native": {
            "label": "Spatial Upsample (x2)",
            "latent_upsampler": "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
            "sigmas": "0.85, 0.7250, 0.4219, 0.0",
            "cfg": 1.0,
            "sampler": "euler",
        },

        "attention_patches": ("sage_auto",),
        "incompatible_flags": (),
    },
}

ARCH_KEYS = list(ARCH_REGISTRY.keys())


def get_arch(name):
    spec = ARCH_REGISTRY.get(name)
    if spec is None:
        raise ValueError(
            f"[LTX Oasis] Unknown architecture '{name}'. "
            f"Valid options: {', '.join(ARCH_KEYS)}"
        )
    return spec


def validate_combo(arch_name, source_type, mode):
    """Fail loudly on illegal architecture/source/mode combos before loading."""
    spec = get_arch(arch_name)
    if source_type not in spec["loaders"]:
        valid = ", ".join(spec["loaders"])
        raise ValueError(
            f"[LTX Oasis] Architecture '{arch_name}' cannot use source "
            f"type '{source_type}'. Valid sources: {valid}.")
    if mode not in spec["modes"]:
        valid = ", ".join(spec["modes"])
        raise ValueError(
            f"[LTX Oasis] Architecture '{arch_name}' does not support mode "
            f"'{mode}'. Valid modes: {valid}.")
    return spec


def snap_frames(spec, frames):
    """Snap a frame count to the architecture's quantum*n + 1 grid (nearest,
    minimum one quantum). The UI mirrors this so what you see is what runs."""
    q = int(spec["frame_quantum"])
    frames = max(int(frames), q + 1)
    return ((frames - 1 + q // 2) // q) * q + 1

