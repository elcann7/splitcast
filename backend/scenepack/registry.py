"""Model registry and quality presets.

A recognizer/detector is looked up by id, so swapping one in only needs a new entry here.
Thresholds are per recognizer: cosine similarities of different embedding networks are not
comparable. Values were tuned on real footage (see ARCHITECTURE.md section 3.2).
"""
from __future__ import annotations

from dataclasses import dataclass

from . import paths

_IF = "https://github.com/deepinsight/insightface/releases/download/v0.7/{}.zip"
_DG = "https://huggingface.co/deepghs/{}/resolve/main/{}"
CONTENTS = ("live", "anime")


@dataclass(frozen=True)
class Pack:
    id: str
    url: str
    sizeMb: int


PACKS = {
    "buffalo_s": Pack("buffalo_s", _IF.format("buffalo_s"), 122),
    "buffalo_l": Pack("buffalo_l", _IF.format("buffalo_l"), 275),
    "antelopev2": Pack("antelopev2", _IF.format("antelopev2"), 344),
}


@dataclass(frozen=True)
class ModelSpec:
    id: str                 # local file stem under models/
    kind: str               # detector | recognizer | shots
    label: str
    pack: str | None        # pack that ships the file (None = no pack)
    member: str | None      # file name inside the pack zip
    embedDim: int = 0
    url: str | None = None  # direct download of a single file (no pack)
    sizeMb: int = 0         # size of that direct download

    @property
    def path(self):
        return paths.MODELS_DIR / f"{self.id}.onnx"

    @property
    def installed(self) -> bool:
        return self.path.exists() and self.path.stat().st_size > 100_000


MODELS = {
    "scrfd_500m": ModelSpec("scrfd_500m", "detector", "SCRFD-500MF", "buffalo_s", "det_500m.onnx"),
    "scrfd_10g": ModelSpec("scrfd_10g", "detector", "SCRFD-10GF", "buffalo_l", "det_10g.onnx"),
    "scrfd_10g_v2": ModelSpec("scrfd_10g_v2", "detector", "SCRFD-10GF", "antelopev2", "scrfd_10g_bnkps.onnx"),
    "arcface_mbf": ModelSpec("arcface_mbf", "recognizer", "ArcFace MobileFaceNet", "buffalo_s", "w600k_mbf.onnx", 512),
    "arcface_r50": ModelSpec("arcface_r50", "recognizer", "ArcFace R50", "buffalo_l", "w600k_r50.onnx", 512),
    "arcface_r100": ModelSpec("arcface_r100", "recognizer", "ArcFace R100 Glint360K", "antelopev2", "glintr100.onnx", 512),
    # Third-party ONNX export of the MIT-licensed TransNetV2 weights.
    "transnetv2": ModelSpec("transnetv2", "shots", "TransNetV2", None, None,
                            url="https://huggingface.co/elya5/transnetv2/resolve/main/transnetv2.onnx", sizeMb=30),
    # Anime (anime.py): deepghs face detector (MIT) and CCIP character features (OpenRAIL).
    "anime_face_n": ModelSpec("anime_face_n", "detector", "Anime Face YOLOv8n", None, None,
                              url=_DG.format("anime_face_detection", "face_detect_v1.4_n/model.onnx"), sizeMb=12),
    "anime_face_s": ModelSpec("anime_face_s", "detector", "Anime Face YOLOv8s", None, None,
                              url=_DG.format("anime_face_detection", "face_detect_v1.4_s/model.onnx"), sizeMb=43),
    "ccip_feat": ModelSpec("ccip_feat", "recognizer", "CCIP CAFormer", None, None, 768,
                           url=_DG.format("ccip_onnx", "ccip-caformer-24-randaug-pruned/model_feat.onnx"), sizeMb=144),
}


@dataclass(frozen=True)
class Thresholds:
    """Cosine-similarity thresholds for one recognizer."""
    link: float        # within-shot detection to track linking when no spatial overlap
    link_min: float    # minimum similarity to link with spatial overlap
    cluster: float     # average-linkage stop similarity between tracklets
    reassign: float    # refinement: weak tracklet to nearest centroid
    merge: float       # refinement: centroid-to-centroid merge
    weak: float = 0.36 # attach profile/blurry tracklets (also needs a margin over the runner-up)
    # Share of the smaller cluster's tracklets that may clash (be seen in the same frame) with the
    # other cluster and still allow a merge. 0 = strict cannot-link, right for real footage. Drawn
    # shows put one character on screen twice (split panels, memories, reflections), so anime
    # tolerates a few clashes between two large, near-identical clusters.
    conflict_tol: float = 0.0


