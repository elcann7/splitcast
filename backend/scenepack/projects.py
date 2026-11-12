"""Project persistence and editing (ARCHITECTURE.md section 3.4 / 4).

project.json (version 2) holds identity and edits; evidence lives in scans/ (see scans.py):

    sources     [{id, label, order, media, status, error, stats, token, poster, needsRescan, addedAt}]
    characters  [{id, name, seq, named, hidden}]
    assign      {sourceId: {tracklet id: [characterId, pinned]}}
    separate    [[characterId, characterId]]      pairs the user split (never auto-merged)

Appearances are *derived*: all tracklets of one character in one shot of one source form one
appearance. Moving or merging only rewrites `assign`, so the next derivation is right by construction.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from . import identity, media, paths, scans
from .scans import Scan

PREVIEW_HANDLE_S = 2.0
VERSION = 2
_DEFAULT_NAME = re.compile(r"^Personaj \d+$")
LEGACY_NOTICE = ("Bu video əvvəlki versiyada analiz olunub və tanıma məlumatı saxlanmayıb. "
                 "Başqa video əlavə etdikdə o əvvəlcə yenidən skan olunacaq (adlar və gizlətmələr saxlanır).")


class ProjectError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def is_minor(screen_time: float, appearances: int, content: str = "live") -> bool:
    if content == "anime":       # drawn crowds yield dozens of small background clusters
        return appearances < 6 or screen_time < 15.0
    return appearances < 3 and screen_time < 4.0


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def norm_path(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def shot_size(rel_heights: list[float]) -> str:
    r = float(np.median(rel_heights)) if rel_heights else 0.0
    return "closeup" if r >= 0.22 else "medium" if r >= 0.09 else "wide"


class ProjectStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._cache: dict[str, dict] = {}
        self._active: dict[str, str] = {}      # project id -> running analysis job id
        self._rev: dict[str, int] = {}
        self._views: dict[str, tuple[int, list[dict]]] = {}
        self._scans: dict[tuple[str, str], Scan] = {}
        self.progress: dict[tuple[str, str], float] = {}   # (pid, sid) -> 0..1 while analysing (not persisted)

    # ---- paths -------------------------------------------------------------
    def dir(self, pid: str) -> Path:
        return paths.PROJECTS_DIR / pid

    def thumbs_dir(self, pid: str) -> Path:
        d = self.dir(pid) / "thumbs"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def previews_dir(self, pid: str) -> Path:
        d = self.dir(pid) / "previews"
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---- load / save / migration ---------------------------------------------
    def recover_on_startup(self) -> None:
        """Runs left behind by a process that died can never finish: restore or fail their sources,
        and delete thumbnails / scans that no source refers to."""
        paths.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        for d in list(paths.PROJECTS_DIR.iterdir()):
            if not (d / "project.json").is_file():
                continue
            try:
                p = self._load(d.name)
            except Exception:
                continue
            changed = False
            for s in p["sources"]:
                if s["status"] in ("queued", "analyzing"):
                    has = scans.exists(d, s.get("token"))
                    s["status"] = "ready" if has else "failed"
                    if not has:
                        s["error"] = "Analiz yarımçıq qaldı (proqram bağlanıb). Yenidən skan edin."
                    changed = True
            if changed:
                self.save(p)
            self._gc(p)

    def _gc(self, p: dict) -> None:
        d = self.dir(p["id"])
        tokens = {s["token"] for s in p["sources"] if s.get("token")}
        try:
            for f in (d / "thumbs").iterdir():
                if not f.is_file():
                    continue
                m = re.match(r"^(?:poster_)?([0-9a-f]{6})(?:_[fs]\d+)?\.jpg$", f.name)
                if m and m.group(1) not in tokens:
                    f.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            for f in (d / "scans").iterdir():
                stem = f.name.split(".")[0]
                if re.fullmatch(r"[0-9a-f]{6}", stem) and stem not in tokens:
                    f.unlink(missing_ok=True)
        except OSError:
            pass

    def _write(self, p: dict) -> None:
        d = self.dir(p["id"])
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "project.json.tmp"
        tmp.write_text(json.dumps(p, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, d / "project.json")

    def _load(self, pid: str) -> dict:
        with self._lock:
            p = self._cache.get(pid)
            if p is not None:
                return p
            f = self.dir(pid) / "project.json"
            if not f.is_file():
                raise ProjectError("not_found", "Layihə tapılmadı", 404)
            p = json.loads(f.read_text(encoding="utf-8-sig"))
            if p.get("version", 1) < VERSION:
                backup = self.dir(pid) / "project.v1.json"
                if not backup.exists():
                    shutil.copyfile(f, backup)
                p = self._migrate_v1(p)
                self._write(p)
            self._cache[pid] = p
            return p

    def save(self, p: dict) -> None:
        with self._lock:
            self._cache[p["id"]] = p
            self._rev[p["id"]] = self._rev.get(p["id"], 0) + 1
            self._write(p)

    def _migrate_v1(self, old: dict) -> dict:
        """Single-video project (media + characters with stored appearances) -> one source.
        Nothing is re-analysed. The old data has no embeddings, so the source is marked needsRescan:
        adding another video first re-scans it and carries names / hidden flags / merges over by time overlap."""
        pid = old["id"]
        sid = new_id("s")
        chars, atoms, assign, shots = [], [], {}, {}
        token = None
        for k, c in enumerate(old.get("characters", [])):
            m = re.match(r"^Personaj (\d+)$", c["name"])
            seq = int(m.group(1)) if m else k + 1
            chars.append({"id": c["id"], "name": c["name"], "seq": seq, "named": not _DEFAULT_NAME.match(c["name"]),
                          "hidden": bool(c.get("hidden"))})
            for a in c["appearances"]:
                i = len(atoms)
                if token is None:
                    m2 = re.match(r"^([0-9a-f]{6})_", a.get("thumb", "") or "")
                    token = m2.group(1) if m2 else None
                shots.setdefault(a["shotIndex"], {"start": a["start"], "end": a["end"], "n": 0,
                                                  "people": a.get("peopleCount", 1)})
                atoms.append({
                    "id": i, "shot": a["shotIndex"], "first": a["start"], "last": a["end"], "samples": [],
                    "q": a.get("q", 0.0), "quality": a.get("q", 0.0), "nUsable": 1, "maxScore": 1.0, "nObs": 1,
                    "relH": None, "face": a.get("faceThumb"), "frame": a.get("thumb"), "person": True,
                    "rel": False, "hasEmb": False, "hasWeak": False,
                    "legacy": {"aid": a["id"], "start": a["start"], "end": a["end"], "coverage": a.get("coverage", 0),
                               "confidence": a.get("confidence", 0), "peopleCount": a.get("peopleCount", 1),
                               "shotSize": a.get("shotSize", "medium"), "visible": a.get("visible", a["end"] - a["start"])},
                })
                assign.setdefault(sid, {})[str(i)] = [c["id"], 0]
        token = token or uuid.uuid4().hex[:6]
        scan = Scan(token=token, preset=old.get("preset", ""), shots=shots, atoms=atoms,
                    emb=np.zeros((len(atoms), scans.EMB_DIM), np.float32),
                    embw=np.zeros((len(atoms), scans.EMB_DIM), np.float32), legacy=True)
        scans.save(self.dir(pid), scan)
        m = old["media"]
        src = {
            "id": sid, "label": Path(m.get("fileName") or m["path"]).stem, "order": 0, "media": m,
            "status": old.get("status", "ready"), "error": old.get("error"), "stats": old.get("stats"),
            "token": token if old.get("characters") or old.get("status") == "ready" else None,
            "poster": old.get("poster"), "needsRescan": True, "addedAt": old.get("createdAt"),
        }
        if src["status"] == "analyzing":
            src["status"], src["error"] = "failed", "Analiz yarımçıq qaldı (proqram bağlanıb). Yenidən skan edin."
        if src["token"] is None:
            scans.delete(self.dir(pid), token)
            src["needsRescan"] = False
        return {
            "version": VERSION, "id": pid, "title": old["title"], "createdAt": old["createdAt"],
            "preset": old["preset"], "error": old.get("error"), "nextChar": max([c["seq"] for c in chars], default=0) + 1,
            "sources": [src], "characters": chars, "assign": assign if src["token"] else {}, "separate": [],
        }

    # ---- scans -----------------------------------------------------------------
    def getscan(self, pid: str, model: dict | None = None):
        """A callable sid -> Scan for the project (or for a working copy / rebuild model of it)."""
        def get(sid: str) -> Scan:
            p = model if model is not None else self._load(pid)
            s = next((x for x in p["sources"] if x["id"] == sid), None)
            if s is None or not s.get("token"):
                raise ProjectError("not_found", "Video tapılmadı", 404)
            return self.scan_for(pid, s["token"])
        return get

    def scan_for(self, pid: str, token: str) -> Scan:
        with self._lock:
            sc = self._scans.get((pid, token))
            if sc is None:
                sc = scans.load(self.dir(pid), token)
                self._scans[(pid, token)] = sc
            return sc

    def put_scan(self, pid: str, scan: Scan) -> None:
        with self._lock:
            self._scans[(pid, scan.token)] = scan

    def forget_scan(self, pid: str, token: str | None) -> None:
        with self._lock:
            self._scans.pop((pid, token), None)

    def purge_token(self, pid: str, token: str | None, aids: list[str] | None = None) -> None:
        """Remove everything a scan left on disk (thumbnails, poster, scan files, cached previews)."""
        if not token:
            return
        self.forget_scan(pid, token)
        d = self.dir(pid)
        for f in (d / "thumbs").glob(f"{token}_*"):
            f.unlink(missing_ok=True)
        (d / "thumbs" / f"poster_{token}.jpg").unlink(missing_ok=True)
        scans.delete(d, token)
        pv = d / "previews"
        if pv.is_dir():
            for f in pv.glob(f"a_{token}_*"):
                f.unlink(missing_ok=True)
            for aid in aids or ():
                (pv / f"{aid}.mp4").unlink(missing_ok=True)

    # ---- queries -----------------------------------------------------------
    def raw(self, pid: str) -> dict:
        return self._load(pid)

    def list(self) -> list[dict]:
        out = []
        paths.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        for d in paths.PROJECTS_DIR.iterdir():
            if (d / "project.json").is_file():
                try:
                    out.append(self.summary(self._load(d.name)))
                except Exception:
                    continue
        out.sort(key=lambda s: s["createdAt"], reverse=True)
        return out

    @staticmethod
    def derived_status(p: dict) -> str:
        srcs = p["sources"]
        if any(s["status"] == "ready" or (s.get("token") and s["status"] in ("queued", "analyzing")) for s in srcs):
            return "ready"
        if any(s["status"] in ("queued", "analyzing") for s in srcs):
            return "analyzing"
        if any(s["status"] == "failed" for s in srcs):
            return "failed"
        if any(s["status"] == "cancelled" for s in srcs):
            return "cancelled"
        return "failed"

    def summary(self, p: dict) -> dict:
        pid = p["id"]
        srcs = sorted(p["sources"], key=lambda s: s["order"])
        poster = next((s["poster"] for s in srcs if s.get("poster") and s.get("token")), None)
        hidden = {c["id"] for c in p["characters"] if c.get("hidden")}
        live = {s["id"] for s in p["sources"] if s.get("token")}
        shown = {v[0] for sid, amap in p["assign"].items() if sid in live for v in amap.values()} - hidden
        return {
            "id": pid, "title": p["title"], "createdAt": p["createdAt"], "status": self.derived_status(p),
            "preset": p["preset"], "content": p.get("content", "live"),
            "duration": round(sum(s["media"]["duration"] for s in srcs), 3),
            "sourceCount": len(srcs), "readySourceCount": sum(1 for s in srcs if s["status"] == "ready"),
            "poster": self._thumb_url(pid, poster),
            "characterCount": len(shown),
            "activeJobId": self._active.get(pid),
        }

    def _thumb_url(self, pid: str, name: str | None) -> str | None:
        return f"/api/projects/{pid}/thumbs/{name}" if name else None

    def source_json(self, p: dict, s: dict) -> dict:
        pid = p["id"]
        prog = self.progress.get((pid, s["id"]))
        out = {
            "id": s["id"], "label": s["label"], "order": s["order"], "media": s["media"],
            "status": s["status"], "sourceMissing": not media.path_exists(s["media"]["path"]),
            "error": s.get("error"), "stats": s.get("stats"),
            "poster": self._thumb_url(pid, s.get("poster")) if s.get("token") else None,
            # additions to section 7.3 (optional for the client):
            "needsRescan": bool(s.get("needsRescan")),
            "notice": LEGACY_NOTICE if s.get("needsRescan") else None,
            "progress": round(prog, 4) if (prog is not None and s["status"] == "analyzing") else None,
        }
        return out

    def full(self, pid: str) -> dict:
        p = self._load(pid)
        with self._lock:
            out = self.summary(p)
            out["sources"] = [self.source_json(p, s) for s in sorted(p["sources"], key=lambda s: s["order"])]
            if out["status"] == "failed" or p.get("error"):
                err = p.get("error") or next((s.get("error") for s in p["sources"] if s.get("error")), None)
                if err:
                    out["error"] = err
            chars = []
            for c in self._derive(p):
                apps = []
                for a in c["appearances"]:
                    ap = {k: v for k, v in a.items() if k not in _INTERNAL_APP}
                    ap["thumb"] = self._thumb_url(pid, a["thumb"])
                    ap["previewOffset"] = round(a["start"] - max(0.0, a["start"] - PREVIEW_HANDLE_S), 3)
                    apps.append(ap)
                ch = {k: v for k, v in c.items() if k not in _INTERNAL_CHAR}
                ch["thumb"] = self._thumb_url(pid, c["thumb"])
                ch["appearances"] = apps
                chars.append(ch)
            out["characters"] = chars
            return out

    # ---- derivation of characters and appearances ------------------------------
    def _derive(self, p: dict) -> list[dict]:
        with self._lock:
            hit = self._views.get(p["id"])
            if hit and hit[0] == self._rev.get(p["id"], 0):
                return hit[1]
            return self._derive_locked(p)

    def _derive_locked(self, p: dict) -> list[dict]:
        pid = p["id"]
        order = {s["id"]: s["order"] for s in p["sources"]}
        by_char: dict[str, dict] = {}
        cdefs = {c["id"]: c for c in p["characters"]}
        # gather
        groups: dict[tuple[str, str, int], list[tuple[dict, Scan, int]]] = {}
        for sid, amap in p["assign"].items():
            s = next((x for x in p["sources"] if x["id"] == sid), None)
            if s is None or not s.get("token"):
                continue
            sc = self.scan_for(pid, s["token"])
            for aid, (cid, _pin) in amap.items():
                if cid not in cdefs:
                    continue
                i = sc.idx(int(aid))
                groups.setdefault((cid, sid, sc.atoms[i]["shot"]), []).append((sc.atoms[i], sc, i))
        # centroids for confidence
        cent: dict[str, np.ndarray] = {}
        acc: dict[str, np.ndarray] = {}
        for (cid, sid, shot), lst in groups.items():
            for a, sc, i in lst:
                if a.get("rel") and a.get("hasEmb"):
                    v = sc.emb[i] * identity.atom_weight(a)
                    acc[cid] = acc[cid] + v if cid in acc else v
        for cid, v in acc.items():
            n = float(np.linalg.norm(v))
            if n > 0:
                cent[cid] = v / n
        for (cid, sid, shot), lst in groups.items():
            sc = lst[0][1]
            sh = sc.shots.get(shot, {})
            atoms = [x[0] for x in lst]
            lg = [a["legacy"] for a in atoms if a.get("legacy")]
            best = max((a for a in atoms if a.get("frame")), key=lambda a: a["q"], default=atoms[0])
            if lg:
                start, end = lg[0]["start"], lg[0]["end"]
                people = max(l["peopleCount"] for l in lg)
                size = lg[0]["shotSize"]
                cov = min(1.0, sum(l["coverage"] for l in lg))
                conf = float(np.mean([l["confidence"] for l in lg]))
                visible = max(l["visible"] for l in lg)
            else:
                start, end = sh["start"], sh["end"]
                people = max(1, int(sh.get("people", 1)))
                size = shot_size([a["relH"] for a in atoms if a.get("relH") is not None])
                n = max(1, sh.get("n", 1))
                seen = set().union(*[set(a["samples"]) for a in atoms])
                cov = min(1.0, len(seen) / n)
                sims = [float(sc.emb[i] @ cent[cid]) for a, _sc, i in lst if a.get("hasEmb") and cid in cent]
                conf = float(np.clip(np.mean(sims), 0.0, 1.0)) if sims else 0.3
                interval = (end - start) / n
                visible = min(end - start, (max(a["last"] for a in atoms) - min(a["first"] for a in atoms)) + interval)
            first_legacy = next((l["aid"] for l in lg), None)
            aid = first_legacy or f"a_{sc.token}_{min(a['id'] for a in atoms)}"
            ap = {
                "id": aid, "shotIndex": shot, "start": round(start, 3), "end": round(end, 3),
                "thumb": best.get("frame"), "shotSize": size, "solo": people <= 1, "peopleCount": people,
                "coverage": round(cov, 3), "confidence": round(conf, 3), "sourceId": sid,
                "faceThumb": best.get("face"), "q": best["q"], "visible": round(visible, 2),
                "atoms": sorted(a["id"] for a in atoms),
            }
            by_char.setdefault(cid, {"c": cdefs[cid], "apps": []})["apps"].append(ap)
        out = []
        for cid, d in by_char.items():
            c, apps = d["c"], d["apps"]
            apps.sort(key=lambda a: (order.get(a["sourceId"], 0), a["start"]))
            st = round(sum(a["visible"] for a in apps), 2)
            top = max(apps, key=lambda a: a["q"])
            out.append({
                "id": cid, "name": c["name"], "thumb": top["faceThumb"], "thumbQ": top["q"],
                "hidden": bool(c.get("hidden")), "isMinor": is_minor(st, len(apps), p.get("content", "live")), "screenTime": st,
                "appearanceCount": len(apps), "sourceCount": len({a["sourceId"] for a in apps}), "appearances": apps,
            })
        out.sort(key=lambda c: -c["screenTime"])
        self._views[pid] = (self._rev.get(pid, 0), out)
        return out

    def find_appearance(self, pid: str, aid: str) -> tuple[dict, dict, dict, dict]:
        """(project, source, character view, appearance view) for an appearance id."""
        p = self._load(pid)
        for c in self._derive(p):
            for a in c["appearances"]:
                if a["id"] == aid:
                    s = next(s for s in p["sources"] if s["id"] == a["sourceId"])
                    return p, s, c, a
        raise ProjectError("not_found", "Səhnə tapılmadı", 404)

    # ---- lifecycle -----------------------------------------------------------
    def create(self, title: str, preset: str, content: str = "live") -> dict:
        pid = new_id("p")
        p = {"version": VERSION, "id": pid, "title": title, "createdAt": now_iso(), "preset": preset,
             "content": content, "error": None,
             "nextChar": 1, "sources": [], "characters": [], "assign": {}, "separate": []}
        self.dir(pid).mkdir(parents=True, exist_ok=True)
        self.save(p)
        return p

    def add_sources(self, pid: str, infos: list[dict]) -> tuple[list[dict], list[str]]:
        """Adds queued sources. Returns (new source dicts, paths skipped as duplicates)."""
        with self._lock:
            p = self._load(pid)
            have = {norm_path(s["media"]["path"]) for s in p["sources"]}
            fresh, skipped = [], []
            for m in infos:
                k = norm_path(m["path"])
                if k in have:
                    skipped.append(m["path"])
                    continue
                have.add(k)
                fresh.append(m)
            fresh.sort(key=lambda m: natural_key(Path(m["path"]).stem))
            base = max((s["order"] for s in p["sources"]), default=-1) + 1
            out = []
            for k, m in enumerate(fresh):
                s = {"id": new_id("s"), "label": Path(m["path"]).stem, "order": base + k, "media": m,
                     "status": "queued", "error": None, "stats": None, "token": None, "poster": None,
                     "needsRescan": False, "addedAt": now_iso()}
                p["sources"].append(s)
                out.append(s)
            if out:
                self.save(p)
            return out, skipped

    def source(self, p: dict, sid: str) -> dict:
        for s in p["sources"]:
            if s["id"] == sid:
                return s
        raise ProjectError("not_found", "Video tapılmadı", 404)

    def patch_source(self, pid: str, sid: str, label: str) -> None:
        label = (label or "").strip()
        if not label:
            raise ProjectError("bad_request", "Ad boş ola bilməz")
        with self._lock:
            p = self._load(pid)
            self.source(p, sid)["label"] = label
            self.save(p)

    def remove_source(self, pid: str, sid: str) -> None:
        """Drops the source with its appearances and evidence. Characters left empty disappear;
        everything else the user did stays."""
        with self._lock:
            p = self._load(pid)
            s = self.source(p, sid)
            if s["status"] == "analyzing":
                raise ProjectError("busy", "Bu video indi analiz olunur. Əvvəlcə analizi dayandırın.", 409)
            if len(p["sources"]) <= 1:
                raise ProjectError("last_source", "Layihədəki yeganə video silinə bilməz. Layihəni silin.", 409)
            aids = [a["id"] for c in self._derive(p) for a in c["appearances"] if a["sourceId"] == sid]
            token = s.get("token")
            p["sources"] = [x for x in p["sources"] if x["id"] != sid]
            p["assign"].pop(sid, None)
            identity.prune_empty(p)
            self.save(p)
            self.purge_token(pid, token, aids)
            self.progress.pop((pid, sid), None)

    def set_active_job(self, pid: str, job_id: str | None) -> None:
        with self._lock:
            if job_id:
                self._active[pid] = job_id
            else:
                self._active.pop(pid, None)

    def clear_active_job(self, pid: str, job_id: str) -> None:
        with self._lock:
            if self._active.get(pid) == job_id:
                self._active.pop(pid, None)

    def active_job(self, pid: str) -> str | None:
        return self._active.get(pid)

    def delete(self, pid: str) -> None:
        with self._lock:
            self._load(pid)
            self._cache.pop(pid, None)
            self._active.pop(pid, None)
            self._views.pop(pid, None)
            for k in [k for k in self._scans if k[0] == pid]:
                self._scans.pop(k, None)
        shutil.rmtree(self.dir(pid), ignore_errors=True)

    def rename(self, pid: str, title: str) -> None:
        title = title.strip()
        if not title:
            raise ProjectError("bad_request", "Ad boş ola bilməz")
        with self._lock:
            p = self._load(pid)
            p["title"] = title
            self.save(p)

    # ---- character editing ---------------------------------------------------
    @staticmethod
    def _char(p: dict, cid: str) -> dict:
        c = identity.char_by_id(p, cid)
        if c is None:
            raise ProjectError("not_found", "Personaj tapılmadı", 404)
        return c

    def patch_character(self, pid: str, cid: str, name: str | None, hidden: bool | None) -> None:
        with self._lock:
            p = self._load(pid)
            c = self._char(p, cid)
            if name is not None:
                if not name.strip():
                    raise ProjectError("bad_request", "Ad boş ola bilməz")
                c["name"] = name.strip()
                c["named"] = True
            if hidden is not None:
                c["hidden"] = bool(hidden)
            self.save(p)

    def merge(self, pid: str, source_ids: list[str], target_id: str) -> None:
        with self._lock:
            p = self._load(pid)
            self._char(p, target_id)
            drop = {s for s in source_ids if s != target_id}
            for s in drop:
                self._char(p, s)
            for amap in p["assign"].values():
                for v in amap.values():
                    if v[0] in drop:
                        v[0] = target_id
            p["characters"] = [c for c in p["characters"] if c["id"] not in drop]
            sep = []
            for a, b in p.get("separate", []):
                a = target_id if a in drop else a
                b = target_id if b in drop else b
                if a != b:
                    sep.append([a, b])
            p["separate"] = sep
            self.save(p)

    def move_appearances(self, pid: str, app_ids: list[str], target: str) -> None:
        with self._lock:
            p = self._load(pid)
            wanted = set(app_ids)
            moving = [(c["id"], a) for c in self._derive(p) for a in c["appearances"] if a["id"] in wanted]
            if not moving:
                raise ProjectError("not_found", "Səhnə tapılmadı", 404)
            if target == "new":
                dest = identity.new_character(p)["id"]
            else:
                dest = self._char(p, target)["id"]
            origins = set()
            for origin, a in moving:
                if origin == dest:
                    continue
                origins.add(origin)
                amap = p["assign"][a["sourceId"]]
                for atom_id in a["atoms"]:
                    amap[str(atom_id)] = [dest, 1]
            for o in origins:        # the user said these two are not the same: never auto-merge them back
                if not identity.separated(p, o, dest):
                    p.setdefault("separate", []).append([o, dest])
            identity.prune_empty(p)
            self.save(p)


_INTERNAL_APP = ("faceThumb", "q", "visible", "atoms")
_INTERNAL_CHAR = ("thumbQ",)

STORE = ProjectStore()
