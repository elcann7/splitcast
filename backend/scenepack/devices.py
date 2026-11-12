"""Chooses the ONNX Runtime build for this machine, before onnxruntime is imported.

The installer carries two builds of ONNX Runtime that cannot be loaded together:
  * onnxruntime-gpu (CUDA) in the normal site-packages, for NVIDIA cards;
  * onnxruntime-directml in <install>\\runtime\\Lib\\dml-packages, for AMD, Intel and every other DirectX 12 GPU.
Putting the DirectML folder first on sys.path makes `import onnxruntime` find that build instead. This module only
decides and sets sys.path / environment variables; it never imports onnxruntime itself (a probe runs in a child process).

Decision, in order:
  1. Settings "device": "cpu"  -> CPU only (SCENEPACK_FORCE_CPU=1), no GPU build is chosen.
  2. SCENEPACK_DEVICE=cuda|dml|cpu in the environment overrides everything (support and tests).
  3. No DirectML folder (development install, or an old install) -> keep the default build.
  4. No NVIDIA driver -> DirectML.
  5. NVIDIA driver -> CUDA if a real CUDA session works (probed once per driver version and remembered),
     otherwise DirectML. An old driver cannot run the CUDA 13 build; DirectML still can.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

from . import paths

_NO_WINDOW = 0x08000000


def dml_dir(app_root: Path) -> Path:
    env = os.environ.get("SCENEPACK_DML_PATH")
    return Path(env) if env else app_root.parent / "runtime" / "Lib" / "dml-packages"


def _nvidia_driver() -> str | None:
    """Driver version when an NVIDIA driver is installed, else None."""
    if not (Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "nvcuda.dll").exists():
        return None
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=15, creationflags=_NO_WINDOW).stdout.strip()
        return out.splitlines()[0].strip() if out else "unknown"
    except Exception:
        return "unknown"


def _device_pref() -> str:
    try:
        return json.loads(paths.SETTINGS_FILE.read_text(encoding="utf-8-sig")).get("device", "auto")
    except Exception:
        return "auto"


def _cuda_works(driver: str) -> bool:
    cache = paths.DATA_DIR / "device.json"
    try:
        saved = json.loads(cache.read_text(encoding="utf-8"))
        if saved.get("driver") == driver and saved.get("runtime") == sys.version:
            return bool(saved.get("cuda"))
    except Exception:
        pass
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join([str(Path(__file__).resolve().parents[1]), env.get("PYTHONPATH", "")])
    try:
        ok = subprocess.run([sys.executable, "-m", "scenepack.runtime", "--probe-cuda"], env=env, timeout=90,
                            capture_output=True, creationflags=_NO_WINDOW).returncode == 0
    except Exception:
        ok = False
    try:
        paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"driver": driver, "runtime": sys.version, "cuda": ok}), encoding="utf-8")
    except OSError:
        pass
    return ok


def select(app_root: Path) -> str:
    """Returns "cuda", "dml", "cpu" or "default" (nothing to choose between). Call before importing onnxruntime."""
    forced = os.environ.get("SCENEPACK_DEVICE", "").lower()
    pref = forced or ("cpu" if _device_pref() == "cpu" else "auto")
    dml = dml_dir(app_root)
    has_dml = dml.is_dir()

    if pref == "cpu":
        os.environ["SCENEPACK_FORCE_CPU"] = "1"
        return "cpu"
    if pref == "dml" and has_dml:
        choice = "dml"
    elif pref == "cuda" or not has_dml:
        choice = "cuda" if has_dml else "default"
    else:
        driver = _nvidia_driver()
        choice = "cuda" if driver and _cuda_works(driver) else "dml"

    if choice == "dml":
        sys.path.insert(0, str(dml))  # first: `import onnxruntime` now finds the DirectML build
    return choice
