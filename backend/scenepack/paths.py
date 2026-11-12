"""Filesystem locations. Everything heavy lives in %LOCALAPPDATA% (ASCII, not synced by OneDrive)."""
from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
DIST_DIR = REPO_ROOT / "dist"


def _data_root() -> Path:
    override = os.environ.get("SCENEPACK_DATA")
    if override:
        return Path(override)
    base = Path(os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local"))
    legacy, current = base / "ScenepackStudio", base / "Splitcast"
    # keep using the old folder when it already holds someone's projects and models
    return legacy if (legacy / "projects").exists() and not (current / "projects").exists() else current


DATA_DIR = _data_root()
BIN_DIR = DATA_DIR / "bin"
MODELS_DIR = DATA_DIR / "models"
# SCENEPACK_PROJECTS_DIR relocates only the projects folder (test servers); models, bin and venv stay put.
PROJECTS_DIR = Path(os.environ["SCENEPACK_PROJECTS_DIR"]) if os.environ.get("SCENEPACK_PROJECTS_DIR") else DATA_DIR / "projects"
SETTINGS_FILE = DATA_DIR / "settings.json"
TMP_DIR = DATA_DIR / "tmp"


def default_export_dir() -> Path:
    videos = Path.home() / "Videos"
    base = videos if videos.exists() else Path.home()
    return base / "Splitcast"


def ensure_dirs() -> None:
    for d in (DATA_DIR, BIN_DIR, MODELS_DIR, PROJECTS_DIR, TMP_DIR):
        d.mkdir(parents=True, exist_ok=True)


def ffmpeg_exe() -> Path:
    return BIN_DIR / "ffmpeg.exe"


def ffprobe_exe() -> Path:
    return BIN_DIR / "ffprobe.exe"
