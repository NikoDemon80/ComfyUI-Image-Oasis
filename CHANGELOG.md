# Changelog

## v1.9.1

Click-to-pause in the player. Class ids unchanged.

### Video Oasis Viewer and LTX Oasis

#### Added
- Click the video to play/pause, same as Space or the ▶/⏸ button. Frame
  drag still works (a real drag never counts as a click). Off in the
  lightbox, where click/drag pans and double-click resets.

---

## v1.9.0

NVENC GPU encode, browser preview copies for FFV1 / ProRes / hevc, and a new
Oasis Metadata node. Existing class ids unchanged: `ImageOasis`,
`VideoOasisPreview`, `LTX23Oasis`, `AudioOasis`; new: `OasisMetadata`.

### Pack / registry

#### Added
- **Oasis Metadata** (`OasisMetadata`): pick a saved PNG or video and read
  the embedded prompt plus Oasis generation settings. Outputs two STRING
  sockets (prompt, settings). Core Load Image / Load Video do not expose
  those tags. Image and File are separate pickers; the image-upload widget
  cannot take video.
- Shared `oasis_nvenc.py` helper: detects NVENC once per session with a real
  test encode, so a listed-but-broken encoder is never offered.

---

### Video Oasis Viewer and LTX Oasis

#### Added
- **GPU Encode** (On / Off, default On) encodes with NVIDIA NVENC. Shown only
  when NVENC works and the codec has a GPU version: h264 and hevc on any RTX
  card, av1 on RTX 40-series and newer. `auto` writes h264. Quality presets
  map to NVENC cq; the scene bar badge reads `nvenc cq` instead of `crf`. A
  failed GPU encode is redone on the CPU and flagged with a warning. Clip and
  the Create Movie re-encode fallback follow the same setting.
- **Browser preview copies.** FFV1, ProRes, and hevc where the browser can't
  play it are shown through a small h264 copy at the same size, fps and frame
  count. The info bar reads "preview copy". Save, Clip, frame drag and the
  motion-context tail always use the real file. Copies live in
  `temp/oasis_proxy` and clear on restart. Scene-bar thumbnails for these
  files come from a server-side frame grab.

#### Changed
- hevc in mp4/mov is tagged `hvc1`, the label browsers and Apple players
  expect.

#### Fixed
- Clip on a B-frame source dropped the last frames when the range ran to the
  end of the file.
- LTX Oasis no longer writes `ltxo_audio_diag.wav` to `output/` and logs
  `[AUDIO-DIAG]` warnings on every audio decode (leftover diagnostic from
  v1.8.0).

---

## v1.8.0

CSRF gate so Manager can treat this as Latest after 1.6/1.7 were banned,
plus Continue-from-latent, AV1-in-mp4, RTX VSR, and Audio Oasis chop tools.
Class ids unchanged: `ImageOasis`, `VideoOasisPreview`, `LTX23Oasis`,
`AudioOasis`.

### Pack / registry

#### Added
- Same-origin **Origin must match Host** check on mutating POST/DELETE
  routes (presets, themes, save, save_segments, clip, create movie, enhance).
  That is the CSRF gate 1.6/1.7 were banned for missing (policy-v0.2
  UNAUTHENTICATED_SIDE_EFFECT). Same-origin UI fetch already sends Origin; a
  cross-site form POST does not match and is rejected.

---

### LTX Oasis

#### Added
- **Continue from viewed video** prefers a cached sampled latent for the clip
  in the scene bar (same idea as H3 Oasis). Clips with no latent — loaded from
  disk, Clip, Create Movie — still decode the viewer file.
- **RTX Video Super Resolution** in Upscale, a toggle above Spatial Upsample.
  Settings (× Scale or target size, quality) appear when it is on. It calls
  `RTXVideoSuperResolution` from Nvidia RTX Nodes on the decoded frames.
  Spatial Upsample still runs in latent first if both are on. Toggling VSR
  reuses the sampled latent.

#### Changed
- **AV1** is allowed in mp4 as well as webm (AOMedia ISOBMFF). Auto+AV1 still
  homes to webm. Create Movie keeps an AV1 mp4 bar in mp4 instead of remuxing
  it to webm.

---

### Video Oasis Viewer

