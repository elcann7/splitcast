"""Download InsightFace packs and extract just the detector/recognizer files we use."""
from __future__ import annotations

import os
import threading
import zipfile
from typing import Callable

import requests

from . import paths, registry

ProgressCb = Callable[[float, str], None]


def _download(url: str, dest, on_bytes: Callable[[int, int], None], cancel: threading.Event | None) -> None:
    with requests.get(url, stream=True, timeout=30, headers={"User-Agent": "ScenepackStudio"}) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length", 0))
        done = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1 << 20):
                if cancel is not None and cancel.is_set():
                    raise InterruptedError("cancelled")
                f.write(chunk)
                done += len(chunk)
                on_bytes(done, total)


def ensure_preset(preset_id: str, on_progress: ProgressCb | None = None,
                  cancel: threading.Event | None = None, content: str = "live") -> None:
    """Make sure every weight file of a preset is present. Safe to call repeatedly."""
    paths.ensure_dirs()
    spec = registry.spec(preset_id, content)
    wanted = [m for m in registry.preset_models(spec) if not m.installed]
    by_pack: dict[str, list[registry.ModelSpec]] = {}
    for m in wanted:
        by_pack.setdefault(m.pack or m.id, []).append(m)
    n = len(by_pack)
    for i, (pack_id, models) in enumerate(by_pack.items()):
        if models[0].url:                         # single-file model
            _fetch_file(models[0], i, n, on_progress, cancel)
            continue
        pack = registry.PACKS[pack_id]
        zpath = paths.TMP_DIR / f"{pack_id}.zip.part"

        def on_bytes(done, total, i=i, pack_id=pack_id):
            frac = (done / total) if total else 0.0
            if on_progress:
                on_progress((i + frac * 0.95) / n, f"{pack_id} {done / 1e6:.0f} / {total / 1e6:.0f} MB")

        try:
            _download(pack.url, zpath, on_bytes, cancel)
            with zipfile.ZipFile(zpath) as z:
                names = z.namelist()
                for m in models:
                    # some packs are flat, antelopev2 has a top-level folder
                    member = next(n for n in names if n == m.member or n.endswith("/" + m.member))
                    with z.open(member) as src, open(str(m.path) + ".part", "wb") as dst:
                        while chunk := src.read(1 << 20):
                            dst.write(chunk)
                    # atomic: a half-written weight file must never look installed
                    os.replace(str(m.path) + ".part", m.path)
        finally:
            zpath.unlink(missing_ok=True)
        if on_progress:
            on_progress((i + 1) / n, f"{pack_id} ok")


def _fetch_file(m: registry.ModelSpec, i: int, n: int, on_progress, cancel) -> None:
    part = str(m.path) + ".part"

    def on_bytes(done, total):
        if on_progress:
            on_progress((i + (done / total if total else 0) * 0.95) / n,
                        f"{m.id} {done / 1e6:.0f} / {total / 1e6:.0f} MB")

    try:
        _download(m.url, part, on_bytes, cancel)
        os.replace(part, m.path)
    finally:
        if os.path.exists(part):
            os.remove(part)
    if on_progress:
        on_progress((i + 1) / n, f"{m.id} ok")


if __name__ == "__main__":  # python -m scenepack.model_download balanced
    import sys

    for pid in sys.argv[1:] or ["balanced"]:
        last = [-1.0]

        def show(p, msg):
            if p - last[0] >= 0.05 or p >= 1:
                last[0] = p
                print(f"[{pid}] {p * 100:5.1f}%  {msg}", flush=True)

        ensure_preset(pid, show)
        print(f"[{pid}] models ready", flush=True)
