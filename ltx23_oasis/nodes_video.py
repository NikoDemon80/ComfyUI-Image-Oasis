"""
LTX2.3 Oasis — the generation monolith.

Socketless OUTPUT_NODE, Image Oasis pattern: the frontend serializes the
entire configuration into one hidden STRING widget as JSON; results are
delivered over the `video-oasis/result` WebSocket event (from the shared
VideoOasisPreview encoder) keyed by a stable io_id. Encode / Save still
delegate to that preview node — one player stack suite-wide.

Cache tiers:
    _RAW_CACHE   raw model/clip/vae loads, keyed by files+dtype
    _WORK_CACHE  loras + attention patches applied
    _SAMPLED     per-io_id sampled latent (CPU) + conditioning, keyed by
                 everything upstream of Upscale/Encode — so toggling the
                 upscaler or re-encoding does NOT reload or resample; only
                 the upsample + decode + encode stages run.
"""

import json
import hashlib
import logging

import torch

from . import registry_video as rv
from . import stage_load_video as load
from . import stage_condition_video as scond
from . import stage_context_video as sctx
from . import stage_sample_video as ssamp
from .comfy_bridge_video import node_class

log = logging.getLogger("LTXOasis")

_RAW_CACHE = {}     # key -> loaded dict
_WORK_CACHE = {}    # key -> (models, clip)
_SAMPLED = {}       # io_id -> {"key", "latent"(cpu), cond fields}
_TAIL_SRC = {}      # io_id -> {"video","subfolder","type"}: the viewer entry
                    # that seeds continue-from-viewed. A reference, not
                    # pixels — whatever is in the viewer IS the tail source,
                    # including clips loaded from previous sessions, so the
                    # frames get decoded off disk at generate time.
_TAIL_VER = {}      # io_id -> int; bumps when the tail source changes, so the
                    # sampled-latent key sees continue-last input changes


def clear_caches():
    """Manual big hammer (POST /ltx23_oasis/flush_cache): drop every
    cached model set and sampled latent. _TAIL_SRC survives — it is a few
    strings, and losing it breaks continue-from-viewed for no memory win."""
    _RAW_CACHE.clear()
    _WORK_CACHE.clear()
    _SAMPLED.clear()


def _key(*parts):
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str)
                        .encode()).hexdigest()


def _samples_to_cpu(samples):
    """Snapshot latent samples to CPU for the retake cache. Plain tensors
    detach/clone/cpu; comfy's NestedTensor (LTX AV latents = video + audio
    packed together) has no detach — rebuild it from its component tensors.
    Unknown wrappers are held by reference (better a live reference than a
    crash; worst case the retake cache pins some memory)."""
    if torch.is_tensor(samples):
        return samples.detach().clone().cpu()
    tensors = getattr(samples, "tensors", None)
    if tensors is not None:
        return type(samples)([t.detach().clone().cpu() for t in tensors])
    return samples


def _audio_file_checked(st):
    if st.get("audio_mode") != "file":
        return ""
    fn = (st.get("audio_file") or "").strip()
    if not fn:
        raise ValueError("[LTX Oasis] Audio is set to File but no audio file "
                         "is loaded — add one in Video, or switch the Audio "
                         "toggle to Generate or Off.")
    return fn


