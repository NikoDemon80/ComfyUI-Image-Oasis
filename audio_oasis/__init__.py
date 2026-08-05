"""Audio Oasis -- mp3/wav loader, waveform chopper, sequential segment
saver (subpackage)."""

from .nodes_audio import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

try:
    from . import routes_audio  # noqa: F401
except Exception as _e:
    print(f"[Audio Oasis] routes not registered: {_e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
