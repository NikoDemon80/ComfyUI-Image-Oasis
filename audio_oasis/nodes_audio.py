"""
Audio Oasis -- mp3/wav loader, waveform chopper, and sequential segment
saver. Feeds LTX2.3 Oasis's audio-driven-video slot (drag a segment chip
onto it) or any other AUDIO-input node in the graph (wire the output).

Chopping, saving, and BPM/key analysis all happen synchronously over plain
HTTP routes (routes_audio.py) while you edit in the node -- fast enough that none
of it needs a queued graph run or the WebSocket result-delivery dance
LTX2.3 Oasis and Video Oasis Viewer use for slow encodes. The node's own
execute() only does one thing: hand the currently selected clip (the whole
track, or one saved segment) to the graph as a normal AUDIO output.
"""

import json
import logging

from .comfy_bridge_audio import first

log = logging.getLogger("AudioOasis")


class AudioOasis:
    """Load an audio file, chop it into segments on a waveform, save them
    to disk in numbered order, and output the selected clip as AUDIO."""

    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {},
            "optional": {
                # Entire node state (track, chop points, saved segments,
                # selection) serialized by the frontend as JSON -- same
                # pattern as ltx23_oasis_ui / video_oasis_ui.
                "audio_oasis_ui": ("STRING", {"default": "{}"}),
            },
        }

    RETURN_TYPES = ("AUDIO", "STRING")
    RETURN_NAMES = ("audio", "filename")
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "audio"
    DESCRIPTION = ("Upload an mp3/wav, chop it into segments on a waveform, save them in "
                   "numbered order, and output the selected clip as AUDIO -- or drag a "
                   "segment straight onto LTX2.3 Oasis's audio slot.")
    SEARCH_ALIASES = ["audio oasis", "chop audio", "audio segments", "waveform",
                       "mp3 chopper", "audio splitter", "song segments"]

    @staticmethod
    def _read_widget_state(raw):
        try:
            state = json.loads(raw) if raw else {}
            return state if isinstance(state, dict) else {}
        except Exception:
            log.exception("AudioOasis: bad audio_oasis_ui payload, using defaults")
            return {}

    @classmethod
    def IS_CHANGED(cls, audio_oasis_ui="{}"):
        """Key the execute cache on the selected file's identity AND its
        on-disk mtime/size. Without this, re-saving segments that produce a
        byte-different file under the SAME name (same boundaries, different
        source edit) would serve ComfyUI's cached AUDIO from the previous
        run instead of re-reading the file."""
        import os
        import folder_paths
        st = cls._read_widget_state(audio_oasis_ui)
        exec_state = st.get("exec") if isinstance(st.get("exec"), dict) else st
        selected = (exec_state.get("selected_file")
                    or exec_state.get("track_file") or "").strip()
        if not selected:
            return ""
        rel = selected.replace("\\", "/")
        path = os.path.join(folder_paths.get_input_directory(), *rel.split("/"))
        try:
            s = os.stat(path)
            return f"{rel}:{s.st_mtime_ns}:{s.st_size}"
        except OSError:
            # Missing file still returns a distinct key; run() raises the
            # user-facing error with the real explanation.
            return rel

    def run(self, audio_oasis_ui="{}"):
        st = self._read_widget_state(audio_oasis_ui)
        exec_state = st.get("exec") if isinstance(st.get("exec"), dict) else st

        selected = (exec_state.get("selected_file") or exec_state.get("track_file") or "").strip()
        if not selected:
            raise ValueError(
                "[Audio Oasis] No audio loaded. Upload a track in the node "
                "(and, optionally, save and pick a segment) before running.")

        audio = first("LoadAudio", audio=selected)
        return (audio, selected)


NODE_CLASS_MAPPINGS = {
    "AudioOasis": AudioOasis,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AudioOasis": "Audio Oasis \U0001f334",
}
