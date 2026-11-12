"""Background job system: threads, cancellation, progress, and crash-to-failed guarantees."""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from typing import Callable


class JobCancelled(Exception):
    pass


class Job:
    def __init__(self, type_: str, stage: str):
        self.id = "j_" + uuid.uuid4().hex[:10]
        self.type = type_
        self.status = "queued"
        self.progress = 0.0
        self.stage = stage
        self.message: str | None = None
        self.speedFps: float | None = None
        self.etaSeconds: float | None = None
        self.recentFaces: list[str] = []
        self.counts: dict | None = None
        self.error: str | None = None
        self.result: dict | None = None
        # analysis jobs only (a batch of sources processed one after another)
        self.sourceId: str | None = None
        self.sourceIndex = 0
        self.sourceCount = 0
        self.cancel_event = threading.Event()
        self.created = time.time()
        self._lock = threading.Lock()

    def update(self, **kw) -> None:
        with self._lock:
            for k, v in kw.items():
                setattr(self, k, v)
            if "progress" in kw:
                self.progress = max(0.0, min(1.0, self.progress))

    def check_cancel(self) -> None:
        if self.cancel_event.is_set():
            raise JobCancelled()

    def to_json(self) -> dict:
        with self._lock:
            extra = {"sourceId": self.sourceId, "sourceIndex": self.sourceIndex,
                     "sourceCount": self.sourceCount} if self.type == "analysis" else {}
            return {
                **{"id": self.id, "type": self.type, "status": self.status,
                "progress": round(self.progress, 4), "stage": self.stage, "message": self.message,
                "speedFps": self.speedFps, "etaSeconds": self.etaSeconds,
                "recentFaces": list(self.recentFaces[-12:]), "counts": self.counts,
                "error": self.error, "result": self.result},
                **extra,
            }


class JobManager:
    def __init__(self):
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def start(self, type_: str, stage: str, fn: Callable[[Job], dict | None],
              on_finish: Callable[[Job, str], None] | None = None,
              on_created: Callable[[Job], None] | None = None) -> Job:
        """Run fn(job) on a thread. Any exception ends the job as failed with a readable message."""
        job = Job(type_, stage)
        with self._lock:
            self._jobs[job.id] = job
            self._prune()

        def runner():
            job.update(status="running")
            outcome, result = "done", None
            try:
                result = fn(job)
                if job.cancel_event.is_set():
                    outcome = "cancelled"
            except JobCancelled:
                outcome = "cancelled"
            except BaseException as e:  # noqa: BLE001 - nothing may leave a job stuck at "running"
                traceback.print_exc()
                outcome = "failed"
                job.update(error=(str(e).strip() or e.__class__.__name__)[:600])
            # persist side effects (project status) before the job becomes visibly terminal,
            # so a client that sees "done"/"cancelled" and refetches the project gets the final state
            if on_finish:
                try:
                    on_finish(job, outcome)
                except Exception:
                    traceback.print_exc()
            if outcome == "done":
                job.update(status="done", progress=1.0, result=result, etaSeconds=0.0)
            else:
                job.update(status=outcome)

        if on_created:
            on_created(job)
        threading.Thread(target=runner, name=f"job-{job.id}", daemon=True).start()
        return job

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job and job.status in ("queued", "running"):
            job.cancel_event.set()
        return job

    def _prune(self) -> None:
        if len(self._jobs) > 200:
            old = sorted(self._jobs.values(), key=lambda j: j.created)[:50]
            for j in old:
                if j.status in ("done", "failed", "cancelled"):
                    self._jobs.pop(j.id, None)


JOBS = JobManager()
