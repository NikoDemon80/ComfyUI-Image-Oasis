# Oasis Suite

One ComfyUI pack with five nodes that share the same player language, save
habits, and UI patterns. Install once; everything lands under
`custom_nodes/ComfyUI-Image-Oasis/`.

| Node | Class id | Folder | Docs |
|------|----------|--------|------|
| **Image Oasis** | `ImageOasis` | `image_oasis/` | [image_oasis/image_oasis_README.md](image_oasis/image_oasis_README.md) |
| **Video Oasis Viewer** | `VideoOasisPreview` | `video_oasis/` | [video_oasis/video_oasis_README.md](video_oasis/video_oasis_README.md) |
| **LTX Oasis** | `LTX23Oasis` | `ltx23_oasis/` | [ltx23_oasis/ltx23_oasis_README.md](ltx23_oasis/ltx23_oasis_README.md) |
| **Audio Oasis** | `AudioOasis` | `audio_oasis/` | [audio_oasis/audio_oasis_README.md](audio_oasis/audio_oasis_README.md) |
| **Oasis Metadata** | `OasisMetadata` | `nodes_metadata.py` | Reads prompt + settings out of a saved PNG or video |

Frontends live in `web/` (`image_oasis.js`, `video_oasis.js`, `ltx23_oasis.js`,
`audio_oasis.js`).
**License: GPL-3.0-or-later** for the whole pack (see [LICENSE](LICENSE)).

---

## What's new in 1.9.1

Click the video in LTX Oasis or Video Oasis Viewer to play/pause. Same as
Space or the ▶/⏸ button. Frame drag still works; the lightbox is unchanged
(click/drag pans, double-click resets).

## What's new in 1.9

### GPU Encode (Video Oasis Viewer and LTX Oasis)

**GPU Encode** (default On) encodes with NVIDIA NVENC: h264 and hevc on any
RTX card, av1 on RTX 40-series and newer. It only shows when NVENC works on
your machine. Clip and Create Movie follow it. A failed GPU encode is redone
on the CPU with a warning.

### Browser preview copies

FFV1, ProRes, and hevc the browser can't play now preview through a small
h264 copy. Save, Clip and frame drag still use the real file.

### Oasis Metadata

New `OasisMetadata` node: pick a saved PNG or video and get its prompt and
Oasis settings as two STRING outputs.

### Fixes

- Clip no longer drops the last frames of B-frame sources
- LTX Oasis no longer writes a leftover `ltxo_audio_diag.wav` to `output/`

## What's new in 1.8

1.6.0 and 1.7.0 stay banned on the registry; this is the version Manager can
treat as Latest after publish. Class ids are unchanged.

### CSRF gate (whole pack)

Mutating POST/DELETE routes (presets, themes, save, save_segments, clip,
create movie, enhance) now require the request Origin to match Host. Same-origin
UI fetch already sends it; a cross-site form POST is rejected.

### Continue from cached latent (LTX Oasis)

**Continue from viewed video** prefers a cached sampled latent for the clip in
the scene bar, the same idea as H3 Oasis. Generated clips no longer round-trip
through h264 for the motion-context tail. Clips loaded from disk, Clip, and
Create Movie have no latent and still decode the viewer file.

### RTX Video Super Resolution (LTX Oasis)

Upscale gains **RTX Video Super Resolution**, a toggle above Spatial Upsample.
Tick it for Size (× Scale or target W×H) and Quality. It runs
`RTXVideoSuperResolution` from Nvidia RTX Nodes on the decoded frames. Spatial
Upsample still runs in latent first if both are on. Toggling VSR reuses the
sampled latent. Needs an Nvidia RTX GPU and that custom node installed.

### AV1 in mp4 (Video Oasis Viewer and LTX Oasis)

AV1 is allowed in mp4 as well as webm (AOMedia ISOBMFF). Auto+AV1 still homes
to webm. Create Movie keeps an AV1 mp4 bar in mp4 instead of remuxing it to
webm.

### Audio Oasis chops

- **Snap: 17k+5 (H3)** next to 8n+1 (LTX), shortest useful segment 22 frames
- Dragging a chop defaults to **shift later**; **stretch** is the one-handle
  resize. Alt inverts for one drag
- **split every** can step in seconds or in frames
- Each segment row has a **frame-count stepper** (type a length or click the
  arrows) so you do not have to drag a handle on the waveform
- Until you save, the whole track is already the AUDIO output. Segment
  highlight needs a saved file

---

## What's new in 1.7

### LTX 2.5 (LTX Oasis)

The architecture picker gains **LTX 2.5 22B (Distilled)** alongside 2.3. It is
one registry entry rather than a new node, so the class id stays `LTX23Oasis`
and existing workflows are untouched - the dropdown decides which model family
a run targets.

