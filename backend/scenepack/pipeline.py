"""Analysis pipeline. One source at a time: probe -> shots -> faces -> tracklets -> within-video clustering;
then identity.py decides which project characters those clusters are. A per-project runner works through
the queue of sources."""
from __future__ import annotations

import copy
import itertools
import queue
import shutil
import threading
import time
import uuid
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from . import cluster, faces, identity, imaging, media, model_download, projects, registry, scans, shots
from .jobs import JOBS, Job, JobCancelled
from .projects import STORE
from .tracking import Obs, ShotTracker, Tracklet

WORK_LONG_SIDE = 1920     # decode size for crops; the detector resizes further down
FRAME_BATCH = 8           # frames per recognizer batch
FRAME_THUMB_W = 480


# ------------------------------------------------------------------ stage plumbing

class Stages:
    """Maps per-stage fractions to overall job progress. `outer` maps this source's 0..1 to the batch's."""

    def __init__(self, job: Job, weights: dict[str, float], outer=None, on_source=None, extra_eta=None):
        self.job = job
        total = sum(weights.values())
        self.span: dict[str, tuple[float, float]] = {}
        acc = 0.0
        for k, w in weights.items():
            self.span[k] = (acc / total, (acc + w) / total)
            acc += w
        self.t0 = time.time()
        self.outer = outer or (lambda f: f)
        self.on_source = on_source or (lambda f: None)
        self.extra_eta = extra_eta or (lambda: 0.0)

    def begin(self, stage: str, message: str | None = None) -> None:
        self.job.check_cancel()
        f = self.span[stage][0]
        self.on_source(f)
        self.job.update(stage=stage, progress=self.outer(f), message=message)

    def at(self, stage: str, frac: float, message: str | None = None, **kw) -> None:
        a, b = self.span[stage]
        f = a + (b - a) * max(0.0, min(1.0, frac))
        self.on_source(f)
        if kw.get("etaSeconds") is not None:
            kw["etaSeconds"] = kw["etaSeconds"] + self.extra_eta()
        self.job.update(progress=self.outer(f), message=message, **kw)


# ------------------------------------------------------------------ face pass

def _sample_schedule(shot_list: list[shots.Shot], fps: float) -> tuple[list[float], list[int]]:
    times, owner = [], []
    for s in shot_list:
        n = max(1, int(round(s.duration * fps)))
        for i in range(n):
            times.append(s.start + (i + 0.5) * s.duration / n)
            owner.append(s.index)
    return times, owner


