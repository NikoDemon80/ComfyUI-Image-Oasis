"""Image Oasis — all-in-one image generation node (subpackage)."""

import os
import sys
import importlib.util

_THIS_DIR = os.path.dirname(os.path.abspath(__file__))


def _load(mod_name):
    key = f"image_oasis_{mod_name}"
    if key in sys.modules:
        return sys.modules[key]
    path = os.path.join(_THIS_DIR, f"{mod_name}.py")
    spec = importlib.util.spec_from_file_location(key, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module


_nodes = _load("nodes_image")

try:
    _load("routes_image")
except Exception as _e:
    print(f"[Image Oasis] route registration skipped: {_e}")
try:
    _load("routes_enhance")
except Exception as _e:
    print(f"[Image Oasis] enhancer route registration skipped: {_e}")

NODE_CLASS_MAPPINGS = _nodes.NODE_CLASS_MAPPINGS
NODE_DISPLAY_NAME_MAPPINGS = _nodes.NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
