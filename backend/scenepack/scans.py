"""Per-source scan data: shots, tracklets ("atoms") and their embeddings.

A scan is what one analysis of one video leaves behind. Identity decisions (which character a
tracklet belongs to) live in the project; the scan only holds evidence, so matching, refinement,
merges and re-scans can be recomputed without decoding video again.

Files (in the project folder, named by the scan token so a re-scan never overwrites live data):
    scans/<token>.json   shots + tracklet metadata
    scans/<token>.npz    embeddings (float16, L2-normalised), one row per tracklet
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

EMB_DIM = 512


@dataclass
class Scan:
    token: str
    preset: str
    shots: dict[int, dict]            # shot index -> {start, end, n (sampled frames), people}
    atoms: list[dict]                 # tracklet metadata (see pipeline.build_scan)
    emb: np.ndarray                   # (n, D) float32, zero row = none
    embw: np.ndarray                  # (n, D) attach-only embedding of weak tracklets
    legacy: bool = False              # migrated from a pre-multi-video project: no embeddings
    _index: dict[int, int] = field(default_factory=dict, repr=False)

    def __post_init__(self):
        self._index = {a["id"]: i for i, a in enumerate(self.atoms)}

    def idx(self, atom_id: int) -> int:
        return self._index[atom_id]

    def atom(self, atom_id: int) -> dict:
        return self.atoms[self._index[atom_id]]

    def has(self, atom_id: int) -> bool:
        return atom_id in self._index


def scan_dir(pdir: Path) -> Path:
    d = pdir / "scans"
    d.mkdir(parents=True, exist_ok=True)
    return d


def save(pdir: Path, scan: Scan) -> None:
    d = scan_dir(pdir)
    meta = {"version": 1, "token": scan.token, "preset": scan.preset, "legacy": scan.legacy,
            "shots": {str(k): v for k, v in scan.shots.items()}, "atoms": scan.atoms}
    # npz first: the json is what makes a scan "exist"
    if not scan.legacy:
        tmp = d / f"{scan.token}.tmp.npz"
        np.savez_compressed(tmp, emb=scan.emb.astype(np.float16), embw=scan.embw.astype(np.float16))
        os.replace(tmp, d / f"{scan.token}.npz")
    tmpj = d / f"{scan.token}.json.tmp"
    tmpj.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(tmpj, d / f"{scan.token}.json")


def exists(pdir: Path, token: str | None) -> bool:
    return bool(token) and (pdir / "scans" / f"{token}.json").is_file()


def load(pdir: Path, token: str) -> Scan:
    d = pdir / "scans"
    meta = json.loads((d / f"{token}.json").read_text(encoding="utf-8"))
    atoms = meta["atoms"]
    n = len(atoms)
    npz = d / f"{token}.npz"
    if npz.is_file():
        z = np.load(npz)
        emb, embw = z["emb"].astype(np.float32), z["embw"].astype(np.float32)
    else:
        emb = np.zeros((n, EMB_DIM), np.float32)
        embw = np.zeros((n, EMB_DIM), np.float32)
    return Scan(token=token, preset=meta.get("preset", ""), shots={int(k): v for k, v in meta["shots"].items()},
                atoms=atoms, emb=emb, embw=embw, legacy=bool(meta.get("legacy")))


def delete(pdir: Path, token: str | None) -> None:
    if not token:
        return
    for ext in ("json", "npz"):
        (pdir / "scans" / f"{token}.{ext}").unlink(missing_ok=True)
