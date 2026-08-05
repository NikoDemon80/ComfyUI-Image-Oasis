"""
Video pipeline Stage 3: sampling (three chain shapes), the optional native
second stage (LTX spatial upsample), guide cropping, and decode
to frames (+ audio).

All heavy lifting is delegated to the installed ComfyUI's node classes via
comfy_bridge_video — this module owns only the per-architecture orchestration.
"""

from .comfy_bridge_video import call_node, first
from .stage_context_video import context_span_px


# ---------------------------------------------------------------------------
# Chain shapes
# ---------------------------------------------------------------------------

def _custom_sample(model, positive, negative, latent, sigmas, sampler_name,
                   cfg, seed, add_noise=True):
    noise = first("RandomNoise", noise_seed=int(seed)) if add_noise \
        else first("DisableNoise")
    guider = first("CFGGuider", model=model, positive=positive,
                   negative=negative, cfg=float(cfg))
    sampler = first("KSamplerSelect", sampler_name=sampler_name)
    out, _denoised = call_node(
        "SamplerCustomAdvanced", noise=noise, guider=guider,
        sampler=sampler, sigmas=sigmas, latent_image=latent)
    return out


def run_sampling(spec, models, cond, gen):
    """Run the architecture's base sampling chain. `cond` is
    stage_condition_video's output dict; `gen` is the Generation section
    (user-edited values — the registry only seeded their defaults).
    Returns the sampled latent."""
    kind = spec["sampling"]["kind"]
    pos, neg, latent = cond["positive"], cond["negative"], cond["latent"]
    seed = int(gen.get("seed", 0))

    if kind == "distilled_manual_sigmas":
        sigmas = first("ManualSigmas", sigmas=str(gen["sigmas"]))
        return _custom_sample(models["model"], pos, neg, latent, sigmas,
                              gen["sampler"], gen["cfg"], seed)

    raise ValueError(f"[LTX Oasis] Unknown sampling kind '{kind}'.")


# ---------------------------------------------------------------------------
# Pipeline tail: AV split -> crop -> optional upscale (+ optional polish)
# -> decode. Ordered so the upsampler and the polish pass only ever see a
# clean video-only latent with guide frames already removed.
# ---------------------------------------------------------------------------

def _trim_audio_window(audio, ctx_frames, deliver_frames, fps):
    """Cut a decoded AUDIO down to the delivered window: drop ctx_frames off
    the front, then keep deliver_frames' worth."""
    wave = audio.get("waveform")
    sr = int(audio.get("sample_rate") or 0)
    if wave is None or not sr:
        return audio
    n = max(0, int(round((float(ctx_frames) / float(fps)) * sr)))
    keep = max(1, int(round((float(deliver_frames) / float(fps)) * sr)))
    if n >= int(wave.shape[-1]):
        return audio
    return {"waveform": wave[..., n:n + keep].contiguous(),
            "sample_rate": sr}


