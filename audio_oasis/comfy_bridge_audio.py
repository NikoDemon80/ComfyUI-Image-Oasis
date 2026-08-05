"""
Runtime bridge to ComfyUI's node registry.

Vendored (not imported from ltx23_oasis) so Audio Oasis works standalone --
same reasoning as Image Oasis's routes_image.py vendoring its own folder-scan
helpers instead of reaching into a sibling suite. Only what Audio Oasis
needs: calling the stock `LoadAudio` node to turn a filename in the input
folder into a proper AUDIO dict.
"""

import inspect


def node_class(class_name):
    import nodes as _n
    Cls = _n.NODE_CLASS_MAPPINGS.get(class_name)
    if Cls is None:
        raise RuntimeError(
            f"[Audio Oasis] Node '{class_name}' is not registered in this "
            "ComfyUI install. Update ComfyUI -- this feature needs it.")
    return Cls


def _fill_defaults(Cls, kwargs):
    try:
        req = Cls.INPUT_TYPES().get("required", {})
    except Exception:
        return kwargs
    for k, v in req.items():
        if k in kwargs:
            continue
        try:
            spec = v[1] if len(v) > 1 and isinstance(v[1], dict) else {}
            d = spec.get("default",
                         v[0][0] if isinstance(v[0], (list, tuple)) and v[0] else None)
        except Exception:
            d = None
        if d is not None:
            kwargs[k] = d
    return kwargs


def call_node(class_name, **kwargs):
    """Invoke a registered node functionally. Returns its output tuple.
    Handles both legacy (INPUT_TYPES/FUNCTION) and v3 io.ComfyNode APIs."""
    Cls = node_class(class_name)
    kwargs = _fill_defaults(Cls, kwargs)

    fn_name = getattr(Cls, "FUNCTION", None)
    if not fn_name:
        out = Cls.execute(**kwargs)  # bare v3 io.ComfyNode
    else:
        raw = inspect.getattr_static(Cls, fn_name, None)
        if isinstance(raw, (classmethod, staticmethod)):
            out = getattr(Cls, fn_name)(**kwargs)
        else:
            out = getattr(Cls(), fn_name)(**kwargs)

    if hasattr(out, "args"):
        return tuple(out.args)
    if isinstance(out, dict) and "result" in out:
        return tuple(out["result"])
    if isinstance(out, tuple):
        return out
    return (out,)


def first(class_name, **kwargs):
    """call_node and return only the first output -- the common case."""
    return call_node(class_name, **kwargs)[0]
