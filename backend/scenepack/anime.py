"""Anime engine: drawn faces need their own detector and their own idea of identity.

Detector   deepghs/anime_face_detection (YOLOv8, one class "face", no landmarks).
Recognizer deepghs CCIP (Contrastive Anime Character Image Pre-training): a 768-d feature of the
           character crop. Its published "difference" is exactly (1 - cosine) / 2, so cosine
           similarity of L2-normalised features plugs straight into tracking / clustering / identity.

Drawn faces differ mostly by hair and eye colour, so the recognizer is fed the whole head (face box
grown upwards and sideways), not a tight landmark-aligned face as ArcFace is.
"""
from __future__ import annotations

import cv2
import numpy as np

from . import registry, runtime
from .faces import Detection, _l2, _nms

MIN_FACE_PX = 40           # source pixels of box height: below this a drawn face is a few flat blobs
USABLE_FACE_PX = 64
MIN_DET_SCORE = 0.35
USABLE_DET_SCORE = 0.50
CCIP_SIZE = 384
_MEAN = np.array([0.48145466, 0.4578275, 0.40821073], np.float32)
_STD = np.array([0.26862954, 0.26130258, 0.27577711], np.float32)


class YoloFaceDetector:
    def __init__(self, spec: registry.ModelSpec, det_size: int):
        self.sess = runtime.create_session(spec.path)
        self.input_name = self.sess.get_inputs()[0].name
        self.det_size = det_size
        self.provider = runtime.session_provider(self.sess)

    def detect(self, rgb: np.ndarray, thresh: float = 0.30, nms: float = 0.5) -> list[Detection]:
        ih, iw = rgb.shape[:2]
        s = self.det_size / max(ih, iw)
        rw, rh = max(1, int(round(iw * s))), max(1, int(round(ih * s)))
        cw, ch = int(np.ceil(rw / 32) * 32), int(np.ceil(rh / 32) * 32)
        canvas = np.full((ch, cw, 3), 114, np.uint8)
        canvas[:rh, :rw] = cv2.resize(rgb, (rw, rh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
        blob = (canvas.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]
        out = self.sess.run(None, {self.input_name: blob})[0][0]
        if out.shape[0] < out.shape[1]:          # (4 + classes, anchors) -> (anchors, 4 + classes)
            out = out.T
        sc = out[:, 4:].max(axis=1)
        keep = sc >= thresh
        if not keep.any():
            return []
        b, sc = out[keep, :4], sc[keep]
        boxes = np.stack([b[:, 0] - b[:, 2] / 2, b[:, 1] - b[:, 3] / 2,
                          b[:, 0] + b[:, 2] / 2, b[:, 1] + b[:, 3] / 2], axis=1) / s
        return [Detection(boxes[j], None, float(sc[j])) for j in _nms(boxes, sc, nms)]


def head_crop(rgb: np.ndarray, box: np.ndarray) -> np.ndarray:
    """Square crop around the head (hair included), CCIP_SIZE px. Parts outside the frame repeat the edge."""
    x1, y1, x2, y2 = (float(v) for v in box)
    w, h = x2 - x1, y2 - y1
    side = max(w, h) * 1.7
    cx = (x1 + x2) / 2.0
    top = y1 - 0.62 * h                       # hair sits above the face box
    m = np.array([[CCIP_SIZE / side, 0, -(cx - side / 2) * CCIP_SIZE / side],
                  [0, CCIP_SIZE / side, -top * CCIP_SIZE / side]], np.float32)
    return cv2.warpAffine(rgb, m, (CCIP_SIZE, CCIP_SIZE),
                          flags=cv2.INTER_AREA if side > CCIP_SIZE else cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


class CcipRecognizer:
    def __init__(self, spec: registry.ModelSpec):
        self.sess = runtime.create_session(spec.path)
        self.input_name = self.sess.get_inputs()[0].name
        self.provider = runtime.session_provider(self.sess)
        self.dim = spec.embedDim

    def embed(self, crops: list[np.ndarray], batch: int = 16) -> np.ndarray:
        if not crops:
            return np.zeros((0, self.dim), np.float32)
        out = []
        for i in range(0, len(crops), batch):
            x = (np.stack(crops[i:i + batch]).astype(np.float32) / 255.0 - _MEAN) / _STD
            out.append(_l2(self.sess.run(None, {self.input_name: np.ascontiguousarray(x.transpose(0, 3, 1, 2))})[0]))
        return np.concatenate(out).astype(np.float32)


class AnimeEngine:
    kind = "anime"
    max_faces = 6            # CCIP is heavy; a crowd's sixth-largest face is an extra anyway

    def __init__(self, spec: registry.PresetSpec):
        self.det = YoloFaceDetector(registry.MODELS[spec.detector], spec.detSize)
        self.rec = CcipRecognizer(registry.MODELS[spec.recognizer])
        self.provider = self.det.provider
        self.dim = self.rec.dim

    def detect(self, rgb: np.ndarray) -> list[Detection]:
        return self.det.detect(rgb)

    def keep(self, d: Detection, h_src: float) -> bool:
        w, h = d.box[2] - d.box[0], d.box[3] - d.box[1]
        return d.score >= MIN_DET_SCORE and h_src >= MIN_FACE_PX and h > 0 and 0.5 <= w / h <= 1.8

    def prepare(self, rgb: np.ndarray, d: Detection, h_src: float):
        """(crop for the recognizer, quality 0..1, usable, embeddable)."""
        crop = head_crop(rgb, d.box)
        ih, iw = rgb.shape[:2]
        x1, y1, x2, y2 = d.box
        w, h = x2 - x1, y2 - y1
        # a face cut by the frame edge is half a face: fine as a sighting, useless as identity
        cut = x1 < -0.05 * w or y1 < -0.05 * h or x2 > iw + 0.05 * w or y2 > ih + 0.05 * h
        fx1, fy1 = int(max(0, x1)), int(max(0, y1))
        fx2, fy2 = int(min(iw, x2)), int(min(ih, y2))
        lap = 0.0
        if fx2 - fx1 > 4 and fy2 - fy1 > 4:
            grey = cv2.cvtColor(cv2.resize(rgb[fy1:fy2, fx1:fx2], (112, 112)), cv2.COLOR_RGB2GRAY)
            lap = float(cv2.Laplacian(grey, cv2.CV_32F).var())
        size_q = min(1.0, max(0.0, (h_src - MIN_FACE_PX) / 140.0) ** 0.7 + 0.15)
        sharp_q = min(1.0, lap / 150.0) ** 0.6           # motion-smeared and out-of-focus drawings are flat
        det_q = min(1.0, max(0.0, (d.score - 0.3) / 0.5))
        q = float(size_q * (0.35 + 0.65 * sharp_q) * (0.4 + 0.6 * det_q))
        usable = bool(not cut and h_src >= USABLE_FACE_PX and d.score >= USABLE_DET_SCORE and lap >= 12.0 and q >= 0.12)
        embeddable = bool(h_src >= MIN_FACE_PX and d.score >= MIN_DET_SCORE and lap >= 4.0)
        return crop, min(1.0, q), usable, embeddable

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        return self.rec.embed(crops)
