"""
Scene-bar latent cache for LTX Oasis motion context.

Same job as H3 Oasis's cache: the clip in the viewer is the chain identity,
and the previous sample should reach the next run as a latent rather than as
h264. LTX still has to VAE-decode that latent into pixels before
LTXVImgToVideoInplace (the packed temporal latent cannot be spliced into a
new head without promoting a delta frame into the anchor slot). The win is
skipping the file round-trip, which is what compounds along a chain.

A miss is not a failed chain. Clips loaded from disk, Clip, Create Movie,
and anything whose cache file was swept still continue from the viewer file,
which is the path this node had before the cache existed.
"""

import hashlib
import logging
import os
import re
import shutil
import threading

import torch

log = logging.getLogger("LTXOasis")

try:
    from safetensors.torch import load_file as _st_load, save_file as _st_save
except ImportError:
    _st_load = _st_save = None

FORMAT_TAG = "ltx23_oasis_av_latent_v1"
SUBDIR = os.path.join("ltx23_oasis", "latents")
EXT = ".safetensors"
DEFAULT_BUDGET_BYTES = 5 * 1024 ** 3
MEMORY_SLOTS = 3

_lock = threading.RLock()
_mem = {}
_mem_order = []
_budget = DEFAULT_BUDGET_BYTES
_pending = {}   # io_id -> pair, committed once encode names the file


def cache_dir():
    import folder_paths
    d = os.path.join(folder_paths.get_output_directory(), SUBDIR)
    os.makedirs(d, exist_ok=True)
    return d


def _stem(entry_id):
    raw = str(entry_id or "")
    safe = re.sub(r"[^A-Za-z0-9_-]", "", raw)[:48]
    h = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    return f"{safe}_{h}" if safe else h


def path_for(entry_id):
    return os.path.join(cache_dir(), _stem(entry_id) + EXT)


def entry_id_for(video, subfolder="", type_="temp"):
    """Stable id derived from the scene-bar file identity.

    type is part of the key: Save copies temp → output, which is a new
    entry and needs its own copy of the latent.
    """
    parts = (str(type_ or "temp").strip().lower(),
             str(subfolder or "").strip().replace("\\", "/").strip("/"),
             str(video or "").strip().replace("\\", "/"))
    if not parts[2]:
        return ""
    return "%s:%s" % (parts[0], "/".join(p for p in parts[1:] if p))


def _cpu_tensor(t):
    if t is None:
        return None
    if not torch.is_tensor(t):
        t = getattr(t, "samples", t)
    if not torch.is_tensor(t):
        return None
    return t.detach().to("cpu").contiguous()


def snapshot_pair(video_latent, audio_latent=None, ctx_latent_frames=0,
                  deliver_frames=0, fps=25.0, quantum=8):
    """CPU copy of the pre-decode video (and optional generate-mode audio)."""
    video = _cpu_tensor(video_latent if not isinstance(video_latent, dict)
                       else video_latent.get("samples"))
    if video is None:
        return None
    audio = None
    if audio_latent is not None:
        audio = _cpu_tensor(audio_latent if not isinstance(audio_latent, dict)
                            else audio_latent.get("samples"))
    return {
        "video": video,
        "audio": audio,
        "ctx_latent_frames": int(ctx_latent_frames or 0),
        "deliver_frames": int(deliver_frames or 0),
        "fps": float(fps or 25.0),
        "quantum": int(quantum or 8),
    }


def _touch(entry_id):
    if entry_id in _mem_order:
        _mem_order.remove(entry_id)
    _mem_order.append(entry_id)


def _mem_put(entry_id, pair):
    _mem[entry_id] = pair
    _touch(entry_id)
    while len(_mem_order) > MEMORY_SLOTS:
        old = _mem_order.pop(0)
        _mem.pop(old, None)


def _pack_tensors(pair):
    out = {
        "video": pair["video"],
        "ctx_latent_frames": torch.tensor([int(pair["ctx_latent_frames"])],
                                          dtype=torch.int32),
        "deliver_frames": torch.tensor([int(pair["deliver_frames"])],
                                       dtype=torch.int32),
        "fps_milli": torch.tensor(
            [int(round(float(pair["fps"]) * 1000))], dtype=torch.int32),
        "quantum": torch.tensor([int(pair["quantum"])], dtype=torch.int32),
    }
    if pair.get("audio") is not None:
        out["audio"] = pair["audio"]
    return out


def _unpack_tensors(data):
    if "video" not in data:
        return None
    def _i(name, default):
        t = data.get(name)
        if t is None:
            return default
        return int(t.reshape(-1)[0].item())
    fps_milli = _i("fps_milli", 25000)
    return {
        "video": data["video"],
        "audio": data.get("audio"),
        "ctx_latent_frames": _i("ctx_latent_frames", 0),
        "deliver_frames": _i("deliver_frames", 0),
        "fps": fps_milli / 1000.0,
        "quantum": _i("quantum", 8),
    }


