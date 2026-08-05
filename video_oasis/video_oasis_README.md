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
right) into `output/video/create_movie_NNNNN.mp4`.

- Clips should match resolution and FPS
- Same bitstream params → video is **stream-copied** (lossless)
- After Clip (or mixed encode settings) → movie is **re-encoded** so the join
  stays clean
- 🔊/🔇 toggle: with audio on, tracks are aligned (silence padded where needed);
  off = silent movie
- The movie lands in the scene bar as a saved entry, and is **not** excluded
  from the next Create Movie - concatenating a movie with further clips is how
  you build runs longer than the bar holds. Remove what you don't want with a
  thumbnail's ✕ first

## Encode / Save

One collapsible section (same layout as LTX2.3 Oasis), with the square **💾 Save**
button beside the section header. Controls live in the node UI (serialized with
the widget, not as separate Comfy widgets):

| Control | Notes |
|---------|--------|
| **Format** | `auto`, `mp4`, `webm`, `mkv` (toggle group) |
| **Codec** | `auto`, `h264`, `hevc`, `vp9`, `av1` (toggle group) |
| **Quality** | `balanced` (default) / `high` / `small` / `custom` (exposes CRF) |
| **Save prefix** | Path stem under `output/` (default `video/VideoOasis`) |

`auto` everything matches stock Save Video's fast path when possible. webm
accepts VP9/AV1; mp4 takes h264/hevc; mkv takes anything. HEVC may not play
in-browser; the file on disk is fine.

## Theme

Palette follows **LTX2.3 Oasis** (companion node). Edit colors in LTXO's Theme
section; Video Oasis Viewer picks them up automatically.

## Multi-node / API

Each viewer instance keeps a stable `io_id` inside the `video_oasis_ui` widget
JSON so scene-bar and save routes target the right pane when several viewers
are on the graph. HTTP routes live under `/video_oasis/*` (list, probe, save,
clip, create-movie, frame extraction). LTX2.3 Oasis shares the save and
frame-extraction routes.

## License

The Oasis Suite pack is **GPL-3.0-or-later**. See [../LICENSE](../LICENSE).
