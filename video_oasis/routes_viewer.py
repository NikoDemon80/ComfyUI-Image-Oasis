"""
Video Oasis Viewer -- HTTP routes for the scene bar / clip / create-movie tools.

Moved out of LTX2.3 Oasis so the standalone Video Oasis Viewer owns the
full preview toolkit. LTX may keep thin aliases until the repos are merged.
"""

import os
import logging

import folder_paths
from aiohttp import web
from server import PromptServer

log = logging.getLogger("VideoOasis")
routes = PromptServer.instance.routes


def _resolve_under(base, *parts):
    """Join parts onto base; None unless the result stays inside base."""
    resolved = os.path.realpath(os.path.join(base, *parts))
    root = os.path.realpath(base)
    if resolved != root and not resolved.startswith(root + os.sep):
        return None
    return resolved


# ── Load-from-disk (external videos, output/ only) ──────────────────────────
#
# The "+" tile in the scene bar opens a picker that lists videos under
# output/ and lets the user drop one into the strip as a saved entry.
# list_output_videos does the cheap directory walk (name + size + mtime);
# probe_video runs PyAV on demand to fetch the full metadata the frontend
# needs to build a strip entry that matches the fresh-generation shape.

_VIDEO_EXTS = (".mp4", ".webm", ".mkv", ".mov", ".m4v", ".avi")
_LIST_CAP = 500


def _walk_output_videos():
    out_root = folder_paths.get_output_directory()
    if not os.path.isdir(out_root):
        return []
    results = []
    for dirpath, _, filenames in os.walk(out_root):
        for name in filenames:
            if not name.lower().endswith(_VIDEO_EXTS):
                continue
            full = os.path.join(dirpath, name)
            try:
                stat = os.stat(full)
            except OSError:
                continue
            rel = os.path.relpath(dirpath, out_root)
            subfolder = "" if rel == "." else rel.replace(os.sep, "/")
            results.append({
                "filename": name,
                "subfolder": subfolder,
                "size_bytes": int(stat.st_size),
                "mtime": float(stat.st_mtime),
            })
    results.sort(key=lambda r: r["mtime"], reverse=True)
    return results[:_LIST_CAP]


@routes.get("/video_oasis/list_output_videos")
async def vo_list_output_videos(request):
    try:
        return web.json_response(_walk_output_videos())
    except Exception as e:
        return web.json_response({"error": f"List failed: {e}"}, status=500)


