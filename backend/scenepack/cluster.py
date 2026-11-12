"""Tracklet clustering: constrained average-linkage agglomeration followed by a refinement pass.

Cannot-link: two tracklets that were detected in the same sampled frame of the same shot are
different people and their clusters never merge. Weak tracklets (no usable face) never seed or
bridge clusters; they are attached afterwards to the nearest centroid if it is close enough.
"""
from __future__ import annotations

import numpy as np

from . import registry
from .tracking import Tracklet

NEG = -2.0
MIN_RELIABLE_Q = 0.18


def is_reliable(t: Tracklet) -> bool:
    """May seed/define a cluster. A lone, mediocre-confidence detection is too often a non-face."""
    return (t.emb is not None and t.n_usable >= 1 and t.quality >= MIN_RELIABLE_Q
            and (len(t.obs) >= 2 or t.max_score >= 0.75))


def conflicts(tracklets: list[Tracklet]) -> dict[int, set[int]]:
    """Index-based cannot-link sets (indices into `tracklets`)."""
    by_shot: dict[int, list[int]] = {}
    for i, t in enumerate(tracklets):
        by_shot.setdefault(t.shot_index, []).append(i)
    conf: dict[int, set[int]] = {i: set() for i in range(len(tracklets))}
    for idxs in by_shot.values():
        for a in range(len(idxs)):
            sa = tracklets[idxs[a]].samples
            for b in range(a + 1, len(idxs)):
                if sa & tracklets[idxs[b]].samples:
                    conf[idxs[a]].add(idxs[b])
                    conf[idxs[b]].add(idxs[a])
    return conf


def _weight(t: Tracklet) -> float:
    return max(0.2, t.quality) * min(max(t.n_usable, 1), 8) ** 0.5


def agglomerate(emb: np.ndarray, w: np.ndarray, conf: dict[int, set[int]], thr: float) -> np.ndarray:
    """Average-linkage on cosine similarity, merging while best similarity >= thr. Returns labels."""
    n = len(emb)
    if n == 0:
        return np.zeros(0, int)
    S = (emb @ emb.T).astype(np.float32)
    np.fill_diagonal(S, NEG)
    for i, cs in conf.items():
        for j in cs:
            S[i, j] = NEG
    conf = {i: set(c) for i, c in conf.items()}
    w = w.astype(np.float32).copy()
    alive = np.ones(n, bool)
    label = np.arange(n)
    rowmax = S.max(axis=1)
    rowarg = S.argmax(axis=1)
    while True:
        i = int(rowmax.argmax())
        if rowmax[i] < thr:
            break
        j = int(rowarg[i])
        # merge j into i
        row = (w[i] * S[i] + w[j] * S[j]) / (w[i] + w[j])
        cj = conf[j]
        ci = conf[i]
        for c in (ci | cj):
            row[c] = NEG
        conf[i] = ci | cj
        for c in cj:
            conf[c].discard(j)
            conf[c].add(i)
        for c in ci:
            conf[c].add(i)
        row[i] = NEG
        row[j] = NEG
        row[~alive] = NEG
        w[i] += w[j]
        alive[j] = False
        label[label == j] = i
        S[i, :] = row
        S[:, i] = row
        S[j, :] = NEG
        S[:, j] = NEG
        rowmax[j] = NEG
        rowarg[j] = j
        rowmax[i] = row.max()
        rowarg[i] = int(row.argmax())
        stale = np.where(alive & ((rowarg == i) | (rowarg == j)))[0]
        stale = stale[stale != i]
        for r in stale:
            rowarg[r] = int(S[r].argmax())
            rowmax[r] = S[r, rowarg[r]]
        # entries toward i may have increased for others
        better = alive & (S[:, i] > rowmax)
        better[i] = False
        for r in np.where(better)[0]:
            rowmax[r] = S[r, i]
            rowarg[r] = i
    return label


def _centroids(emb: np.ndarray, w: np.ndarray, label: np.ndarray, ids: list[int]) -> np.ndarray:
    out = np.zeros((len(ids), emb.shape[1]), np.float32)
    for k, c in enumerate(ids):
        m = label == c
        v = (emb[m] * w[m, None]).sum(axis=0)
        out[k] = v / max(np.linalg.norm(v), 1e-9)
    return out


def _violates(members_of_target: np.ndarray, i: int, conf: dict[int, set[int]]) -> bool:
    return any(m in conf[i] for m in members_of_target)


