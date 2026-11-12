"""Face detection (SCRFD), alignment, embedding (ArcFace family) and face quality scoring."""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from . import registry, runtime

# Canonical 5-point ArcFace template for a 112x112 crop.
_ARC_DST = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                     [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)

MIN_FACE_PX = 40          # source pixels of box height
MIN_DET_SCORE = 0.5
USABLE_DET_SCORE = 0.6    # non-faces (machinery, textures) tend to score 0.5-0.6


@dataclass
class Detection:
    box: np.ndarray        # x1,y1,x2,y2 in the coordinate system of the frame passed to detect()
    kps: np.ndarray | None # 5x2 landmarks; None for detectors without them (anime)
    score: float


class Detector:
    """SCRFD with 3 strides and 5-point landmarks. Input height/width are free (multiples of 32)."""

    def __init__(self, spec: registry.ModelSpec, det_size: int):
        self.sess = runtime.create_session(spec.path)
        self.input_name = self.sess.get_inputs()[0].name
        self.out_names = [o.name for o in self.sess.get_outputs()]
        self.det_size = det_size
        self.strides = (8, 16, 32)
        self._anchors: dict[tuple[int, int, int], np.ndarray] = {}
        # outputs: 3 scores, 3 boxes, 3 landmarks
        self.fmc = 3
        self.provider = runtime.session_provider(self.sess)

    def input_dims(self, w: int, h: int) -> tuple[int, int]:
        s = self.det_size / max(w, h)
        nw = max(32, int(np.ceil(w * s / 32.0)) * 32)
        nh = max(32, int(np.ceil(h * s / 32.0)) * 32)
        return nw, nh

    def _centers(self, stride: int, h: int, w: int) -> np.ndarray:
        key = (stride, h, w)
        c = self._anchors.get(key)
        if c is None:
            g = np.stack(np.mgrid[:h, :w][::-1], axis=-1).astype(np.float32) * stride
            c = np.stack([g.reshape(-1, 2)] * 2, axis=1).reshape(-1, 2)   # 2 anchors per location
            self._anchors[key] = c
        return c

    def detect(self, rgb: np.ndarray, thresh: float = 0.4, nms: float = 0.4) -> list[Detection]:
        """rgb: HxWx3 uint8. Returns detections in rgb's own pixel coordinates."""
        ih, iw = rgb.shape[:2]
        nw, nh = self.input_dims(iw, ih)
        scale = min(nw / iw, nh / ih)
        rw, rh = max(1, int(round(iw * scale))), max(1, int(round(ih * scale)))
        resized = cv2.resize(rgb, (rw, rh), interpolation=cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR)
        canvas = np.zeros((nh, nw, 3), np.uint8)
        canvas[:rh, :rw] = resized
        blob = ((canvas.astype(np.float32) - 127.5) / 128.0).transpose(2, 0, 1)[None]
        outs = self.sess.run(self.out_names, {self.input_name: blob})
        boxes, kpss, scores = [], [], []
        for i, stride in enumerate(self.strides):
            sc = outs[i].reshape(-1)
            keep = np.where(sc >= thresh)[0]
            if keep.size == 0:
                continue
            centers = self._centers(stride, nh // stride, nw // stride)[keep]
            bp = outs[i + self.fmc].reshape(-1, 4)[keep] * stride
            kp = outs[i + 2 * self.fmc].reshape(-1, 10)[keep] * stride
            boxes.append(np.stack([centers[:, 0] - bp[:, 0], centers[:, 1] - bp[:, 1],
                                   centers[:, 0] + bp[:, 2], centers[:, 1] + bp[:, 3]], axis=1))
            kpss.append((centers[:, None, :] + kp.reshape(-1, 5, 2)))
            scores.append(sc[keep])
        if not boxes:
            return []
        boxes, kpss, scores = np.concatenate(boxes), np.concatenate(kpss), np.concatenate(scores)
        order = _nms(boxes, scores, nms)
        inv = 1.0 / scale
        return [Detection(boxes[j] * inv, kpss[j] * inv, float(scores[j])) for j in order]


def _nms(boxes: np.ndarray, scores: np.ndarray, thr: float) -> list[int]:
    x1, y1, x2, y2 = boxes.T
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(int(i))
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1 + 1) * np.maximum(0, yy2 - yy1 + 1)
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[1:][iou <= thr]
    return keep


