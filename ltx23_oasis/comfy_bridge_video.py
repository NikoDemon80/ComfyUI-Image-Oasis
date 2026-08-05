"""
Runtime bridge to ComfyUI's node registry. LTX2.3 Oasis invokes core nodes
(comfy_extras LTX/AV nodes, custom-sampler primitives) through
NODE_CLASS_MAPPINGS instead of copying their code — always matching the
installed ComfyUI, and working across both node APIs:

  - legacy classes:  INPUT_TYPES / FUNCTION / instance method returning tuple
  - v3 io.ComfyNode: define_schema() / classmethod execute() returning NodeOutput

call_node() fills unspecified required inputs from the node's declared
defaults (same technique as stage_load's GGUF bridge), so callers only pass
what they mean.
"""

import inspect


def node_class(class_name):
    import nodes as _n
    Cls = _n.NODE_CLASS_MAPPINGS.get(class_name)
    if Cls is None:
        raise RuntimeError(
            f"[LTX Oasis] Node '{class_name}' is not registered in this "
            "ComfyUI install. Update ComfyUI — this architecture needs it.")
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
    """Invoke a registered node functionally. Returns its output tuple."""
    Cls = node_class(class_name)
    kwargs = _fill_defaults(Cls, kwargs)

    fn_name = getattr(Cls, "FUNCTION", None)
    if not fn_name:
        out = Cls.execute(**kwargs)  # bare v3 io.ComfyNode
    else:
        # v3 ComfyNode: FUNCTION -> EXECUTE_NORMALIZED is a @classmethod.
        # getattr returns a *bound* method, so isinstance(..., classmethod)
        # is False. Calling fn(Cls(), **kwargs) would pass the instance as
        # execute()'s first input and collide with the matching kwarg
        # (TypeError: got multiple values for argument 'positive').
        raw = inspect.getattr_static(Cls, fn_name, None)
        if isinstance(raw, (classmethod, staticmethod)):
            out = getattr(Cls, fn_name)(**kwargs)
        else:
            out = getattr(Cls(), fn_name)(**kwargs)

    # Unwrap v3 NodeOutput / dict-style returns to a plain tuple.
    if hasattr(out, "args"):
        return tuple(out.args)
    if isinstance(out, dict) and "result" in out:
        return tuple(out["result"])
    if isinstance(out, tuple):
        return out
    return (out,)


def first(class_name, **kwargs):
    """call_node and return only the first output — the common case."""
    return call_node(class_name, **kwargs)[0]