class _FacePass:
    def __init__(self, pid: str, path: str, info: dict, spec: registry.PresetSpec, shot_list: list[shots.Shot],
                 engine, job: Job, stages: Stages, token: str):
        self.pid, self.path, self.info, self.spec = pid, path, info, spec
        self.shots = shot_list
        self.engine = engine
        self.job, self.stages, self.token = job, stages, token
        self.thumbs = STORE.thumbs_dir(pid)
        self.live_dir = self.thumbs / "live"
        self.live_dir.mkdir(exist_ok=True)
        self.ids = itertools.count(1)
        self.tracker: ShotTracker | None = None
        self.tracklets: list[Tracklet] = []
        self.shot_samples: dict[int, int] = {}
        self.pending: dict[int, tuple[float, np.ndarray, np.ndarray]] = {}
        self.face_count = 0
        self.live_n = 0
        self.last_live = 0.0
        self.times, self.owner = _sample_schedule(shot_list, spec.sampleFps)
        self.pool = ThreadPoolExecutor(max_workers=2) if engine.provider == "cuda" else None

    # -- decoding thread --
    def _produce(self, q: queue.Queue, stop: threading.Event) -> None:
        try:
            j, n = 0, len(self.times)
            half = 0.5 / max(self.info["fps"], 1.0)
            for t, frame in media.iter_frames(self.path):
                if stop.is_set() or j >= n:
                    break
                if t + half < self.times[j]:
                    continue
                rgb, scale = media.to_rgb(frame, WORK_LONG_SIDE)
                q.put((j, t, rgb, scale, frame.height))
                j += 1
                while j < n and self.times[j] <= t + half:
                    j += 1
            q.put(None)
        except BaseException as e:  # surfaced in the consumer
            q.put(e)

    # -- per-frame detection --
    def _detect(self, item):
        j, t, rgb, scale, src_h = item
        out = []
        for d in self.engine.detect(rgb):
            h_src = (d.box[3] - d.box[1]) / scale
            if self.engine.keep(d, h_src):
                out.append((d, h_src))
        out.sort(key=lambda x: -x[0].score * x[1])
        return out[:self.engine.max_faces]

    def run(self) -> None:
        q: queue.Queue = queue.Queue(maxsize=FRAME_BATCH * 3)
        stop = threading.Event()
        prod = threading.Thread(target=self._produce, args=(q, stop), daemon=True)
        prod.start()
        batch: list = []
        done = 0
        t0 = time.time()
        total = len(self.times)
        try:
            while True:
                item = q.get()
                if isinstance(item, BaseException):
                    raise item
                if item is not None:
                    batch.append(item)
                if batch and (len(batch) >= FRAME_BATCH or item is None):
                    self._process(batch)
                    done += len(batch)
                    batch = []
                    frac = done / total
                    el = time.time() - t0
                    vid_t = self.times[min(done, total) - 1]
                    self.stages.at(
                        "faces", frac, f"{done} / {total}",
                        speedFps=(vid_t * self.info["fps"]) / el if el > 0 else None,
                        etaSeconds=el * (1 - frac) / frac * 1.08 + 3 if frac > 0.01 else None,
                        counts={"shots": len(self.shots), "faces": self.face_count, "characters": 0},
                    )
                    self.job.check_cancel()
                if item is None:
                    break
        finally:
            stop.set()
            try:
                while True:
                    q.get_nowait()
            except queue.Empty:
                pass
            if self.pool:
                self.pool.shutdown(wait=False)
        self._close_shot()

    # -- batch processing --
    def _process(self, batch: list) -> None:
        if self.pool:
            dets = list(self.pool.map(self._detect, batch))
        else:
            dets = [self._detect(it) for it in batch]
        crops, meta = [], []
        per_frame: list[list[dict]] = []
        for it, ds in zip(batch, dets):
            _, _, rgb, scale, src_h = it
            frame_faces = []
            for d, h_src in ds:
                crop, q, usable, embeddable = self.engine.prepare(rgb, d, h_src)
                rec = {"det": d, "h": h_src, "q": q, "usable": usable, "weak": embeddable and not usable, "emb": None}
                if usable or embeddable:
                    crops.append(crop)
                    meta.append(rec)
                frame_faces.append(rec)
            per_frame.append(frame_faces)
        if crops:
            embs = self.engine.embed(crops)
            for rec, e in zip(meta, embs):
                rec["emb"] = e
        for it, frame_faces in zip(batch, per_frame):
            self._track(it, frame_faces)

    def _track(self, it, frame_faces: list[dict]) -> None:
        j, t, rgb, scale, src_h = it
        shot_idx = self.owner[j]
        if self.tracker is None or self.tracker.shot_index != shot_idx:
            self._close_shot()
            self.tracker = ShotTracker(shot_idx, self.spec.thresholds, lambda: next(self.ids))
        inv = 1.0 / scale
        obs = [Obs(sample=0, t=t, box=r["det"].box * inv, score=r["det"].score, q=r["q"], usable=r["usable"],
                   emb=r["emb"], weak_ok=r["weak"], frame_h=float(src_h)) for r in frame_faces]
        self.face_count += len(obs)
        pairs = self.tracker.update(t, obs)
        frame_thumb = None
        rec_of = {id(o): r for o, r in zip(obs, frame_faces)}
        for o, tr in pairs:
            rec = rec_of[id(o)]
            if o.q > tr.best_q + 0.02:
                tr.best_q = o.q
                if frame_thumb is None:
                    frame_thumb = imaging.resize_width(rgb, FRAME_THUMB_W)
                self.pending[tr.id] = (o.q, imaging.square_crop(rgb, rec["det"].box), frame_thumb)
            if o.usable and o.q >= 0.35 and time.time() - self.last_live > 0.3:
                self._live(rgb, rec["det"].box)

    def _live(self, rgb, box) -> None:
        self.last_live = time.time()
        self.live_n += 1
        name = f"L{self.token}{self.live_n}.jpg"
        imaging.write_jpeg(self.live_dir / name, imaging.square_crop(rgb, box, out=128), 80)
        self.job.recentFaces.append(f"/api/projects/{self.pid}/thumbs/live/{name}")
        del self.job.recentFaces[:-12]
        old = self.live_dir / f"L{self.token}{self.live_n - 24}.jpg"
        old.unlink(missing_ok=True)

    def _close_shot(self) -> None:
        if self.tracker is None:
            return
        trs = self.tracker.finish()
        self.shot_samples[self.tracker.shot_index] = self.tracker.sample_count
        for tr in trs:
            ent = self.pending.pop(tr.id, None)
            if ent:
                _, crop, fthumb = ent
                tr.face_file = f"{self.token}_f{tr.id}.jpg"
                tr.frame_file = f"{self.token}_s{tr.id}.jpg"
                imaging.write_jpeg(self.thumbs / tr.face_file, crop)
                imaging.write_jpeg(self.thumbs / tr.frame_file, fthumb, 82)
        self.tracklets.extend(trs)
        self.tracker = None


