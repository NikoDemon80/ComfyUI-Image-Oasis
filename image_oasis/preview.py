"""
On-node image preview for Image Oasis.

Writes the decoded image batch to ComfyUI's temp directory with embedded PNG
metadata (prompt + workflow) and returns the standard ComfyUI
[{filename, subfolder, type:"temp"}] list. nodes_image.py sends that list to the
frontend via the "image-oasis/result" WebSocket event, keyed by the node's
stable io_id — NOT via ui["images"], which would route by raw numeric node id
against the currently active graph and misdeliver to same-id nodes on other
workflows (see the comment at the end of ImageOasis.generate).

This is the temp-save core only; the explicit save-to-output route lives in
routes_image.py.
"""

import os
import json
import random

import numpy as np
import folder_paths
from PIL import Image
from PIL.PngImagePlugin import PngInfo

try:
    from comfy.cli_args import args
except Exception:
    args = None


def _disable_metadata():
    return bool(getattr(args, "disable_metadata", False)) if args is not None else False


def save_preview(images, prompt=None, extra_pnginfo=None):
    """Write `images` (IMAGE tensor [B,H,W,C] or [B,T,H,W,C]) to temp and return
    the list of {filename, subfolder, type} entries for the io_id result event."""
    if images is None:
        return []

    # Ensure 4D (flatten 5D video batch)
    if hasattr(images, "ndim") and images.ndim == 5:
        images = images.view(-1, images.shape[-3], images.shape[-2], images.shape[-1])

    if getattr(images, "shape", None) is None or images.shape[0] == 0:
        return []

    output_dir = folder_paths.get_temp_directory()
    suffix = "".join(random.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(5))
    prefix = "ImageOasis_io_temp_" + suffix

    full_out, filename, counter, subfolder, _ = folder_paths.get_save_image_path(
        prefix, output_dir, images[0].shape[1], images[0].shape[0]
    )

    results = []
    nan_warned = False
    for batch_idx, image in enumerate(images):
        arr = image.cpu().numpy()
        # Surface corruption BEFORE clamping it away. nan_to_num below keeps
        # the preview from crashing, but silently masking NaN/Inf hid a real
        # bug for a long time (sage-attention producing NaN latents on Krea 2
        # showed up only as a black image). Warn once per batch.
        if not nan_warned and not np.isfinite(arr).all():
            nan_warned = True
            print("[Image Oasis] WARNING: NaN/Inf values in decoded image — "
                  "the latents were corrupted upstream (check for an "
                  "incompatible attention backend, e.g. --use-sage-attention). "
                  "Values clamped for preview; the image is not trustworthy.")
        arr = np.nan_to_num(arr, nan=0.0, posinf=1.0, neginf=0.0)
        img = Image.fromarray(np.clip(arr * 255.0, 0, 255).astype(np.uint8))

        metadata = None
        if not _disable_metadata():
            metadata = PngInfo()
            if prompt is not None:
                metadata.add_text("prompt", json.dumps(prompt))
            if extra_pnginfo is not None:
                for k, v in extra_pnginfo.items():
                    metadata.add_text(k, json.dumps(v))

        fname = f"{filename.replace('%batch_num%', str(batch_idx))}_{counter:05}_.png"
        img.save(os.path.join(full_out, fname), pnginfo=metadata, compress_level=1)
        results.append({"filename": fname, "subfolder": subfolder, "type": "temp"})
        counter += 1

    return results