The one thing to know when switching: 2.5 takes a **single text encoder**. It
ships Gemma-4-12B with the LTX projection baked into one file, where 2.3 needs
Gemma-3 plus a separate projection file, so the Model section drops to one
text-encoder picker. Its defaults also differ - 24 fps and 960x544 against
2.3's 25 fps and 1280x720 - while the sigma schedule, sampler and CFG are the
same. Everything else (Prompt Beats, guides, audio, motion context, the player
and scene bar) behaves identically on both.

2.5 has no spatial upscaler of its own yet, so **Spatial Upsample** on a 2.5
run loads the 2.3 upscaler, which is what the official 2.5 two-stage workflow
does.

### The LTX node is now "LTX Oasis"

With 2.5 in the picker the node is no longer 2.3-only, so its header reads
**LTX Oasis**. Display name only: the class id stays `LTX23Oasis`, the folder
stays `ltx23_oasis/`, routes stay `/ltx23_oasis/*`, and presets and themes stay
under `user/ltx23_oasis/`. Saved workflows keep loading, and a node you renamed
by hand keeps your title.

### Create Movie audio (Video Oasis Viewer and LTX Oasis)

Joining clips used to drop a short hole into continuous ambience at every cut,
and audio walked progressively late against picture down a long scene bar.
Both came from measuring audio the wrong way: every clip's AAC encode pads its
tail out to a whole block, and clip files run fractionally longer than their
own video. Audio is now cut to exactly the length each clip's frame count
calls for, so the two are measured off the same ruler.

The remaining artifact was the incoming clip's first few frames arriving weak,
which a trim cannot recover because it is real audio, just quiet. The samples
either side of a join are now rebuilt by crossfading the two clips' own
interiors played backwards, which cannot click and does not change the sample
count. Create Movie reports what it did to each clip in the ComfyUI console.

---

## What's new in 1.6

### Motion context for chained clips (LTX2.3 Oasis)

**Continue from viewed video** could only ever see one frame of the previous
clip. A still carries pose but not motion - a leg mid-stride looks the same
swinging forward or back, a camera frozen mid-pan gives no hint which way it
was moving - so every join was a fresh guess and chained clips lurched.

1.6 pins a window of the previous clip in front of the timeline as frozen
frames (9 / 17 / 25 / 33 / 41 / 49; 25 is one second at 25fps, 49 is just under
two). The model reads direction, speed, gait phase and camera drift out of them.
The window is cropped after decode, delivered frame counts are unchanged, and
audio is untouched - File mode pads the window with silence so an uploaded
track is muxed exactly as supplied, Generate mode carries the previous clip's
tail audio so ambient beds and music continue across the cut.

The tail source is now read from the file in the viewer rather than an
in-memory tensor, so clips loaded from `output/` chain exactly like fresh
renders.

### Audio Oasis (new node)

A fourth node joins the suite. Load an mp3/wav/flac/m4a, chop it into segments
on a waveform, save them as numbered files, and feed the result to LTX2.3
Oasis's audio-driven-video slot or any other `AUDIO`-input node.

- Waveform, duration, sample rate, channels and peak/RMS decode in the browser
  on upload, no server round trip
- Click to drop a chop point, drag to slide, double-click or right-click to
  remove; **split every N s** bulk-places evenly spaced points you can still
  edit afterward
- **Grid & Snap** keeps cuts legal for LTX: snap modes **8n+1** (default),
  **frames**, or **off**, with **Re-snap** after an FPS change. Every segment
  row shows its frame count and flags any length LTX would reject
- **Save segments** writes numbered files under `input/audio_oasis/<track>/` in
  the source format, re-encoded so cuts land sample-accurate rather than on the
  nearest frame boundary, plus a `manifest.json`
- **Load saved set** restores track, points, FPS and segments from that
  manifest, so a chop survives restarts even if the workflow was never saved
- Drag a segment's grip straight onto LTX2.3 Oasis's audio slot, or pick a
  segment (or **Use full track as output**) to set what the `AUDIO` socket
  carries
- **Analyze** gives BPM and estimated key via optional `librosa`
- Its own theme, independent of Image Oasis and LTX2.3 Oasis

Full detail:
[audio_oasis/audio_oasis_README.md](audio_oasis/audio_oasis_README.md) (and the
in-node Help pane, fed by `audio_oasis/audio_oasis_help_content.md`).

### Video Oasis Viewer

The scene bar holds **48** clips, up from 24. LTX2.3 Oasis's bar shares the
constant and gets the same capacity.

---

## What's new in 1.5