# ------------------------------------------------------------------ scan building

def _rel_height(t: Tracklet) -> float:
    hs = [o.box[3] - o.box[1] for o in t.obs if o.usable] or [o.box[3] - o.box[1] for o in t.obs]
    return float(np.median(hs)) / t.obs[0].frame_h


def _counts_as_person(t: Tracklet) -> bool:
    return len(t.obs) >= 2 or t.n_usable >= 1 or max(o.score for o in t.obs) >= 0.65


@dataclass
class Analysis:
    scan: scans.Scan
    labels: np.ndarray          # within-video cluster label per scan atom
    faces: int
    shots: int
    seconds: float
    poster: str | None
    info: dict


def build_scan(token: str, preset: str, tracklets: list[Tracklet], labels: list[int],
               shot_list: list[shots.Shot], shot_samples: dict[int, int], dim: int) -> tuple[scans.Scan, np.ndarray]:
    """Everything identity needs from one analysis, without any video: only tracklets that belong to
    a within-video cluster are kept; `people` counts every person-like tracklet of the shot."""
    by_shot: dict[int, list[Tracklet]] = {}
    for t in tracklets:
        by_shot.setdefault(t.shot_index, []).append(t)
    people = {si: max(1, sum(1 for t in ts if _counts_as_person(t))) for si, ts in by_shot.items()}
    keep = [i for i, t in enumerate(tracklets) if labels[i] >= 0 and t.frame_file]
    atoms, rows, roww, lab = [], [], [], []
    shot_meta: dict[int, dict] = {}
    for i in keep:
        t = tracklets[i]
        si = t.shot_index
        sh = shot_list[si]
        shot_meta.setdefault(si, {"start": round(sh.start, 3), "end": round(sh.end, 3),
                                  "n": int(max(1, shot_samples.get(si, 1))), "people": people.get(si, 1)})
        atoms.append({
            "id": int(t.id), "shot": si, "first": round(t.first_t, 3), "last": round(t.last_t, 3),
            "samples": sorted(int(x) for x in t.samples), "q": round(float(t.best_q), 3),
            "quality": round(float(t.quality), 3), "nUsable": int(t.n_usable), "maxScore": round(float(t.max_score), 3),
            "nObs": len(t.obs), "relH": round(_rel_height(t), 4), "face": t.face_file, "frame": t.frame_file,
            "person": _counts_as_person(t), "rel": bool(cluster.is_reliable(t)),
            "hasEmb": t.emb is not None, "hasWeak": t.emb_weak is not None,
        })
        rows.append(t.emb if t.emb is not None else np.zeros(dim, np.float32))
        roww.append(t.emb_weak if t.emb_weak is not None else np.zeros(dim, np.float32))
        lab.append(labels[i])
    emb = np.stack(rows).astype(np.float32) if rows else np.zeros((0, dim), np.float32)
    embw = np.stack(roww).astype(np.float32) if roww else np.zeros((0, dim), np.float32)
    return scans.Scan(token, preset, shot_meta, atoms, emb, embw), np.array(lab, int)