#### Changed
- **AV1** is allowed in mp4 as well as webm, same as LTX Oasis. Auto+AV1 still
  homes to webm. Create Movie keeps an AV1 mp4 bar in mp4.

---

### Audio Oasis

#### Added
- **Snap: 17k+5 (H3)** next to 8n+1 (LTX), so chops stay legal for MiniMax H3
  (shortest useful segment is 22 frames).
- **split every** can step in seconds or in frames at the Grid FPS.
- **Frame-count stepper** on each segment row: type a length or click the
  arrows. Steps by the snap grid. Resizes that segment; the neighbour absorbs
  the difference. The last row moves its start chop (the track end is fixed).

#### Changed
- Dragging a chop defaults to **shift later** (later segments keep their
  length). **stretch** is the old one-handle resize. Alt still inverts for
  one drag.
- Until you save, the whole track is already the AUDIO output. Unsaved rows
  no longer look selectable; **Use full track as output** says it is already
  on. Clicking an unsaved row tells you to save first.

#### Fixed
- Clicks on the Segments pane (row select, Use full track) were swallowed by
  the AUDIO output socket. The widget now stops pointer events the same way
  the other Oasis nodes do.

---

## v1.7.0

LTX 2.5 support and a rebuild of Create Movie's audio handling. Class ids are
unchanged: `ImageOasis`, `VideoOasisPreview`, `LTX23Oasis`, `AudioOasis`.

### LTX Oasis

#### Added
- **LTX 2.5 22B (Distilled)** as a second architecture in the picker. One
  registry entry, no new node and no new class id - the node keeps the
  `LTX23Oasis` id and the dropdown chooses which model family a run targets.
- 2.5 takes a **single text encoder**. It ships Gemma-4-12B with the LTX
  projection already baked into one file, where 2.3 needs Gemma-3 plus a
  separate projection file. The Model section drops to one text-encoder picker
  when 2.5 is selected. This is load-bearing rather than cosmetic: feeding the
  combined file to a two-slot loader builds a mismatched encoder and dies
  inside `sd1_clip` with an unpack error.
- 2.5 defaults follow its reference workflow: 24 fps and 960x544x121, against
  2.3's 25 fps and 1280x720x121. The sigma schedule, sampler and CFG are
  byte-identical to 2.3, verified against the official single-stage and
  two-stage 2.5 workflows.

#### Changed
- The node header now reads **LTX Oasis** instead of LTX2.3 Oasis, since the
  node is no longer 2.3-only. Display name only: the class id stays
  `LTX23Oasis`, the folder stays `ltx23_oasis/`, routes stay `/ltx23_oasis/*`,
  and presets and themes stay under `user/ltx23_oasis/`. Saved workflows keep
  working, and any node you renamed by hand keeps your title.

#### Notes
- Frame quantum, PromptRelay, Prompt Beats, guides, audio modes, motion
  context and the whole player/scene-bar toolkit work the same on 2.5 as on
  2.3. Both use the same 8x temporal compression and 8n+1 frame grid.
- 2.5 has no spatial upscaler of its own yet. Selecting **Spatial Upsample**
  on a 2.5 run loads the 2.3 upscaler, which is what the official two-stage
  2.5 workflow does. Still OFF by default, same identity-drift reason as 2.3.

---

### Create Movie (Video Oasis Viewer and LTX Oasis)

#### Fixed
- **The gap in the audio at every join.** Each clip on disk carries its own
  AAC encode, and an AAC encode pads the end of the stream out to a whole
  1024-sample block. Decoding hands that padding back as real zeros, so
  concatenating dropped roughly 23ms of silence into the middle of continuous
  ambience at every cut. Each clip's audio is now trimmed to exactly the
  length its own frame count calls for.
- **Audio drifting late against picture down a long scene bar.** Clip files
  come out fractionally longer than their own video, and the error accumulated
  across every join because audio length was read from the container duration.
  Length now comes from frames divided by fps, so audio and video are measured
  off the same ruler.
- **The weak opening on the incoming clip.** A generator's audio settles over
  the first few frames, which a trim cannot fix because it is real audio, just
  quiet. The samples either side of a join are rebuilt by crossfading the two
  clips' own interiors played backwards - reversed ambience is
  indistinguishable from forwards ambience, and reversing makes the patch
  start on the exact sample it replaces, so the splice cannot click. Sample
  count is unchanged, so sync holds.

