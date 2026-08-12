# LTX Oasis 🌴

Everything works like Image Oasis. If you know IO, you already know this node. This page covers the video-specific parts and the reasoning behind the defaults.

## Quick start

1. **Model**: pick your architecture (LTX 2.3 or LTX 2.5), then Diffusion or GGUF, the model, its text encoder(s), and the video VAE. For sound, pick the audio VAE here and set **Audio** under Video / Audio to *Generate* (or *File* to drive the video from your own audio track).
2. **Prompt Enhancer**: Text → Video / Image → Video at the top sets both the pipeline and the enhancer style. Short idea in User Prompt, ✨ Enhance to expand it, or write straight into the Enhanced Prompt box. Negative Prompt sits under Enhance (same order as IO).
3. Press **▶** (keep seed) or **🎲** (randomize + generate) above the render pane. The timer runs while it cooks; **⏹** interrupts. Every render lands in the scene bar; click any thumbnail to bring it back.

## Architecture: 2.3 or 2.5

Both are the 22B distilled model and both run through the same pipeline. The differences that matter when you switch:

- **Text encoders.** 2.3 takes two (Gemma-3 plus the LTX text projection). 2.5 takes **one** - it ships Gemma-4-12B with the projection already baked into the file. The Model section changes its picker count to match, so just follow the UI. This is not a shortcut you can skip: giving the combined 2.5 file to a two-slot loader builds a mismatched encoder and dies with an unpack error.
- **Defaults.** 2.5 opens at 24 fps and 960×544; 2.3 at 25 fps and 1280×720. Both are 121 frames on the same 8n+1 grid.
- **Spatial Upsample.** 2.5 has no upscaler of its own yet, so it loads the 2.3 one - which is exactly what the official 2.5 two-stage workflow does.

Sigmas, sampler and CFG are the same on both. Prompt Beats, guides, audio, motion context, the player and the scene bar all behave identically. The node keeps its name and class id whichever you pick, so old workflows still load.

## LoRAs

The IO stack, verbatim: **+ Add LoRA**, pick a file, set strength (text-encoder strength mirrors it behind the scenes). Drag the grip to reorder; they apply top to bottom. The ●/○ button toggles a LoRA without losing its settings. The **trigger words** field under each enabled LoRA is prepended to the positive prompt automatically (in stack order, comma-separated).

## The enhancer

✨ Enhance is powered by Image Oasis - same pack, always present - and shares IO's resident LLM (models go in `models/LLM`, GGUF). Pick the model in **Prompt Enhancer**; **Enhancer Settings** at the bottom of that section exposes Auto GPU layers (leave it on), context size, and max tokens. Enhance is disabled while a video is generating; loading the LLM mid-run would evict the diffusion model.

## Modes

- **Text → Video**: the prompt alone drives everything.
- **Image → Video**: a Start image becomes (approximately) the first frame. Drop or paste an image onto the thumbnail; dragging a render straight out of Image Oasis works. Loading an image into Start auto-selects this mode, and clearing the slot (✕) returns to Text → Video - the switch itself still works manually on top of that. You can also **drag the current frame out of this node's player** (pause/scrub to the frame you want, then drag the video onto Start or a beat guide slot).

### ↻ Continue from viewed video

Chains clips together in *any* mode, including T2V. **The tail source is whatever's in the viewer**: the next run continues from the clip currently showing in the right pane. Click a different thumbnail in the scene bar and the next run continues from *that* clip instead. It overrides the Start slot while active.

Tick it once and keep hitting 🎲: each clip picks up where the viewed one ended, then becomes the viewed clip itself, so the chain walks forward automatically. Use 🎬 Create Movie (or any editor) to stitch the saved files afterwards.

#### Motion context

A single still tells the model *where* things are, not where they were **going**. Pose is ambiguous: a leg mid-stride looks the same swinging forward or back, and a camera frozen mid-pan gives no hint which way it was moving. That's why chained clips used to lurch at every join - the model re-invented the motion each time.

**Motion context** pins the last second or two of the previous clip in front of the timeline as real, frozen frames. The model reads direction, speed, gait phase and camera drift straight out of them instead of guessing. Those frames are cropped off after decode, so you never see them.

| Setting | Window | At 25fps |
|---|---|---|
| Last frame only | 1 frame | the old behaviour |
| 9 / 17 / 25 / 33 / 41 / 49 frames | 2-7 latent frames | 0.36s / 0.68s / 1.00s / 1.32s / 1.64s / 1.96s |

25 frames at 25fps is exactly one second and a good default. 49 is just under two seconds, the longest window on offer. Bigger windows cost more sampling time and nothing else, but that cost is real: the overhead is 8 frames per latent frame, so a 49-frame window samples 56 extra frames in front of your clip.