def analyse_source(pid: str, path: str, spec: registry.PresetSpec, job: Job, st: Stages, token: str) -> Analysis:
    """Stages 1-5 of one video (ARCHITECTURE.md 3.2). Writes thumbnails named by `token`; the caller
    removes them if anything later fails."""
    started = time.time()
    thumbs = STORE.thumbs_dir(pid)

    st.begin("probe")
    info = media.probe(path)
    st.at("probe", 1.0)

    st.begin("shots", "kadrlar axtarılır")
    shot_list = shots.detect(path, info["duration"], job.cancel_event,
                             lambda f, n: st.at("shots", f, f"{n} kadr oxundu"),
                             use_transnet=spec.shotModel == "transnetv2")
    job.check_cancel()
    job.update(counts={"shots": len(shot_list), "faces": 0, "characters": 0})

    st.begin("faces", "üzlər axtarılır")
    engine = faces.make_engine(spec)
    fp = _FacePass(pid, path, info, spec, shot_list, engine, job, st, token)
    try:
        fp.run()
    finally:
        for f in fp.live_dir.glob(f"L{token}*"):
            f.unlink(missing_ok=True)
    job.check_cancel()

    st.begin("cluster", "personajlar qruplaşdırılır")
    labels = cluster.cluster_tracklets(fp.tracklets, spec.thresholds, refine=True)
    scan, lab = build_scan(token, spec.id, fp.tracklets, labels, shot_list, fp.shot_samples, engine.dim)
    job.update(counts={"shots": len(shot_list), "faces": fp.face_count,
                       "characters": len(set(lab.tolist())) if len(lab) else 0})
    st.at("cluster", 1.0)
    job.check_cancel()

    st.begin("finalize", "yekunlaşdırılır")
    poster = None
    framed = [a for a in scan.atoms if a.get("frame")]
    if framed:
        best = max(framed, key=lambda a: a["q"])
        poster = f"poster_{token}.jpg"
        shutil.copyfile(thumbs / best["frame"], thumbs / poster)
    else:
        frame = media.read_frame_at(path, info["duration"] * 0.1, 640)
        if frame is not None:
            poster = f"poster_{token}.jpg"
            imaging.write_jpeg(thumbs / poster, frame)
    # thumbnails of tracklets that never became part of a cluster are useless
    keep = {a["frame"] for a in scan.atoms} | {a["face"] for a in scan.atoms}
    for f in thumbs.glob(f"{token}_*"):
        if f.name not in keep:
            f.unlink(missing_ok=True)
    return Analysis(scan, lab, fp.face_count, len(shot_list), time.time() - started, poster, info)


# ------------------------------------------------------------------ committing a source to the project

def _prune_thumbs(pid: str, p: dict, only: str | None = None) -> None:
    """Keep, per (character, shot) appearance, the best face and frame only; forget the other files.
    The best of a merged group is always the best of one of its parts, so merges and moves stay valid."""
    view = STORE._derive(p)
    keep: dict[str, set[str]] = {}
    for c in view:
        for a in c["appearances"]:
            ks = keep.setdefault(a["sourceId"], set())
            ks.update(x for x in (a["thumb"], a["faceThumb"]) if x)
    for s in p["sources"]:
        if not s.get("token") or (only and s["id"] != only):
            continue
        sc = STORE.scan_for(pid, s["token"])
        if sc.legacy:
            continue
        ks = keep.get(s["id"], set())
        dirty = False
        for a in sc.atoms:
            for k in ("frame", "face"):
                if a.get(k) and a[k] not in ks:
                    (STORE.thumbs_dir(pid) / a[k]).unlink(missing_ok=True)
                    a[k] = None
                    dirty = True
        if dirty:
            scans.save(STORE.dir(pid), sc)