#### Notes
- At a join landing on speech or a distinct musical event, roughly 36ms of
  reversed material may be audible. Widen or narrow it with `_SEAM_PRE_MS` and
  `_SEAM_POST_MS` at the top of the Create Movie section.
- Seam repair is skipped, not forced, when a clip is too short to donate
  samples or when either side of the join is silent - a deliberately quiet
  clip stays quiet.
- Create Movie now prints what it did to each clip's audio to the ComfyUI
  console, tagged `[VOV Movie]` or `[LTXO Movie]`.

---

## v1.6.0

Motion context for chained LTX clips, plus a fourth node. Class ids stay
stable: `ImageOasis`, `VideoOasisPreview`, `LTX23Oasis`. New: `AudioOasis`.

### LTX2.3 Oasis

#### Added
- **Motion context** for *Continue from viewed video*: a window of the previous
  clip (9 / 17 / 25 / 33 / 41 / 49 frames - 25 is one second at 25fps, 49 is
  just under two) is encoded and frozen at the head of the timeline, then
  cropped before decode. A single frame carries pose but no motion, so chained
  clips used to re-invent direction and speed at every join; with real frames
  the model reads camera drift, travel direction and gait phase straight out of
  them. Selector appears under the Continue checkbox; **Last frame only** keeps
  the pre-1.6 behaviour.
- Generate-mode audio continuity: the previous clip's tail audio is frozen
  alongside the video context, so ambient beds, music and transient events
  (footfalls) carry across a cut instead of restarting.
- `stage_context_video.py`: viewer-entry resolution and PyAV tail decode
  (frames + audio), plus `context_span_px`, the single definition of how many
  pixel frames a latent context window occupies.

#### Changed
- **Tail source is now the file in the viewer, not an in-memory tensor.**
  `_LAST_FRAME` (IMAGE tensor per io_id) is replaced by `_TAIL_SRC`, a
  `{video, subfolder, type}` reference; frames are decoded off disk at generate
  time. Clips loaded from `output/` now chain identically to fresh renders, and
  nothing large is pinned per io_id.
- `POST /ltx23_oasis/set_tail` takes a JSON entry descriptor instead of a
  multipart PNG upload. The frontend no longer spins up a throwaway `<video>`
  to seek and canvas-encode the last frame.
- Beat guides and PromptRelay beats are laid out against the padded timeline,
  so guide indices and beat boundaries still land on the delivered frames they
  were written for.
- Context frames are resized to the render resolution before encoding, so a
  viewer entry at a different resolution or aspect chains cleanly.

#### Fixed
- `build_mux_audio` compares the uploaded track against the delivered frame
  count, not the sampled length. Sampling extra frames in front would otherwise
  have made every file-driven track look short and had a decoded generated tail
  appended to it.
- Context frames are cropped in **pixel** space after decode, never by slicing
  latent frames off the head. LTX's first latent frame decodes to one pixel
  frame and each later one to eight, so cropping the latent promotes a delta
  frame into the anchor position - the decoder renders a whole quantum of
  motion into a single frame and takes a few more to settle, visible as a
  shimmy at every scene join.
- The front cut is the context *span* (`8n+1`), not the sampled overhead
  (`8n`). The two differ by a constant 7 frames of real content; trimming the
  overhead made each clip start 7 frames late, visible as a jump ahead at the
  join. The surplus now comes off the back.

#### Notes
- Motion context costs sampling time proportional to the window (a 25-frame
  window on a 121-frame render samples 153) and nothing else. Delivered frame
  counts, audio length and audio sync are unchanged.
- The context window is trimmed after the spatial upsampler rather than before,
  because cropping earlier reintroduces the re-anchoring artifact. With
  **Spatial Upsample** enabled those frames cost extra upscale/polish work.
- Legacy saved values from testing builds (8 / 24 / 32) snap down to the
  nearest legal window (off / 17 / 25).

---

### Video Oasis Viewer

#### Changed
- **Scene bar holds 48 clips**, up from 24 in v1.5 (`HISTORY_CAP`). LTX2.3
  Oasis's bar shares the constant and gets the same capacity. Existing
  histories are unaffected; the bar simply stops pruning as early.