**Your clip does not get shorter.** Frames still means delivered frames. The context is extra work sampled in front of your clip, not a slice taken out of it - a 121-frame render with a 25-frame window samples 153 and delivers 121.

**Audio is untouched.** In File mode the context window is padded with silence, so your uploaded track still starts on delivered frame 1 and is muxed exactly as supplied - never trimmed, resampled or shifted. In Generate mode the previous clip's tail audio is frozen alongside the frames, so ambient beds, music and footfalls carry across the cut instead of restarting. With audio Off nothing happens at all.

Windows are 8n+1 counts like every other LTX length. Anything else is snapped down. If the source clip is too short for the window you picked, it drops to the largest one that fits and says so in the console.

A T2V run with Continue active silently becomes image-conditioned from the second run on. That's expected; it's how the chain works.

Two things worth knowing: the tail is always read from the file in the viewer, so a clip loaded from disk behaves exactly like one you just rendered. And if the tail source runs at a different frame rate than your render, the motion reads at the wrong speed - the console warns when that happens.

## Reference images

- **Start Frame**: the I2V anchor. The info line under the button shows resolution and file size; the ⤢ button copies the image's dimensions into Width/Height (snapped to /32, which LTX requires).

Keyframe guides live on **Prompt Beats** (their own section), not under references.

## Prompt Beats (multi-prompt + guides)

One timeline, one list. The **Enhanced Prompt** is the whole-clip description: subject, style, setting. Each **beat** is a stretch of time that can carry:

- **Local text**: what *happens* during that stretch (PromptRelay attention mask)
- **Guide image** (optional): a look/pose pinned at the **start** of that beat (`LTXVAddGuide`); strength under the thumb. Hover the thumb and click ✕ to clear it.

> Enhanced: *cinematic shot of a woman in a red coat inside a dim apartment, evening light*
> Beat 1: *she walks slowly toward the window* + start pose as guide
> Beat 2: *she opens the window and leans out into the rain* + end pose as guide

**Frames** on each beat sets duration. Leave every beat at 0 to split the video evenly. The meter under the beat list shows how your beats add up against the Video frame count: green = match, amber = short (frames past the last beat follow the Enhanced prompt alone, no local steering), red = over (beats past the video's end get truncated). When the sum doesn't match, **Match frames** sets Video frames to the beat sum (snapped to the LTX grid). Add as many beats as you need; there is no 3-guide hard limit (VRAM/latent size is the real constraint). Guide frames are cropped out after sampling and never appear literally in the output.

Tips: 2-3 beats for a 5-second clip is plenty; beats describe *actions*, not new scenes. Empty text with a guide is fine (guide-only beat). Empty guide with text is fine too.

## Video / Audio

- **Width / Height**: LTX wants multiples of 32; the ratio locks, ↔ swap, and ⤢ use-size all snap accordingly. Sweet spot with a reference image: render at **half the source image's resolution** (e.g. 1536×1536 source → 768×768 video), a clean 2:1 supersample.
- **Frames**: snaps to the LTX grid (8n+1: 97, 121, 145...). The ≈ seconds line updates live as you type.
- **FPS**: playback rate of the encoded file. LTX's native rhythm is 25.
- **Cond. FPS**: the frame rate stamped into the model's conditioning: how fast the model *thinks* time passes, independent of playback. 0 = follow FPS, which is right 95% of the time. The other 5%: conditioning 25 + encoding 12.5 = smooth slow motion; conditioning 25 now + RIFE-interpolating to 50 later keeps motion natural.
- **Audio**: three modes, all needing the Audio VAE under Model when not Off:
  - **Off**: silent video.
  - **Generate**: the model dreams the soundtrack from the prompt (describe the soundscape explicitly for best results).
  - **File**: *audio-driven video.* Upload or drop a real audio file; it's trimmed to the video's duration, encoded into the latent, and masked as fixed, so the model generates video that **matches your audio** (lip sync, singing, music-timed motion). The output muxes your original waveform (not a vocoder re-decode), so playback stays in sync with the frames. Longer files are trimmed; shorter files keep the original and generate the audio for the remaining tail.

## Generation

The distilled LTX models sample on a fixed **sigma schedule** instead of a step count. The default list is the known-good template schedule (9 values ≈ 8 steps). Fewer values = faster and rougher; you can hand-edit the list. The ↺ button next to Sigmas restores the arch default. CFG stays at 1 for distilled models; raising it roughly doubles the time per step for usually-marginal benefit.

**Negative prompt** works in both regimes, through different plumbing. At CFG > 1 (base model territory) it's standard classifier-free guidance. At CFG 1 the sampler never runs an unconditional pass, so the node automatically routes the negative through **NAG** (Normalized Attention Guidance, KJNodes' LTX2 NAG; ComfyUI-KJNodes must be installed) which injects it directly into cross-attention. Leave the box empty and neither path activates.