def commit_source(pid: str, sid: str, an: Analysis, rebuild: dict | None = None) -> dict:
    """Atomic: identity for the source is decided on a copy of the project and swapped in on success."""
    with STORE._lock:
        p = STORE.raw(pid)
        target = rebuild["model"] if rebuild else copy.deepcopy(p)
        s = STORE.source(target, sid)
        spec = registry.spec(target["preset"], target.get("content"))
        old, old_token, old_aids = None, None, []
        if not rebuild and s.get("token"):
            old_token = s["token"]
            old_scan = STORE.scan_for(pid, old_token)
            old = identity.old_atoms(target, sid, old_scan)
            old_aids = [a["legacy"]["aid"] for a in old_scan.atoms if a.get("legacy")]
        scans.save(STORE.dir(pid), an.scan)
        STORE.put_scan(pid, an.scan)
        get = STORE.getscan(pid, target)
        try:
            report = identity.add_source(target, get, sid, an.scan, an.labels, spec, old)
            s["token"] = an.scan.token
            merged = identity.refine(target, get, spec)
            report["merged"] = len(merged)
            s.update({"status": "ready", "error": None, "poster": an.poster, "media": an.info,
                      "needsRescan": False,
                      "stats": {"shotCount": an.shots, "faceCount": an.faces, "analysisSeconds": round(an.seconds, 1)}})
            if rebuild:
                return report
            target["error"] = None
            p.clear()
            p.update(target)
            STORE.save(p)
        except BaseException:
            STORE.purge_token(pid, an.scan.token)
            raise
        _prune_thumbs(pid, p, only=sid)
        STORE.purge_token(pid, old_token, old_aids)
        return report


def finish_rebuild(pid: str, rb: dict) -> None:
    """Swap the freshly built model (another preset) in; names and hidden flags carry over by time overlap."""
    with STORE._lock:
        p = STORE.raw(pid)
        model = rb["model"]
        old_tokens = {s["id"]: s.get("token") for s in p["sources"]}
        old_aids = []
        for tok in old_tokens.values():
            if tok:
                sc = STORE.scan_for(pid, tok)
                old_aids += [a["legacy"]["aid"] for a in sc.atoms if a.get("legacy")]
        new_get = STORE.getscan(pid, model)
        old_get = STORE.getscan(pid, p)
        rb["carried"] = identity.carry_over(model, new_get, p, old_get)
        identity.prune_empty(model)
        identity.refine(model, new_get, registry.spec(model["preset"], model.get("content")))
        for ms in model["sources"]:
            tgt = STORE.source(p, ms["id"])
            tgt.update({k: ms[k] for k in ("token", "status", "error", "poster", "media", "stats", "needsRescan")})
        for k in ("preset", "characters", "assign", "separate", "nextChar"):
            p[k] = model[k]
        p["error"] = None
        STORE.save(p)
        for tok in old_tokens.values():
            STORE.purge_token(pid, tok, old_aids)
        _prune_thumbs(pid, p)


# ------------------------------------------------------------------ the per-project queue

@dataclass
class Task:
    sid: str
    kind: str          # new | rescan | rebuild
    dur: float


_RUNLOCK = threading.RLock()
RUNNERS: dict[str, "Runner"] = {}