---

### Audio Oasis (new node)

Waveform chopper and segment saver (`AudioOasis`). Loads an mp3/wav/flac/m4a,
cuts it into segments on a waveform, saves them in numbered order, and hands
the selected clip to the graph as a normal `AUDIO` output.

#### Added
- **Browser-side decode.** Waveform, duration, sample rate, channel count and
  peak/RMS levels appear on upload with no server round trip.
- **Chop points**: click the waveform to drop one, drag to slide, double-click
  or right-click to remove. **split every N s** bulk-places evenly spaced
  points that you can still edit freely afterward.
- **Grid & Snap**: FPS plus three snap modes - **8n+1 (LTX)** (default),
  **frames**, and **off** - with **Re-snap** to re-quantize existing points
  after a mode or FPS change. Each segment row shows its frame count and flags
  any length LTX would reject.
- **Analysis**: BPM and estimated musical key via `librosa` (optional
  dependency; every other feature works without it, and the Analyze button
  returns a clear message when it is missing).
- **Save segments** writes `<track>_seg001.<ext>`, `<track>_seg002.<ext>`, ...
  under `input/audio_oasis/<track>/` in the source file's own format,
  re-encoded rather than bitstream-copied so cuts land sample-accurate instead
  of on the nearest frame boundary (~20-30ms off).
- **Load saved set** restores track, chop points, FPS and segment list from a
  set's `manifest.json`. Saved sets live on disk, so they survive ComfyUI
  restarts even if the workflow was never saved. If the source file is gone,
  segments stay selectable and draggable; only waveform and preview are lost.
- **Segment drag-out**: drag a saved segment's grip onto LTX2.3 Oasis's audio
  slot to use it as that node's audio-driven-video input, no upload and no
  wire. Same socketless pattern as the rest of the suite.
- **Use full track as output** toggles whether the `AUDIO` socket carries the
  whole track or a single selected segment.
- Independent theme system scoped to `.ao-widget`, with its own active palette
  and named-palette library under `user/audio_oasis/`. Image Oasis, LTX2.3
  Oasis and Audio Oasis can show three different palettes at once.
- In-node **Help** from `audio_oasis_help_content.md`.
- HTTP routes under `/audio_oasis/*` (analyze, save_segments, saved_tracks,
  load_manifest, help, theme, themes, save_named_theme, delete).
- `librosa` listed commented-out in `requirements.txt`, alongside
  `llama-cpp-python`, as an opt-in dependency.

#### Notes
- Layout follows the suite standard: full-width waveform strip on top, then the
  IO/LTXO two-column body with **Segments** in the right output pane and a
  **Bypass Node** button under the left column.
- `IS_CHANGED` keys on the selected file's mtime and size, not just its name.
  Re-saving segments that produce a byte-different file under the same name
  would otherwise serve ComfyUI's cached `AUDIO` from the previous run.
- Supported formats: mp3, wav, flac, m4a/aac. Segments save in whichever of
  these the source already is.
- The first Analyze after a restart takes 10-30 seconds. That is librosa and
  numba warming up their JIT, not a per-call cost.

---

## v1.5.0

Oasis Suite release. Two previously unreleased nodes ship in this pack for the
first time alongside Image Oasis. Class ids stay stable:
`ImageOasis`, `VideoOasisPreview`, `LTX23Oasis`.

### Pack / suite

#### Added
- Three-node suite layout: `image_oasis/`, `video_oasis/`, `ltx23_oasis/` with
  shared frontends under `web/` and a single root `__init__.py` registration.
- Root README reframed as suite overview + what's new in 1.5; full per-node
  docs live in each subfolder README (plus LTX in-node Help from
  `ltx23_oasis/ltx23_oasis_help_content.md`).

#### Changed
- **License is now GPL-3.0-or-later** for the whole pack (required by LTX
  Director code vendored under `ltx23_oasis/vendor/`).
- `requirements.txt` documents optional non-pip custom nodes: **ComfyUI-GGUF**
  (GGUF source type) and **ComfyUI-KJNodes** (LTX2 NAG for distilled negatives).
