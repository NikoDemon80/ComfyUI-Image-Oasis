# Audio Oasis Help 🌴

Load a track, chop it into segments on the waveform, save them as numbered files, and feed the result to LTX Oasis's audio-driven-video slot or any other AUDIO-input node.

---

## 🎵 Layout

The **waveform strip** (waveform, scrub bar, transport, and split tools) runs full width at the top. Below it: a settings column on the left, and the **Segments** pane on the right. Segments are the node's output, so they sit where the other Oasis nodes put theirs.

---

## 📂 Track

**Upload** an mp3, wav, flac, or m4a/aac by clicking the slot or dropping a file on it. Waveform, duration, sample rate, channel count, and peak/RMS levels appear immediately - decoded in the browser, no server round trip.

**Save as** sets the folder name your segments save under. Defaults to the upload's filename.

**Load saved set** restores a previously saved chop from disk without re-chopping. Every save writes a `manifest.json` next to its segment files under `input/audio_oasis/<track>/`, so a saved set survives ComfyUI restarts even if the workflow was never saved. Loading one brings back the track, chop points, FPS, and segment list exactly as saved. If the original source file is gone from the input folder, the segments are still selectable and draggable - only the waveform and preview are unavailable.

---

## ✂️ Chopping

- **Click** anywhere on the waveform to drop a chop point.
- **Drag** a point to slide it. **Double-click** or **right-click** removes it.
- **split every N s** (in the transport strip) bulk-places evenly spaced points. You can still add, remove, and drag points afterward.
- **Play** on a segment row previews it, before or after saving.

---

## 🎛️ Grid & Snap

LTX only accepts clips whose frame count is **8n+1** (9, 17, 25, 33, ...) - the same grid on 2.3 and 2.5. This section keeps your chops legal.

- **FPS** - the frame rate the chop grid is quantized to. Match it to your video pipeline's FPS (25 for LTX 2.3, 24 for LTX 2.5).
- **Snap: 8n+1 (LTX)** - locks every chop point so every segment's frame count stays 8n+1. This is the default and the right mode when the segments feed LTX.
- **Snap: frames** - locks points to whole frames without the 8n+1 rule.
- **Snap: off** - free positioning in seconds.
- **Re-snap** - re-quantizes all existing points after an FPS or snap-mode change.

The last segment usually is not 8n+1 - the track just ends where it ends. The segment row flags it. Drag its handle, delete it, or leave it and skip feeding that one to LTX.

---

## 🔍 Analysis

**Analyze** estimates BPM and musical key. It needs `librosa`, which is not installed by default: `pip install librosa` (or uncomment it in the root `requirements.txt`) and restart ComfyUI. The first run after a ComfyUI restart takes 10-30 seconds while librosa warms up; after that it is fast. Everything else in the node works without librosa.

---

## 📋 Segments

**Save segments** writes each range to disk as `<track>_seg001.<ext>`, `<track>_seg002.<ext>`, ... under `input/audio_oasis/<track>/`, in the same format as the source file. Cuts are **sample-accurate** (decoded and re-encoded, not a bitstream copy - bitstream copies only land on the nearest compressed frame boundary, ~20-30ms off). Re-saving replaces the previous numbered set for that track name.

- **Click a segment row** to make it the node's AUDIO output.
- **Click Use full track as output** to send the whole track instead.
- **Drag a saved segment's grip** (⋮⋮) straight onto LTX Oasis's audio slot - no upload step, no wire.

> 💡 You can drag a saved segment chip onto **any** node that accepts a file drop, not just LTX Oasis.

---

## ⏻ Bypass Node

The button pinned under the left column. Click **Bypass Node** to skip this node at execution (same as rgthree's bypass - node mode 4); the button highlights and flips to **Activate Node** to bring it back.

---

## Tips & gotchas 💡

- **Segment won't save?** Check that the source format's encoder is available in your FFmpeg build. The error message names the missing encoder.
- **Waveform won't load?** The browser decodes the file client-side; if it fails it usually means the file is corrupted or an unsupported variant of the format.
- **Chop points jumping around?** That's the 8n+1 quantizer keeping every segment legal. Switch to **Snap: frames** or **Snap: off** if you don't need LTX-legal lengths.
- **Analysis taking forever?** Only the first Analyze call after a ComfyUI restart is slow (librosa/numba JIT warm-up). Subsequent calls are fast for the life of the process.
- **Lost your chops after closing ComfyUI?** Use **Load saved set** in the Track section. As long as you hit Save segments at least once, the manifest on disk has everything needed to restore the session.
