"""User settings persisted to settings.json in the data directory."""
from __future__ import annotations

import json
import os
import threading

from . import paths, registry

_lock = threading.Lock()

LANGUAGES = ("az", "en", "tr", "ru", "uk", "de", "fr", "es", "pt", "it", "pl", "zh", "ja", "ko", "ar", "hi")

_EXPORT_DEFAULTS = {"mode": "clips", "codec": "h264", "quality": "high", "audio": True,
                    "paddingMs": 0, "joinAdjacent": True}


def defaults() -> dict:
    return {"language": "az", "defaultPreset": "balanced", "exportDir": str(paths.default_export_dir()),
            "export": dict(_EXPORT_DEFAULTS)}


def load() -> dict:
    s = defaults()
    try:
        saved = json.loads(paths.SETTINGS_FILE.read_text(encoding="utf-8-sig"))
        for k in ("language", "defaultPreset", "exportDir"):
            if k in saved and (k != "language" or saved[k] in LANGUAGES):
                s[k] = saved[k]
        s["export"].update({k: v for k, v in saved.get("export", {}).items() if k in _EXPORT_DEFAULTS})
    except (OSError, ValueError):
        pass
    return s


def save(new: dict) -> dict:
    from .projects import ProjectError
    s = defaults()
    if new.get("language") not in LANGUAGES:
        raise ProjectError("bad_request", "unsupported language")
    if new.get("defaultPreset") not in registry.PRESETS:
        raise ProjectError("bad_request", "unknown defaultPreset")
    s["language"], s["defaultPreset"] = new["language"], new["defaultPreset"]
    s["exportDir"] = str(new.get("exportDir") or s["exportDir"])
    ex = new.get("export") or {}
    for k in _EXPORT_DEFAULTS:
        if k in ex:
            s["export"][k] = ex[k]
    with _lock:
        paths.ensure_dirs()
        tmp = paths.SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, paths.SETTINGS_FILE)
    return s
