"""First-run components: ffmpeg and the default model pack. Used by the installer and by "Repair".

    python -m scenepack.bootstrap            # ffmpeg + balanced models
    python -m scenepack.bootstrap --check    # exit 0 when everything is in place

Idempotent: anything already present is skipped.
"""
from __future__ import annotations

import io
import sys
import zipfile

import requests

from . import paths

FFMPEG_SOURCES = (
    # BtbN (GitHub CDN) first: fast and includes NVENC; gyan.dev is the fallback.
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
)


def ffmpeg_ready() -> bool:
    return paths.ffmpeg_exe().exists() and paths.ffprobe_exe().exists()


def _say(msg: str) -> None:
    print(msg, flush=True)


def _download(url: str) -> bytes:
    buf = io.BytesIO()
    last = -1
    with requests.get(url, stream=True, timeout=30, headers={"User-Agent": "Splitcast"}) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        done = 0
        for chunk in r.iter_content(1 << 20):
            buf.write(chunk)
            done += len(chunk)
            pct = int(done * 100 / total) if total else -1
            if pct >= 0 and pct // 10 != last // 10:
                last = pct
                _say(f"  {pct}%  ({done >> 20} MB)")
    return buf.getvalue()


def install_ffmpeg() -> None:
    if ffmpeg_ready():
        return
    paths.BIN_DIR.mkdir(parents=True, exist_ok=True)
    errors = []
    for url in FFMPEG_SOURCES:
        try:
            _say(f"Downloading ffmpeg from {url.split('/')[2]} ...")
            with zipfile.ZipFile(io.BytesIO(_download(url))) as z:
                found = {}
                for name in z.namelist():
                    base = name.rsplit("/", 1)[-1].lower()
                    if base in ("ffmpeg.exe", "ffprobe.exe") and base not in found:
                        found[base] = name
                if len(found) != 2:
                    raise RuntimeError("archive does not contain ffmpeg and ffprobe")
                for base, name in found.items():
                    (paths.BIN_DIR / base).write_bytes(z.read(name))
            return
        except Exception as e:  # try the next mirror
            errors.append(f"{url}: {e}")
            _say(f"  failed: {e}")
    raise RuntimeError("Could not download ffmpeg.\n" + "\n".join(errors))


def install_models(preset: str = "balanced") -> None:
    from . import model_download
    last = [-1.0]

    def show(p: float, msg: str) -> None:
        if p - last[0] >= 0.1 or p >= 1:
            last[0] = p
            _say(f"  {p * 100:3.0f}%  {msg}")

    model_download.ensure_preset(preset, show)


def main(argv: list[str]) -> int:
    paths.ensure_dirs()
    if "--check" in argv:
        return 0 if ffmpeg_ready() else 1
    try:
        _say("[1/2] ffmpeg")
        install_ffmpeg()
        _say("[2/2] AI models (balanced)")
        install_models("balanced")
    except Exception as e:
        _say(f"\nSetup problem: {e}")
        return 1
    _say("\nAll components are in place.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