- Registry scan hygiene for the suite publish: no `requirements.txt` GitHub
  URLs; JS avoids the network-rule false-positive method form; CivitAI LoRA
  lookup uses aiohttp (already used by Comfy routes) instead of urllib;
  install docs avoid `git clone` GitHub URLs; `.comfyignore` keeps local scan
  helpers out of the artifact.

#### Notes
- If you still have experimental `custom_nodes/video_oasis` or
  `custom_nodes/ltx23_oasis` folders from local testing, delete them so class
  ids are not registered twice.

---

### Video Oasis Viewer (new node)

Preview-first Save Video replacement (`VideoOasisPreview`). Encodes to temp;
nothing hits `output/` until Save.

#### Added
- In-node player: scrub, frame-step, mute, playback speed, Space play/pause,
  lightbox (scroll zoom, drag pan, double-click reset).
- Playback modes: **off → loop → cycle** (cycle walks the scene bar).
- **Scene bar** (up to 24): recall, delete, long-press reorder, **+** load from
  `output/`, **Save** (lossless copy + workflow metadata),
  saved ✓ badge; history survives tab switches and reloads.
- **Clip**: mark in `[` / out `]` then Clip - trimmed file lands in the bar.
- **Create Movie**: concat every *saved* bar clip; stream-copy when codec +
  extradata match, otherwise re-encode; audio toggle with silence padding.
- Encode UI: container / codec / quality (or custom CRF) / save prefix.
- HTTP routes under `/video_oasis/*` (list, probe, save, clip, create-movie,
  frame extraction).
- Frame drag from the player onto other nodes' image inputs (same export path
  as LTX2.3 Oasis; disabled in lightbox so pan keeps working).

#### Changed
- **Save All** removed; single **Save** matches Image Oasis (square button,
  Accent colors, hides when the pane is empty; scene ‹ n/m › nav in the info
  bar). Fresh spawn sizes: IO `1030×770`, LTXO `960×770`, VOV `570×770`.

#### Fixed
- Frame drag onto stock ComfyUI image nodes (Load Image and any upload-widget
  node). The drag now carries a same-origin `/video_oasis/frame` extraction
  URL that ComfyUI's drop pipeline accepts; previously only Oasis drop
  targets received the frame, because Chromium clears File items from the
  drag store once a string type is added.
- Create Movie no longer corrupts after the first cut when mixing originals
  with Clip outputs (extradata / SPS-PPS mismatch now forces re-encode).
- Clip duration / FPS reporting (1-frame and bogus FPS cases).
- Lightbox: Space play/pause and pan work without a prior click; frame-drag
  to slots no longer steals lightbox input.
- Registry YARA false positives cleaned for the viewer pack ahead of merge
  (same class of issues as v1.4.1).

---

### LTX2.3 Oasis (new node)

All-in-one LTX 2.3 generation (`LTX23Oasis`) in the Image Oasis UI shape.
Encode / player / scene bar / Clip / Create Movie / Save use the in-pack
Video Oasis Viewer path.

#### Added
- Text→Video and Image→Video with a single top-of-prompt mode control (drives
  both pipeline and enhancer style).
- **Prompt Beats**: own section; unlimited beats with local text + optional
  guide image / strength; frame-sum meter vs Video frames; **Match frames**;
  hover ✕ to clear a guide (no separate Clear Guides control).
- Vendored PromptRelay / guide crop path (LTX Director) under `vendor/`.
- **Start Frame** (I2V): upload / drop / paste; info line + ⤢ size-to-latent;
  drag the paused player frame onto Start or a beat guide. Loading a start
  image auto-selects Image → Video; clearing it returns to Text → Video (the
  manual mode switch still works as normal).
- **Continue from viewed video**: next run starts from the last frame of
  whatever is in the viewer (scene-bar click changes the chain source).
- **Audio** modes under Video / Audio: Off / Generate / **File** (audio-driven
  video - encode real audio into the latent, mux original waveform back).
- Distilled **sigma schedule** editor with ↺ reset (Generation + Upscale
  polish sigmas).
- **Negative prompt** restored: CFG > 1 uses standard CFG; CFG 1 routes
  through **LTX2 NAG** via ComfyUI-KJNodes.
- Spatial Upsample (×2) + optional Polish pass with cached sample reuse.
- Same player / scene bar / Clip / Create Movie / encode / Save toolkit as
  Video Oasis Viewer (including off/loop/cycle and movie audio toggle).