@routes.post("/video_oasis/probe_video")
async def vo_probe_video(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    filename = (data.get("filename") or "").strip()
    subfolder = (data.get("subfolder") or "").strip()
    if not filename:
        return web.json_response({"error": "Missing filename."}, status=400)
    out_root = folder_paths.get_output_directory()
    # _resolve_under prevents traversal via .. or absolute paths.
    path = _resolve_under(out_root, subfolder, filename) if subfolder \
           else _resolve_under(out_root, filename)
    if not path or not os.path.isfile(path):
        return web.json_response(
            {"error": "Not found under output/."}, status=404)
    try:
        import av
    except ImportError:
        return web.json_response(
            {"error": "PyAV not installed."}, status=500)
    try:
        with av.open(path) as container:
            vs = None
            has_audio = False
            for stream in container.streams:
                if stream.type == "video" and vs is None:
                    vs = stream
                elif stream.type == "audio":
                    has_audio = True
            if vs is None:
                return web.json_response(
                    {"error": "No video stream in file."}, status=400)
            width = int(vs.codec_context.width or 0)
            height = int(vs.codec_context.height or 0)
            codec_name = vs.codec_context.name or ""
            # average_rate is a Fraction; base_rate is a fallback. Some
            # files report neither (rare); default to 24 in that case.
            fps = float(vs.average_rate) if vs.average_rate \
                  else (float(vs.base_rate) if vs.base_rate else 24.0)
            # container.duration is in AV_TIME_BASE units (microseconds).
            duration_s = (float(container.duration) / 1_000_000.0
                          if container.duration else 0.0)
            # vs.frames may be zero for streams that don't advertise it;
            # derive from duration in that case.
            frames = int(vs.frames) if vs.frames \
                     else max(0, int(round(duration_s * fps)))
        try:
            size_bytes = int(os.path.getsize(path))
        except OSError:
            size_bytes = 0
        ext = os.path.splitext(filename)[1].lstrip(".").lower() or "mp4"
        return web.json_response({
            "width": width, "height": height,
            "fps": fps, "frames": frames,
            "duration_s": duration_s,
            "codec": codec_name,
            "format": ext,
            "size_bytes": size_bytes,
            "has_audio": has_audio,
        })
    except Exception as e:
        return web.json_response(
            {"error": f"Probe failed: {e}"}, status=500)


# ── Create Movie: fast-path stream-copy concat ──────────────────────────────
#
# Video: stream-copy when every input shares codec + extradata (SPS/PPS);
# otherwise re-encode. Mixing originals with Clip outputs used to pass the
# old codec/size/fps check then corrupt after the first cut.
#
# Audio: always re-encoded to AAC when requested, with silence synthesized
# for clips that have no audio stream.
#
# The output is written to output/video/create_movie_NNNNN.mp4, with NNNNN
# chosen to be the next unused sequence number in that folder.

_MOVIE_PREFIX = "create_movie_"


def _next_movie_path():
    """Pick output/video/create_movie_NNNNN.mp4 -- the smallest unused N ≥ 1."""
    out_root = folder_paths.get_output_directory()
    video_dir = os.path.join(out_root, "video")
    os.makedirs(video_dir, exist_ok=True)
    used = set()
    for name in os.listdir(video_dir):
        if not name.startswith(_MOVIE_PREFIX) or not name.lower().endswith(".mp4"):
            continue
        stem = name[len(_MOVIE_PREFIX):-4]
        if stem.isdigit():
            used.add(int(stem))
    n = 1
    while n in used:
        n += 1
    filename = f"{_MOVIE_PREFIX}{n:05d}.mp4"
    return os.path.join(video_dir, filename), f"video/{filename}"


def _emit_silence(out_container, audio_stream, seconds, pts_start):
    """Encode `seconds` of silence into `audio_stream`. Returns new pts.

    PTS units are the stream's time_base (samples for typical AAC streams).
    Frames are float32 planar (fltp) with n_channels rows of zeros.
    """
    import av
    import numpy as np
    codec_ctx = audio_stream.codec_context
    sample_rate = codec_ctx.sample_rate
    layout_name = codec_ctx.layout.name
    n_channels = len(codec_ctx.layout.channels)
    frame_size = codec_ctx.frame_size or 1024
    total = int(round(seconds * sample_rate))
    pts = pts_start
    emitted = 0
    while emitted < total:
        n = min(frame_size, total - emitted)
        arr = np.zeros((n_channels, n), dtype=np.float32)
        frame = av.AudioFrame.from_ndarray(arr, format="fltp", layout=layout_name)
        frame.sample_rate = sample_rate
        frame.pts = pts
        emitted += n
        pts += n
        for packet in audio_stream.encode(frame):
            out_container.mux(packet)
    return pts


def _probe_movie_inputs(input_paths):
    """Probe clips for Create Movie. Raises ValueError on size/fps mismatch."""
    import av
    from fractions import Fraction
    if len(input_paths) < 2:
        raise ValueError("Need at least two clips.")
    ref = None
    probes = []
    for p in input_paths:
        with av.open(p) as c:
            v = next((s for s in c.streams if s.type == "video"), None)
            a = next((s for s in c.streams if s.type == "audio"), None)
            if v is None:
                raise ValueError(f"{os.path.basename(p)}: no video stream.")
            width = int(v.codec_context.width or 0)
            height = int(v.codec_context.height or 0)
            codec = v.codec_context.name or ""
            if v.average_rate and float(v.average_rate) > 0:
                fps_frac = Fraction(v.average_rate).limit_denominator(1001)
            elif v.base_rate and float(v.base_rate) > 0:
                fps_frac = Fraction(v.base_rate).limit_denominator(1001)
            else:
                fps_frac = Fraction(25, 1)
            fps = float(fps_frac)
            duration_s = (float(c.duration) / 1_000_000.0) if c.duration else 0.0
            extradata = bytes(v.codec_context.extradata or b"")
            probe = {
                "path": p, "width": width, "height": height,
                "codec": codec, "fps": fps, "fps_frac": fps_frac,
                "duration_s": duration_s,
                "has_audio": a is not None,
                "audio_rate": (a.codec_context.sample_rate if a else 0),
                "audio_layout": (a.codec_context.layout.name if a else ""),
                "extradata": extradata,
            }
            if ref is None:
                ref = probe
            else:
                if (probe["width"] != ref["width"] or
                        probe["height"] != ref["height"] or
                        abs(probe["fps"] - ref["fps"]) > 0.01):
                    raise ValueError(
                        f"{os.path.basename(p)} is incompatible with "
                        f"{os.path.basename(ref['path'])} (size/fps mismatch).")
            probes.append(probe)
    return probes, ref


def _stream_copy_viable(probes):
    """True only when every clip shares codec + SPS/PPS (extradata).

    Clipped re-encodes often share h264/size/fps with the originals but
    different extradata -- stream-copy then corrupts after the first cut.
    """
    if not probes:
        return False
    ref = probes[0]
    for p in probes[1:]:
        if p["codec"] != ref["codec"] or p["extradata"] != ref["extradata"]:
            return False
    return True


def _stream_copy_concat(input_paths, output_path, use_audio, probes=None):
    """Concatenate when bitstream params match. Prefer _reencode_concat for
    mixed sources (e.g. original + Clip outputs)."""
    import av
    probes, ref = (probes, probes[0]) if probes else _probe_movie_inputs(input_paths)

    out_audio_params = None
    if use_audio:
        for p in probes:
            if p["has_audio"]:
                out_audio_params = {
                    "rate": p["audio_rate"] or 48000,
                    "layout": p["audio_layout"] or "stereo",
                }
                break

    with av.open(input_paths[0]) as tmpl_c:
        tmpl_v = next(s for s in tmpl_c.streams if s.type == "video")
        with av.open(output_path, mode="w") as out:
            if hasattr(out, "add_stream_from_template"):
                v_out = out.add_stream_from_template(tmpl_v)
            else:
                v_out = out.add_stream(template=tmpl_v)
            a_out = None
            if out_audio_params:
                a_out = out.add_stream("aac", rate=out_audio_params["rate"])
                a_out.layout = out_audio_params["layout"]

            v_pts_offset = 0
            a_pts = 0

            for probe in probes:
                path = probe["path"]
                with av.open(path) as in_c:
                    v_in = next(s for s in in_c.streams if s.type == "video")

                    first_pts = None
                    last_end = 0
                    for packet in in_c.demux(v_in):
                        if packet.dts is None:
                            continue
                        p_pts = packet.pts if packet.pts is not None else packet.dts
                        if first_pts is None:
                            first_pts = p_pts
                        packet.stream = v_out
                        if packet.pts is not None:
                            packet.pts = (packet.pts - first_pts) + v_pts_offset
                        if packet.dts is not None:
                            packet.dts = (packet.dts - first_pts) + v_pts_offset
                        if packet.duration:
                            last_end = max(last_end, packet.pts + packet.duration)
                        out.mux(packet)
                    v_pts_offset = last_end if last_end > 0 else v_pts_offset

                # Audio needs its own container handle: the demux loop above
                # runs `in_c` to EOF and PyAV does not rewind, so decoding
                # audio from that same handle yields zero frames -- an aac
                # stream is declared, never fed, and the movie is silent.
                # _reencode_concat already opens a second handle for this
                # reason; the stream-copy path did not.
                if a_out is not None:
                    if probe["has_audio"]:
                        with av.open(path) as in_a:
                            a_in = next(s for s in in_a.streams if s.type == "audio")
                            resampler = av.AudioResampler(
                                format="fltp",
                                layout=out_audio_params["layout"],
                                rate=out_audio_params["rate"],
                            )
                            for frame in in_a.decode(a_in):
                                for out_frame in (resampler.resample(frame) or []):
                                    out_frame.pts = a_pts
                                    a_pts += out_frame.samples
                                    for pkt in a_out.encode(out_frame):
                                        out.mux(pkt)
                    else:
                        a_pts = _emit_silence(
                            out, a_out, probe["duration_s"], a_pts)

            if a_out is not None:
                for pkt in a_out.encode(None):
                    out.mux(pkt)

    try:
        size_bytes = int(os.path.getsize(output_path))
    except OSError:
        size_bytes = 0
    return {
        "size_bytes": size_bytes,
        "duration_s": sum(p["duration_s"] for p in probes),
        "method": "stream_copy",
    }


def _reencode_concat(input_paths, output_path, use_audio, probes=None):
    """Decode/re-encode concat -- safe for mixed originals + Clip outputs."""
    import av
    from fractions import Fraction
    probes, ref = (probes, probes[0]) if probes else _probe_movie_inputs(input_paths)
    fps = ref["fps_frac"]
    width, height = ref["width"], ref["height"]
    v_tb = Fraction(1, int(round(ref["fps"])) or 25)

    out_audio_params = None
    if use_audio:
        for p in probes:
            if p["has_audio"]:
                out_audio_params = {
                    "rate": p["audio_rate"] or 48000,
                    "layout": p["audio_layout"] or "stereo",
                }
                break

    with av.open(output_path, mode="w") as out:
        v_out = out.add_stream("libx264", rate=fps)
        v_out.width = width
        v_out.height = height
        v_out.pix_fmt = "yuv420p"
        v_out.time_base = v_tb
        try:
            v_out.codec_context.time_base = v_tb
        except Exception:
            pass
        try:
            v_out.options = {"crf": "18", "preset": "veryfast"}
        except Exception:
            pass

        a_out = None
        if out_audio_params:
            a_out = out.add_stream("aac", rate=out_audio_params["rate"])
            a_out.layout = out_audio_params["layout"]

        v_pts = 0
        a_pts = 0
        for probe in probes:
            with av.open(probe["path"]) as in_c:
                v_in = next(s for s in in_c.streams if s.type == "video")
                for frame in in_c.decode(v_in):
                    out_frame = frame.reformat(
                        width=width, height=height, format="yuv420p")
                    out_frame.pts = v_pts
                    out_frame.time_base = v_tb
                    v_pts += 1
                    for pkt in v_out.encode(out_frame):
                        out.mux(pkt)
            if a_out is not None and probe["has_audio"]:
                with av.open(probe["path"]) as in_a:
                    a_in = next(s for s in in_a.streams if s.type == "audio")
                    resampler = av.AudioResampler(
                        format="fltp",
                        layout=out_audio_params["layout"],
                        rate=out_audio_params["rate"],
                    )
                    for frame in in_a.decode(a_in):
                        for out_frame in (resampler.resample(frame) or []):
                            out_frame.pts = a_pts
                            a_pts += out_frame.samples
                            for pkt in a_out.encode(out_frame):
                                out.mux(pkt)
            elif a_out is not None:
                a_pts = _emit_silence(out, a_out, probe["duration_s"], a_pts)

        for pkt in v_out.encode(None):
            out.mux(pkt)
        if a_out is not None:
            for pkt in a_out.encode(None):
                out.mux(pkt)

    try:
        size_bytes = int(os.path.getsize(output_path))
    except OSError:
        size_bytes = 0
    return {
        "size_bytes": size_bytes,
        "duration_s": (v_pts / float(fps)) if float(fps) else sum(
            p["duration_s"] for p in probes),
        "method": "reencode",
        "frames": v_pts,
    }


def _concat_movie(input_paths, output_path, use_audio):
    """Create Movie entry: stream-copy when safe, otherwise re-encode."""
    probes, _ref = _probe_movie_inputs(input_paths)
    if _stream_copy_viable(probes):
        return _stream_copy_concat(input_paths, output_path, use_audio, probes)
    return _reencode_concat(input_paths, output_path, use_audio, probes)


@routes.post("/video_oasis/create_movie")
async def vo_create_movie(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)
    entries = data.get("entries") or []
    use_audio = bool(data.get("use_audio"))
    if not isinstance(entries, list) or len(entries) < 2:
        return web.json_response(
            {"error": "Need at least two saved clips."}, status=400)

    # Resolve every entry to an absolute path under output/. Any that
    # can't be resolved (moved / deleted since the strip was populated)
    # abort the whole operation -- a partial movie would be confusing.
    out_root = folder_paths.get_output_directory()
    paths = []
    for e in entries:
        fn = (e.get("filename") or "").strip().replace("\\", "/")
        sf = (e.get("subfolder") or "").strip().replace("\\", "/").strip("/")
        if not fn:
            return web.json_response(
                {"error": "Entry missing filename."}, status=400)
        p = _resolve_under(out_root, sf, fn) if sf \
            else _resolve_under(out_root, fn)
        if not p or not os.path.isfile(p):
            shown = f"{sf}/{fn}" if sf else fn
            return web.json_response(
                {"error": f"Missing on disk: {shown}"}, status=404)
        paths.append(p)

    try:
        import av  # noqa: F401
    except ImportError:
        return web.json_response(
            {"error": "PyAV not installed."}, status=500)

    output_path, rel_path = _next_movie_path()
    try:
        info = _concat_movie(paths, output_path, use_audio)
    except ValueError as e:
        # Clean up any partial output before returning the error.
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass
        return web.json_response(
            {"error": f"Concat failed: {e}"}, status=500)

    # filename/subfolder are split out (not just the joined rel_path) so the
    # frontend can hand the finished movie straight to loadExternalVideo and
    # have it land in the scene bar, exactly the way Clip already does.
    subfolder, _, filename = rel_path.rpartition("/")
    return web.json_response({
        "ok": True,
        "path": rel_path,
        "filename": filename,
        "subfolder": subfolder,
        "size_bytes": info["size_bytes"],
        "duration_s": info["duration_s"],
    })


_CLIP_PREFIX = "clip_"


def _next_clip_path():
    """Pick output/video/clip_NNNNN.mp4 -- smallest unused N ≥ 1."""
    out_root = folder_paths.get_output_directory()
    video_dir = os.path.join(out_root, "video")
    os.makedirs(video_dir, exist_ok=True)
    used = set()
    for name in os.listdir(video_dir):
        if not name.startswith(_CLIP_PREFIX) or not name.lower().endswith(".mp4"):
            continue
        stem = name[len(_CLIP_PREFIX):-4]
        if stem.isdigit():
            used.add(int(stem))
    n = 1
    while n in used:
        n += 1
    filename = f"{_CLIP_PREFIX}{n:05d}.mp4"
    return os.path.join(video_dir, filename), f"video/{filename}", filename


def _resolve_view_path(filename, subfolder, type_):
    """Resolve a /view-style entry under temp/ or output/."""
    fn = (filename or "").strip().replace("\\", "/")
    sf = (subfolder or "").strip().replace("\\", "/").strip("/")
    if not fn:
        return None
    kind = (type_ or "temp").strip().lower()
    if kind == "output":
        root = folder_paths.get_output_directory()
    else:
        root = folder_paths.get_temp_directory()
    return _resolve_under(root, sf, fn) if sf else _resolve_under(root, fn)


def _frame_time_s(frame, stream):
    if getattr(frame, "time", None) is not None:
        return float(frame.time)
    if frame.pts is None or stream.time_base is None:
        return None
    return float(frame.pts * stream.time_base)


def _trim_video(input_path, output_path, start_s, end_s):
    """Re-encode [start_s, end_s) of input into output_path (H.264 + AAC).

    Stream-copy is unreliable for arbitrary cut points (keyframe alignment),
    so we decode/re-encode. Returns {duration_s, frames, size_bytes, fps}.

    Decoded frames keep the *source* time_base. Assigning pts = 0,1,2 on
    those frames makes PyAV rescale as if the values were still in the source
    time_base, collapsing every frame onto one instant (1-frame playback;
    probe reports absurd fps like frames/duration ~ 2525). Fix: reformat to
    yuv420p and stamp pts in the encoder time_base (1 tick per frame).
    """
    import av
    from fractions import Fraction

    if end_s <= start_s:
        raise ValueError("Clip out must be after clip in.")
    start_s = max(0.0, float(start_s))
    end_s = float(end_s)

    with av.open(input_path) as inn:
        v_in = next((s for s in inn.streams if s.type == "video"), None)
        a_in = next((s for s in inn.streams if s.type == "audio"), None)
        if v_in is None:
            raise ValueError("No video stream.")

        if v_in.average_rate and float(v_in.average_rate) > 0:
            fps = Fraction(v_in.average_rate).limit_denominator(1001)
        elif v_in.base_rate and float(v_in.base_rate) > 0:
            fps = Fraction(v_in.base_rate).limit_denominator(1001)
        else:
            fps = Fraction(25, 1)
        src_fps = float(fps)
        width = int(v_in.codec_context.width or 0)
        height = int(v_in.codec_context.height or 0)
        # 1 tick per frame at the source rate.
        v_tb = Fraction(1, int(round(src_fps)) or 25)

        with av.open(output_path, mode="w") as out:
            v_out = out.add_stream("libx264", rate=fps)
            v_out.width = width
            v_out.height = height
            v_out.pix_fmt = "yuv420p"
            v_out.time_base = v_tb
            try:
                v_out.codec_context.time_base = v_tb
            except Exception:
                pass
            try:
                v_out.options = {"crf": "18", "preset": "veryfast"}
            except Exception:
                pass

            a_out = None
            resampler = None
            if a_in is not None:
                audio_rate = int(a_in.codec_context.sample_rate or 48000)
                layout = (
                    a_in.codec_context.layout.name
                    if a_in.codec_context.layout else "stereo"
                )
                a_out = out.add_stream("aac", rate=audio_rate)
                a_out.layout = layout
                resampler = av.AudioResampler(
                    format="fltp", layout=layout, rate=audio_rate)

            try:
                inn.seek(int(start_s * av.time_base), backward=True)
            except Exception:
                pass

            frames = 0
            a_pts = 0
            streams = [v_in] + ([a_in] if a_in is not None else [])
            video_done = False
            audio_done = a_in is None

            for packet in inn.demux(*streams):
                if packet.dts is None and packet.pts is None:
                    continue
                try:
                    decoded = packet.decode()
                except Exception:
                    continue
                for frame in decoded:
                    if packet.stream.type == "video":
                        if video_done:
                            continue
                        t = _frame_time_s(frame, v_in)
                        if t is None or t < start_s:
                            continue
                        if t >= end_s:
                            video_done = True
                            continue
                        out_frame = frame.reformat(
                            width=width, height=height, format="yuv420p")
                        out_frame.pts = frames
                        out_frame.time_base = v_tb
                        frames += 1
                        for pkt in v_out.encode(out_frame):
                            out.mux(pkt)
                    elif a_out is not None and packet.stream.type == "audio":
                        if audio_done:
                            continue
                        t = _frame_time_s(frame, a_in)
                        if t is None or t < start_s:
                            continue
                        if t >= end_s:
                            audio_done = True
                            continue
                        for out_frame in (resampler.resample(frame) or []):
                            out_frame.pts = a_pts
                            a_pts += out_frame.samples
                            for pkt in a_out.encode(out_frame):
                                out.mux(pkt)
                if video_done and audio_done:
                    break

            for pkt in v_out.encode(None):
                out.mux(pkt)
            if a_out is not None:
                for pkt in a_out.encode(None):
                    out.mux(pkt)

    try:
        size_bytes = int(os.path.getsize(output_path))
    except OSError:
        size_bytes = 0
    if frames <= 0:
        raise ValueError("No frames in the selected range.")
    return {
        "duration_s": frames / src_fps if src_fps else 0.0,
        "frames": frames,
        "size_bytes": size_bytes,
        "fps": src_fps,
    }


@routes.post("/video_oasis/clip_video")
async def vo_clip_video(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Bad request body."}, status=400)

    filename = (data.get("filename") or "").strip()
    subfolder = (data.get("subfolder") or "").strip()
    type_ = (data.get("type") or "temp").strip()
    try:
        start_s = float(data.get("start_s"))
        end_s = float(data.get("end_s"))
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "start_s and end_s are required numbers."}, status=400)
    if end_s <= start_s:
        return web.json_response(
            {"error": "Clip out must be after clip in."}, status=400)

    path = _resolve_view_path(filename, subfolder, type_)
    if not path or not os.path.isfile(path):
        shown = f"{subfolder}/{filename}" if subfolder else filename
        return web.json_response(
            {"error": f"Missing on disk: {shown}"}, status=404)

    try:
        import av  # noqa: F401
    except ImportError:
        return web.json_response(
            {"error": "PyAV not installed."}, status=500)

    output_path, rel_path, out_name = _next_clip_path()
    try:
        info = _trim_video(path, output_path, start_s, end_s)
    except ValueError as e:
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass
        return web.json_response({"error": str(e)}, status=400)
    except Exception as e:
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
        except OSError:
            pass
        return web.json_response(
            {"error": f"Clip failed: {e}"}, status=500)

    return web.json_response({
        "ok": True,
        "path": rel_path,
        "filename": out_name,
        "subfolder": "video",
        "frames": info["frames"],
        "duration_s": info["duration_s"],
        "size_bytes": info["size_bytes"],
        "fps": info["fps"],
    })