class Runner:
    """Works through a project's sources one after another inside a single analysis job.
    Sources queued while it runs join the same job; the job's progress is weighted by video duration."""

    def __init__(self, pid: str, tasks: list[Task], rebuild_preset: str | None = None):
        self.pid = pid
        self.lock = threading.Lock()
        self.queue: list[Task] = list(tasks)
        self.closed = False
        self.job: Job | None = None
        self.total_dur = sum(t.dur for t in tasks)
        self.done_dur = 0.0
        self.count = len(tasks)
        self.index = 0
        self.current: Task | None = None
        self.rebuild: dict | None = None
        self.rate: float | None = None        # wall seconds per media second, measured on finished sources
        self.ok = 0
        self.fail_msgs: list[str] = []
        if rebuild_preset:
            p = STORE.raw(pid)
            self.rebuild = {"preset": rebuild_preset, "model": {
                "id": pid, "preset": rebuild_preset, "content": p.get("content", "live"),
                "nextChar": p.get("nextChar", 1), "characters": [],
                "assign": {}, "separate": [],
                "sources": [{"id": s["id"], "order": s["order"], "label": s["label"], "token": None,
                             "media": s["media"], "status": "queued", "error": None, "stats": None, "poster": None,
                             "needsRescan": False} for s in p["sources"]]}}

    # -- queue --
    def add(self, tasks: list[Task], front: bool = False) -> bool:
        with self.lock:
            if self.closed:
                return False
            known = {t.sid for t in self.queue} | ({self.current.sid} if self.current else set())
            tasks = [t for t in tasks if t.sid not in known]
            if front:
                self.queue[0:0] = tasks
            else:
                self.queue.extend(tasks)
            self.total_dur += sum(t.dur for t in tasks)
            self.count += len(tasks)
            if self.job:
                self.job.update(sourceCount=self.count)
            return True

    def busy_sids(self) -> set[str]:
        with self.lock:
            return {t.sid for t in self.queue} | ({self.current.sid} if self.current else set())

    def remove_queued(self, sid: str) -> bool:
        with self.lock:
            for t in self.queue:
                if t.sid == sid:
                    self.queue.remove(t)
                    self.total_dur -= t.dur
                    self.count -= 1
                    if self.job:
                        self.job.update(sourceCount=self.count)
                    return True
        return False

    def _overall(self, f: float) -> float:
        cur = self.current.dur if self.current else 0.0
        tot = max(self.total_dur, 1e-6)
        return min(1.0, (self.done_dur + f * cur) / tot)

    def _extra_eta(self) -> float:
        rate = self.rate
        if rate is None:
            return 0.0
        with self.lock:
            return rate * sum(t.dur for t in self.queue)

    # -- job body --
    def run(self, job: Job) -> dict:
        pid = self.pid
        spec_id = self.rebuild["preset"] if self.rebuild else STORE.raw(pid)["preset"]
        self.spec = registry.spec(spec_id, STORE.raw(pid).get("content"))
        try:
            self._ensure_models(job)
            while True:
                job.check_cancel()
                with self.lock:
                    if not self.queue:
                        self.closed = True
                        break
                    self.current = self.queue.pop(0)
                    self.index += 1
                    t = self.current
                job.update(sourceId=t.sid, sourceIndex=self.index, sourceCount=self.count, recentFaces=[])
                self._process(job, t)
                with self.lock:
                    self.done_dur += t.dur
                    self.current = None
            if self.rebuild:
                finish_rebuild(pid, self.rebuild)
        except JobCancelled:
            self._abort("cancelled")
            raise
        except BaseException as e:
            self._abort("failed", str(e))
            raise
        if self.ok == 0 and self.fail_msgs:
            raise RuntimeError(self.fail_msgs[0])
        res = {"projectId": pid, "ready": self.ok, "failed": len(self.fail_msgs)}
        if self.rebuild:
            res["carriedCharacters"] = self.rebuild.get("carried", 0)
        return res

    def _ensure_models(self, job: Job) -> None:
        if registry.missing_download_mb(self.spec) > 0:
            job.update(stage="download", message="modellər yüklənir")
            model_download.ensure_preset(self.spec.id, lambda f, m: job.update(progress=f * 0.05, message=m),
                                         job.cancel_event, content=self.spec.content)
            job.check_cancel()

    def _process(self, job: Job, t: Task) -> None:
        pid = self.pid
        p = STORE.raw(pid)
        s = STORE.source(p, t.sid)
        token = uuid.uuid4().hex[:6]
        with STORE._lock:
            s["status"], s["error"] = "analyzing", None
            STORE.save(p)
        STORE.progress[(pid, t.sid)] = 0.0
        started = time.time()
        st = Stages(job, {"probe": 0.01, "shots": 0.10, "faces": 0.70, "cluster": 0.07, "finalize": 0.03},
                    outer=self._overall, extra_eta=self._extra_eta,
                    on_source=lambda f: STORE.progress.__setitem__((pid, t.sid), f))
        try:
            an = analyse_source(pid, s["media"]["path"], self.spec, job, st, token)
            job.check_cancel()
            report = commit_source(pid, t.sid, an, self.rebuild)
            wall = time.time() - started
            r = wall / max(t.dur, 1.0)
            self.rate = r if self.rate is None else 0.5 * (self.rate + r)
            self.ok += 1
            chars = self.rebuild["model"]["characters"] if self.rebuild else STORE.raw(pid)["characters"]
            job.update(counts={"shots": an.shots, "faces": an.faces, "characters": len(chars)})
            print(f"[analysis] {s['label']}: {report} ({wall:.0f}s)", flush=True)
        except JobCancelled:
            self._cleanup_partial(pid, token)
            raise
        except BaseException as e:
            self._cleanup_partial(pid, token)
            if isinstance(e, (KeyboardInterrupt, SystemExit)):
                raise
            import traceback
            traceback.print_exc()
            msg = (str(e).strip() or e.__class__.__name__)[:600]
            if self.rebuild:
                raise RuntimeError(f"{s['label']}: {msg}") from e     # the old analysis stays; nothing half-rebuilt
            with STORE._lock:
                q = STORE.raw(pid)
                s2 = STORE.source(q, t.sid)
                s2["status"] = "ready" if s2.get("token") and scans.exists(STORE.dir(pid), s2["token"]) else "failed"
                s2["error"] = msg
                STORE.save(q)
            self.fail_msgs.append(msg)
        finally:
            STORE.progress.pop((pid, t.sid), None)

    @staticmethod
    def _cleanup_partial(pid: str, token: str) -> None:
        thumbs = STORE.thumbs_dir(pid)
        for f in thumbs.glob(f"{token}_*"):
            f.unlink(missing_ok=True)
        (thumbs / f"poster_{token}.jpg").unlink(missing_ok=True)
        for f in (thumbs / "live").glob(f"L{token}*"):
            f.unlink(missing_ok=True)

    def _abort(self, outcome: str, error: str | None = None) -> None:
        """Cancel / crash: the current and all queued sources go back to what they were. A source that
        has an analysis keeps it (ready); one without becomes cancelled / failed."""
        with self.lock:
            self.closed = True
            rest = ([self.current] if self.current else []) + self.queue
            self.queue = []
        if self.rebuild:
            for mt in self.rebuild["model"]["sources"]:
                STORE.purge_token(self.pid, mt.get("token"))
        try:
            with STORE._lock:
                p = STORE.raw(self.pid)
                ids = {t.sid for t in rest}
                if self.rebuild:
                    ids |= {s["id"] for s in p["sources"] if s["status"] in ("queued", "analyzing")}
                for sid in ids:
                    try:
                        s = STORE.source(p, sid)
                    except projects.ProjectError:
                        continue
                    if s.get("token") and scans.exists(STORE.dir(self.pid), s["token"]):
                        s["status"] = "ready"
                        if outcome != "cancelled":
                            s["error"] = (error or "Analiz uğursuz oldu")[:600]
                    else:
                        s["status"] = "cancelled" if outcome == "cancelled" else "failed"
                        if outcome != "cancelled":
                            s["error"] = (error or "Analiz uğursuz oldu")[:600]
                STORE.save(p)
        except projects.ProjectError:
            pass            # the project was deleted while it ran