def align(rgb: np.ndarray, kps: np.ndarray) -> np.ndarray:
    """112x112 landmark-aligned crop (RGB)."""
    m, _ = cv2.estimateAffinePartial2D(kps.astype(np.float32), _ARC_DST, method=cv2.LMEDS)
    if m is None:
        return np.zeros((112, 112, 3), np.uint8)
    return cv2.warpAffine(rgb, m, (112, 112), flags=cv2.INTER_AREA if _shrinking(m) else cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def _shrinking(m: np.ndarray) -> bool:
    return float(np.hypot(m[0, 0], m[1, 0])) < 0.9


def plausible(box: np.ndarray, kps: np.ndarray) -> bool:
    """Landmark geometry of a real face: eyes above nose above mouth, everything inside the box.
    Rejects most detector false positives (machinery, textures) that score 0.5-0.8."""
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    if h <= 0 or w <= 0 or not 0.5 <= w / h <= 1.4:
        return False
    le, re, nose, lm, rm = kps
    eye_y, mouth_y = (le[1] + re[1]) / 2, (lm[1] + rm[1]) / 2
    if not (eye_y < nose[1] < mouth_y) or mouth_y - eye_y < 0.12 * h:
        return False
    if re[0] - le[0] < 0.04 * w:
        return False
    m = 0.15 * w
    return bool(np.all(kps[:, 0] > x1 - m) and np.all(kps[:, 0] < x2 + m)
                and np.all(kps[:, 1] > y1 - m) and np.all(kps[:, 1] < y2 + m))


def pose_ratios(kps: np.ndarray) -> tuple[float, float]:
    """(yaw, pitch) proxies from 5 landmarks (order: left eye, right eye, nose, left mouth, right mouth).
    yaw ~ 0 when frontal; |yaw| > ~0.4 is a heavy turn. pitch ~ 0.55-0.65 when level."""
    le, re, nose, lm, rm = kps
    eye_dx = re[0] - le[0]
    if eye_dx < 1e-3:
        return 9.0, 0.0
    yaw = (nose[0] - (le[0] + re[0]) / 2.0) / eye_dx
    eye_y = (le[1] + re[1]) / 2.0
    mouth_y = (lm[1] + rm[1]) / 2.0
    pitch = (nose[1] - eye_y) / max(mouth_y - eye_y, 1e-3)
    return float(yaw), float(pitch)


def quality(box_h_src: float, det_score: float, crop112: np.ndarray, kps: np.ndarray) -> tuple[float, bool, bool]:
    """(quality 0..1, usable, embeddable).
    usable: good enough to define who someone is (seeds clusters, builds centroids).
    embeddable: profile/blurry faces that are still embedded so they can be attached to a known
    character afterwards, but never define one."""
    yaw, pitch = pose_ratios(kps)
    size_q = min(1.0, max(0.0, (box_h_src - MIN_FACE_PX) / 80.0) ** 0.7 + 0.15) if box_h_src >= MIN_FACE_PX else 0.0
    grey = cv2.cvtColor(crop112, cv2.COLOR_RGB2GRAY)
    lap = float(cv2.Laplacian(grey, cv2.CV_32F).var())
    sharp_q = min(1.0, lap / 120.0) ** 0.6
    frontal_q = max(0.0, 1.0 - abs(yaw) / 0.55) * max(0.0, 1.0 - max(0.0, abs(pitch - 0.6) - 0.25) / 0.3)
    det_q = min(1.0, max(0.0, (det_score - 0.4) / 0.5))
    q = float(size_q * (0.35 + 0.65 * sharp_q) * (0.2 + 0.8 * frontal_q) * (0.5 + 0.5 * det_q))
    usable = bool(box_h_src >= MIN_FACE_PX and det_score >= USABLE_DET_SCORE and abs(yaw) <= 0.42
                  and lap >= 18.0 and q >= 0.12)
    embeddable = bool(box_h_src >= MIN_FACE_PX and det_score >= MIN_DET_SCORE and lap >= 6.0)
    return min(1.0, q), usable, embeddable


class Recognizer:
    def __init__(self, spec: registry.ModelSpec, flip: bool):
        self.sess = runtime.create_session(spec.path)
        self.input_name = self.sess.get_inputs()[0].name
        self.flip = flip
        self.provider = runtime.session_provider(self.sess)
        self.dim = spec.embedDim

    def embed(self, crops: list[np.ndarray], batch: int = 64) -> np.ndarray:
        """crops: list of 112x112 RGB uint8. Returns L2-normalised float32 (N, dim)."""
        if not crops:
            return np.zeros((0, self.dim), np.float32)
        out = []
        for i in range(0, len(crops), batch):
            x = np.stack(crops[i:i + batch]).astype(np.float32)
            x = ((x - 127.5) / 127.5).transpose(0, 3, 1, 2)
            e = self.sess.run(None, {self.input_name: np.ascontiguousarray(x)})[0]
            if self.flip:
                xf = np.ascontiguousarray(x[:, :, :, ::-1])
                e = _l2(e) + _l2(self.sess.run(None, {self.input_name: xf})[0])
            out.append(_l2(e))
        return np.concatenate(out).astype(np.float32)


def _l2(x: np.ndarray) -> np.ndarray:
    return x / np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-9)


class LiveEngine:
    """Real footage: SCRFD + landmark-aligned ArcFace. The pipeline only talks to this interface
    (detect / keep / prepare / embed), so another kind of content plugs in as another engine."""
    kind = "live"
    max_faces = 12

    def __init__(self, spec: registry.PresetSpec):
        self.det = Detector(registry.MODELS[spec.detector], spec.detSize)
        self.rec = Recognizer(registry.MODELS[spec.recognizer], spec.flipAugment)
        self.provider = self.det.provider
        self.dim = self.rec.dim

    def detect(self, rgb: np.ndarray) -> list[Detection]:
        return self.det.detect(rgb)

    def keep(self, d: Detection, h_src: float) -> bool:
        return d.score >= MIN_DET_SCORE and h_src >= MIN_FACE_PX and plausible(d.box, d.kps)

    def prepare(self, rgb: np.ndarray, d: Detection, h_src: float):
        """(crop for the recognizer, quality 0..1, usable, embeddable)."""
        crop = align(rgb, d.kps)
        q, usable, embeddable = quality(h_src, d.score, crop, d.kps)
        return crop, q, usable, embeddable

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        return self.rec.embed(crops)


def make_engine(spec: registry.PresetSpec):
    if spec.content == "anime":
        from .anime import AnimeEngine
        return AnimeEngine(spec)
    return LiveEngine(spec)
