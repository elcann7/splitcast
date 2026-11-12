"""Shot boundary detection.

Content-adaptive detector: per-frame colour-histogram distance plus pixel difference on a tiny
thumbnail, accepted as a cut when it is both large in absolute terms and large relative to the
local motion level. Flash frames (a spike that returns to the previous look) are rejected.
A TransNetV2 ONNX model can be dropped into models/transnetv2.onnx later; the registry has the slot.
"""
from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Callable

import numpy as np

from . import media, registry, runtime

MIN_SHOT_S = 0.4
_BINS = 16


@dataclass
class Shot:
    index: int
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def _features(small: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """small: HxWx3 uint8. Returns (normalised per-channel histograms, grey thumbnail)."""
    h = np.concatenate([np.bincount((small[..., c] >> 4).ravel(), minlength=_BINS) for c in range(3)]).astype(np.float32)
    h /= small.shape[0] * small.shape[1]
    grey = small.astype(np.float32).mean(axis=2)
    return h, grey


class _TransNet:
    """Streaming TransNetV2: 100-frame windows of 48x27 RGB, step 50, the middle 50 predictions are kept."""

    def __init__(self, path):
        self.sess = runtime.create_session(path)
        self.buf: list[np.ndarray] = []
        self.started = False

    def _run(self) -> np.ndarray:
        x = np.stack(self.buf[:100])[None].astype(np.float32)       # 0..255; the graph normalises itself
        return self.sess.run(None, {"input": x})[0][0, :, 0]

    def feed(self, small48: np.ndarray) -> list[float]:
        if not self.started:
            self.started = True
            self.buf = [small48] * 25
        self.buf.append(small48)
        if len(self.buf) < 100:
            return []
        out = self._run()[25:75]
        self.buf = self.buf[50:]
        return out.tolist()

    def flush(self) -> list[float]:
        if not self.started or len(self.buf) <= 25:
            return []
        n_real = len(self.buf) - 25
        self.buf = self.buf + [self.buf[-1]] * (100 - len(self.buf))
        return self._run()[25:25 + n_real].tolist()


def detect(path: str, duration: float, cancel: threading.Event,
           on_progress: Callable[[float, int], None], use_transnet: bool = False) -> list[Shot]:
    """TransNetV2 when requested and its weights are installed, otherwise the content-adaptive detector."""
    if use_transnet and registry.shot_model_available():
        return _detect_transnet(path, duration, cancel, on_progress)
    return _detect_content(path, duration, cancel, on_progress)


def _detect_transnet(path, duration, cancel, on_progress) -> list[Shot]:
    tn = _TransNet(registry.MODELS["transnetv2"].path)
    times: list[float] = []
    probs: list[float] = []
    last_report = 0.0
    for t, frame in media.iter_frames(path):
        if cancel.is_set():
            return []
        small = frame.reformat(width=48, height=27, format="rgb24", interpolation="AREA").to_ndarray()
        times.append(t)
        probs.extend(tn.feed(small))
        if t - last_report > 2.0:
            last_report = t
            on_progress(min(1.0, t / max(duration, 1e-6)), len(times))
    probs.extend(tn.flush())
    if not times:
        return [Shot(0, 0.0, duration)]
    # a spike at frame i marks the last frame of a shot; the next shot starts at i + 1
    cuts = [i + 1 for i, p in enumerate(probs[:len(times)]) if p > 0.5 and i + 1 < len(times)]
    return _build_shots(times, cuts, duration)


def _detect_content(path, duration, cancel, on_progress) -> list[Shot]:
    times: list[float] = []
    hists: list[np.ndarray] = []
    hd: list[float] = []   # histogram distance to previous frame, 0..1
    pd: list[float] = []   # mean absolute grey difference to previous frame, 0..1
    prev_h = prev_g = None
    last_report = 0.0
    for t, frame in media.iter_frames(path):
        if cancel.is_set():
            return []
        small = frame.reformat(width=96, height=54, format="rgb24", interpolation="AREA").to_ndarray()
        h, g = _features(small)
        if prev_h is None:
            hd.append(0.0)
            pd.append(0.0)
        else:
            hd.append(float(np.abs(h - prev_h).sum() / 6.0))      # each channel sums to 1 -> L1 in [0, 6]
            pd.append(float(np.abs(g - prev_g).mean() / 255.0))
        times.append(t)
        hists.append(h)
        prev_h, prev_g = h, g
        if t - last_report > 2.0:
            last_report = t
            on_progress(min(1.0, t / max(duration, 1e-6)), len(times))
    n = len(times)
    if n == 0:
        return [Shot(0, 0.0, duration)]
    hd_a, pd_a = np.asarray(hd), np.asarray(pd)
    # combined score: histograms catch big colour changes, pixel diff catches cuts between similar palettes
    score = 0.6 * hd_a + 0.4 * np.minimum(1.0, pd_a * 2.0)
    cuts = _pick_cuts(score, hd_a, pd_a, hists, np.asarray(times))
    return _build_shots(times, cuts, duration)


def _pick_cuts(score, hd, pd, hists, times) -> list[int]:
    n = len(score)
    cuts: list[int] = []
    k = 12
    for i in range(1, n):
        if score[i] < 0.16 or hd[i] < 0.12:
            continue
        lo, hi = max(0, i - k), min(n, i + k + 1)
        window = np.concatenate([score[lo:i], score[i + 1:hi]])
        local = float(np.median(window)) if window.size else 0.0
        local_peak = float(np.percentile(window, 90)) if window.size else 0.0
        if score[i] < max(3.0 * local, 1.35 * local_peak, 0.16):
            continue
        # must be the maximum in its immediate neighbourhood (avoid double cuts on a 2-frame transition)
        if score[i] < score[max(0, i - 2):i + 3].max():
            continue
        # flash rejection: the picture a few frames later looks like the one before the spike
        flash = False
        for j in range(i + 1, min(n, i + 4)):
            back = float(np.abs(hists[j] - hists[i - 1]).sum() / 6.0)
            if back < 0.35 * hd[i] and score[j] >= 0.5 * score[i]:
                flash = True
                break
        if not flash:
            cuts.append(i)
    return cuts


def _build_shots(times: list[float], cuts: list[int], duration: float) -> list[Shot]:
    bounds = [0.0] + [times[i] for i in cuts] + [max(duration, times[-1])]
    # merge sub-0.4s shots into a neighbour (the previous one, or the next for a leading sliver)
    merged = [bounds[0]]
    for b in bounds[1:-1]:
        if b - merged[-1] < MIN_SHOT_S and len(merged) > 1:
            continue
        merged.append(b)
    if len(merged) > 1 and bounds[-1] - merged[-1] < MIN_SHOT_S:
        merged.pop()
    if len(merged) > 1 and merged[1] - merged[0] < MIN_SHOT_S:
        merged.pop(1)
    merged.append(bounds[-1])
    return [Shot(i, merged[i], merged[i + 1]) for i in range(len(merged) - 1)]