def _on_finish(pid: str, runner: Runner):
    def on_finish(job: Job, outcome: str) -> None:
        with _RUNLOCK:
            runner.closed = True
            if RUNNERS.get(pid) is runner:
                RUNNERS.pop(pid, None)
        for sid in [s["id"] for s in _sources_of(pid)]:
            STORE.progress.pop((pid, sid), None)
        STORE.clear_active_job(pid, job.id)
        if not (STORE.dir(pid) / "project.json").exists():
            shutil.rmtree(STORE.dir(pid), ignore_errors=True)    # deleted while running: drop what the thread wrote
    return on_finish


def _sources_of(pid: str) -> list[dict]:
    try:
        return STORE.raw(pid)["sources"]
    except projects.ProjectError:
        return []


def _start(pid: str, tasks: list[Task], front: list[Task] | None = None, rebuild_preset: str | None = None) -> Job:
    """Queue tasks on the project's runner (joining a running one) and return its job."""
    with _RUNLOCK:
        r = RUNNERS.get(pid)
        if r is not None and not r.closed:
            if rebuild_preset or r.rebuild:
                raise projects.ProjectError("busy", "Layihə yenidən qurulur. Bitməsini gözləyin.", 409)
            if front:
                r.add(front, front=True)
            if r.add(tasks):
                return r.job
        r = Runner(pid, (front or []) + tasks, rebuild_preset)
        RUNNERS[pid] = r

        def created(job: Job) -> None:
            r.job = job
            job.update(sourceCount=r.count)
            STORE.set_active_job(pid, job.id)

        return JOBS.start("analysis", "probe", r.run, _on_finish(pid, r), on_created=created)


