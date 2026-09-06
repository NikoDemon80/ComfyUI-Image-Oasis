"""LTX2.3 Oasis — all-in-one LTX 2.3 video generation (subpackage).

GPL-3.0-or-later. Uses in-pack VideoOasisPreview for encode/player/save.
"""

from .nodes_video import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import latent_cache  # noqa: F401  scene-bar motion-context cache

try:
    from . import routes_video  # noqa: F401
except Exception as _e:
    print(f"[LTX Oasis] routes not registered: {_e}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
