"""ONNX Runtime setup: CUDA (NVIDIA) or DirectML (AMD, Intel, any DirectX 12 GPU) when it genuinely works, CPU otherwise.

Which GPU provider exists depends on the wheel that is installed: onnxruntime-gpu gives CUDA, onnxruntime-directml
gives DirectML. Each provider is probed with a real session before it is trusted, and the truth is reported.
SCENEPACK_FORCE_CPU=1 skips the GPU providers (a support escape hatch).
"""
from __future__ import annotations

import base64
import os
import subprocess
import threading
from pathlib import Path

import numpy as np
import onnxruntime as ort

# 1x8 Relu graph, used to prove a GPU session can really be created and run.
_PROBE_MODEL = base64.b64decode(
    "CAg6OwoMCgF4EgF5IgRSZWx1EgFnWhMKAXgSDgoMCAESCAoCCAEKAggIYhMKAXkSDgoMCAESCAoCCAEKAggIQgQKABAN"
)

_lock = threading.Lock()
_state: dict = {"initialised": False, "provider": "cpu", "note": None, "gpuName": None, "vramMb": None}

_DML_OPTIONS = {"device_id": 0, "performance_preference": "high_performance"}  # high_performance: the discrete GPU on laptops
_NO_WINDOW = 0x08000000


def _nvidia_info() -> tuple[str | None, int | None]:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, creationflags=_NO_WINDOW,
        ).stdout.strip().splitlines()[0]
        name, mem = [s.strip() for s in out.split(",")]
        return name, int(float(mem))
    except Exception:
        return None, None