def _dur(s: dict) -> float:
    return max(float(s["media"].get("duration") or 0.0), 1.0)


def enqueue_sources(pid: str, sids: list[str]) -> Job:
    """Newly added (or retried / re-scanned) sources. A migrated source without evidence is re-scanned first."""
    with STORE._lock:
        p = STORE.raw(pid)
        tasks, marked = [], []
        for sid in sids:
            s = STORE.source(p, sid)
            tasks.append(Task(sid, "rescan" if s.get("token") else "new", _dur(s)))
            marked.append((s, s["status"], s["error"]))
            s["status"], s["error"] = "queued", None
        front = []
        busy = RUNNERS[pid].busy_sids() if pid in RUNNERS else set()
        for s in p["sources"]:
            if (s.get("needsRescan") and s["id"] not in sids and s["id"] not in busy and s["status"] == "ready"
                    and media.path_exists(s["media"]["path"])):
                front.append(Task(s["id"], "rescan", _dur(s)))
                marked.append((s, s["status"], s["error"]))
                s["status"] = "queued"
        STORE.save(p)
    try:
        return _start(pid, tasks, front)
    except BaseException:
        with STORE._lock:
            for s, status, error in marked:
                s["status"], s["error"] = status, error
            STORE.save(STORE.raw(pid))
        raise


def rescan_source(pid: str, sid: str) -> Job:
    p = STORE.raw(pid)
    s = STORE.source(p, sid)
    if s["status"] in ("queued", "analyzing"):
        raise projects.ProjectError("busy", "Bu video artıq növbədədir", 409)
    if not media.path_exists(s["media"]["path"]):
        raise projects.ProjectError("source_missing", "Mənbə video faylı tapılmadı. Fayl köçürülüb və ya silinib.", 409)
    return enqueue_sources(pid, [sid])


def rescan_project(pid: str, preset_id: str) -> Job:
    p = STORE.raw(pid)
    if STORE.active_job(pid):
        raise projects.ProjectError("busy", "Bu layihə üçün analiz artıq gedir", 409)
    srcs = sorted(p["sources"], key=lambda s: s["order"])
    if not srcs:
        raise projects.ProjectError("bad_request", "Layihədə video yoxdur")
    missing = [s["label"] for s in srcs if not media.path_exists(s["media"]["path"])]
    if missing:
        raise projects.ProjectError("source_missing", "Bu videoların faylı tapılmadı: " + ", ".join(missing[:5]), 409)
    if preset_id == p["preset"]:
        return enqueue_sources(pid, [s["id"] for s in srcs])
    with STORE._lock:
        for s in srcs:
            s["status"], s["error"] = "queued", None
        STORE.save(p)
    try:
        return _start(pid, [Task(s["id"], "rebuild", _dur(s)) for s in srcs], rebuild_preset=preset_id)
    except BaseException:
        with STORE._lock:
            for s in srcs:
                s["status"] = "ready" if s.get("token") else "failed"
            STORE.save(p)
        raise


def cancel_queued(pid: str, sid: str) -> bool:
    r = RUNNERS.get(pid)
    return bool(r and r.remove_queued(sid))
