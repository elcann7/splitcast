"""Scenepack export: per-appearance clips or one merged file, via ffmpeg.

A character's appearances may come from several sources (episodes). Clips are cut source by source;
a merged file runs in source order and is conformed to the first selected source when the sources
differ in resolution, frame rate or audio (ARCHITECTURE.md 3.3).
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import ffmpeg, media, paths, settings
from .jobs import JOBS, Job
from .projects import STORE, ProjectError

_MP4_VIDEO = {"h264", "hevc", "av1", "mpeg4"}
_MP4_AUDIO = {"aac", "mp3", "ac3", "eac3", "alac", "opus"}
_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_MERGE_AUDIO = ["-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2"]   # uniform, so segments concatenate cleanly


def safe_name(s: str, fallback: str = "Scenepack") -> str:
    s = _ILLEGAL.sub("_", s).strip().rstrip(".")
    return (s[:80] or fallback)


def _video_args(codec: str, quality: str, hw: str | None, ten_bit: bool) -> list[str]:
    """Encoder arguments. `hw` is the GPU encoder to use ("nvenc", "amf", "qsv") or None for the CPU encoder.

    NVENC is the tested path. AMF and QSV are used only after a real test encode with exactly these arguments
    succeeds on the machine (see ffmpeg.encoder_works); otherwise the CPU encoder is used, which is slower but safe."""
    master = quality == "master"
    if codec == "h264":
        if hw == "nvenc":
            return ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "12" if master else "16",
                    "-b:v", "0", "-spatial-aq", "1", "-pix_fmt", "yuv420p"]
        if hw == "amf":
            q = ("14", "16", "18") if master else ("18", "20", "22")
            return ["-c:v", "h264_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", q[0], "-qp_p", q[1], "-qp_b", q[2],
                    "-pix_fmt", "yuv420p"]
        if hw == "qsv":
            return ["-c:v", "h264_qsv", "-preset", "slow", "-global_quality", "14" if master else "18", "-pix_fmt", "nv12"]
        return ["-c:v", "libx264", "-preset", "medium", "-crf", "12" if master else "16", "-pix_fmt", "yuv420p"]
    if codec == "hevc":
        pix = "p010le" if (ten_bit and hw == "nvenc") else "yuv420p10le" if ten_bit else "yuv420p"
        if hw == "nvenc":
            return ["-c:v", "hevc_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "14" if master else "18",
                    "-b:v", "0", "-tag:v", "hvc1", "-pix_fmt", pix]
        if hw == "amf":
            q = ("16", "18", "20") if master else ("20", "22", "24")
            return ["-c:v", "hevc_amf", "-quality", "quality", "-rc", "cqp", "-qp_i", q[0], "-qp_p", q[1], "-qp_b", q[2],
                    "-tag:v", "hvc1", "-pix_fmt", "yuv420p"]
        if hw == "qsv":
            return ["-c:v", "hevc_qsv", "-preset", "slow", "-global_quality", "16" if master else "20", "-tag:v", "hvc1",
                    "-pix_fmt", "nv12"]
        return ["-c:v", "libx265", "-preset", "medium", "-crf", "14" if master else "18", "-tag:v", "hvc1",
                "-pix_fmt", pix]
    if codec == "prores":
        return ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]
    raise ProjectError("bad_request", f"Naməlum kodek: {codec}")


def video_args_for(codec: str, quality: str, ten_bit: bool) -> list[str]:
    """The arguments to use on this machine: the GPU encoder when it works for this exact case, else the CPU encoder."""
    if codec not in ("h264", "hevc"):
        return _video_args(codec, quality, None, ten_bit)
    hw = ffmpeg.hw_encoder()
    if hw == "nvenc":
        return _video_args(codec, quality, hw, ten_bit)
    if hw in ("amf", "qsv") and not ten_bit:  # 10-bit goes to the CPU encoder: not worth the risk on untested encoders
        args = _video_args(codec, quality, hw, ten_bit)
        if ffmpeg.encoder_works(tuple(args)):
            return args
    return _video_args(codec, quality, None, ten_bit)


def _is_10bit(path: str) -> bool:
    try:
        import av
        with av.open(path) as c:
            fmt = c.streams.video[0].codec_context.pix_fmt or ""
            return "10" in fmt or "12" in fmt
    except Exception:
        return False


@dataclass
class Part:
    """The selected ranges of one source."""
    source: dict
    ranges: list[tuple[float, float]]

    @property
    def info(self) -> dict:
        return self.source["media"]


def _ranges(req: dict, apps: list[dict], duration: float) -> list[tuple[float, float]]:
    pad = max(0, int(req.get("paddingMs", 0))) / 1000.0
    out = []
    for a in apps:
        tr = (req.get("trims") or {}).get(a["id"])
        s, e = (tr["start"], tr["end"]) if tr else (a["start"], a["end"])
        s, e = max(0.0, s - pad), min(duration, e + pad)
        if e - s < 0.05:
            raise ProjectError("bad_request", f"Səhnə çox qısadır: {a['id']}")
        out.append((s, e))
    out.sort()
    if req.get("joinAdjacent") and out:
        joined = [out[0]]
        for s, e in out[1:]:
            if s - joined[-1][1] <= 0.12:
                joined[-1] = (joined[-1][0], max(joined[-1][1], e))
            else:
                joined.append((s, e))
        out = joined
    return out


def _plan(pid: str, req: dict) -> tuple[dict, dict, list[Part], int]:
    """(project, character view, parts in source order, appearances skipped because their file is gone)."""
    p = STORE.raw(pid)
    char = next((c for c in STORE._derive(p) if c["id"] == req["characterId"]), None)
    if char is None:
        raise ProjectError("not_found", "Personaj tapılmadı", 404)
    if not req.get("appearanceIds"):
        raise ProjectError("bad_request", "Heç bir səhnə seçilməyib")
    by_id = {a["id"]: a for a in char["appearances"]}
    per_source: dict[str, list[dict]] = {}
    for aid in req["appearanceIds"]:
        a = by_id.get(aid)
        if a is None:
            raise ProjectError("not_found", f"Səhnə tapılmadı: {aid}", 404)
        per_source.setdefault(a["sourceId"], []).append(a)
    parts, skipped = [], 0
    for s in sorted(p["sources"], key=lambda s: s["order"]):
        apps = per_source.get(s["id"])
        if not apps:
            continue
        if not media.path_exists(s["media"]["path"]):
            skipped += len(apps)
            continue
        parts.append(Part(s, _ranges(req, apps, s["media"]["duration"])))
    if not parts:
        raise ProjectError("source_missing", "Mənbə video faylı tapılmadı. Fayl köçürülüb və ya silinib.", 409)
    return p, char, parts, skipped


def _copy_ext(info: dict, audio: bool) -> str:
    v, a = info["videoCodec"], info.get("audioCodec")
    if v == "prores":
        return ".mov"
    if v in _MP4_VIDEO and (not audio or a is None or a in _MP4_AUDIO):
        return ".mp4"
    return ".mkv"


def _ts_ok(info: dict, audio: bool) -> bool:
    """MPEG-TS joins stream-copied segments with continuous timestamps (mkv segments leave dts overlaps)."""
    return info["videoCodec"] in {"h264", "hevc", "mpeg2video", "mpeg4"} and (
        not audio or info.get("audioCodec") in {"aac", "mp3", "ac3", "eac3", "mp2"})


def _stream_key(info: dict, audio: bool) -> tuple:
    return (info["videoCodec"], info["width"], info["height"], round(info["fps"], 2),
            info.get("audioCodec") if audio else None)


def _same_picture(a: dict, b: dict) -> bool:
    return (a["width"], a["height"]) == (b["width"], b["height"]) and abs(a["fps"] - b["fps"]) < 0.01


def _fps_expr(fps: float) -> str:
    for num, den in ((24000, 1001), (30000, 1001), (60000, 1001)):
        if abs(fps - num / den) < 0.005:
            return f"{num}/{den}"
    return f"{fps:.6g}"


def _conform_filter(info: dict, ref: dict) -> str | None:
    """Fit this source into the reference picture: scale to fit, letterbox, same frame rate. Never stretched."""
    if _same_picture(info, ref):
        return None
    w, h = ref["width"], ref["height"]
    return (f"scale={w}:{h}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={_fps_expr(ref['fps'])}")


def _clip(src: str, s: float, e: float, out: Path, *, copy: bool, vargs: list[str], audio: bool, aargs: list[str],
          vf: str | None, silent: bool, job: Job, on_frac) -> None:
    """Cut [s, e) of src into out. `silent` adds a silent stereo track (a source without audio in a merge)."""
    args = ["-ss", f"{s:.3f}"]
    if copy:
        args += ["-to", f"{e:.3f}", "-i", src]
    else:
        args += ["-i", src]
        if silent:
            args += ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
        args += ["-t", f"{e - s:.3f}"]
    args += ["-map", "0:v:0"]
    if not audio:
        args += ["-an"]
    elif silent:
        args += ["-map", "1:a:0"]
    else:
        args += ["-map", "0:a:0?"]
    if copy:
        args += ["-c", "copy", "-avoid_negative_ts", "make_zero"]
    else:
        if vf:
            args += ["-vf", vf]
        args += vargs
        if audio:
            args += aargs
    if out.suffix == ".mp4":
        args += ["-movflags", "+faststart"]
    args += [str(out)]
    ffmpeg.run(args, duration=None if copy else (e - s), cancel=job.cancel_event, on_progress=on_frac)
    job.check_cancel()


def run_export(pid: str, req: dict, job: Job) -> dict:
    if not ffmpeg.available():
        raise ProjectError("ffmpeg_missing", "ffmpeg tapılmadı. setup.ps1 faylını işə salın.", 500)
    p, char, parts, skipped = _plan(pid, req)
    ref = parts[0].info
    codec = req.get("codec", "h264")
    copy = codec == "copy"
    merged = req.get("mode") == "merged"
    audio = bool(req.get("audio", True)) and any(pt.info.get("hasAudio") for pt in parts)
    multi = len(p["sources"]) > 1

    out_dir = Path(req.get("outputDir") or settings.load()["exportDir"]) / safe_name(p["title"]) / safe_name(char["name"])
    out_dir.mkdir(parents=True, exist_ok=True)
    n = sum(len(pt.ranges) for pt in parts)
    job.update(stage="export", message=f"0 / {n}", progress=0.0)
    done = 0

    def frac(i: int, f: float) -> None:
        job.update(progress=(i + f) / (n + (0.05 if merged else 0)), message=f"{min(i + 1, n)} / {n}")

    def finished(count: int) -> None:
        # ffmpeg reports progress only for clips that run long enough; a clip of a second or two ends before the
        # first progress line, so without this the bar stayed at 0% while hundreds of clips were being written
        job.update(progress=count / (n + (0.05 if merged else 0)), message=f"{count} / {n}")

    files: list[str] = []
    if not merged:
        for pt in parts:
            info, src = pt.info, pt.info["path"]
            has_audio = audio and info.get("hasAudio", False)
            ext = _copy_ext(info, has_audio) if copy else (".mov" if codec == "prores" else ".mp4")
            vargs = [] if copy else video_args_for(codec, req.get("quality", "high"), _is_10bit(src))
            aargs = ["-c:a", "pcm_s16le"] if codec == "prores" else ["-c:a", "aac", "-b:a", "256k"]
            base = (f"{safe_name(char['name'])} - {safe_name(pt.source['label'])}" if multi
                    else f"{safe_name(p['title'])} - {safe_name(char['name'])}")
            for k, (s, e) in enumerate(pt.ranges):
                out = out_dir / f"{base} - {k + 1:03d}{ext}"
                _clip(src, s, e, out, copy=copy, vargs=vargs, audio=has_audio, aargs=aargs, vf=None, silent=False,
                      job=job, on_frac=lambda f, i=done: frac(i, f))
                files.append(str(out))
                done += 1
                finished(done)
    else:
        ext = _copy_ext(ref, audio) if copy else (".mov" if codec == "prores" else ".mp4")
        vargs = [] if copy else video_args_for(codec, req.get("quality", "high"), _is_10bit(ref["path"]))
        tmp = paths.TMP_DIR / f"export_{job.id}"
        tmp.mkdir(parents=True, exist_ok=True)
        try:
            seg_ext = ".mov" if codec == "prores" else ".ts" if (copy and _ts_ok(ref, audio)) else ".mkv"
            segs = []
            for pt in parts:
                info, src = pt.info, pt.info["path"]
                vf = None if copy else _conform_filter(info, ref)
                silent = audio and not copy and not info.get("hasAudio", False)
                for s, e in pt.ranges:
                    seg = tmp / f"seg_{done:04d}{seg_ext}"
                    _clip(src, s, e, seg, copy=copy, vargs=vargs, audio=audio, aargs=_MERGE_AUDIO, vf=vf,
                          silent=silent, job=job, on_frac=lambda f, i=done: frac(i, f))
                    segs.append(seg)
                    done += 1
                    finished(done)
            lst = tmp / "list.txt"
            lst.write_text("".join(f"file '{sg.as_posix()}'\n" for sg in segs), encoding="utf-8")
            out = out_dir / f"{safe_name(p['title'])} - {safe_name(char['name'])} - merged{ext}"
            args = ["-f", "concat", "-safe", "0", "-i", str(lst), "-map", "0:v:0"]
            args += ["-map", "0:a?"] if audio else ["-an"]
            args += ["-c:v", "copy"]
            if audio:
                args += ["-c:a", "copy"] if (copy or codec == "prores") else ["-c:a", "aac", "-b:a", "256k"]
            if codec == "hevc":
                args += ["-tag:v", "hvc1"]
            if out.suffix == ".mp4":
                args += ["-movflags", "+faststart"]
            args += [str(out)]
            ffmpeg.run(args, cancel=job.cancel_event)
            job.check_cancel()
            files.append(str(out))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    job.update(progress=1.0, message=f"{n} / {n}")
    return {"outputDir": str(out_dir), "files": files, "skipped": skipped}


def start_export(pid: str, req: dict) -> Job:
    if req.get("codec") not in ("copy", "h264", "hevc", "prores"):
        raise ProjectError("bad_request", "codec must be copy, h264, hevc or prores")
    if req.get("mode") not in ("clips", "merged"):
        raise ProjectError("bad_request", "mode must be clips or merged")
    _p, _char, parts, _skipped = _plan(pid, req)      # 404 / bad selection before a job exists
    if req["codec"] == "copy" and req["mode"] == "merged":
        audio = bool(req.get("audio", True))
        if len({_stream_key(pt.info, audio) for pt in parts}) > 1:
            raise ProjectError("incompatible_sources",
                               "Seçilmiş videoların kodeki, ölçüsü və ya kadr sürəti fərqlidir. "
                               "Tək fayl üçün H.264, HEVC və ya ProRes seçin.", 409)
    return JOBS.start("export", "export", lambda job: run_export(pid, req, job))
