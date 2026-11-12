"""Native file/folder dialogs: the pywebview window when running as the desktop app, tkinter otherwise."""
from __future__ import annotations

_window = None

VIDEO_EXTS = "*.mp4;*.mkv;*.mov;*.avi;*.webm;*.m4v;*.mpg;*.mpeg;*.ts;*.mts;*.m2ts;*.wmv;*.flv"


def set_window(window) -> None:
    global _window
    _window = window


def _first(result) -> str | None:
    if not result:
        return None
    return str(result[0] if isinstance(result, (list, tuple)) else result)


def open_video() -> list[str]:
    """Multi-select. Returns [] when the dialog is cancelled."""
    if _window is not None:
        import webview
        kind = getattr(getattr(webview, "FileDialog", None), "OPEN", None) or webview.OPEN_DIALOG
        res = _window.create_file_dialog(
            kind, allow_multiple=True,
            file_types=(f"Video ({VIDEO_EXTS})", "All files (*.*)"))
        return [str(x) for x in (res or [])]
    return _tk_many()


def choose_folder() -> str | None:
    if _window is not None:
        import webview
        kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or webview.FOLDER_DIALOG
        return _first(_window.create_file_dialog(kind))
    return _tk(lambda fd: fd.askdirectory())


def _tk(fn) -> str | None:
    try:
        import tkinter
        from tkinter import filedialog
    except Exception:
        return None
    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return fn(filedialog) or None
    finally:
        root.destroy()


def _tk_many() -> list[str]:
    try:
        import tkinter
        from tkinter import filedialog
    except Exception:
        return []
    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return [str(x) for x in (filedialog.askopenfilenames(
            filetypes=[("Video", VIDEO_EXTS.replace(";", " ")), ("All files", "*.*")]) or [])]
    finally:
        root.destroy()
