# Audio Oasis 🌴

Part of the **Oasis Suite**. Node class id: `AudioOasis`.
Frontend: [`../web/audio_oasis.js`](../web/audio_oasis.js). Suite overview:
[root README](../README.md).

Load an mp3/wav/flac/m4a, chop it into segments on a waveform, save the
segments in numbered order, and feed the result to LTX Oasis's
audio-driven-video slot - or any other AUDIO-input node.

## Layout

Suite-standard as of the v1.6 line: the waveform strip (waveform, scrub bar,
transport and split tools) runs full width across the top. Below it, the
IO/LTXO two-column body: a left column of collapsible sections (**Track**,
**Grid & Snap**, **Analysis**, **Help**) with a **Bypass Node** button pinned
underneath (same mode-4 toggle as the other Oasis nodes), and a right pane
holding the **Segments** list - the node's output, in the output-pane
position.

## Using it

1. **Track** section - upload or drop an audio file. The waveform, duration,
   sample rate, channel count, and peak/RMS levels appear immediately
   (decoded in the browser, no server round trip).
2. Click anywhere on the waveform to drop a chop point. Drag a point:
   **shift later** (default) moves that chop and every later one, so the
   segments after it keep their length; **stretch** moves only that chop
   so the next segment grows or shrinks. Hold Alt to invert for one drag.
   Double-click or right-click a point to remove it. **split every N** in
   the transport strip bulk-places evenly spaced points (toggle **s** /
   **f** for seconds or frames) - you can still add, remove, and drag
   points afterward. Each segment row also has a frame-count stepper: type a
   length or click the arrows (steps on the snap grid) instead of dragging
   a handle on the waveform.
3. Hit **Play** on a segment row to preview it (works before saving too -
   it's just the full track played between that segment's bounds).
4. **Analysis** section - Analyze gives BPM and estimated musical key. This
   needs `librosa`, which is not installed by default: `pip install librosa`
   (or uncomment it in the root `requirements.txt`) and restart ComfyUI.
   Everything else in the node works without it.
5. **Save segments** writes each chop-point range to disk as
   `<track>_seg001.<ext>`, `<track>_seg002.<ext>`, ... under
   `ComfyUI/input/audio_oasis/<track>/`, in the *same format* as the source
   file (re-encoded for a sample-accurate cut, not a bitstream copy -
   copying compressed audio at arbitrary times only lands on the nearest
   frame boundary, ~20-30ms off). A `manifest.json` next to the segments
   records the full cut state. Re-saving replaces the previous numbered set
   for that track name.
6. Drag a saved segment's grip (⋮⋮) straight onto LTX Oasis's audio
   slot to use it as that node's audio-driven-video input - no upload
   step, no wire. You can also click a segment row (or "Use full track as
   output") to choose what the node's own `AUDIO` output socket carries if
   you'd rather wire it normally.
7. **Load saved set** (Track section) restores a previously saved chop from
   its `manifest.json` - track, chop points, FPS, and segment list - into
   a fresh node, without re-chopping. Saved sets survive ComfyUI restarts
   because they live on disk, not in the workflow. If the original source
   file is gone from the input folder, the segments remain selectable and
   draggable; only the waveform and preview are unavailable.

## Notes

- Supported formats: mp3, wav, flac, m4a/aac. Segments save in whichever
  of these the source file already is.
- The first Analyze call after a ComfyUI restart is slow (10-30s) -
  that's librosa/numba's one-time JIT warm-up, not a per-call cost.
- Without `librosa` installed, everything works except the Analyze button,
  which returns a clear error explaining what's missing.
- In-node **Help** renders `audio_oasis_help_content.md`, served by
  `GET /audio_oasis/help` - same pattern as Image Oasis.