- Bypass Node / Activate Node footer (fixed under the left column).
- Per-LoRA **CivitAI** button (by-file-hash → direct model page).
- Presets + per-node Theme under `user/ltx23_oasis/`.
- Cond. FPS on the Frames / FPS row; Audio control moved out of Model into
  Video / Audio; section renames (Prompt Enhancer, Prompt Beats, Video / Audio,
  Start Frame); save-prefix / naming unified away from legacy
  `video_oasis_gen` / `VideoOasis_oasis_*` filenames.

#### Fixed
- `LTXVCropGuides` / guide-crop call signature mismatch on newer ComfyUI.
- Audio-driven File mode drift over long clips (PTS / mux alignment); original
  waveform mux keeps lip-sync with frames.
- Scene bar vanished on ComfyUI tab switch - widget now persists full history
  (parity with Video Oasis Viewer); temps still prune after restart.
- Create Movie corruption when joining Clip outputs (shared fix with Viewer).
- Frame drag onto stock ComfyUI image nodes (shared fix with Viewer).
- Lightbox Space / pan vs frame-drag conflict (shared fix with Viewer).
- Clip 1-frame / FPS probe bugs (shared fix with Viewer).
- Beat textarea sizing consistency; guide strength no longer stretches with
  the text area.
- Help content and docs scrubbed (em-dashes removed; beats / audio / clip /
  movie / NAG documented).

---

### Image Oasis

#### Added
- History strip under the viewer (save, load-from-output, nav; image-appropriate
  subset of the video scene-bar toolkit - no reorder).
- Bypass Node / Activate Node footer (fixed under the left column; same
  mode-4 behavior as rgthree Fast Groups Bypasser).
- Per-LoRA **CivitAI** button under strength (by-file-hash → direct model page,
  not a search results list).

#### Fixed
- CivitAI button alignment with the strength field.

---

## v1.4.1

### Fixed
- Fixed two Comfy Registry YARA false positives that flagged v1.4.0 and blocked the pack from showing cleanly in Custom Node Manager: removed a GitHub URL from a `requirements.txt` comment (`contains_custom_url_dependency`), and replaced a JS method that the scanner mistook for Python network activity (`python_network_operations`).

---

## v1.4

### Added
- Added img2img to every non-Qwen architecture. A new **Init** slot in the Reference Images section (under its own "Img2Img Init" divider) starts generation from your image instead of noise - an occupied slot enables it, clearing the slot returns to normal generation. Think image inspiration rather than image editing: the model remakes your image in its own style, carrying over structure, composition, and palette. Denoise is the strength dial (start around 0.5 and adjust). The Init slot has full parity with the other slots: upload, drag-drop, paste, clear, and the compare-base toggle.
- Added a **Latent** section: width/height with a swap button, aspect-ratio presets (1:1, 2:3, 3:4, 9:16, 16:9, 4:3, 3:2) that lock the fields together (nearest /16), a **Fit Method** row, and Batch (moved from Generation).
- Added the **Fit Method** (Stretch / Crop / Pad) controlling how incoming images are conformed to the latent size on both image paths: the img2img init image on non-Qwen architectures, and the edit reference images on Qwen-Image-Edit - which previously scaled references by its own internal policy without asking. Crop is the default; Pad fills leftover space with edge replication rather than black bars.
- Added an image info line to every occupied reference/init slot showing the image's resolution and file size, plus a one-click ⤢ button that sets the latent width/height to the source image's dimensions (snapped to /16).
- Added an **Interrupt** button (⏹) to the output header, visible only while a run is in progress.
- Added a fail-fast guard for startup flags that corrupt specific architectures, registry-driven. Krea 2 now refuses to run under `--use-sage-attention` with a clear error instead of silently producing black images.
- Added an automatic conditioning rebalance to the Krea 2 architecture. Krea 2 conditions on 12 stacked text-encoder layers, and alignment training under-weights the deep layers that carry fine detail and identity; the node now reweights them as part of the encode path, RMS-renormalized so overall conditioning strength is unchanged. Always on, no control to set. Krea 2 seeds from v1.3 will render slightly differently. Technique credit: nova452 and huwhitememes (both Apache-2.0).
- Added Boogu-Image 0.1 (Base and Turbo) as a first-class architecture, with the new `boogu` CLIP type. The arch default CLIP type is required - Boogu derives a mandatory conditioning argument from metadata only its own text-encoder path attaches, so generic CLIP types crash the run. Uses the Flux VAE and the Qwen3-VL-8B text encoder. The Edit variant is not supported. Requires a ComfyUI recent enough to include native Boogu support.
- Added a **Variety** control to the Generation section for the low seed-diversity problem on distilled models (Z-Image Turbo, Krea 2 Turbo, Boogu Turbo, and similar), where re-rolling the seed barely changes the composition. Variety adds a small, seeded amount of noise to the prompt conditioning during the early sampling steps so each seed lands on a genuinely different layout, then hands back the clean prompt for the rest of the run. 0 is off (the default, exact previous behavior); start around 0.1. Same seed plus same Variety reproduces the same image, and the setting rides presets like any other generation parameter.
- The CLIP type dropdown is now served from the registry alongside the architecture definitions, removing the last hand-synced frontend list - new image models are a registry-only change end to end.

