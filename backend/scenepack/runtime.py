"""ONNX Runtime setup: CUDA when it genuinely works, CPU otherwise, and the truth is reported."""
from __future__ import annotations

import base64
import subprocess
import threading
from pathlib import Path

import numpy as np
import onnxruntime as ort

# 1x8 Relu graph, used to prove a CUDA session can really be created and run.
_PROBE_MODEL = base64.b64decode(
    "CAg6OwoMCgF4EgF5IgRSZWx1EgFnWhMKAXgSDgoMCAESCAoCCAEKAggIYhMKAXkSDgoMCAESCAoCCAEKAggIQgQKABAN"
)

_lock = threading.Lock()
_state: dict = {"initialised": False, "provider": "cpu", "note": None, "gpuName": None, "vramMb": None}


def _gpu_info() -> tuple[str | None, int | None]:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, creationflags=0x08000000,
        ).stdout.strip().splitlines()[0]
        name, mem = [s.strip() for s in out.split(",")]
        return name, int(float(mem))
    except Exception:
        return None, None


def init() -> dict:
    """Idempotent. Loads the NVIDIA runtime DLLs and probes the CUDA execution provider."""
    with _lock:
        if _state["initialised"]:
            return dict(_state)
        ort.set_default_logger_severity(3)
        _state["gpuName"], _state["vramMb"] = _gpu_info()
        note = None
        try:
            ort.preload_dlls()
        except Exception as e:  # missing wheels or old ORT; the probe below decides
            note = f"preload_dlls failed: {e}"
        provider = "cpu"
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            note = note or "onnxruntime build has no CUDA provider (CPU wheel installed)"
        else:
            try:
                so = ort.SessionOptions()
                so.log_severity_level = 3
                s = ort.InferenceSession(_PROBE_MODEL, so, providers=["CUDAExecutionProvider"])
                if s.get_providers()[0] == "CUDAExecutionProvider":
                    s.run(None, {"x": np.zeros((1, 8), np.float32)})
                    provider = "cuda"
                else:
                    note = "CUDA provider did not initialise; using CPU"
            except Exception as e:
                note = f"CUDA unavailable, using CPU: {str(e).splitlines()[0][:200]}"
        _state.update(initialised=True, provider=provider, note=note)
        return dict(_state)


def device_info() -> dict:
    s = init()
    return {"provider": s["provider"], "gpuName": s["gpuName"], "vramMb": s["vramMb"], "note": s["note"]}


def create_session(path: Path) -> ort.InferenceSession:
    """Session on CUDA if the probe succeeded, else CPU. Falls back (and records why) on failure."""
    st = init()
    so = ort.SessionOptions()
    so.log_severity_level = 3
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if st["provider"] == "cuda":
        try:
            opts = {"device_id": 0, "cudnn_conv_algo_search": "HEURISTIC", "arena_extend_strategy": "kSameAsRequested"}
            sess = ort.InferenceSession(str(path), so, providers=[("CUDAExecutionProvider", opts), "CPUExecutionProvider"])
            if sess.get_providers()[0] == "CUDAExecutionProvider":
                return sess
        except Exception as e:
            with _lock:
                _state.update(provider="cpu", note=f"CUDA session failed for {path.name}, using CPU: {str(e).splitlines()[0][:200]}")
    so.intra_op_num_threads = 6
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def session_provider(sess: ort.InferenceSession) -> str:
    return "cuda" if sess.get_providers()[0] == "CUDAExecutionProvider" else "cpu"


if __name__ == "__main__":  # python -m scenepack.runtime
    print(device_info())