def cluster_tracklets(tracklets: list[Tracklet], th: registry.Thresholds, refine: bool = True) -> list[int]:
    """Returns a cluster label per tracklet (-1 = not assigned to any character)."""
    labels_out = [-1] * len(tracklets)
    rel_idx = [i for i, t in enumerate(tracklets) if is_reliable(t)]
    if not rel_idx:
        return labels_out
    sub = [tracklets[i] for i in rel_idx]
    emb = np.stack([t.emb for t in sub]).astype(np.float32)
    w = np.array([_weight(t) for t in sub], np.float32)
    full_conf = conflicts(tracklets)
    pos = {g: k for k, g in enumerate(rel_idx)}
    conf = {pos[g]: {pos[x] for x in cs if x in pos} for g, cs in full_conf.items() if g in pos}

    label = agglomerate(emb, w, conf, th.cluster)
    if refine:
        label = _refine(emb, w, label, conf, th)

    for k, g in enumerate(rel_idx):
        labels_out[g] = int(label[k])

    # attach the rest: tracklets that are profile/blurry/single-shot. Looser evidence, so a margin is required.
    ids = sorted(set(label.tolist()))
    cents = _centroids(emb, w, label, ids)
    members: dict[int, list[int]] = {c: [rel_idx[k] for k in np.where(label == c)[0]] for c in ids}
    # only clusters backed by at least two reliable tracklets may recruit; a lone seed is often a false positive
    solid = np.array([len(members[c]) >= 2 for c in ids])
    for g, t in enumerate(tracklets):
        if labels_out[g] != -1:
            continue
        strong = t.emb is not None
        e = t.emb if strong else t.emb_weak
        if e is None or t.max_score < 0.6 or not solid.any():
            continue
        sims = np.where(solid, cents @ e, -2.0)
        need = th.reassign if strong else th.weak
        order = np.argsort(-sims)
        best = order[0]
        second = sims[order[1]] if len(order) > 1 else -1.0
        if sims[best] < need or (not strong and sims[best] - second < 0.04):
            continue
        for k in order:
            if sims[k] < need:
                break
            if not any(m in full_conf[g] for m in members[ids[k]]):
                labels_out[g] = ids[k]
                members[ids[k]].append(g)
                break
    return labels_out


def _refine(emb, w, label, conf, th: registry.Thresholds):
    n = len(emb)
    label = label.copy()
    for _ in range(3):
        ids = sorted(set(label.tolist()))
        cents = _centroids(emb, w, label, ids)
        idpos = {c: k for k, c in enumerate(ids)}
        moved = 0
        sims_all = emb @ cents.T
        for i in range(n):
            own = idpos[int(label[i])]
            own_members = np.where(label == label[i])[0]
            # similarity to own cluster without itself, to avoid self-reinforcement of singletons
            others = own_members[own_members != i]
            own_sim = float((emb[i] @ emb[others].T).mean()) if len(others) else -1.0
            order = np.argsort(-sims_all[i])
            for k in order[:3]:
                if k == own:
                    break
                if sims_all[i, k] >= th.reassign and sims_all[i, k] > own_sim + 0.04:
                    tgt = np.where(label == ids[k])[0]
                    if not _violates(tgt, i, conf):
                        label[i] = ids[k]
                        moved += 1
                        break
        # merge clusters with very close centroids if constraints allow
        merged = _merge_close(emb, w, label, conf, th.merge, th.conflict_tol)
        if moved == 0 and not merged:
            break
    return label


def _merge_close(emb, w, label, conf, thr: float, tol: float = 0.0) -> bool:
    any_merge = False
    while True:
        ids = sorted(set(label.tolist()))
        if len(ids) < 2:
            return any_merge
        cents = _centroids(emb, w, label, ids)
        S = cents @ cents.T
        np.fill_diagonal(S, -1)
        best = None
        for a in range(len(ids)):
            for b in np.argsort(-S[a])[:3]:
                if b <= a or S[a, b] < thr:
                    continue
                ma, mb = np.where(label == ids[a])[0], np.where(label == ids[b])[0]
                small, large = (ma, set(mb.tolist())) if len(ma) <= len(mb) else (mb, set(ma.tolist()))
                clashes = sum(1 for i in small if conf[i] & large)
                if clashes > int(tol * len(small)):
                    continue
                if best is None or S[a, b] > best[0]:
                    best = (S[a, b], ids[a], ids[b])
        if best is None:
            return any_merge
        label[label == best[2]] = best[1]
        any_merge = True
