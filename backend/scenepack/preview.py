"""Lazily built, cached H.264/AAC proxy clips for the in-app player (plays in Edge WebView2)."""
from __future__ import annotations

import os
import threading
from pathlib import Path

from . import ffmpeg, media
from .projects import PREVIEW_HANDLE_S, STORE, ProjectError

_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()
_slots = threading.Semaphore(2)   # a hover-scrub over a grid must not spawn dozens of encodes


def preview_path(pid: str, aid: str) -> Path:
    p, source, _c, a = STORE.find_appearance(pid, aid)
    src = source["media"]["path"]
    if not media.path_exists(src):
        raise ProjectError("source_missing", "Mənbə video faylı tapılmadı. Fayl köçürülüb və ya silinib.", 409)
    out = STORE.previews_dir(pid) / f"{aid}.mp4"
    with _locks_guard:
        lock = _locks.setdefault(f"{pid}/{aid}", threading.Lock())
    with lock:
        if out.exists() and out.stat().st_size > 1000:
            return out
        start = max(0.0, a["start"] - PREVIEW_HANDLE_S)
        end = min(source["media"]["duration"], a["end"] + PREVIEW_HANDLE_S)
        tmp = out.with_suffix(".part.mp4")
        args = [
            "-ss", f"{start:.3f}", "-i", src, "-t", f"{end - start:.3f}",
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=-2:'min(720,trunc(ih/2)*2)',format=yuv420p",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-g", "24", "-sc_threshold", "0",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-movflags", "+faststart", "-f", "mp4", str(tmp),
        ]
        with _slots:
            try:
                ffmpeg.run(args)
            except Exception as e:
                tmp.unlink(missing_ok=True)
                raise ProjectError("preview_failed", f"Önbaxış yaradıla bilmədi: {e}", 500)
        os.replace(tmp, out)
        return out