def _adapt_flat_state(st):
    """The frontend serializes ONE flat IO-style dict (mirroring image_oasis's
    execState keys). Adapt it to the nested exec shape generate() consumes.
    Unreleased node: no legacy nested-blob support."""
    loras, triggers = [], []
    for l in (st.get("loras") or []):
        if not isinstance(l, dict) or l.get("enabled") is False or not l.get("name"):
            continue
        loras.append({"name": l["name"],
                      "strength_model": l.get("strength_model", 1.0),
                      "strength_clip": l.get("strength_clip",
                                             l.get("strength_model", 1.0))})
        tw = (l.get("trigger_words") or "").strip()
        if tw:
            triggers.append(tw)

    positive = (st.get("positive") or "").strip()
    if triggers:
        positive = ", ".join(triggers + ([positive] if positive else []))

    # Guides live on beats — each relay segment may carry a guide image.
    guides = scond.guides_from_beats(
        st.get("relay_segments") or [], st.get("frames", 0))

    gen = {k: st[k] for k in ("width", "height", "frames", "fps", "seed",
                              "cfg", "sigmas", "conditioning_fps")
           if k in st}
    if "sampler_name" in st:
        gen["sampler"] = st["sampler_name"]
    if not gen.get("conditioning_fps"):
        gen.pop("conditioning_fps", None)   # 0 = follow fps

    return {
        "arch": st.get("architecture", "ltx23"),
        "mode": st.get("mode", "t2v"),
        "source_type": st.get("source_type", "diffusion"),
        "model_files": {"model": st.get("model_file", "")},
        "clip_files": [st.get("clip_file", ""), st.get("clip_file_2", "")],
        "vae_files": {"video": st.get("vae_file", ""),
                      "audio": st.get("vae_audio_file", "")},
        "weight_dtype": st.get("weight_dtype", "default"),
        "loras": loras,
        # audio_mode: "off" | "generate" | "file" (file = audio-driven video)
        "audio": st.get("audio_mode", "off") != "off",
        "audio_file": _audio_file_checked(st),
        "prompt": positive,
        "negative": (st.get("negative") or "").strip(),
        "relay": {
            # Active whenever any beats exist; empty list = normal prompt path.
            "enabled": bool(st.get("relay_segments")),
            "segments": list(st.get("relay_segments") or []),
        },
        "refs": {"start_image": st.get("start_image", ""),
                 "guides": guides,
                 "continue_last": bool(st.get("continue_last")),
                 # Motion context window, in PIXEL frames. 0 = the classic
                 # single-frame tail. Snapped to the quantum in generate().
                 "context_frames": int(st.get("context_frames", 0) or 0)},
        "gen": gen,
        "upscale": {"enabled": bool(st.get("enable_upscale")),
                    "latent_upsampler": st.get("upscale_upsampler", ""),
                    "polish": bool(st.get("upscale_polish")),
                    "sigmas": st.get("upscale_sigmas", ""),
                    "cfg": st.get("upscale_cfg", 1.0),
                    "sampler": st.get("upscale_sampler", "euler")},
        "encode": {"format": st.get("format", "auto"),
                   "codec": st.get("codec", "auto"),
                   "quality": st.get("quality", "balanced"),
                   "crf": st.get("crf", 20),
                   "save_prefix": st.get("save_prefix", "video/LTX23Oasis")},
    }


