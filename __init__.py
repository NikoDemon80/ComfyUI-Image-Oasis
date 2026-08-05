"""
Oasis Suite — Image Oasis + Video Oasis Viewer + LTX2.3 Oasis + Audio Oasis.

One ComfyUI custom-node pack. Subpackages keep stable node class ids:
  ImageOasis, VideoOasisPreview, LTX23Oasis, AudioOasis

License: GPL-3.0-or-later (required by LTX Director vendored code in ltx23_oasis/).
"""

import os
import sys
import importlib.util

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))

# Stable sys.modules keys (not the bare folder names) so a leftover
# custom_nodes/video_oasis or custom_nodes/ltx23_oasis folder cannot shadow
# these in-pack copies during import. Flat names (no dots) avoid needing a
# parent namespace package for relative imports.


def _load_subpackage(folder_name, sys_name):
    """Load `./{folder_name}/__init__.py` as package `sys_name`."""
    if sys_name in sys.modules:
        return sys.modules[sys_name]
    pkg_dir = os.path.join(_THIS_DIR, folder_name)
    init_path = os.path.join(pkg_dir, "__init__.py")
    spec = importlib.util.spec_from_file_location(
        sys_name,
        init_path,
        submodule_search_locations=[pkg_dir],
    )
    mod = importlib.util.module_from_spec(spec)
    mod.__path__ = [pkg_dir]
    mod.__package__ = sys_name
    sys.modules[sys_name] = mod
    spec.loader.exec_module(mod)
    return mod


_image = _load_subpackage("image_oasis", "oasis_suite_image_oasis")
_video = _load_subpackage("video_oasis", "oasis_suite_video_oasis")
_ltx = _load_subpackage("ltx23_oasis", "oasis_suite_ltx23_oasis")
_audio = _load_subpackage("audio_oasis", "oasis_suite_audio_oasis")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
NODE_CLASS_MAPPINGS.update(getattr(_image, "NODE_CLASS_MAPPINGS", {}) or {})
NODE_CLASS_MAPPINGS.update(getattr(_video, "NODE_CLASS_MAPPINGS", {}) or {})
NODE_CLASS_MAPPINGS.update(getattr(_ltx, "NODE_CLASS_MAPPINGS", {}) or {})
NODE_CLASS_MAPPINGS.update(getattr(_audio, "NODE_CLASS_MAPPINGS", {}) or {})
NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_image, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {})
NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_video, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {})
NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_ltx, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {})
NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_audio, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {})

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