def store(entry_id, pair):
    if not entry_id or not pair or pair.get("video") is None:
        return None
    with _lock:
        _mem_put(entry_id, pair)
        if _st_save is None:
            log.warning("[LTX Oasis] safetensors unavailable; latent kept in "
                        "memory only and will not survive a restart.")
            return None
        p = path_for(entry_id)
        try:
            _st_save(_pack_tensors(pair), p,
                     metadata={"format": FORMAT_TAG, "entry_id": str(entry_id)})
        except Exception as e:
            log.warning("[LTX Oasis] Could not write latent for %s: %r",
                        entry_id, e)
            return None
        nbytes = int(pair["video"].numel()) * int(pair["video"].element_size())
        log.info("[LTX Oasis] Cached latent for %s (video %s, %.1f MB)",
                 entry_id, tuple(pair["video"].shape), nbytes / 1024 ** 2)
        _enforce_budget()
        return p


def fetch(entry_id):
    if not entry_id:
        return None
    with _lock:
        pair = _mem.get(entry_id)
        if pair is not None:
            _touch(entry_id)
            return pair
        if _st_load is None:
            return None
        p = path_for(entry_id)
        if not os.path.isfile(p):
            return None
        try:
            data = _st_load(p)
        except Exception as e:
            log.warning("[LTX Oasis] Could not read cached latent %s: %r", p, e)
            return None
        pair = _unpack_tensors(data)
        if pair is None:
            log.warning("[LTX Oasis] %s is not an LTX Oasis latent; ignoring.", p)
            return None
        _mem_put(entry_id, pair)
        log.info("[LTX Oasis] Loaded cached latent for %s", entry_id)
        return pair


def has(entry_id):
    if not entry_id:
        return False
    with _lock:
        return entry_id in _mem or os.path.isfile(path_for(entry_id))


def copy_to(src_entry_id, dst_entry_id):
    if not src_entry_id or not dst_entry_id or src_entry_id == dst_entry_id:
        return False
    with _lock:
        pair = _mem.get(src_entry_id)
        if pair is not None:
            _mem_put(dst_entry_id, pair)
        dp = path_for(dst_entry_id)
        if os.path.isfile(dp):
            return True
        sp = path_for(src_entry_id)
        if os.path.isfile(sp):
            try:
                shutil.copyfile(sp, dp)
            except OSError as e:
                log.warning("[LTX Oasis] Could not copy latent %s -> %s: %r",
                            src_entry_id, dst_entry_id, e)
                return pair is not None
            log.info("[LTX Oasis] Latent for %s now also filed under %s",
                     src_entry_id, dst_entry_id)
            _enforce_budget()
            return True
        if pair is not None and _st_save is not None:
            try:
                _st_save(_pack_tensors(pair), dp,
                         metadata={"format": FORMAT_TAG,
                                   "entry_id": str(dst_entry_id)})
            except Exception as e:
                log.warning("[LTX Oasis] Could not write latent for %s: %r",
                            dst_entry_id, e)
                return True
            _enforce_budget()
            return True
        return pair is not None


def drop(entry_id):
    if not entry_id:
        return False
    with _lock:
        _mem.pop(entry_id, None)
        if entry_id in _mem_order:
            _mem_order.remove(entry_id)
        p = path_for(entry_id)
        if os.path.isfile(p):
            try:
                os.remove(p)
                log.info("[LTX Oasis] Dropped cached latent for %s", entry_id)
                return True
            except OSError as e:
                log.warning("[LTX Oasis] Could not remove %s: %r", p, e)
        return False


def set_pending(io_id, pair):
    if io_id and pair:
        _pending[str(io_id)] = pair


def commit_pending(io_id, video, subfolder="", type_="temp"):
    pair = _pending.pop(str(io_id or ""), None)
    if pair is None:
        return None
    return store(entry_id_for(video, subfolder, type_), pair)


def _files():
    try:
        d = cache_dir()
    except Exception:
        return []
    out = []
    for f in os.listdir(d):
        if not f.endswith(EXT):
            continue
        p = os.path.join(d, f)
        try:
            st = os.stat(p)
        except OSError:
            continue
        out.append((p, st.st_size, st.st_mtime))
    return out


def _enforce_budget():
    files = _files()
    total = sum(s for _p, s, _m in files)
    if total <= _budget:
        return 0
    files.sort(key=lambda t: t[2])
    removed = 0
    for p, size, _m in files:
        if total <= _budget:
            break
        try:
            os.remove(p)
        except OSError:
            continue
        total -= size
        removed += 1
    if removed:
        log.info("[LTX Oasis] Latent cache over budget; removed %d oldest "
                 "(now %.2f GB of %.2f GB)",
                 removed, total / 1024 ** 3, _budget / 1024 ** 3)
    return removed


def sweep(known_entry_ids=None):
    with _lock:
        removed = 0
        if known_entry_ids is not None:
            keep = {_stem(e) + EXT for e in known_entry_ids}
            for p, _s, _m in _files():
                if os.path.basename(p) not in keep:
                    try:
                        os.remove(p)
                        removed += 1
                    except OSError:
                        pass
            known = set(known_entry_ids)
            for e in [e for e in _mem if e not in known]:
                _mem.pop(e, None)
                if e in _mem_order:
                    _mem_order.remove(e)
            if removed:
                log.info("[LTX Oasis] Swept %d latents with no scene bar "
                         "entry", removed)
        removed += _enforce_budget()
        return removed
