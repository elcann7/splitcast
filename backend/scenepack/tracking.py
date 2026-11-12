"""Within-shot tracking: sampled face detections are linked into tracklets (one person in one shot)."""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import linear_sum_assignment

from . import registry


@dataclass
class Obs:
    sample: int                 # index of the sampled frame inside the shot
    t: float
    box: np.ndarray             # source-pixel coordinates (x1, y1, x2, y2)
    score: float
    q: float
    usable: bool
    emb: np.ndarray | None
    frame_h: float              # source frame height, for relative face size
    weak_ok: bool = False       # embedded although not usable (profile/blur): attach-only evidence


@dataclass
class Tracklet:
    id: int
    shot_index: int
    obs: list[Obs] = field(default_factory=list)
    # best-quality evidence for thumbnails; JPEG files already written by the pipeline
    best_q: float = -1.0
    face_file: str | None = None
    frame_file: str | None = None
    # filled by finish()
    emb: np.ndarray | None = None
    emb_weak: np.ndarray | None = None   # from the best non-usable faces; attach-only
    quality: float = 0.0
    n_usable: int = 0
    max_score: float = 0.0
    _mean: np.ndarray | None = None
    _mean_w: float = 0.0

    @property
    def samples(self) -> set[int]:
        return {o.sample for o in self.obs}

    @property
    def first_t(self) -> float:
        return self.obs[0].t

    @property
    def last_t(self) -> float:
        return self.obs[-1].t

    @property
    def last_box(self) -> np.ndarray:
        return self.obs[-1].box

    def add(self, o: Obs) -> None:
        self.obs.append(o)
        if o.usable and o.emb is not None:
            w = max(o.q, 0.05)
            self._mean = o.emb * w if self._mean is None else self._mean + o.emb * w
            self._mean_w += w

    @property
    def running_emb(self) -> np.ndarray | None:
        if self._mean is None:
            return None
        n = np.linalg.norm(self._mean)
        return self._mean / n if n > 0 else None

    def finish(self, top_k: int = 10) -> None:
        good = sorted((o for o in self.obs if o.usable and o.emb is not None), key=lambda o: -o.q)[:top_k]
        self.n_usable = sum(1 for o in self.obs if o.usable)
        if good:
            m = sum(o.emb * max(o.q, 0.05) for o in good)
            n = np.linalg.norm(m)
            self.emb = (m / n).astype(np.float32) if n > 0 else None
            self.quality = float(np.mean([o.q for o in good[:3]]))
        else:
            weak = sorted((o for o in self.obs if o.weak_ok and o.emb is not None), key=lambda o: -o.q)[:3]
            if weak:
                m = sum(o.emb for o in weak)
                n = np.linalg.norm(m)
                self.emb_weak = (m / n).astype(np.float32) if n > 0 else None
            self.quality = float(max((o.q for o in self.obs), default=0.0)) * 0.5
        self.max_score = max(o.score for o in self.obs)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


class ShotTracker:
    """Online tracker for one shot. Call update() per sampled frame, then finish()."""

    def __init__(self, shot_index: int, th: registry.Thresholds, next_id, max_gap_s: float = 1.3):
        self.shot_index = shot_index
        self.th = th
        self._next_id = next_id
        self.max_gap = max_gap_s
        self.tracks: list[Tracklet] = []
        self.sample_count = 0

    def update(self, t: float, observations: list[Obs]) -> list[tuple[Obs, Tracklet]]:
        """Link observations of one sampled frame. Returns (obs, tracklet) pairs."""
        sample = self.sample_count
        self.sample_count += 1
        for o in observations:
            o.sample = sample
        active = [tr for tr in self.tracks if t - tr.last_t <= self.max_gap]
        pairs: list[tuple[Obs, Tracklet]] = []
        matched_det: set[int] = set()
        if active and observations:
            cost = np.full((len(active), len(observations)), 1e3, np.float64)
            for i, tr in enumerate(active):
                temb = tr.running_emb
                dt = t - tr.last_t
                for j, o in enumerate(observations):
                    c = self._cost(tr, temb, o, dt)
                    if c is not None:
                        cost[i, j] = c
            rows, cols = linear_sum_assignment(cost)
            for i, j in zip(rows, cols):
                if cost[i, j] < 1e3:
                    active[i].add(observations[j])
                    pairs.append((observations[j], active[i]))
                    matched_det.add(j)
        for j, o in enumerate(observations):
            if j in matched_det:
                continue
            tr = Tracklet(id=self._next_id(), shot_index=self.shot_index)
            tr.add(o)
            self.tracks.append(tr)
            pairs.append((o, tr))
        return pairs

    def _cost(self, tr: Tracklet, temb, o: Obs, dt: float) -> float | None:
        a, b = tr.last_box, o.box
        ov = iou(a, b)
        ha, hb = a[3] - a[1], b[3] - b[1]
        ca, cb = ((a[0] + a[2]) / 2, (a[1] + a[3]) / 2), ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)
        d = float(np.hypot(ca[0] - cb[0], ca[1] - cb[1])) / max(ha, hb, 1.0)
        spatial_ok = ov >= 0.08 or d <= 0.6 + 1.5 * dt
        sim = None
        if temb is not None and o.emb is not None and o.usable:
            sim = float(temb @ o.emb)
        if sim is not None:
            if not ((spatial_ok and sim >= self.th.link_min) or sim >= self.th.link):
                return None
            sp = 1.0 - max(ov, 1.0 - min(d, 1.5) / 1.5)
            return 0.5 * sp + 0.5 * (1.0 - sim)
        if not spatial_ok:
            return None
        # a face too poor to identify may only extend a track it overlaps strongly
        if ov < 0.2 and d > 0.5:
            return None
        return (1.0 - max(ov, 1.0 - min(d, 1.5) / 1.5)) + 0.2

    def finish(self) -> list[Tracklet]:
        for tr in self.tracks:
            tr.finish()
        return self.tracks
