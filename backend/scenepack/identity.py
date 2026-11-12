"""Who is who across videos: matching, project-level refinement and carrying user edits over re-scans.

Everything here works on the persisted project model, not on live objects:

    p["characters"]          [{id, name, seq, named, hidden}]
    p["assign"][sid][atomId] [characterId, pinned]       tracklet -> character, per source
    p["separate"]            [[cidA, cidB], ...]         pairs the user split; never auto-merged
    scans (scans.py)         tracklet metadata + embeddings per source

`pinned` marks a manual placement (appearance move). Matching never moves pinned tracklets.

Identity of a character is not one mean vector. A character is represented by a few "looks"
(exemplars): the sub-clusters of its reliable tracklets. A look carries its weight and support, so
a character whose lighting / make-up / costume changes between episodes still matches, while a
single noisy tracklet cannot define a look on its own.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import cluster, registry
from .scans import Scan

GetScan = Callable[[str], Scan]
MAX_LOOKS = 8
LEGACY_SAMPLE = -1       # sample set of a migrated appearance: "unknown, treat as overlapping"


# ------------------------------------------------------------------ evidence and looks

def atom_weight(a: dict) -> float:
    """Same weighting as within-video clustering (cluster._weight)."""
    return max(0.2, a["quality"]) * min(max(a["nUsable"], 1), 8) ** 0.5


@dataclass
class Looks:
    E: np.ndarray                  # (m, d) unit vectors
    W: np.ndarray                  # (m,) total weight of the look
    N: np.ndarray                  # (m,) number of tracklets behind the look
    n_atoms: int = 0               # reliable tracklets in total

    @property
    def empty(self) -> bool:
        return len(self.E) == 0


EMPTY = Looks(np.zeros((0, 1), np.float32), np.zeros(0, np.float32), np.zeros(0, int), 0)


def build_looks(emb: np.ndarray, w: np.ndarray, th: registry.IdentityTh) -> Looks:
    n = len(emb)
    if n == 0:
        return EMPTY
    emb = emb.astype(np.float32)
    w = w.astype(np.float32)
    lab = cluster.agglomerate(emb, w, {i: set() for i in range(n)}, th.exemplar) if n > 1 else np.zeros(1, int)
    E, W, N = [], [], []
    for c in sorted(set(lab.tolist())):
        m = lab == c
        v = (emb[m] * w[m, None]).sum(axis=0)
        E.append(v / max(float(np.linalg.norm(v)), 1e-9))
        W.append(float(w[m].sum()))
        N.append(int(m.sum()))
    order = np.argsort(-np.array(W))[:MAX_LOOKS]
    return Looks(np.stack(E)[order], np.array(W, np.float32)[order], np.array(N)[order], n)


def look_score(x: Looks, c: Looks) -> float:
    """How well `c` explains `x`: for every look of x the best matching look of c, weighted by x's looks.
    A look backed by a single tracklet counts half (it may be a pose/blur outlier)."""
    if x.empty or c.empty:
        return -1.0
    best = (x.E @ c.E.T).max(axis=1)
    wt = x.W * np.where(x.N >= 2, 1.0, 0.5)
    return float((best * wt).sum() / wt.sum())


# ------------------------------------------------------------------ conflicts (cannot-link)

def _samples(a: dict) -> set[int]:
    s = a.get("samples")
    return set(s) if s else {LEGACY_SAMPLE}


def _clash(x: set[int], y: set[int]) -> bool:
    return LEGACY_SAMPLE in x or LEGACY_SAMPLE in y or bool(x & y)


class ConflictIndex:
    """For each character: per source, per shot, the sampled-frame sets its tracklets occupy.
    Two tracklets seen in the same sampled frame of the same shot are different people."""

    def __init__(self):
        self.occ: dict[str, dict[str, dict[int, list[set[int]]]]] = {}

    def add(self, cid: str, sid: str, shot: int, samples: set[int]) -> None:
        self.occ.setdefault(cid, {}).setdefault(sid, {}).setdefault(shot, []).append(samples)

    def conflict(self, a: str, b: str) -> bool:
        oa, ob = self.occ.get(a, {}), self.occ.get(b, {})
        for sid, shots in oa.items():
            other = ob.get(sid)
            if not other:
                continue
            for shot, sets in shots.items():
                for s2 in other.get(shot, ()):
                    if any(_clash(s1, s2) for s1 in sets):
                        return True
        return False

    def conflict_with(self, cid: str, sid: str, atoms: list[dict]) -> bool:
        occ = self.occ.get(cid, {}).get(sid)
        if not occ:
            return False
        for a in atoms:
            s = _samples(a)
            if any(_clash(s, o) for o in occ.get(a["shot"], ())):
                return True
        return False

    def merge_into(self, src: str, dst: str) -> None:
        for sid, shots in self.occ.pop(src, {}).items():
            d = self.occ.setdefault(dst, {}).setdefault(sid, {})
            for shot, sets in shots.items():
                d.setdefault(shot, []).extend(sets)


def conflict_index(p: dict, getscan: GetScan) -> ConflictIndex:
    ci = ConflictIndex()
    for sid, amap in p["assign"].items():
        scan = getscan(sid)
        for aid, (cid, _pin) in amap.items():
            a = scan.atom(int(aid))
            ci.add(cid, sid, a["shot"], _samples(a))
    return ci


# ------------------------------------------------------------------ char evidence

def char_looks(p: dict, getscan: GetScan, th: registry.IdentityTh, exclude: str | None = None) -> dict[str, Looks]:
    rows: dict[str, list[tuple[np.ndarray, float]]] = {}
    for sid, amap in p["assign"].items():
        if sid == exclude:
            continue
        scan = getscan(sid)
        for aid, (cid, _pin) in amap.items():
            i = scan.idx(int(aid))
            a = scan.atoms[i]
            if a.get("rel") and a.get("hasEmb"):
                rows.setdefault(cid, []).append((scan.emb[i], atom_weight(a)))
    out = {}
    for cid, lst in rows.items():
        out[cid] = build_looks(np.stack([r[0] for r in lst]), np.array([r[1] for r in lst], np.float32), th)
    return out


# ------------------------------------------------------------------ characters

def new_character(p: dict) -> dict:
    n = int(p.get("nextChar", 1))
    p["nextChar"] = n + 1
    import uuid
    c = {"id": "c_" + uuid.uuid4().hex[:8], "name": f"Personaj {n:02d}", "seq": n, "named": False, "hidden": False}
    p["characters"].append(c)
    return c


def char_by_id(p: dict, cid: str) -> dict | None:
    return next((c for c in p["characters"] if c["id"] == cid), None)


def prune_empty(p: dict) -> None:
    used = {v[0] for amap in p["assign"].values() for v in amap.values()}
    p["characters"] = [c for c in p["characters"] if c["id"] in used]
    alive = {c["id"] for c in p["characters"]}
    p["separate"] = [pair for pair in p.get("separate", []) if pair[0] in alive and pair[1] in alive]


def separated(p: dict, a: str, b: str) -> bool:
    return any((x == a and y == b) or (x == b and y == a) for x, y in p.get("separate", []))


# ------------------------------------------------------------------ inheritance (re-scans)

@dataclass
class OldAtom:
    shot: int
    first: float
    last: float
    pad: float                     # half a sampling interval: how far the observation reaches around its times
    cid: str
    pinned: bool
    emb: np.ndarray | None


def old_atoms(p: dict, sid: str, scan: Scan) -> list[OldAtom]:
    """Snapshot of what the previous analysis of this source decided, for carrying edits over a re-scan."""
    out = []
    for aid, (cid, pin) in p["assign"].get(sid, {}).items():
        i = scan.idx(int(aid))
        a = scan.atoms[i]
        out.append(_old_from(a, scan, cid, bool(pin), scan.emb[i] if a.get("hasEmb") else None))
    return out


def _old_from(a: dict, scan: Scan, cid: str, pinned: bool, emb) -> OldAtom:
    if a.get("legacy"):
        lg = a["legacy"]
        return OldAtom(a["shot"], lg["start"], lg["end"], 0.0, cid, pinned, None)
    sh = scan.shots.get(a["shot"], {})
    n = max(1, sh.get("n", 1))
    pad = 0.5 * (sh.get("end", 0) - sh.get("start", 0)) / n
    return OldAtom(a["shot"], a["first"], a["last"], pad, cid, pinned, emb)


def _overlap(a_first, a_last, a_pad, o: OldAtom) -> float:
    lo = max(a_first - a_pad, o.first - o.pad)
    hi = min(a_last + a_pad, o.last + o.pad)
    return max(0.0, hi - lo)


EMB_GATE = 0.80   # same recognizer, same footage: a genuinely identical tracklet is ~1.0


def votes_for_atom(a: dict, scan: Scan, emb: np.ndarray | None, by_shot: dict[int, list[OldAtom]]) -> dict[str, float]:
    sh = scan.shots.get(a["shot"], {})
    n = max(1, sh.get("n", 1))
    pad = 0.5 * (sh.get("end", 0) - sh.get("start", 0)) / n
    votes: dict[str, float] = {}
    for o in by_shot.get(a["shot"], ()):
        if emb is not None and o.emb is not None and float(emb @ o.emb) < EMB_GATE:
            continue
        ov = _overlap(a["first"], a["last"], pad, o)
        if ov > 0:
            votes[o.cid] = votes.get(o.cid, 0.0) + ov
    return votes


def atom_len(a: dict, scan: Scan) -> float:
    sh = scan.shots.get(a["shot"], {})
    n = max(1, sh.get("n", 1))
    return max(1e-3, (a["last"] - a["first"]) + (sh.get("end", 0) - sh.get("start", 0)) / n)


# ------------------------------------------------------------------ adding a source

@dataclass
class Cluster:
    label: int
    idx: list[int]                                  # indices into scan.atoms
    looks: Looks = field(default_factory=lambda: EMPTY)
    seconds: float = 0.0


def make_clusters(scan: Scan, labels: np.ndarray, th: registry.IdentityTh) -> list[Cluster]:
    groups: dict[int, list[int]] = {}
    for i, lab in enumerate(labels):
        if lab >= 0:
            groups.setdefault(int(lab), []).append(i)
    out = []
    for lab, idx in groups.items():
        rel = [i for i in idx if scan.atoms[i].get("rel") and scan.atoms[i].get("hasEmb")]
        looks = build_looks(scan.emb[rel], np.array([atom_weight(scan.atoms[i]) for i in rel], np.float32), th) \
            if rel else EMPTY
        secs = sum(atom_len(scan.atoms[i], scan) for i in idx)
        out.append(Cluster(lab, idx, looks, secs))
    out.sort(key=lambda c: -c.seconds)
    return out


def match_clusters(clusters: list[Cluster], chars: dict[str, Looks], th: registry.IdentityTh) -> dict[int, tuple[str, float]]:
    """Decide which clusters attach to which existing character. Returns {cluster.label: (cid, score)}.
    Needs: score >= match (+lone for single-tracklet clusters) and a margin over the runner-up."""
    out: dict[int, tuple[str, float]] = {}
    if not chars:
        return out
    cids = list(chars)
    for cl in clusters:
        if cl.looks.empty:
            continue
        sc = np.array([look_score(cl.looks, chars[c]) for c in cids])
        order = np.argsort(-sc)
        s1 = float(sc[order[0]])
        s2 = float(sc[order[1]]) if len(order) > 1 else -1.0
        need = th.match + (th.lone if cl.looks.n_atoms < 2 else 0.0)
        if s1 >= need and s1 - s2 >= th.match_margin:
            out[cl.label] = (cids[int(order[0])], s1)
    return out


def add_source(p: dict, getscan: GetScan, sid: str, scan: Scan, labels: np.ndarray, spec: registry.PresetSpec,
               old: list[OldAtom] | None = None) -> dict:
    """Assign every clustered tracklet of `scan` to a character of the project. Replaces p['assign'][sid].
    Order of authority: pinned manual placement > inheritance from the previous scan of this source >
    match against other sources > new character. Returns a small report."""
    th = spec.identity
    clusters = make_clusters(scan, labels, th)
    amap: dict[str, list] = {}
    report = {"inherited": 0, "matched": 0, "created": 0, "pinned": 0}

    p["assign"].pop(sid, None)             # the other sources' evidence only
    existing = {c["id"] for c in p["characters"]}
    cidx = conflict_index(p, getscan)

    fixed: set[int] = set()
    assigned: dict[int, str] = {}            # cluster label -> character
    by_shot: dict[int, list[OldAtom]] = {}
    for o in old or ():
        if o.cid in existing:
            by_shot.setdefault(o.shot, []).append(o)

    def put(i: int, cid: str, pin: bool) -> None:
        a = scan.atoms[i]
        amap[str(a["id"])] = [cid, 1 if pin else 0]
        cidx.add(cid, sid, a["shot"], _samples(a))

    if by_shot:
        # 1) pinned placements survive: a tracklet that overlaps (and looks like) a pinned old one goes where it was put
        for cl in clusters:
            for i in cl.idx:
                a = scan.atoms[i]
                best, best_ov = None, 0.0
                sh = scan.shots.get(a["shot"], {})
                pad = 0.5 * (sh.get("end", 0) - sh.get("start", 0)) / max(1, sh.get("n", 1))
                emb = scan.emb[i] if a.get("hasEmb") else None
                for o in by_shot.get(a["shot"], ()):
                    if not o.pinned:
                        continue
                    if emb is not None and o.emb is not None and float(emb @ o.emb) < EMB_GATE:
                        continue
                    ov = _overlap(a["first"], a["last"], pad, o)
                    if ov > best_ov:
                        best, best_ov = o, ov
                if best is not None and best_ov >= 0.5 * min(atom_len(a, scan), best.last - best.first + 2 * best.pad + 1e-3):
                    put(i, best.cid, True)
                    fixed.add(i)
                    report["pinned"] += 1
        # 2) clusters vote for the character their time span used to belong to
        # Every (cluster, old character) pair with a majority overlap is a candidate, and the pairs
        # with the most seconds are settled first. A migrated scan only knows "who was in this shot",
        # so a sidekick's cluster overlaps the lead's old character as fully as its own; taking pairs
        # by seconds gives the lead their identity first and the sidekick then falls to their own.
        cands = []
        for cl in clusters:
            tot, votes = 0.0, {}
            for i in cl.idx:
                if i in fixed:
                    continue
                a = scan.atoms[i]
                tot += atom_len(a, scan)
                for cid, v in votes_for_atom(a, scan, scan.emb[i] if a.get("hasEmb") else None, by_shot).items():
                    votes[cid] = votes.get(cid, 0.0) + v
            for cid, v in votes.items():
                if tot > 0 and v / tot >= 0.5:
                    cands.append((v, v / tot, cl, cid))
        for _v, _share, cl, cid in sorted(cands, key=lambda t: (-t[0], -t[1])):
            if cl.label in assigned:
                continue
            atoms = [scan.atoms[i] for i in cl.idx if i not in fixed]
            if cidx.conflict_with(cid, sid, atoms):
                continue
            for i in cl.idx:
                if i not in fixed:
                    put(i, cid, False)
            assigned[cl.label] = cid
            report["inherited"] += 1

    # 3) match the rest against characters built from the other sources
    rest = [cl for cl in clusters if cl.label not in assigned]
    chars = {c: lk for c, lk in char_looks(p, getscan, th, exclude=sid).items() if c in existing}
    cand = match_clusters(rest, chars, th)
    for cl in sorted(rest, key=lambda c: -cand.get(c.label, ("", -1))[1]):
        hit = cand.get(cl.label)
        if hit is None:
            continue
        cid, _s = hit
        atoms = [scan.atoms[i] for i in cl.idx if i not in fixed]
        if cidx.conflict_with(cid, sid, atoms):
            continue
        for i in cl.idx:
            if i not in fixed:
                put(i, cid, False)
        assigned[cl.label] = cid
        report["matched"] += 1

    # 4) everyone else is somebody new (largest screen time first, so the numbering follows importance)
    for cl in rest:
        if cl.label in assigned:
            continue
        c = new_character(p)
        for i in cl.idx:
            if i not in fixed:
                put(i, c["id"], False)
        assigned[cl.label] = c["id"]
        report["created"] += 1

    p["assign"][sid] = amap
    prune_empty(p)
    return report


# ------------------------------------------------------------------ project-level refinement

def _merge_chars(p: dict, keep: str, drop: str, cidx: ConflictIndex) -> None:
    for amap in p["assign"].values():
        for v in amap.values():
            if v[0] == drop:
                v[0] = keep
    p["characters"] = [c for c in p["characters"] if c["id"] != drop]
    sep = []
    for a, b in p.get("separate", []):
        a = keep if a == drop else a
        b = keep if b == drop else b
        if a != b:
            sep.append([a, b])
    p["separate"] = sep
    cidx.merge_into(drop, keep)


def refine(p: dict, getscan: GetScan, spec: registry.PresetSpec) -> list[tuple[str, str, float]]:
    """Merge characters that are now clearly the same person. Returns [(kept, dropped, score)].
    A pair is merged only when it clears `merge`, each is the other's best candidate, both lead their
    runner-up by `merge_margin` (blocked pairs count as runners-up: a look-alike you may not merge is
    still a reason to doubt), they never share a sampled frame, the user did not split them, they are
    not two differently named characters, and their hidden flags agree."""
    th = spec.identity
    done: list[tuple[str, str, float]] = []
    cidx = conflict_index(p, getscan)
    while True:
        looks = char_looks(p, getscan, th)
        cids = [c["id"] for c in p["characters"] if c["id"] in looks]
        if len(cids) < 2:
            return done
        n = len(cids)
        S = np.full((n, n), -2.0)
        for i in range(n):
            for j in range(n):
                if i != j:
                    S[i, j] = max(look_score(looks[cids[i]], looks[cids[j]]), look_score(looks[cids[j]], looks[cids[i]]))
        best = None
        for i in range(n):
            for j in range(i + 1, n):
                s = S[i, j]
                if s < th.merge:
                    continue
                ci, cj = char_by_id(p, cids[i]), char_by_id(p, cids[j])
                if cidx.conflict(cids[i], cids[j]) or separated(p, cids[i], cids[j]):
                    continue
                if ci["named"] and cj["named"] and ci["name"] != cj["name"]:
                    continue
                if ci["hidden"] != cj["hidden"]:
                    continue
                ri = np.delete(S[i], [i, j]).max(initial=-2.0)
                rj = np.delete(S[j], [i, j]).max(initial=-2.0)
                if s - ri < th.merge_margin or s - rj < th.merge_margin:
                    continue
                if best is None or s > best[0]:
                    best = (s, i, j)
        if best is None:
            return done
        s, i, j = best
        ci, cj = char_by_id(p, cids[i]), char_by_id(p, cids[j])
        # the named one survives; otherwise the older one (default names are never renumbered)
        keep, drop = (ci, cj) if (ci["named"], -ci["seq"]) >= (cj["named"], -cj["seq"]) else (cj, ci)
        _merge_chars(p, keep["id"], drop["id"], cidx)
        done.append((keep["id"], drop["id"], float(s)))


# ------------------------------------------------------------------ whole-project rebuild: carrying identity

def carry_over(new_p: dict, new_scans: GetScan, old_p: dict, old_scans: GetScan) -> int:
    """After a rebuild with another recognizer the new characters are anonymous. Give each the identity
    (id, name, hidden, seq) of the old character it overlaps most in time, per source. Returns how many
    characters took over an old identity. Two new characters may share an old one only if they never
    co-occur (the user had merged them); otherwise the larger overlap wins."""
    old_atoms_by_src: dict[str, dict[int, list[OldAtom]]] = {}
    for sid, amap in old_p["assign"].items():
        if sid not in new_p["assign"]:
            continue
        sc = old_scans(sid)
        by_shot: dict[int, list[OldAtom]] = {}
        for aid, (cid, pin) in amap.items():
            a = sc.atom(int(aid))
            by_shot.setdefault(a["shot"], []).append(_old_from(a, sc, cid, bool(pin), None))
        old_atoms_by_src[sid] = by_shot

    votes: dict[str, dict[str, float]] = {}      # new cid -> old cid -> seconds
    for sid, amap in new_p["assign"].items():
        by_shot = old_atoms_by_src.get(sid)
        if not by_shot:
            continue
        sc = new_scans(sid)
        for aid, (ncid, _pin) in amap.items():
            a = sc.atom(int(aid))
            for ocid, v in votes_for_atom(a, sc, None, by_shot).items():
                d = votes.setdefault(ncid, {})
                d[ocid] = d.get(ocid, 0.0) + v

    cidx = conflict_index(new_p, new_scans)
    old_ids = {c["id"] for c in old_p["characters"]}
    pairs = sorted(((v, n, o) for n, d in votes.items() for o, v in d.items() if o in old_ids), reverse=True)
    owner: dict[str, str] = {}          # old cid -> new cid that took the identity
    took: dict[str, str] = {}           # new cid -> old cid
    extra: list[tuple[str, str]] = []   # (new cid merged into owner's new cid)
    total_new = {n: sum(d.values()) for n, d in votes.items()}
    for v, n, o in pairs:
        if n in took:
            continue
        if v < 0.3 * total_new.get(n, 0.0) or v < 0.5:
            continue
        if o not in owner:
            owner[o] = n
            took[n] = o
        else:
            other = owner[o]
            if not cidx.conflict(n, other) and not separated(new_p, n, other):
                extra.append((n, other))
                took[n] = o
    oldc = {c["id"]: c for c in old_p["characters"]}
    # re-key new characters that inherited an identity
    for o, n in owner.items():
        c = char_by_id(new_p, n)
        oc = oldc[o]
        rekey = {n: o}
        c.update({"id": o, "name": oc["name"], "named": oc.get("named", False), "hidden": oc.get("hidden", False),
                  "seq": oc.get("seq", c["seq"])})
        for amap in new_p["assign"].values():
            for vv in amap.values():
                if vv[0] in rekey:
                    vv[0] = rekey[vv[0]]
        extra = [(rekey.get(a, a), rekey.get(b, b)) for a, b in extra]
        for pair in new_p.get("separate", []):
            pair[:] = [rekey.get(pair[0], pair[0]), rekey.get(pair[1], pair[1])]
        cidx.occ = {rekey.get(k, k): v for k, v in cidx.occ.items()}
    for n, keep in extra:
        _merge_chars(new_p, keep, n, cidx)
    return len(owner)