v1.5 turns Image Oasis into a small **suite**. Two new nodes ship in this pack
for the first time (they were never a public release on their own):

### Video Oasis Viewer (new)

A preview-first Save Video replacement. Incoming `VIDEO` encodes to temp and
plays in-node; nothing hits your output folder until you press Save.

- Click the video to play/pause; scrub / frame-step / mute / speed / lightbox (scroll zoom, drag pan)
- Frame drag onto other nodes' image inputs (Load Image, refs, LTX guides, ...)
- Playback: **off → loop → cycle** (cycle walks the scene bar like a dailies reel)
- **Scene bar** (up to 24, raised to 48 in 1.6): click to recall, delete,
  long-press reorder, **+** load from `output/`, **Save** (lossless copy +
  workflow metadata)
- **Clip**: mark in `[` / out `]` then Clip - trimmed file lands in the bar
- **Create Movie**: concat every *saved* bar clip, result lands back in the bar
  (stream-copy when possible,
  re-encode when Clip or mismatched params require it)
- **Encode / Save** section (LTXO-matching): format / codec / quality / save prefix
- Theme follows LTX2.3 Oasis (not Image Oasis)

Full detail: [video_oasis/video_oasis_README.md](video_oasis/video_oasis_README.md).

### LTX2.3 Oasis (new)

All-in-one LTX 2.3 video generation in the Image Oasis UI shape - model pick,
prompt enhancer, LoRA stack, Start Frame / Prompt Beats, audio modes, sigmas,
spatial upsample - with the same player, scene bar, Clip, Create Movie, and
encode/save path as Video Oasis Viewer (uses the in-pack encode path; no
extra video pack required).

- Text→Video and Image→Video, plus **Continue from viewed video** chaining
- Prompt Beats (local text + optional guide images on a timeline)
- Audio: Off / Generate / File (audio-driven video)
- Scene bar persistence across ComfyUI tab switches and reloads

Full detail: [ltx23_oasis/ltx23_oasis_README.md](ltx23_oasis/ltx23_oasis_README.md)
(and the in-node Help pane, fed by `ltx23_oasis/ltx23_oasis_help_content.md`).

### Image Oasis (carried forward)

Same all-in-one image node as 1.4.x, plus the recent history-strip / bypass /
CivitAI-hash work. Architecture registry, enhancer, LoRAs, refiner, upscale -
unchanged class id `ImageOasis`. See
[image_oasis/image_oasis_README.md](image_oasis/image_oasis_README.md) for the
full feature list and older "what's new" notes (v1.1-1.4).

### Pack-level changes

- Layout: `image_oasis/`, `video_oasis/`, `ltx23_oasis/` + shared `web/`
- Whole pack is **GPL-3.0-or-later** (LTX Director code vendored under
  `ltx23_oasis/vendor/` requires it)
- Stable class ids so workflows keep loading: `ImageOasis`,
  `VideoOasisPreview`, `LTX23Oasis`

---

## Install

1. Place (or update) this folder at
   `ComfyUI/custom_nodes/ComfyUI-Image-Oasis/`.
2. Install Python deps from the pack root:
   `pip install -r requirements.txt`
3. Restart ComfyUI, then hard-refresh the browser (Ctrl+F5) so the frontend
   scripts reload.

**Optional (Image Oasis / LTX enhancer):** `llama-cpp-python` with a CUDA/Metal
build for the GGUF prompt enhancer - see
[image_oasis/image_oasis_README.md](image_oasis/image_oasis_README.md).

**Optional (LTX):** `ComfyUI-GGUF` for GGUF diffusion; `ComfyUI-KJNodes` for
LTX2 NAG when CFG is 1 and a negative prompt is set; **Nvidia RTX Nodes**
(`comfyui_nvidia_rtx_nodes`) for RTX Video Super Resolution in Upscale.

**Optional (Audio Oasis):** `librosa` for BPM/key Analyze - listed commented-out
in `requirements.txt` because it pulls in numba/llvmlite. Chop / save / drag all
work without it.

Presets / themes:

- Image Oasis → `ComfyUI/user/image_oasis/`
- LTX Oasis → `ComfyUI/user/ltx23_oasis/`
- Audio Oasis → `ComfyUI/user/audio_oasis/`

---

## Credits

- Execution timer pattern adapted from crt-nodes.
- Krea 2 conditioning rebalance: nova452 / huwhitememes (Apache-2.0).
- LTX Oasis vendors PromptRelay / patches from WhatDreamsCost-ComfyUI
  (LTX Director), GPL-3.0-or-later - see `ltx23_oasis/vendor/`.
- "Accessibility tool for the nodally challenged" - PheebyKatz.

## License

**GPL-3.0-or-later.** See [LICENSE](LICENSE).
