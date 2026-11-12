"""ffmpeg helpers: capability detection and a cancellable runner with progress parsing."""
from __future__ import annotations

import re
import subprocess
import threading
from functools import lru_cache
from typing import Callable

from . import paths

NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW


class FfmpegError(RuntimeError):
    pass


def available() -> bool:
    return paths.ffmpeg_exe().exists() and paths.ffprobe_exe().exists()


@lru_cache(maxsize=1)
def version() -> str | None:
    if not available():
        return None
    try:
        out = subprocess.run([str(paths.ffmpeg_exe()), "-version"], capture_output=True, text=True,
                             timeout=15, creationflags=NO_WINDOW).stdout
        m = re.search(r"ffmpeg version (\S+)", out)
        return m.group(1) if m else None
    except Exception:
        return None


@lru_cache(maxsize=1)
def nvenc_available() -> bool:
    """True only if an NVENC encode really succeeds on this machine (not just listed in -encoders)."""
    if not available():
        return False
    try:
        r = subprocess.run(
            [str(paths.ffmpeg_exe()), "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=black:s=320x240:d=0.2",
             "-c:v", "h264_nvenc", "-f", "null", "-"],
            capture_output=True, timeout=30, creationflags=NO_WINDOW)
        return r.returncode == 0
    except Exception:
        return False


def _hms_to_s(s: str) -> float:
    h, m, sec = s.split(":")
    return int(h) * 3600 + int(m) * 60 + float(sec)


def run(args: list[str], *, duration: float | None = None, cancel: threading.Event | None = None,
        on_progress: Callable[[float], None] | None = None) -> None:
    """Run ffmpeg. `duration` (output seconds) enables fractional progress via -progress.
    Raises FfmpegError with the tail of stderr on failure; kills the process when `cancel` is set."""
    cmd = [str(paths.ffmpeg_exe()), "-hide_banner", "-nostdin", "-y", "-loglevel", "error",
           "-progress", "pipe:1", "-nostats", *args]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace", creationflags=NO_WINDOW)
    err_chunks: list[str] = []
    t = threading.Thread(target=lambda: err_chunks.append(proc.stderr.read()), daemon=True)
    t.start()
    try:
        for line in proc.stdout:
            if cancel is not None and cancel.is_set():
                proc.kill()
                break
            if on_progress and duration and line.startswith("out_time="):
                v = line.split("=", 1)[1].strip()
                if re.match(r"^\d+:\d\d:\d\d", v):
                    on_progress(min(1.0, _hms_to_s(v) / duration))
        proc.wait()
    finally:
        if proc.poll() is None:
            proc.kill()
        t.join(timeout=5)
    if cancel is not None and cancel.is_set():
        return
    if proc.returncode != 0:
        tail = "".join(err_chunks).strip().splitlines()[-6:]
        raise FfmpegError("ffmpeg failed: " + " | ".join(tail))