# == Frame extraction: serve a single frame as PNG ===========================
#
# Backs the player's frame drag. The drag payload carries a same-origin
# text/uri-list pointing here; ComfyUI's stock drop pipeline (LoadImage and
# every upload-widget node) fetches same-origin uri-list entries and
# re-uploads the blob as a dropped image. Chromium clears File items from
# the drag data store once any string type is added, so the client-side
# canvas capture alone never reliably reaches stock nodes -- the server has
# to be able to reproduce the frame on demand.
#
# Note `filename` in the query is NOT the video: ComfyUI's drop handler
# names the uploaded file after that param (frame_N.png). The source video
# is `video` + `subfolder` + `type`.


@routes.get("/video_oasis/frame")
async def vo_frame(request):
    q = request.rel_url.query
    video = (q.get("video") or "").strip()
    subfolder = (q.get("subfolder") or "").strip()
    type_ = (q.get("type") or "temp").strip()
    try:
        frame_n = max(0, int(q.get("frame", "0")))
    except (TypeError, ValueError):
        return web.json_response(
            {"error": "frame must be an integer."}, status=400)

    path = _resolve_view_path(video, subfolder, type_)
    if not path or not os.path.isfile(path):
        shown = f"{subfolder}/{video}" if subfolder else video
        return web.json_response(
            {"error": f"Missing on disk: {shown}"}, status=404)

    try:
        import av
    except ImportError:
        return web.json_response(
            {"error": "PyAV not installed."}, status=500)

    import io

    try:
        with av.open(path) as container:
            vs = next(
                (s for s in container.streams if s.type == "video"), None)
            if vs is None:
                return web.json_response(
                    {"error": "No video stream in file."}, status=400)
            fps = float(vs.average_rate) if vs.average_rate \
                  else (float(vs.base_rate) if vs.base_rate else 24.0)
            target_s = frame_n / fps
            # Seek to the keyframe at/before the target, then decode forward
            # to the exact frame. Offset is in AV_TIME_BASE units (us) when
            # no stream is passed. Broad except: PyAV's error class moved
            # across versions (AVError -> FFmpegError); a failed seek just
            # means we decode from the start.
            try:
                container.seek(int(target_s * 1_000_000),
                               backward=True, any_frame=False)
            except Exception:
                pass
            best = None
            half_frame = 0.5 / fps
            for fr in container.decode(vs):
                best = fr
                t = _frame_time_s(fr, vs)
                if t is not None and t >= target_s - half_frame:
                    break
            # frame_n past EOF falls through with best = last decoded frame.
            if best is None:
                return web.json_response(
                    {"error": "No decodable frames."}, status=500)
            img = best.to_image()
    except Exception as e:
        return web.json_response(
            {"error": f"Frame extraction failed: {e}"}, status=500)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return web.Response(
        body=buf.getvalue(),
        content_type="image/png",
        headers={"Cache-Control": "no-store"},
    )
