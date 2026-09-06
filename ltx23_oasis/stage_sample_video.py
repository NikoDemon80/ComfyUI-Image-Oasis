"""
Video pipeline Stage 3: sampling (three chain shapes), the optional native
second stage (LTX spatial upsample), guide cropping, and decode
to frames (+ audio).

All heavy lifting is delegated to the installed ComfyUI's node classes via
comfy_bridge_video — this module owns only the per-architecture orchestration.
"""

from .comfy_bridge_video import call_node, first, node_class, node_registered
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


def _audio_diag(video_latent, audio_latent, audio):
    """TEMP DIAGNOSTIC - remove after the audio-noise hunt.

    Reports the post-sample audio stream and dumps the raw VAE decode to a
    WAV in ComfyUI's output folder, before trimming or muxing touches it."""
    import logging
    log = logging.getLogger("LTXOasis")
    try:
        import os
        import torch
        import folder_paths
        vs = video_latent.get("samples")
        as_ = audio_latent.get("samples")
        log.warning("[AUDIO-DIAG] post-sample video %r | audio %r",
                    tuple(vs.shape) if vs is not None else None,
                    tuple(as_.shape) if as_ is not None else None)
        if as_ is not None:
            f = as_.float()
            log.warning("[AUDIO-DIAG] audio latent stats min=%.4f max=%.4f "
                        "mean=%.4f std=%.4f",
                        float(f.min()), float(f.max()),
                        float(f.mean()), float(f.std()))
        if audio is None:
            log.warning("[AUDIO-DIAG] decode returned None")
            return
        w = audio.get("waveform")
        sr = int(audio.get("sample_rate") or 0)
        log.warning("[AUDIO-DIAG] decoded waveform %r sample_rate=%r dtype=%r",
                    tuple(w.shape) if w is not None else None, sr,
                    str(w.dtype) if w is not None else None)
        if w is None or not sr:
            return
        wf = w.float().cpu()
        log.warning("[AUDIO-DIAG] waveform stats min=%.4f max=%.4f mean=%.4f "
                    "std=%.4f | %.3f s at %d Hz",
                    float(wf.min()), float(wf.max()),
                    float(wf.mean()), float(wf.std()),
                    wf.shape[-1] / float(sr), sr)
        out_dir = folder_paths.get_output_directory()
        path = os.path.join(out_dir, "ltxo_audio_diag.wav")
        flat = wf[0] if wf.ndim == 3 else wf
        if flat.ndim == 1:
            flat = flat.unsqueeze(0)
        peak = float(flat.abs().max())
        if peak > 1.0:
            flat = flat / peak
        pcm = (flat.clamp(-1.0, 1.0) * 32767.0).to(torch.int16)
        import wave as _wave
        with _wave.open(path, "wb") as fh:
            fh.setnchannels(int(pcm.shape[0]))
            fh.setsampwidth(2)
            fh.setframerate(sr)
            fh.writeframes(pcm.t().contiguous().numpy().tobytes())
        log.warning("[AUDIO-DIAG] raw decode written to %s (peak was %.4f)",
                    path, peak)
    except Exception as exc:
        log.warning("[AUDIO-DIAG] probe failed: %r", exc)


def _apply_rtx_vsr(images, vsr):
    """Pixel-space RTX Video Super Resolution on the delivered frames.

    Runs the installed RTXVideoSuperResolution node (comfyui_nvidia_rtx_nodes).
    Spatial upsample is latent and happens before decode; this is after."""
    if not vsr or not vsr.get("enabled") or images is None:
        return images
    if not node_registered("RTXVideoSuperResolution"):
        raise ValueError(
            "[LTX Oasis] RTX VSR is on but RTXVideoSuperResolution is not "
            "registered. Install Nvidia RTX Nodes from ComfyUI Manager "
            "(search RTX), then restart ComfyUI.")
    kind = str(vsr.get("resize_type") or "scale by multiplier").strip()
    if kind not in ("scale by multiplier", "target dimensions"):
        kind = "scale by multiplier"
    quality = str(vsr.get("quality") or "ULTRA").strip().upper()
    if quality not in ("LOW", "MEDIUM", "HIGH", "ULTRA"):
        quality = "ULTRA"
    try:
        scale = float(vsr.get("scale") if vsr.get("scale") is not None else 2.0)
    except (TypeError, ValueError):
        scale = 2.0
    scale = min(4.0, max(1.0, scale))
    try:
        width = int(vsr.get("width") or 1920)
        height = int(vsr.get("height") or 1080)
    except (TypeError, ValueError):
        width, height = 1920, 1080
    width = max(64, min(8192, width))
    height = max(64, min(8192, height))
    import logging
    logging.getLogger("LTXOasis").info(
        "[LTX Oasis] RTX VSR %s quality=%s scale=%.2f target=%dx%d",
        kind, quality, scale, width, height)
    # Call execute() directly: v3 DynamicCombo INPUT_TYPES can inject extra
    # flattened kwargs that execute() does not accept.
    out = node_class("RTXVideoSuperResolution").execute(
        images=images,
        resize_type={
            "resize_type": kind,
            "scale": scale,
            "width": width,
            "height": height,
        },
        quality=quality,
    )
    if hasattr(out, "args"):
        return out.args[0]
    return out


def finish_pipeline(spec, models, cond, latent, loaded, gen, up, audio_enabled,
                    audio_file=""):
    """Everything after sampling. Returns (images, audio_or_None, cache_pair).

    cache_pair is a CPU snapshot of the pre-decode video latent (and
    generate-mode audio) for the scene-bar cache. None if the snapshot
    could not be taken. The caller files it under the encoded clip's id.

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
         real content and come off the back.
      7. Optional RTX VSR — pixel-space, on the delivered frames only, so a
         motion-context head is not upscaled and then cropped."""
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
    audio_latent = None
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
            _audio_diag(latent, audio_latent, audio)
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

    cache_pair = None
    try:
        from . import latent_cache as lcache
        cache_audio = (audio_latent
                       if audio_enabled and not (audio_file or "").strip()
                       else None)
        cache_pair = lcache.snapshot_pair(
            latent, cache_audio, ctx_latent_frames=ctx,
            deliver_frames=int(gen["frames"]),
            fps=float(gen.get("fps") or spec.get("fps_default") or 25.0),
            quantum=int(spec["frame_quantum"]))
    except Exception:
        cache_pair = None

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
    images = _apply_rtx_vsr(images, (up or {}).get("vsr"))
    return images, audio, cache_pair


def to_video(images, fps, audio=None):
    kw = dict(images=images, fps=float(fps))
    if audio is not None:
        kw["audio"] = audio
    return first("CreateVideo", **kw)
