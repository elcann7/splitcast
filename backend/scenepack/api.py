"""Flask application: the HTTP API from ARCHITECTURE.md section 4 plus the SPA host."""
from __future__ import annotations

import os
import subprocess
import traceback
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory
from flask_cors import CORS

from . import dialogs, export, media, model_download, paths, pipeline, preview, projects, registry, settings, system
from .jobs import JOBS, Job
from .projects import STORE, ProjectError


def default_title(file_paths: list[str]) -> str:
    """One file: its name. Several: their common prefix without separators / episode markers, else the folder."""
    stems = [Path(x).stem for x in file_paths]
    if len(stems) == 1:
        return stems[0]
    pre = os.path.commonprefix(stems).rstrip(" ._-–—eEsSxX0123456789")
    if len(pre) >= 3:
        return pre
    return Path(file_paths[0]).parent.name or stems[0]


def create_app() -> Flask:
    paths.ensure_dirs()
    STORE.recover_on_startup()
    app = Flask(__name__, static_folder=None)
    app.json.ensure_ascii = False
    app.json.sort_keys = False
    CORS(app, origins=["http://localhost:5173", "http://127.0.0.1:5173"])

    # ---- errors -----------------------------------------------------------
    def err(code: str, message: str, status: int):
        return jsonify({"error": {"code": code, "message": message}}), status

    @app.errorhandler(ProjectError)
    def _pe(e: ProjectError):
        return err(e.code, e.message, e.status)

    @app.errorhandler(media.MediaError)
    def _me(e):
        return err("media_error", str(e), 422)

    @app.errorhandler(Exception)
    def _any(e):
        code = getattr(e, "code", None)
        if isinstance(code, int):   # werkzeug HTTPException
            return err("not_found" if code == 404 else "http_error", getattr(e, "description", str(e)), code)
        traceback.print_exc()
        return err("internal", f"{e.__class__.__name__}: {e}", 500)

    def body() -> dict:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            raise ProjectError("bad_request", "JSON gövdəsi gözlənilir")
        return data

    def need(data: dict, *keys: str):
        for k in keys:
            if k not in data:
                raise ProjectError("bad_request", f"'{k}' sahəsi tələb olunur")

    def check_preset(pid):
        if pid not in registry.PRESETS:
            raise ProjectError("bad_request", "Naməlum preset")

    def content_of(d: dict) -> str:
        c = d.get("content") or "live"
        if c not in registry.CONTENTS:
            raise ProjectError("bad_request", "Naməlum məzmun növü")
        return c

    # ---- system -------------------------------------------------------------
    @app.get("/api/system")
    def _system():
        return jsonify(system.system_info())

    @app.post("/api/models/download")
    def _models_download():
        d = body()
        need(d, "preset")
        check_preset(d["preset"])
        content = content_of(d)

        def run(job: Job):
            job.update(stage="download")
            model_download.ensure_preset(d["preset"], lambda f, m: job.update(progress=f, message=m),
                                         job.cancel_event, content=content)
            job.check_cancel()
            return {}

        return jsonify({"jobId": JOBS.start("download", "download", run).id})

    @app.post("/api/dialog/open-video")
    def _dlg_video():
        return jsonify({"paths": dialogs.open_video()})

    @app.post("/api/dialog/choose-folder")
    def _dlg_folder():
        return jsonify({"path": dialogs.choose_folder()})

    @app.post("/api/probe")
    def _probe():
        d = body()
        need(d, "path")
        return jsonify(media.probe(d["path"]))

    # ---- projects -----------------------------------------------------------
    @app.get("/api/projects")
    def _projects():
        return jsonify(STORE.list())

    def probe_all(paths_in) -> list[dict]:
        if not isinstance(paths_in, list) or not paths_in or not all(isinstance(x, str) and x for x in paths_in):
            raise ProjectError("bad_request", "'paths' boş olmayan sətir siyahısı olmalıdır")
        seen, infos = set(), []
        for path in paths_in:
            k = projects.norm_path(path)
            if k in seen:
                continue
            seen.add(k)
            infos.append(media.probe(path))
        return infos

    @app.post("/api/projects")
    def _project_create():
        d = body()
        if "paths" not in d and isinstance(d.get("path"), str):
            d["paths"] = [d["path"]]             # pre-7.3 clients
        need(d, "paths", "preset")
        check_preset(d["preset"])
        infos = probe_all(d["paths"])
        title = (d.get("title") or "").strip() or default_title([i["path"] for i in infos])
        p = STORE.create(title, d["preset"], content_of(d))
        try:
            srcs, _skipped = STORE.add_sources(p["id"], infos)
            job = pipeline.enqueue_sources(p["id"], [s["id"] for s in srcs])
        except BaseException:
            STORE.delete(p["id"])
            raise
        return jsonify({"projectId": p["id"], "jobId": job.id})

    @app.post("/api/projects/<pid>/sources")
    def _sources_add(pid):
        d = body()
        need(d, "paths")
        STORE.raw(pid)
        infos = probe_all(d["paths"])
        srcs, skipped = STORE.add_sources(pid, infos)
        if not srcs:
            return jsonify({"jobId": STORE.active_job(pid), "sourceIds": [], "skipped": skipped})
        job = pipeline.enqueue_sources(pid, [s["id"] for s in srcs])
        return jsonify({"jobId": job.id, "sourceIds": [s["id"] for s in srcs], "skipped": skipped})

    @app.patch("/api/projects/<pid>/sources/<sid>")
    def _source_patch(pid, sid):
        d = body()
        need(d, "label")
        STORE.patch_source(pid, sid, d["label"])
        return jsonify(STORE.full(pid))

    @app.delete("/api/projects/<pid>/sources/<sid>")
    def _source_delete(pid, sid):
        r = pipeline.RUNNERS.get(pid)
        if r is not None and r.rebuild:
            raise ProjectError("busy", "Layihə yenidən qurulur. Bitməsini gözləyin.", 409)
        pipeline.cancel_queued(pid, sid)
        p = STORE.raw(pid)
        s = STORE.source(p, sid)
        if s["status"] == "queued" and not s.get("token"):
            s["status"] = "cancelled"
        elif s["status"] == "queued":
            s["status"] = "ready"
        STORE.remove_source(pid, sid)
        return jsonify(STORE.full(pid))

    @app.post("/api/projects/<pid>/sources/<sid>/rescan")
    def _source_rescan(pid, sid):
        return jsonify({"jobId": pipeline.rescan_source(pid, sid).id})

    @app.get("/api/projects/<pid>")
    def _project(pid):
        return jsonify(STORE.full(pid))

    @app.patch("/api/projects/<pid>")
    def _project_patch(pid):
        d = body()
        need(d, "title")
        STORE.rename(pid, d["title"])
        return jsonify(STORE.full(pid))

    @app.delete("/api/projects/<pid>")
    def _project_delete(pid):
        job_id = STORE.summary(STORE.raw(pid))["activeJobId"]
        if job_id:
            JOBS.cancel(job_id)
        STORE.delete(pid)
        return jsonify({"ok": True})

    @app.post("/api/projects/<pid>/rescan")
    def _rescan(pid):
        d = body()
        need(d, "preset")
        check_preset(d["preset"])
        STORE.raw(pid)
        return jsonify({"jobId": pipeline.rescan_project(pid, d["preset"]).id})

    @app.patch("/api/projects/<pid>/characters/<cid>")
    def _char_patch(pid, cid):
        d = body()
        STORE.patch_character(pid, cid, d.get("name"), d.get("hidden"))
        return jsonify(STORE.full(pid))

    @app.post("/api/projects/<pid>/characters/merge")
    def _merge(pid):
        d = body()
        need(d, "sourceIds", "targetId")
        STORE.merge(pid, list(d["sourceIds"]), d["targetId"])
        return jsonify(STORE.full(pid))

    @app.post("/api/projects/<pid>/appearances/move")
    def _move(pid):
        d = body()
        need(d, "appearanceIds", "targetCharacterId")
        STORE.move_appearances(pid, list(d["appearanceIds"]), d["targetCharacterId"])
        return jsonify(STORE.full(pid))

    @app.get("/api/projects/<pid>/appearances/<aid>/preview.mp4")
    def _preview(pid, aid):
        path = preview.preview_path(pid, aid)
        return send_file(path, mimetype="video/mp4", conditional=True, max_age=3600)

    @app.get("/api/projects/<pid>/thumbs/<path:file>")
    def _thumb(pid, file):
        STORE.raw(pid)
        return send_from_directory(STORE.thumbs_dir(pid), file, max_age=31536000)

    @app.post("/api/projects/<pid>/export")
    def _export(pid):
        d = body()
        need(d, "characterId", "appearanceIds", "mode", "codec")
        d.setdefault("trims", {})
        d.setdefault("quality", "high")
        d.setdefault("audio", True)
        d.setdefault("paddingMs", 0)
        d.setdefault("joinAdjacent", False)
        return jsonify({"jobId": export.start_export(pid, d).id})

    # ---- jobs ----------------------------------------------------------------
    @app.get("/api/jobs/<jid>")
    def _job(jid):
        j = JOBS.get(jid)
        if j is None:
            raise ProjectError("not_found", "İş tapılmadı", 404)
        return jsonify(j.to_json())

    @app.post("/api/jobs/<jid>/cancel")
    def _job_cancel(jid):
        j = JOBS.cancel(jid)
        if j is None:
            raise ProjectError("not_found", "İş tapılmadı", 404)
        return jsonify(j.to_json())

    # ---- settings / storage ------------------------------------------------------
    @app.get("/api/settings")
    def _settings():
        return jsonify(settings.load())

    @app.put("/api/settings")
    def _settings_put():
        return jsonify(settings.save(body()))

    @app.get("/api/storage")
    def _storage():
        return jsonify(system.storage())

    @app.post("/api/storage/clear-previews")
    def _clear():
        return jsonify({"freedBytes": system.clear_previews()})

    @app.post("/api/open-path")
    def _open_path():
        d = body()
        need(d, "path")
        target = Path(d["path"])
        if not target.exists():
            raise ProjectError("not_found", "Yol tapılmadı", 404)
        if target.is_file():
            subprocess.Popen(["explorer", "/select,", str(target)])
        else:
            os.startfile(str(target))
        return jsonify({"ok": True})

    # ---- SPA ------------------------------------------------------------------------
    @app.get("/", defaults={"path": ""})
    @app.get("/<path:path>")
    def _spa(path):
        if path.startswith("api/"):
            return err("not_found", "Tapılmadı", 404)
        dist = paths.DIST_DIR
        if not (dist / "index.html").is_file():
            return ("Splitcast backend is running. The frontend build (dist/) was not found; "
                    "run 'npm run build' or start the Vite dev server on port 5173.", 200,
                    {"Content-Type": "text/plain; charset=utf-8"})
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and dist.resolve() in candidate.parents:
            return send_from_directory(dist, path, max_age=0 if path.endswith(".html") else 3600)
        return send_from_directory(dist, "index.html", max_age=0)

    return app
