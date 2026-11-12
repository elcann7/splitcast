"""Small image helpers (cv2 on in-memory arrays only; file IO goes through Python so Unicode paths are safe)."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np


def square_crop(rgb: np.ndarray, box, margin: float = 1.55, out: int = 160) -> np.ndarray:
    """Square crop around a face box (`margin` x its longer side), resampled to out x out.
    The window slides to stay inside the frame instead of stretching edge pixels."""
    h, w = rgb.shape[:2]
    x1, y1, x2, y2 = [float(v) for v in box]
    side = min(max(x2 - x1, y2 - y1) * margin, float(min(w, h)))
    cx = min(max((x1 + x2) / 2, side / 2), w - side / 2)
    cy = min(max((y1 + y2) / 2, side / 2), h - side / 2)
    s = out / side
    m = np.array([[s, 0, out / 2 - cx * s], [0, s, out / 2 - cy * s]], np.float32)
    return cv2.warpAffine(rgb, m, (out, out), flags=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_REPLICATE)


def resize_width(rgb: np.ndarray, width: int) -> np.ndarray:
    h, w = rgb.shape[:2]
    if w <= width:
        return rgb
    return cv2.resize(rgb, (width, max(1, round(h * width / w))), interpolation=cv2.INTER_AREA)


def write_jpeg(path: Path, rgb: np.ndarray, quality: int = 86) -> None:
    ok, buf = cv2.imencode(".jpg", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    Path(path).write_bytes(buf.tobytes())
