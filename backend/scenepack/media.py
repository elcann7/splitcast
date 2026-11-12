"""Probing and frame decoding through PyAV (handles Unicode paths; never OpenCV on user files)."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import av
import numpy as np


class MediaError(RuntimeError):
    pass


def _open(path: str):
    try:
        return av.open(str(path))
    except Exception as e:
        raise MediaError("Fayl açıla bilmədi: " + (getattr(e, "strerror", None) or str(e))) from e


def probe(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        raise MediaError(f"Fayl tapılmadı: {path}")
    with _open(path) as c:
        if not c.streams.video:
            raise MediaError("Faylda video axını yoxdur")
        v = c.streams.video[0]
        ctx = v.codec_context
        rate = v.average_rate or v.guessed_rate or 25
        if c.duration:
            duration = c.duration / av.time_base
        elif v.duration and v.time_base:
            duration = float(v.duration * v.time_base)
        else:
            duration = 0.0
        audio = _norm_codec(c.streams.audio[0].codec_context.name) if c.streams.audio else None
        return {
            "path": str(p),
            "fileName": p.name,
            "sizeBytes": p.stat().st_size,
            "duration": float(duration),
            "width": int(ctx.width),
            "height": int(ctx.height),
            "fps": float(rate),
            "videoCodec": ctx.name,
            "audioCodec": audio,
            "hasAudio": audio is not None,
        }


def _norm_codec(name: str) -> str:
    """PyAV reports decoder names (mp3float, ac3_fixed); users and the exporter think in codec names."""
    for suffix in ("float", "fixed", "_fixed", "_latm"):
        if name.endswith(suffix) and name[: -len(suffix)] in ("mp3", "ac3", "aac", "eac3", "vorbis", "opus", "mp2"):
            return name[: -len(suffix)]
    return name


def _frame_time(frame, stream, fallback: float) -> float:
    if frame.pts is not None and stream.time_base:
        return float(frame.pts * stream.time_base)
    return fallback


def iter_frames(path: str, start: float = 0.0, end: float | None = None) -> Iterator[tuple[float, "av.VideoFrame"]]:
    """Yield (time_seconds, frame) in presentation order, optionally from a seek point."""
    c = _open(path)
    try:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        if start > 1.0:
            c.seek(int(start * av.time_base), backward=True, any_frame=False)
        fps = float(v.average_rate or 25)
        n = 0
        for frame in c.decode(v):
            t = _frame_time(frame, v, n / fps)
            n += 1
            if t < start - 1e-3:
                continue
            if end is not None and t >= end:
                break
            yield t, frame
    finally:
        c.close()


def to_rgb(frame, long_side: int) -> tuple[np.ndarray, float]:
    """Decode a frame to an RGB array whose long side is at most `long_side`.
    Returns (array, scale) where scale = array_width / source_width."""
    w, h = frame.width, frame.height
    s = min(1.0, long_side / max(w, h))
    if s < 1.0:
        nw, nh = max(2, int(round(w * s)) // 2 * 2), max(2, int(round(h * s)) // 2 * 2)
        arr = frame.reformat(width=nw, height=nh, format="rgb24", interpolation="AREA").to_ndarray()
        return arr, nw / w
    return frame.to_ndarray(format="rgb24"), 1.0


def read_frame_at(path: str, t: float, long_side: int = 1280) -> np.ndarray | None:
    """Single accurate frame near time t (RGB). Used for thumbnails/posters."""
    for ft, frame in iter_frames(path, start=max(0.0, t - 2.0)):
        if ft >= t - 0.02:
            return to_rgb(frame, long_side)[0]
    return None


def path_exists(path: str) -> bool:
    return bool(path) and os.path.isfile(path)
