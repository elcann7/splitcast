"""GET /api/system and storage accounting."""
from __future__ import annotations

from . import __version__, ffmpeg, paths, registry, runtime


def _shot_label(spec: registry.PresetSpec) -> str:
    if spec.shotModel == "transnetv2" and registry.shot_model_available():
        return "TransNetV2"
    return "Content-adaptive"


def preset_info(spec: registry.PresetSpec) -> dict:
    mb = registry.missing_download_mb(spec)
    return {
        "id": spec.id,
        "content": spec.content,
        "shotDetector": _shot_label(spec),
        "faceDetector": f"{registry.MODELS[spec.detector].label} @{spec.detSize}",
        "faceRecognizer": registry.MODELS[spec.recognizer].label + (" + flip" if spec.flipAugment else ""),
        "sampleFps": spec.sampleFps,
        "installed": mb == 0,
        "downloadMb": mb,
        "speedFactor": spec.speedFactor,
    }


def system_info() -> dict:
    return {
        "version": __version__,
        "device": runtime.device_info(),
        "ffmpeg": {"ok": ffmpeg.available(), "version": ffmpeg.version(), "nvenc": ffmpeg.nvenc_available(), "encoder": ffmpeg.hw_encoder()},
        "presets": [preset_info(s) for s in registry.all_presets()],
        "paths": {"data": str(paths.DATA_DIR), "defaultExportDir": str(paths.default_export_dir())},
    }


def _dir_bytes(d, pattern="*") -> int:
    total = 0
    if d.exists():
        for f in d.rglob(pattern):
            try:
                if f.is_file():
                    total += f.stat().st_size
            except OSError:
                pass
    return total


def storage() -> dict:
    previews = 0
    projects = 0
    if paths.PROJECTS_DIR.exists():
        for pd in paths.PROJECTS_DIR.iterdir():
            pv = _dir_bytes(pd / "previews")
            previews += pv
            projects += _dir_bytes(pd) - pv
    return {"projectsBytes": projects, "modelsBytes": _dir_bytes(paths.MODELS_DIR), "previewsBytes": previews}


def clear_previews() -> int:
    import shutil
    freed = 0
    if paths.PROJECTS_DIR.exists():
        for pd in paths.PROJECTS_DIR.iterdir():
            d = pd / "previews"
            freed += _dir_bytes(d)
            shutil.rmtree(d, ignore_errors=True)
    return freed