### Improved
- Improved rerun overhead: reference and init images are content-hashed through a stat-based memo and only loaded/decoded when a cache miss actually needs to encode them, so a seed-only rerun costs a file stat per image instead of a read, decode, and hash.
- Architecture definitions (dropdown entries, labels, CLIP slot counts, image-conditioning gating) are now served to the frontend from the registry, so adding an architecture is a registry-only change with no hand-synced frontend mirror to drift.
- Improved VAE decode resilience: an out-of-memory during decode now retries with tiled decoding instead of failing after the sampling work is already done.
- Improved prompt-enhancer VRAM behavior: the diffusion model is no longer evicted from VRAM by passive events (adding a node, switching workflow tabs, changing the enhancer model dropdown). Eviction now happens only when Enhance is actually clicked. Auto GPU layers are computed after that eviction against real free VRAM, and the recommendation label updates to the layer count actually used.
- Improved enhancer safety: Enhance is refused while an image is generating (on both the button and the backend), and concurrent enhance requests from multiple nodes are serialized instead of racing the model loader.
- Improved error reporting when a selected CLIP/text-encoder file can't be found on disk: the error now names the missing file instead of suggesting you select one.
- Corrupted (NaN) latents reaching the preview now print a loud warning naming the likely cause instead of being silently clamped to a black image.

### Fixed
- Fixed the plain text-encode path silently dropping conditioning extras the text encoder attaches (attention mask and others). It now returns ComfyUI's full conditioning structure exactly like the stock CLIPTextEncode node. This was fatal for Boogu-Image, whose model requires an argument derived from the attention mask, and subtly lossy for other mask-emitting encoders (Qwen-Image, Krea 2) - conditioning for those architectures now matches stock ComfyUI, so seeds may render slightly differently than earlier Image Oasis versions.
- Fixed theme save routes reporting success even when the write to disk failed.
- Fixed a batch of dead code and lint issues flagged by the registry workflow.

---

## v1.3

### Added
- Added Krea 2 (Turbo and Raw) as a first-class architecture. Uses the new `krea2` CLIP type for Qwen3-VL-4B's 12-layer stacked hidden state; the 1.15 flow shift is baked into the model config, so no sampling patch is applied.
- Added `krea2` to the CLIP type dropdown to expose the new text encoder path.

### Notes
- Krea 2 produces black images when ComfyUI is launched with `--use-sage-attention`. Remove the flag if you're generating with Krea 2. Other architectures are unaffected.

---

## v1.2

### Added
- Added a new feature that splits the prompt enhancer into two textareas: a sticky **User Prompt** (your short input) and an **Enhanced Prompt** (the result that drives generation). Re-clicking Enhance always re-runs from the User Prompt, so iterating no longer means losing your original.
- Added a new feature that auto-cleans model-specific output artifacts from enhancer results (`<think>` blocks, orphan `</think>` tags, leaked `[INST]` / `[OUT]` / `<<SYS>>` template tokens, etc.) via `profiles.json`. Profiles are auto-resolved from the model filename with a universal fallback; edit the file to add rules for new models - no restart needed.
- Added an **Enhancer Settings** sub-panel at the bottom of the Prompt section (collapsed by default): Auto GPU layers with a live VRAM-based recommendation, manual GPU layers override, Context, and Max tokens. The recommendation is computed from the GGUF header's layer count and current free VRAM whenever the model selection changes.