def _snap_context_px(px, quantum):
    """Snap a motion-context window down to a legal 8n+1 pixel count.

    Returns 0 when nothing legal fits, which means the classic single-frame
    tail. The minimum useful window is quantum+1 (two latent frames): one
    anchor plus one delta frame is the smallest thing that carries motion at
    all rather than just a pose."""
    px = int(px)
    if px < quantum + 1:
        return 0
    return ((px - 1) // quantum) * quantum + 1


def _load_tail(spec, io_id, gen, refs_cfg, audio_enabled, audio_file):
    """Decode the tail of whatever clip the viewer is currently showing.

    Returns (images, ctx_latent_frames, ctx_audio). ctx_latent_frames is 0
    for the classic single-frame tail, in which case nothing about the
    timeline length changes and this behaves exactly as it always has.

    A window of N latent frames is N*quantum pixel frames of real motion
    pinned in front of the delivered timeline: enough for the model to read
    direction and speed out of the previous segment instead of guessing them
    from a single still.
    """
    src = _TAIL_SRC.get(io_id) or {}
    path = sctx.resolve_entry_path(src.get("video"), src.get("subfolder"),
                                   src.get("type"))
    if not path:
        raise ValueError(
            "[LTX Oasis] The clip seeding continue-from-viewed is not on "
            "disk any more. Pick another entry in the scene bar.")

    q = int(spec["frame_quantum"])
    # context_frames is the ENCODED window in pixel frames and is itself an
    # 8n+1 count, because the first latent frame of any sequence decodes to a
    # single pixel frame and every later one to `q`. 17 real frames is 3
    # latent frames, not 24.
    want_px = _snap_context_px(max(0, int(refs_cfg.get("context_frames", 0) or 0)), q)
    ctx_latent = ((want_px - 1) // q + 1) if want_px else 0
    n_frames = want_px if ctx_latent else 1

    # The tail waveform is only wanted when audio is actually being
    # GENERATED: on a driven run the uploaded track is authoritative and the
    # context window gets silence instead.
    want_audio = bool(ctx_latent and audio_enabled
                      and not (audio_file or "").strip())

    images, ctx_audio, info = sctx.extract_tail(path, n_frames, want_audio)

    got = int(images.shape[0])
    if not ctx_latent:
        images = images[-1:]
    elif got < n_frames:
        # Short source clip: fall back to the largest legal window that fits.
        want_px = _snap_context_px(got, q)
        ctx_latent = ((want_px - 1) // q + 1) if want_px else 0
        images = images[-want_px:] if ctx_latent else images[-1:]
        log.info("[LTX Oasis] Tail source yielded only %d frames — motion "
                 "context reduced to %d frames (%d latent).",
                 got, want_px if ctx_latent else 1, ctx_latent)

    src_fps = float(info.get("fps") or 0.0)
    tgt_fps = float(gen.get("fps") or spec["fps_default"])
    if ctx_latent and src_fps and abs(src_fps - tgt_fps) > 0.01:
        log.warning(
            "[LTX Oasis] Tail source runs at %.3f fps but this render is at "
            "%.3f fps — the motion context will read as %.0f%% speed.",
            src_fps, tgt_fps, (src_fps / tgt_fps) * 100.0)

    # The viewer entry can be any resolution (an earlier session, a different
    # aspect, an upscaled render); the frozen region has to match the target
    # latent's spatial shape.
    images = sctx.fit_context_images(images, int(gen["width"]),
                                     int(gen["height"]))
    if ctx_audio is not None and not ctx_latent:
        ctx_audio = None
    return images, ctx_latent, ctx_audio


class LTX23Oasis:
    @classmethod
    def INPUT_TYPES(s):
        # ONE optional widget only — every declared STRING input makes the
        # frontend auto-create a raw text widget above the DOM widget.
        return {
            "required": {},
            "optional": {
                "ltx23_oasis_ui": ("STRING", {"default": "{}"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "generate"
    OUTPUT_NODE = True
    CATEGORY = "video"
    DESCRIPTION = ("All-in-one LTX 2.3 video generation — model loading, "
                   "LoRAs, Start Frame, Prompt Beats (PromptRelay + "
                   "keyframe guides), audio, generation, optional spatial "
                   "upscale, and the in-node player.")
    SEARCH_ALIASES = ["ltx2.3 oasis", "ltx oasis", "ltx23", "generate video", "ltx"]

    @classmethod
    def IS_CHANGED(cls, ltx23_oasis_ui="{}", **kw):
        return ltx23_oasis_ui

    # ------------------------------------------------------------------
    def generate(self, ltx23_oasis_ui="{}", prompt=None, extra_pnginfo=None):
        raw = ltx23_oasis_ui or "{}"
        try:
            state = json.loads(raw)
            assert isinstance(state, dict)
        except Exception:
            raise ValueError("[LTX Oasis] Bad config payload from the UI.")
        io_id = str(state.get("io_id", ""))
        flat = state.get("execState") or state.get("exec") or {}
        ex = _adapt_flat_state(flat) if "architecture" in flat else flat

        arch = ex.get("arch", "ltx23")
        mode = ex.get("mode", "t2v")
        source = ex.get("source_type", "diffusion")
        spec = rv.validate_combo(arch, source, mode)

        gen = dict(ex.get("gen") or {})
        for k, v in spec["sampling"].items():
            gen.setdefault(k, v)
        gen.setdefault("width", spec["defaults"]["width"])
        gen.setdefault("height", spec["defaults"]["height"])
        gen.setdefault("fps", spec["fps_default"])
        if not str(gen.get("sigmas") or "").strip():
            gen["sigmas"] = spec["sampling"].get("sigmas", "")
        gen["frames"] = rv.snap_frames(spec, gen.get("frames",
                                                     spec["defaults"]["frames"]))
        audio_enabled = bool(ex.get("audio")) and bool(spec.get("audio"))
        audio_file = (ex.get("audio_file") or "").strip()
        up = dict(ex.get("upscale") or {})
        refs_cfg = dict(ex.get("refs") or {})

        # Continue-from-last works in ANY mode: with a tail frame present the
        # run switches to the image-conditioned recipe. First run of a session
        # (no tail yet) proceeds as plain t2v.
        if (refs_cfg.get("continue_last") and io_id in _TAIL_SRC
                and mode == "t2v" and "i2v" in spec["modes"]):
            mode = "i2v"
            spec = rv.validate_combo(arch, source, mode)

        # ── Sampled-latent cache check: everything UPSTREAM of Upscale ──
        sample_key = _key("sampled", arch, mode, source,
                          ex.get("model_files"), ex.get("clip_files"),
                          ex.get("vae_files"), ex.get("weight_dtype"),
                          ex.get("loras"), spec["attention_patches"],
                          ex.get("prompt"), ex.get("negative"),
                          ex.get("relay"), refs_cfg, gen, audio_enabled,
                          audio_file,
                          # the tail frame is only an input when chaining —
                          # keying on it otherwise would invalidate every
                          # follow-up run (each run bumps the version)
                          _TAIL_VER.get(io_id, 0)
                          if refs_cfg.get("continue_last") else None)
        cached = _SAMPLED.get(io_id)
        reuse = bool(cached and cached["key"] == sample_key)

        # ── Tier 1: raw loads (needed even on reuse: VAE decodes, and the
        #    upscale re-noise pass samples on the diffusion model) ──
        load.unload_enhancer_if_loaded()
        rk = _key("raw", arch, source, ex.get("model_files"),
                  ex.get("clip_files"), ex.get("vae_files"),
                  ex.get("weight_dtype"), audio_enabled)
        if rk not in _RAW_CACHE:
            _RAW_CACHE.clear()   # one raw set in VRAM/RAM at a time
            _WORK_CACHE.clear()
            _RAW_CACHE[rk] = load.load_models(
                spec, source, dict(ex.get("model_files") or {}),
                list(ex.get("clip_files") or []),
                dict(ex.get("vae_files") or {}),
                ex.get("weight_dtype", "default"),
                audio_enabled=audio_enabled)
        loaded = _RAW_CACHE[rk]

        # ── Tier 2: loras + attention patches ──
        loras = list(ex.get("loras") or [])
        wk = _key("work", rk, loras, spec["attention_patches"])
        if wk not in _WORK_CACHE:
            _WORK_CACHE.clear()
            models, clip = load.apply_lora_stack_multi(
                loaded["models"], loaded["clip"], loras)
            models = {slot: load.apply_attention_patches(
                          m, spec["attention_patches"])
                      for slot, m in models.items()}
            _WORK_CACHE[wk] = (models, clip)
        models, clip = _WORK_CACHE[wk]

        if reuse:
            log.info("[LTX Oasis] Reusing sampled latent for %s — running "
                     "upscale/decode/encode only.", io_id or "(no id)")
            cond = {"positive": cached["positive"],
                    "negative": cached["negative"],
                    "used_guides_or_inplace": cached["used_guides_or_inplace"],
                    "video_latent_frames": cached["video_latent_frames"],
                    "ctx_latent_frames": cached.get("ctx_latent_frames", 0)}
            latent = {"samples": cached["latent"]}
        else:
            # ── Conditioning ─────────────────────────────────────────────
            pos_text = str(ex.get("prompt", ""))
            neg_text = str(ex.get("negative", "") or "").strip()

            # References first: the motion-context window changes the length
            # of the timeline everything else is measured against, so beats
            # and beat guides cannot be laid out until it is known.
            refs = {"start": None, "guides": []}
            ctx_latent_frames, ctx_audio = 0, None
            if refs_cfg.get("continue_last") and io_id in _TAIL_SRC:
                refs["start"], ctx_latent_frames, ctx_audio = _load_tail(
                    spec, io_id, gen, refs_cfg, audio_enabled, audio_file)
            elif refs_cfg.get("start_image"):
                refs["start"] = scond.load_ref_image(refs_cfg["start_image"])
            ctx_px = sctx.context_span_px(ctx_latent_frames,
                                          int(spec["frame_quantum"]))
            if spec.get("guides"):
                for g in (refs_cfg.get("guides") or []):
                    img = scond.load_ref_image(g.get("image", ""))
                    if img is not None:
                        # Beat guides are indexed against the DELIVERED
                        # timeline; the context window sits in front of it.
                        refs["guides"].append(
                            {"image": img,
                             "frame_idx": int(g.get("frame_idx", 0)) + ctx_px,
                             "strength": g.get("strength", 1.0)})

            relay = dict(ex.get("relay") or {})
            mask_fn = None
            if relay.get("enabled") and spec.get("prompt_relay"):
                any_model = next(iter(models.values()))
                stride = scond.relay_temporal_stride(any_model)
                latent_frames = ((int(gen["frames"]) - 1) // stride + 1
                                 + ctx_latent_frames)
                segs = []
                for s in (relay.get("segments") or []):
                    seg = dict(s)
                    if seg.get("frames"):
                        seg["frames"] = max(1, round(int(seg["frames"]) / stride))
                    segs.append(seg)
                if ctx_latent_frames and segs:
                    # A leading slice over the context window carrying the
                    # first beat's text keeps every real beat aligned to the
                    # delivered frame it was written for. Those frames are
                    # frozen anyway; the slice exists to keep the mask honest.
                    lead = dict(segs[0])
                    lead["frames"] = ctx_latent_frames
                    segs.insert(0, lead)
                pos_text, mask_fn = scond.build_relay(
                    clip, pos_text, segs, latent_frames,
                    relay_options=relay.get("options"))

            positive = scond.encode_text(clip, pos_text)
            negative = scond.encode_text(clip, neg_text)

            # A negative at CFG 1 (distilled) is inert through the sampler —
            # the uncond pass never runs. Route it through NAG instead.
            # NAG must patch BEFORE relay so relay wraps the NAG forward.
            try:
                cfg_val = float(gen.get("cfg", 1.0))
            except (TypeError, ValueError):
                cfg_val = 1.0
            if neg_text and cfg_val <= 1.0:
                log.info("[LTX Oasis] CFG 1 + negative prompt: applying NAG.")
                models = scond.apply_nag(models, negative, audio_enabled)

            if mask_fn is not None:
                models = scond.apply_relay_to_models(models, mask_fn)

            cond = scond.build_latent_and_conditioning(
                spec, mode, loaded, gen, refs, positive, negative,
                audio_enabled, audio_file=audio_file,
                ctx_latent_frames=ctx_latent_frames, ctx_audio=ctx_audio)

            # ── Sample, then stash the latent on CPU for upscale retakes ──
            latent = ssamp.run_sampling(spec, models, cond, gen)
            if io_id:
                with torch.no_grad():
                    _SAMPLED[io_id] = {
                        "key": sample_key,
                        "latent": _samples_to_cpu(latent["samples"]),
                        "positive": cond["positive"],
                        "negative": cond["negative"],
                        "used_guides_or_inplace": cond.get("used_guides_or_inplace", False),
                        "video_latent_frames": cond.get("video_latent_frames"),
                        "ctx_latent_frames": cond.get("ctx_latent_frames", 0),
                    }
            cond = {"positive": cond["positive"], "negative": cond["negative"],
                    "used_guides_or_inplace": cond.get("used_guides_or_inplace", False),
                    "video_latent_frames": cond.get("video_latent_frames"),
                    "ctx_latent_frames": cond.get("ctx_latent_frames", 0)}

        # ── Crop -> AV split -> optional upscale (+polish) -> decode ─────
        images, audio = ssamp.finish_pipeline(
            spec, models, cond, latent, loaded, gen, up, audio_enabled,
            audio_file=audio_file)

        video = ssamp.to_video(images, gen.get("fps", spec["fps_default"]), audio)

        # ── Encode + deliver via in-pack VideoOasisPreview (Video Oasis Viewer) ──
        PrevCls = node_class("VideoOasisPreview")
        preview_blob = json.dumps({"io_id": io_id,
                                   "exec": dict(ex.get("encode") or {})})
        return PrevCls().preview(video, video_oasis_ui=preview_blob,
                                 prompt=prompt, extra_pnginfo=extra_pnginfo)


NODE_CLASS_MAPPINGS = {
    "LTX23Oasis": LTX23Oasis,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "LTX23Oasis": "LTX2.3 Oasis \U0001f334",
}
