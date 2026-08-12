# LTX Oasis

Part of the **Oasis Suite**. Node class id: `LTX23Oasis`.
Frontend: [`../web/ltx23_oasis.js`](../web/ltx23_oasis.js). Suite overview:
[root README](../README.md).

All-in-one LTX video generation in the Image Oasis UI shape, covering **LTX 2.3
and LTX 2.5**. Encode, player, scene bar, Clip, Create Movie, and Save go
through the in-pack **Video Oasis Viewer** path - you do not need a separate
video pack.

In-node Help is the same text as [`ltx23_oasis_help_content.md`](ltx23_oasis_help_content.md).

## Quick start

1. **Model**: pick your architecture (see below), then Diffusion or GGUF, the
   model, its text encoder(s), and the video VAE. For sound, pick the audio VAE
   and set **Audio** under Video / Audio to *Generate* (or *File* to drive the
   video from your own track).
2. **Prompt Enhancer**: Text → Video / Image → Video at the top sets both the
   pipeline and the enhancer style. Short idea in User Prompt, ✨ Enhance to
   expand it, or write straight into the Enhanced Prompt box. Negative Prompt
   sits under Enhance (same order as Image Oasis).
3. Press **▶** (keep seed) or **🎲** (randomize + generate). Every render lands
   in the scene bar; click any thumbnail to bring it back.

## Architectures

| | LTX 2.3 22B (Distilled) | LTX 2.5 22B (Distilled) |
|---|---|---|
| Text encoders | 2 - Gemma-3 + LTX text projection | 1 - Gemma-4-12B, projection baked in |
| Default fps | 25 | 24 |
| Default size | 1280x720x121 | 960x544x121 |
| Spatial Upsample | own x2 upscaler | borrows the 2.3 upscaler |

The **single text encoder on 2.5 is required, not a shortcut**: its file
already contains the projection, so handing it to a two-slot loader builds a
mismatched encoder and fails inside `sd1_clip` with an unpack error. The Model
section drops to one text-encoder picker when you select 2.5, so following the
UI keeps you right.

Sigmas, sampler and CFG are identical across the two, as are the frame quantum
(8n+1), PromptRelay, Prompt Beats, guides, audio modes, motion context and the
player/scene-bar toolkit. The node keeps the `LTX23Oasis` class id whichever
you pick, so existing workflows load unchanged.

## Dependencies

| Need | Package / note |
|------|----------------|
| Required | This Oasis Suite pack (includes Video Oasis Viewer encode/player) |
| Optional | `ComfyUI-GGUF` for GGUF diffusion |
| Optional | `ComfyUI-KJNodes` for LTX2 NAG when CFG is 1 and a negative is set |
| Optional | `llama-cpp-python` (CUDA/Metal) for the GGUF prompt enhancer - same as Image Oasis |

Presets and theme: `ComfyUI/user/ltx23_oasis/`. HTTP API: `/ltx23_oasis/*`
(Save and frame extraction ride the shared `/video_oasis/*` routes).

## LoRAs

Same stack as Image Oasis: **+ Add LoRA**, strength, drag to reorder, ●/○
toggle, optional **trigger words** prepended to the positive prompt.

## The enhancer

✨ Enhance is powered by Image Oasis's resident LLM (`models/LLM`, GGUF). Pick
the model under **Prompt Enhancer**; **Enhancer Settings** exposes Auto GPU
layers, context size, and max tokens. Enhance is disabled while a video is
generating so the LLM load cannot evict the diffusion model mid-run.

## Modes

- **Text → Video**: prompt alone.
- **Image → Video**: Start image ≈ first frame. Drop/paste onto the thumbnail;
  dragging a render from Image Oasis works. You can also **drag the current
  frame out of this node's player** onto Start, a beat guide, or any
  image input on the graph (Load Image, Image Oasis refs, ...).

### ↻ Continue from viewed video

Chains clips in *any* mode (including T2V). The next run continues from
**whatever is in the viewer**. Click another scene-bar thumb and the chain
continues from that clip instead. Tick once and keep hitting 🎲 to walk
forward; stitch with 🎬 Create Movie afterwards.

**Motion context** (v1.6) decides how much of the previous clip the model gets
to see. A single still carries pose but no motion - a leg mid-stride looks
identical swinging forward or back - so chained clips used to lurch at the
join. Pinning the previous second in front of the timeline as frozen frames
gives the model real direction, speed, gait phase and camera drift. Windows run
out to just under two seconds.

| Setting | Window | At 25fps |
|---|---|---|
| Last frame only | 1 frame | pre-1.6 behaviour |
| 9 / 17 / 25 / 33 / 41 / 49 | 2-7 latent frames | 0.36 / 0.68 / 1.00 / 1.32 / 1.64 / 1.96s |

