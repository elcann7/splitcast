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


def _try_encode(args: tuple[str, ...]) -> bool:
    """A real 0.3 s encode with these encoder arguments. True only if it succeeds on this machine."""
    try:
        r = subprocess.run(
            [str(paths.ffmpeg_exe()), "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=black:s=640x360:r=30:d=0.3",
             *args, "-f", "null", "-"],
            capture_output=True, timeout=45, creationflags=NO_WINDOW)
        return r.returncode == 0
    except Exception:
        return False


@lru_cache(maxsize=32)
def encoder_works(args: tuple[str, ...]) -> bool:
    return available() and _try_encode(args)


@lru_cache(maxsize=1)
def hw_encoder() -> str | None:
    """The GPU video encoder that really works here: "nvenc" (NVIDIA), "amf" (AMD) or "qsv" (Intel), else None.

    Listed in -encoders is not enough (an NVENC build runs on a machine without an NVIDIA card), so each one is
    tried with a real encode, in that order."""
    if not available():
        return None
    for name, enc in (("nvenc", "h264_nvenc"), ("amf", "h264_amf"), ("qsv", "h264_qsv")):
        if encoder_works(("-c:v", enc, "-pix_fmt", "yuv420p")):
            return name
    return None


def nvenc_available() -> bool:
    return hw_encoder() == "nvenc"


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