@dataclass(frozen=True)
class IdentityTh:
    """Cross-video identity thresholds for one recognizer (ARCHITECTURE.md section 3.2, step 7)."""
    exemplar: float = 0.55        # sub-clustering similarity that defines one "look" of a character
    match: float = 0.55           # a cluster attaches to an existing character at or above this score
    match_margin: float = 0.06    # ... and only when it beats the runner-up character by this much
    merge: float = 0.60           # project refinement merges two characters at or above this score
    merge_margin: float = 0.06    # ... when each is the other's clear best candidate by this margin
    lone: float = 0.05            # extra similarity demanded of a cluster backed by a single tracklet


@dataclass(frozen=True)
class PresetSpec:
    id: str
    shotModel: str
    detector: str
    recognizer: str
    sampleFps: float
    detSize: int            # long side of detector input
    flipAugment: bool
    refine: bool
    thresholds: Thresholds
    speedFactor: float = 1.0   # x real time for live action: 1080p H.264 on an RTX 5060 measured 2.2-4.7x; kept on the cautious side so ETAs are not optimistic
    identity: IdentityTh = IdentityTh()
    content: str = "live"      # live | anime: which engine (faces.make_engine) reads the footage


# CCIP similarities live on another scale than ArcFace: the same character is ~0.65 and up,
# different characters of one show (same art style, same uniform) routinely reach 0.5.
# Measured on a full episode: tracklet-to-own-centroid ~0.90 (p10 0.83); centroids of two clusters of
# one lead 0.87-0.94; centroids of different leads 0.36-0.70; generic background extras reach 0.9
# among themselves and are only kept apart by cannot-link.
_CCIP = Thresholds(link=0.82, link_min=0.60, cluster=0.74, reassign=0.80, merge=0.86, weak=0.80,
                   conflict_tol=0.08)
_CCIP_ID = IdentityTh(exemplar=0.82, match=0.84, match_margin=0.06, merge=0.88, merge_margin=0.05, lone=0.04)

ANIME_PRESETS = {
    "fast": PresetSpec("fast", "content", "anime_face_n", "ccip_feat", 1.5, 640, False, True,
                       _CCIP, 7.5, _CCIP_ID, "anime"),
    "balanced": PresetSpec("balanced", "transnetv2", "anime_face_s", "ccip_feat", 3.0, 640, False, True,
                           _CCIP, 5.5, _CCIP_ID, "anime"),
    "max": PresetSpec("max", "transnetv2", "anime_face_s", "ccip_feat", 6.0, 960, False, True,
                      _CCIP, 3.0, _CCIP_ID, "anime"),
}

PRESETS = {
    "fast": PresetSpec("fast", "content", "scrfd_500m", "arcface_mbf", 2.0, 640, False, False,
                       Thresholds(0.60, 0.30, 0.32, 0.45, 0.50, 0.42), 5.0, IdentityTh()),
    "balanced": PresetSpec("balanced", "transnetv2", "scrfd_10g", "arcface_r50", 4.0, 640, False, True,
                           Thresholds(0.55, 0.25, 0.38, 0.42, 0.55), 4.0, IdentityTh()),
    "max": PresetSpec("max", "transnetv2", "scrfd_10g_v2", "arcface_r100", 8.0, 960, True, True,
                      Thresholds(0.55, 0.25, 0.38, 0.42, 0.55), 3.0, IdentityTh()),
}


def spec(preset_id: str, content: str | None = "live") -> PresetSpec:
    """The preset for a kind of content. A project has exactly one (content, preset)."""
    return (ANIME_PRESETS if content == "anime" else PRESETS)[preset_id]


def all_presets() -> list[PresetSpec]:
    return list(PRESETS.values()) + list(ANIME_PRESETS.values())


def preset_models(p: PresetSpec) -> list[ModelSpec]:
    models = [MODELS[p.detector], MODELS[p.recognizer]]
    if p.shotModel == "transnetv2":
        models.append(MODELS["transnetv2"])
    return models


def missing_download_mb(p: PresetSpec) -> int:
    """Remaining download size (packs are zip archives, so whole packs count)."""
    missing = [m for m in preset_models(p) if not m.installed]
    return sum(PACKS[k].sizeMb for k in {m.pack for m in missing if m.pack}) + sum(m.sizeMb for m in missing if m.url)


def shot_model_available() -> bool:
    return MODELS["transnetv2"].installed