def _adapter_name() -> str | None:
    """Name of the graphics adapter, for display only (video memory is not reported for non-NVIDIA cards)."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command",
             "(Get-CimInstance Win32_VideoController).Name -join \"`n\""],
            capture_output=True, text=True, timeout=20, creationflags=_NO_WINDOW,
        ).stdout.splitlines()
        names = [n.strip() for n in out if n.strip() and not any(x in n for x in ("Microsoft", "Remote", "Basic"))]
        if not names:
            return None
        for n in names:  # prefer a discrete card over an integrated one
            if any(k in n for k in ("NVIDIA", "Radeon RX", "Radeon Pro", "Arc")):
                return n
        return names[0]
    except Exception:
        return None


def _probe(provider: str, options: dict | None = None) -> bool:
    """Create and run a tiny session on the provider; True only if it really runs there."""
    try:
        so = ort.SessionOptions()
        so.log_severity_level = 3
        if provider == "DmlExecutionProvider":
            so.enable_mem_pattern = False
            so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        s = ort.InferenceSession(_PROBE_MODEL, so, providers=[(provider, options or {})])
        if s.get_providers()[0] != provider:
            return False
        s.run(None, {"x": np.zeros((1, 8), np.float32)})
        return True
    except Exception:
        if provider == "DmlExecutionProvider" and options:
            return _probe(provider, None)  # an older runtime may not know performance_preference
        return False


def init() -> dict:
    """Idempotent. Picks the execution provider for this machine."""
    with _lock:
        if _state["initialised"]:
            return dict(_state)
        ort.set_default_logger_severity(3)
        name, vram = _nvidia_info()
        note = None
        try:
            ort.preload_dlls()  # NVIDIA runtime DLL wheels (no-op for other builds)
        except Exception as e:
            note = f"preload_dlls failed: {e}"
        available = ort.get_available_providers()
        provider = "cpu"
        if os.environ.get("SCENEPACK_FORCE_CPU") == "1":
            note = "SCENEPACK_FORCE_CPU=1: GPU providers are off"
        elif "CUDAExecutionProvider" in available and _probe("CUDAExecutionProvider"):
            provider = "cuda"
        elif "DmlExecutionProvider" in available and _probe("DmlExecutionProvider", _DML_OPTIONS):
            provider = "dml"
        elif "CUDAExecutionProvider" in available:
            note = "CUDA did not initialise; using CPU"
        elif "DmlExecutionProvider" in available:
            note = "DirectML did not initialise (needs a DirectX 12 GPU); using CPU"
        else:
            note = note or "no GPU provider in this onnxruntime build; using CPU"
        if provider == "dml":
            name = _adapter_name() or name
        _state.update(initialised=True, provider=provider, note=note, gpuName=name, vramMb=vram)
        return dict(_state)


def device_info() -> dict:
    s = init()
    return {"provider": s["provider"], "gpuName": s["gpuName"], "vramMb": s["vramMb"], "note": s["note"]}


def _options(dml: bool) -> ort.SessionOptions:
    so = ort.SessionOptions()
    so.log_severity_level = 3
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    if dml:  # required by the DirectML provider
        so.enable_mem_pattern = False
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    return so


def _cpu_session(path: Path) -> ort.InferenceSession:
    so = _options(False)
    so.intra_op_num_threads = 6
    return ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])


def _static_dml_session(path: Path, shape: tuple[int, ...]) -> ort.InferenceSession:
    """A DirectML session for exactly this input shape.

    The DirectML provider rejects several operators (Reshape, MaxPool, Conv...) when the input height and width are
    symbolic, which is how SCRFD and YOLO are exported. Fixing the shape makes the same model run (verified with
    SCRFD 500M/10G at 640 and 960). Needs the `onnx` package, which the DirectML build ships."""
    import onnx

    m = onnx.load(str(path))
    dims = m.graph.input[0].type.tensor_type.shape.dim
    for d, v in zip(dims, shape):
        d.ClearField("dim_param")
        d.dim_value = int(v)
    for o in m.graph.output:  # outputs are recomputed by shape inference
        del o.type.tensor_type.shape.dim[:]
    del m.graph.value_info[:]
    m = onnx.shape_inference.infer_shapes(m)
    try:
        return ort.InferenceSession(m.SerializeToString(), _options(True), providers=[("DmlExecutionProvider", _DML_OPTIONS), "CPUExecutionProvider"])
    except Exception:
        return ort.InferenceSession(m.SerializeToString(), _options(True), providers=[("DmlExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"])


class _DmlSession:
    """A DirectML session that is safe to use whatever the model.

    * Models with a symbolic input size get one static-shape session per distinct input shape (see above).
    * If a run still fails on the GPU, that model continues on the CPU (and the reason is recorded): a failure
      should cost speed, not the analysis.
    All models used here have a single input."""

    _MAX_SHAPES = 6

    def __init__(self, path: Path, base: ort.InferenceSession):
        self._path = path
        self._base = base
        self._cpu: ort.InferenceSession | None = None
        self._static: dict[tuple[int, ...], ort.InferenceSession] = {}
        self._dynamic = any(not isinstance(d, int) for d in base.get_inputs()[0].shape)

    def _session_for(self, feed: dict) -> ort.InferenceSession:
        if self._cpu is not None:
            return self._cpu
        if not self._dynamic:
            return self._base
        shape = tuple(int(v) for v in feed[self._base.get_inputs()[0].name].shape)
        sess = self._static.get(shape)
        if sess is None:
            sess = _static_dml_session(self._path, shape)
            if len(self._static) >= self._MAX_SHAPES:
                self._static.pop(next(iter(self._static)))
            self._static[shape] = sess
        return sess

    def run(self, output_names, feed, *args, **kwargs):
        try:
            return self._session_for(feed).run(output_names, feed, *args, **kwargs)
        except Exception as e:
            if self._cpu is not None:
                raise
            with _lock:
                _state["note"] = f"DirectML failed on {self._path.name}, using CPU for it: {str(e).splitlines()[0][:200]}"
            self._cpu = _cpu_session(self._path)
            return self._cpu.run(output_names, feed, *args, **kwargs)

    def get_providers(self):
        return self._cpu.get_providers() if self._cpu is not None else self._base.get_providers()

    def __getattr__(self, name):  # get_inputs, get_outputs, ...
        return getattr(self._base, name)


def create_session(path: Path):
    """Session on the machine's GPU provider if the probe succeeded, else CPU. Falls back (and records why) on failure."""
    st = init()
    if st["provider"] == "cuda":
        try:
            opts = {"device_id": 0, "cudnn_conv_algo_search": "HEURISTIC", "arena_extend_strategy": "kSameAsRequested"}
            sess = ort.InferenceSession(str(path), _options(False), providers=[("CUDAExecutionProvider", opts), "CPUExecutionProvider"])
            if sess.get_providers()[0] == "CUDAExecutionProvider":
                return sess
        except Exception as e:
            with _lock:
                _state.update(provider="cpu", note=f"CUDA session failed for {path.name}, using CPU: {str(e).splitlines()[0][:200]}")
    elif st["provider"] == "dml":
        try:
            sess = ort.InferenceSession(str(path), _options(True), providers=[("DmlExecutionProvider", _DML_OPTIONS), "CPUExecutionProvider"])
        except Exception:
            try:  # runtime without performance_preference
                sess = ort.InferenceSession(str(path), _options(True), providers=[("DmlExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"])
            except Exception as e:
                with _lock:
                    _state["note"] = f"DirectML session failed for {path.name}, using CPU for it: {str(e).splitlines()[0][:200]}"
                return _cpu_session(path)
        if sess.get_providers()[0] == "DmlExecutionProvider":
            return _DmlSession(path, sess)
    return _cpu_session(path)


def session_provider(sess) -> str:
    p = sess.get_providers()[0]
    return "cuda" if p == "CUDAExecutionProvider" else "dml" if p == "DmlExecutionProvider" else "cpu"


if __name__ == "__main__":  # python -m scenepack.runtime
    print(device_info())
