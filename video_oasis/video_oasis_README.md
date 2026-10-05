# Video Oasis Viewer

Part of the **Oasis Suite**. Node class id:
`VideoOasisPreview`. Frontend: [`../web/video_oasis.js`](../web/video_oasis.js).
Suite overview: [root README](../README.md).

A preview-first Save Video node. Connect a `VIDEO` input; the node encodes to
ComfyUI's **temp** directory and plays the result in-node. Nothing is written
to your output folder until you press **Save**, which copies the already-encoded
file losslessly - workflow metadata included. The `VIDEO` output passes the
same tensor through so you can keep chaining.

## Quick start

1. Drop **Video Oasis Viewer** on the graph and connect any `VIDEO`.
2. Set encode prefs in the node (or leave `auto` / balanced defaults).
3. Run the graph - the clip appears in the player and the **scene bar**.
4. Press **💾 Save** when you want to keep it under your Save prefix.

## Player

- Scrub bar with frame counter
- ▶/⏸ (**Space**), frame-step ⏮/⏭ (arrows; Shift = ~1 second)
- Mute, playback speed, ⛶ **lightbox** (scroll = zoom, drag = pan, double-click = reset)
- Loop button cycles: **off → loop** (repeat current clip) **→ cycle** (play
  through the scene bar left-to-right, a rolling dailies reel)
- **Frame drag**: pause (or scrub) on a frame, then drag the video onto any
  image input on the graph (Load Image, Image Oasis refs, LTX Start / beat
  guides, etc.). Cursor shows grab when a clip is loaded; disabled in lightbox
  so pan keeps working.

## Scene bar

Keeps up to **48** recent clips, one click away:

- Click a thumbnail to load it in the player
- Delete entries you don't need; long-press drag to reorder
- **+** loads any video from your `output/` tree into the bar
- **💾 Save** (square button beside Encode / Save) copies the current preview
  into `output/` under **Save prefix**; hides when the pane is empty
- ✓ badge marks saved clips; scene ‹ n/m › nav lives in the info bar
- History survives ComfyUI tab switches and page reloads (temp previews are
  pruned after a full ComfyUI restart; saved files remain)

## Clip

1. Scrub to the in-point → press **[**
2. Scrub to the out-point → press **]**
3. Press **Clip**

Writes a trimmed copy (e.g. `output/video/clip_NNNNN.mp4`) and adds it to the
scene bar. Useful for keeping only the stretch you want before Create Movie.

## Create Movie

**🎬 Create Movie** concatenates every **saved** clip in the scene bar (left to
right) into `output/video/create_movie_NNNNN.{mp4|webm|mkv|mov}`, matching
the clips' codec.

- Clips should match resolution and FPS
- Same bitstream params → video is **stream-copied** (lossless)
- After Clip (or mixed extradata) → movie is **re-encoded in the same codec**
- Mixed codecs follow the first clip
- 🔊/🔇 toggle: with audio on, tracks are aligned (silence padded where needed);
  off = silent movie
- Audio across each join is rebuilt, not blindly concatenated: clips are
  trimmed to their own frame count (no AAC tail padding leaking in as a gap,
  no drift down a long bar) and the samples either side of the cut are
  crossfaded. Per-clip details print to the console under `[VOV Movie]`
- The movie lands in the scene bar as a saved entry, and is **not** excluded
  from the next Create Movie - concatenating a movie with further clips is how
  you build runs longer than the bar holds. Remove what you don't want with a
  thumbnail's ✕ first

## Encode / Save

One collapsible section (same layout as LTX Oasis), with the square **💾 Save**
button beside the section header. Controls live in the node UI (serialized with
the widget, not as separate Comfy widgets):

| Control | Notes |
|---------|--------|
| **Format** | `auto`, `mp4`, `webm`, `mkv`, `mov` (toggle group) |
| **Codec** | `auto`, `h264`, `hevc`, `vp9`, `av1`, `ffv1`, `prores` (toggle group) |
| **Quality** | `balanced` (default) / `high` / `small` / `custom` (exposes CRF). Hidden for FFV1 and ProRes. |
| **GPU Encode** | `On` (default) / `Off`. NVIDIA NVENC encoding. Only shown when NVENC works on this machine and the codec has a GPU version (h264, hevc; av1 on RTX 40-series and newer). |
| **Save prefix** | Path stem under `output/` (default `video/VideoOasis`) |

`auto` everything matches stock Save Video's fast path when possible. webm
accepts VP9/AV1; mp4 takes h264/hevc/AV1; mkv takes anything including FFV1; mov
takes ProRes 422 HQ. **FFV1 + FLAC** is true lossless of the decoded 8-bit RGB.
**ProRes 422 HQ + PCM** is visually lossless and NLE-friendly. HEVC, FFV1 and
ProRes play through a browser preview copy (below); the file on disk is untouched.

**Browser preview copies.** FFV1 and ProRes never play in a browser, and
hevc only plays in some browsers. When the viewer can't play a file it shows
"Preparing browser preview" and builds a small h264 copy at the same size,
fps and frame count (GPU-encoded when GPU Encode is on), then plays that. The
info bar reads "preview copy" while it's in use. Save, Clip, frame drag and the
motion-context tail always use the real file. Copies live in
`temp/oasis_proxy`, are built once per file, and clear when ComfyUI restarts.
Scene-bar thumbnails for these files come from a server-side frame grab.
hevc files in mp4/mov are now tagged `hvc1`, the label browsers and Apple
players expect.

**GPU Encode** notes:

- With `auto`, GPU Encode writes h264 (a video loaded straight from a file is
  still copied untouched, no encode at all)
- Quality presets map to NVENC's quality scale (cq); the badge reads
  `h264 nvenc cq 21` instead of `crf`
- If the GPU encoder fails, that clip is re-encoded on the CPU and flagged
  with a warning
- **Clip** and the **Create Movie** re-encode fallback follow this setting.
  Clips made with GPU Encode on and off have different headers, so keeping it
  consistent lets Create Movie stream-copy more often
- Biggest win on long movies and upscaled output; short clips barely notice.
  NVENC files run slightly larger at the same quality

## Theme

Palette follows **LTX Oasis** (companion node). Edit colors in LTXO's Theme
section; Video Oasis Viewer picks them up automatically.

## Multi-node / API

Each viewer instance keeps a stable `io_id` inside the `video_oasis_ui` widget
JSON so scene-bar and save routes target the right pane when several viewers
are on the graph. HTTP routes live under `/video_oasis/*` (list, probe, save,
clip, create-movie, frame extraction). LTX Oasis shares the save and
frame-extraction routes.

## License

The Oasis Suite pack is **GPL-3.0-or-later**. See [../LICENSE](../LICENSE).