### Improved
- Improved enhancer iteration speed: the LLM now stays loaded between Enhance clicks instead of unloading per click. It still unloads automatically when image generation starts, so it never competes with the diffusion model for VRAM during sampling.
- Improved enhancer inference speed: flash attention is now enabled by default in the llama.cpp loader. CUDA and Metal builds get the speedup transparently; CPU builds ignore the flag.

### Fixed
- Fixed a bit of code that was adding unnecessary overhead to the LLM loading process, forcing models which would normally full load into VRAM to partially offload, slowing inference speed dramatically. Prompt enhancement is now fully optimized and should feel 3-5x faster.

### Removed
- Removed the Think / No-think toggle. Thinking models now work cleanly out of the box because the auto-cleanup profiles strip the `<think>` block from the output.
- Removed the revert button. With User Prompt and Enhanced Prompt as separate boxes, your original is never overwritten - re-clicking Enhance just re-runs from the User Prompt.

---

## v1.1

### Added
- Added a new feature that lets you A/B compare the current image/batch against the previous image/batch with a draggable wipe slider in the output pane. You can also set any reference image as the compare base.
- Added a new feature that puts a full Help panel inside the node - markdown guide with a category dropdown, scrollable, no separate window needed.
- Added a new feature that surfaces multiple CLIP loader slots automatically based on the chosen architecture (1, 2, or 3 slots).
- Added a new feature that lets you drag-and-drop or Ctrl+V images directly onto reference image slots.
- Added a new feature that puts navigation arrows in the bottom-right corner of the output pane for stepping through multi-image batches.
- Added a new feature that lets you drag-reorder preset cards via a 9-dot grip handle.
- Added a new feature that lets you set trigger words per LoRA. Saved with the stack and prepended to your prompt automatically when the LoRA is enabled.

### Improved
- Improved the output-header buttons by unifying Generate, Randomize, Compare, and Save into equal-size square icons with a consistent hover behavior.
- Improved the Generate and Compare buttons by giving them their own theme variables - they default to green, and the Background and Border sliders propagate to them when moved off-default.
- Improved the execution timer by making it survive tab switches mid-generation. Switch away during a run, come back, and the clock picks up from real elapsed time.
- Improved the negative-prompt skip label to make it clear that the Negative Prompt is what's being ignored when CFG = 1.
- Improved the architecture tooltips with clearer descriptions; corrected the AuraFlow shift default callout to 3.0.
- Improved the timer readout by left-justifying the text so milliseconds digits no longer jiggle the whole string.
- Improved the Upscale section layout by reordering controls and hiding Method when in Model mode (and Up Model when in Algorithmic mode).

### Fixed
- Fixed a bug where the live preview rendered under the node body, overlapping controls and fighting with the compare slider. The right-side output pane is now the sole place the image is shown.
- Fixed a bug that caused the generated image, execution highlight, and progress bar to appear under the wrong node on a different workflow tab when that node happened to share an internal ID with Image Oasis. Results are now delivered directly to the originating Image Oasis node regardless of which workflow tab you're on. (A brief execution highlight may still flash on a same-ID node during a run - it carries no image or progress fill and clears at completion.)

### Known issues
- The generated images no longer appear in the asset side panel. The image is still saved to the temp directory as normal.
- The per-step progress bar no longer renders on the node. Step progress still prints to the ComfyUI console. The overall queue progress bar is unaffected.

---

## v1.0

### Added
- Initial release. A standalone all-in-one ComfyUI image generation node consolidating model loading, conditioning, sampling, refiner, upscale, and preview into a single monolithic node with no input/output sockets.
- Supports Flux, Qwen-Image-Edit, SD3, AuraFlow, and Z-Image Turbo architectures across checkpoint, diffusion model, and GGUF sources.
- Optional refiner pass and optional upscale (algorithmic or model-based).
- Optional LLM-based prompt enhancer (Qwen3 GGUFs).
- LoRA stack with per-LoRA model and CLIP strength.
- Preset library for saving and loading configurations.
- Per-node theme controls.