Context frames are cropped after decode and never appear in the output.
**Frames still means delivered frames** - a 121-frame render with a 25-frame
window samples 153 and delivers 121. Audio is untouched: File mode pads the
window with silence so your track still starts on delivered frame 1 and is
muxed exactly as supplied; Generate mode freezes the previous clip's tail audio
so ambient and music carry across the cut.

The tail is read from the file in the viewer, so loaded-from-disk clips behave
exactly like fresh renders. Mismatched source fps is warned about in the
console (the motion reads at the wrong speed).

## Reference images

- **Start Frame**: I2V anchor. Info line shows resolution/size; ⤢ copies
  dimensions into Width/Height (snapped to /32).

Keyframe guides live under **Prompt Beats**, not under references.

## Prompt Beats (multi-prompt + guides)

The **Enhanced Prompt** is the whole-clip description. Each **beat** can carry:

- **Local text**: what happens during that stretch (PromptRelay attention mask)
- **Guide image** (optional): look/pose at the **start** of that beat
  (`LTXVAddGuide`); strength under the thumb

**Frames** on each beat sets duration. Leave every beat at 0 to split evenly.
The meter under the list: green = match, amber = short, red = over. **Match
frames** snaps Video frames to the beat sum. Guide frames are cropped out after
sampling and never appear literally in the output.

## Video / Audio

- **Width / Height**: multiples of 32; ratio lock, ↔ swap, ⤢ use-size snap.
  Sweet spot with a reference: render at **half** the source resolution.
- **Frames**: LTX grid (8n+1). ≈ seconds updates live.
- **FPS**: playback rate of the encoded file (native rhythm is 25 on 2.3, 24
  on 2.5).
- **Cond. FPS**: how fast the model *thinks* time passes; `0` = follow FPS.
- **Audio** (needs Audio VAE when not Off):
  - **Off** - silent
  - **Generate** - soundtrack from the prompt
  - **File** - audio-driven video; your waveform is muxed back (not vocoder-decoded)

## Generation

The distilled LTX models use a fixed **sigma schedule** (default ~9 values ≈ 8
steps), the same list on 2.3 and 2.5. ↺ restores the arch default. CFG stays at
1 for distilled models.

**Negative prompt**: at CFG > 1, standard CFG; at CFG 1 the node routes through
**NAG** (KJNodes LTX2 NAG). Empty negative = neither path.

Seed: ▶/🎲 by the seed field and header, plus After-gen
(fixed / increment / decrement / randomize).

## Upscale: Spatial Upsample (×2)

LTX 2× latent upsampler after the main sample. **Polish pass** re-samples at
the upscaled resolution (heavy). Sampled video is cached - toggling Upscale
re-runs only upsample + decode. Off by default (likeness drift with refs; half-res
+ supersample often looks better).

## Player & scene bar

Same toolkit as [Video Oasis Viewer](../video_oasis/video_oasis_README.md):

- Scrub, Space, arrows, mute, speed, lightbox
- Drag the paused frame onto Start, a beat guide, or any image input on
  the graph
- **Clip** (`[` / `]` then Clip)
- Loop: off → loop → cycle
- Scene bar (≤48), **+** load from output, **Save** (header; hides when empty)
- History survives tab switches and reloads (temps pruned after Comfy restart)

### 🎬 Create Movie

Concatenates every **saved** scene-bar clip into
`output/video/create_movie_NNNNN.mp4`. Stream-copy when params match;
re-encode when needed (common after Clip). Audio toggle pads silence so the
timeline stays aligned. Audio across each join is rebuilt rather than blindly
concatenated: every clip is trimmed to exactly the length its own frame count
calls for (no AAC tail padding leaking in as a gap, no drift down a long bar)
and the samples either side of the cut are crossfaded. Per-clip detail prints
to the console under `[LTXO Movie]`.

The movie lands back in the scene bar as a saved entry and is **not** excluded
from the next Create Movie, so movie-plus-clips is how you build runs longer
than the bar holds.

## Encode

`auto` defaults are fine. webm → VP9/AV1; mp4 → h264/hevc; mkv → anything.
Quality presets map to per-codec CRF; `custom` exposes CRF. **Save prefix**
defaults to `video/LTX23Oasis`. HEVC may not preview in-browser.

## Presets & Theme

Presets capture model/generation setup - **never** prompts, seed, or reference
images. Stored under `user/ltx23_oasis/`. Theme edits **this node's** palette
(independent of Image Oasis).

## Vendored code

PromptRelay / patches from WhatDreamsCost-ComfyUI (LTX Director) live under
`vendor/` and require **GPL-3.0-or-later** for the pack. See
[../LICENSE](../LICENSE).