Seed handling is IO's: the ▶/🎲 pair by the seed field and on the header, plus the After-gen control (fixed / increment / decrement / randomize).

## Upscale: Spatial Upsample (×2)

Runs the LTX 2× latent upsampler after the main sample (2.5 runs the 2.3 upscaler, as its own reference workflow does). **Polish pass** additionally re-samples at the upscaled resolution: much sharper, but it runs the full diffusion model at 4× the tokens, so it's heavy (its re-noise sigma list is editable; ↺ resets it; fewer/lower values = subtler and faster). Off = upsample-only: fast, slightly softer. The sampled video is cached, so toggling Upscale re-runs only the upsample + decode, not the generation.

Off by default for two reasons: with a reference image active it can drift your subject's likeness, and the half-resolution-render + supersample route usually looks better anyway.

## The player & scene bar

Scrub bar with a frame counter, ▶/⏸ (Space), frame-step ⏮/⏭ (arrow keys; Shift = 1 second), mute, playback speed, and ⛶ lightbox (scroll = zoom, drag = pan, double-click = reset). Pause on any frame and **drag the video** onto Start or a beat guide to reuse that frame.

**Clip**: scrub to a frame and press **[** (mark in) then **]** (mark out), then **Clip**. That writes a trimmed copy under `output/video/clip_NNNNN.mp4` and adds it to the scene bar. Useful for keeping only the stretch you want before Create Movie.

The loop button cycles through three playback modes: **off → loop** (repeat the current clip) **→ cycle** (play through the scene bar clip after clip, a rolling dailies reel).

The **scene bar** keeps up to 48 renders, one click away, surviving tab switches and page reloads (saved entries also survive a ComfyUI restart; temp previews don't). The **+** tile loads any video from your `output/` folder into the bar. **💾 Save** (header button; hides when the pane is empty) copies the current preview losslessly into your output folder under your Save prefix. Scene ‹ n/m › nav sits in the info bar. A ✓ badge marks saved entries.

**Rearranging the bar.** Hover a thumbnail and click its **✕** to drop it from the strip; the file on disk is untouched, so this is housekeeping, not deletion. To change the order, **press and hold a thumbnail for a moment, then drag** it where you want. A thin accent line shows where it will land, and the ✕ buttons hide while you're dragging so you can't remove a clip by accident. A quick tap still just loads the clip, so the hold is what tells the two apart. Order matters for 🎬 Create Movie, which concatenates left to right, so this is how you sequence a run before stitching it.

### 🎬 Create Movie

Concatenates every **saved** clip in the scene bar (left to right) into one file at `output/video/create_movie_NNNNN.mp4`. Clips must match resolution and FPS. When every clip shares the same bitstream params, video is stream-copied (lossless). If any clip differs (common after Clip, which re-encodes), the movie is re-encoded so the join stays clean. The 🔊/🔇 toggle controls audio: on, audio is re-encoded to AAC and silent clips get silence so the timeline stays aligned; off, the movie is silent.

Audio across the joins is rebuilt rather than blindly concatenated: each clip's track is trimmed to exactly the length its frame count calls for (removing the AAC tail padding that used to drop a short hole into continuous ambience, and stopping audio from walking late against picture down a long bar), and the samples either side of each cut are crossfaded so the splice cannot click. Details land in the ComfyUI console under `[LTXO Movie]`.

The finished movie is added to the scene bar as a saved entry, so you can play it back immediately. It is not excluded from the next Create Movie: concatenating a movie with further clips is how you build runs longer than the bar holds. Remove what you don't want with a thumbnail's X first.

## Encode

`auto` everything is a good default. webm accepts VP9/AV1 only; mp4 takes h264/hevc; mkv takes anything. Quality presets map to per-codec CRF values (codec scales differ, which is why presets rather than one raw number); `custom` exposes CRF directly. **Save prefix** sets where 💾 Save lands under `output/` and the filename stem (default `video/LTX23Oasis` → `output/video/LTX23Oasis_...`). Note hevc previews may not play in-browser; the file itself is fine.

## Presets & Theme

Presets capture the model/generation setup and **never** your prompts, seed, or reference images; loading one can't wipe in-progress work. Same cards, expand-for-details, and drag-to-reorder as IO, stored server-side under `user/ltx23_oasis/`. The Theme section edits **this node's** palette (independent of Image Oasis) - and it also skins **Video Oasis Viewer**: the Viewer has no theme editor of its own and follows whatever palette you set here, so both nodes stay matched on the canvas.