def finish_pipeline(spec, models, cond, latent, loaded, gen, up, audio_enabled,
                    audio_file=""):
    """Everything after sampling. Returns (images, audio_or_None).

    Order matters:
      1. AV split (when audio) — AV latents are NestedTensors with no .clone();
         CropGuides and the spatial upsampler need a plain video tensor.
      2. LTXVCropGuides — guide/inplace conditioning frames are dropped so
         nothing downstream wastes compute on frames that get discarded.
      3. Optional 2x latent upsample (LTXVLatentUpsampler, trained to decode
         directly — fast, slightly soft).
      4. Optional polish pass: a short re-noise sample on the DIFFUSION model
         at the upscaled resolution. 4x the tokens of the base render —
         extremely heavy on partially-offloaded systems, hence opt-in.
      5. Decode video (+ audio: VAE decode for Generate, original waveform
         passthrough for File-driven so mux length matches frames/fps).
      6. Cut the delivered window out in pixel space. Deliberately AFTER the
         upsampler: those frames cost extra upscale/polish work, but cropping
         them in the latent re-anchors the sequence and shows up as a stutter
         on the first frames of every chained clip. The front cut is the
         context SPAN, not the sampled overhead -- the surplus 7 frames are
         real content and come off the back."""
    from . import stage_condition_video as scond
    pos, neg = cond["positive"], cond["negative"]

    # Motion context (continue-from-viewed): the head of the timeline was
    # seeded with real frames from the previous segment. gen["frames"] is the
    # DELIVERED count — the context sits in front of it and comes off here.
    ctx = max(0, int(cond.get("ctx_latent_frames") or 0))
    # The window SPANS q*(ctx-1)+1 pixel frames even though it cost q*ctx to
    # sample. Trimming the sampled overhead off the front eats real content
    # and the clip jumps ahead; the surplus belongs on the back.
    ctx_span = context_span_px(ctx, int(spec["frame_quantum"]))

    audio = None
    if audio_enabled and spec.get("audio"):
        latent, audio_latent = call_node("LTXVSeparateAVLatent", av_latent=latent)
        if (audio_file or "").strip():
            # build_mux_audio muxes the ORIGINAL waveform at the delivered
            # length, so the uploaded track is already exactly what it should
            # be — the silence that padded the context window only ever
            # existed in the latent.
            audio = scond.build_mux_audio(
                audio_file.strip(), int(gen["frames"]),
                float(gen.get("fps") or 25.0),
                audio_latent, loaded["audio_vae"])
        else:
            audio = first("LTXVAudioVAEDecode", samples=audio_latent,
                          audio_vae=loaded["audio_vae"])
            if ctx_span and audio is not None:
                # Trim in SAMPLE space rather than cropping the audio latent:
                # sr/fps is exact and needs no assumption about the audio
                # VAE's own temporal ratio.
                audio = _trim_audio_window(
                    audio, ctx_span, int(gen["frames"]),
                    float(gen.get("fps") or 25.0))

    if cond.get("used_guides_or_inplace"):
        # Skip this and reference frames leak into the output as literal
        # frames. Must run after AV split — NestedTensor has no .clone().
        pos, neg, latent = call_node("LTXVCropGuides",
                                     positive=pos, negative=neg, latent=latent)


    if up.get("enabled") and spec.get("upscale_native"):
        # LatentUpscaleModelLoader resolves against
        # models/latent_upscale_models/ ONLY — verify up front so a misplaced
        # file gives a clear error instead of a confusing loader failure.
        name = (up.get("latent_upsampler") or "").strip()
        if not name:
            raise ValueError("[LTX Oasis] Upscale is enabled but no upsampler "
                             "is selected. Put the LTX spatial upscaler in "
                             "ComfyUI/models/latent_upscale_models/ and pick "
                             "it in the Upscale section.")
        import folder_paths
        if not folder_paths.get_full_path("latent_upscale_models", name):
            raise ValueError(
                f"[LTX Oasis] '{name}' is not in models/latent_upscale_models/. "
                "The latent upsampler has its own folder (it is NOT an ESRGAN "
                "pixel upscaler) — move the file there and restart ComfyUI.")
        upscale_model = first("LatentUpscaleModelLoader", model_name=name)
        latent = first("LTXVLatentUpsampler", samples=latent,
                       upscale_model=upscale_model, vae=loaded["vae"])

        if up.get("polish"):
            sigmas = first("ManualSigmas",
                           sigmas=str(up.get("sigmas", "0.85, 0.7250, 0.4219, 0.0")))
            latent = _custom_sample(models["model"], pos, neg, latent, sigmas,
                                    up.get("sampler", "euler"),
                                    up.get("cfg", 1.0),
                                    int(gen.get("seed", 0)) + 1)

    images = first("VAEDecode", samples=latent, vae=loaded["vae"])
    if ctx_span:
        # Trim in PIXEL space, never by slicing latent frames off the head.
        # LTX's first latent frame decodes to one pixel frame and every later
        # one to `frame_quantum`; cropping the latent promotes a delta frame
        # into the anchor position, so the decoder renders a whole quantum of
        # motion into a single frame and takes a few more to settle. That is
        # the shimmy at a scene join. Decoding the full sampled length and
        # dropping pixel frames leaves every delivered frame in the temporal
        # role it was sampled in.
        images = images[ctx_span:int(gen["frames"]) + ctx_span]
    return images, audio


def to_video(images, fps, audio=None):
    kw = dict(images=images, fps=float(fps))
    if audio is not None:
        kw["audio"] = audio
    return first("CreateVideo", **kw)
