"""Splitcast desktop entry: backend in-process + pywebview (Edge WebView2) window."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))

from scenepack import paths  # noqa: E402  (only computes locations, writes nothing)

# keep bytecode out of the repo / install folder
sys.pycache_prefix = str(paths.DATA_DIR / "pycache")

# pythonw.exe has no console: send stdout/stderr to a log so errors are not lost
if sys.stdout is None or sys.stderr is None:
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    _log = open(paths.DATA_DIR / "app.log", "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or _log
    sys.stderr = sys.stderr or _log

# choose CUDA or DirectML (or the CPU) before anything imports onnxruntime; see scenepack/devices.py
from scenepack import devices  # noqa: E402

RUNTIME = devices.select(ROOT)

from scenepack import dialogs, server  # noqa: E402
from scenepack.jobs import JOBS  # noqa: E402

API = f"http://{server.HOST}:{server.PORT}"
VITE = "http://localhost:5173"

# Lets the browser accept a file drop at all, then forwards the real path to the page (see on_drop).
_ENABLE_DROP_JS = """
(function () {
  if (window.__scenepackDrop) return;
  window.__scenepackDrop = true;
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
})();
"""


def _answers(url: str, timeout: float = 0.6) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.status < 500
    except Exception:
        return False


TITLE = "Splitcast"


def _focus_existing() -> bool:
    """Bring the window of an already running instance to the front. False when there is none."""
    import ctypes
    user32 = ctypes.windll.user32
    hwnd = user32.FindWindowW(None, TITLE)
    if not hwnd:
        return False
    user32.ShowWindow(hwnd, 9)          # SW_RESTORE
    user32.SetForegroundWindow(hwnd)
    return True


def _port_taken() -> bool:
    import socket
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex((server.HOST, server.PORT)) == 0


def _fail(message: str) -> None:
    import ctypes
    print(message, flush=True)
    ctypes.windll.user32.MessageBoxW(None, message, TITLE, 0x10)   # MB_ICONERROR
    raise SystemExit(1)


def _start_backend() -> None:
    if _answers(f"{API}/api/settings", 2.0):
        if _focus_existing():                # already open: one window, one backend
            raise SystemExit(0)
        return                               # a bare API server (development): use it
    if _port_taken():
        # Something holds the port but does not answer: on Windows a second server could still
        # bind it and requests would keep going to the dead one, so refuse instead.
        _fail("Splitcast is already running but not responding.\n\n"
              "Close any leftover Splitcast processes in Task Manager (Ctrl+Shift+Esc) and open it again.")
    server.serve_in_thread()
    for _ in range(100):
        if _answers(f"{API}/api/settings", 1.0):
            return
        time.sleep(0.1)
    raise SystemExit("Backend did not start on " + API)


def _pick_url() -> str:
    return VITE if _answers(VITE) else API


def main() -> None:
    import webview
    from webview.dom import DOMEventHandler

    paths.ensure_dirs()
    from scenepack import bootstrap
    if not bootstrap.ffmpeg_ready():
        _fail("Splitcast is missing some components (ffmpeg).\n\n"
              "Open “Splitcast - repair components” from the Start menu while you are online, then start Splitcast again.")
    _start_backend()
    url = _pick_url()

    window = webview.create_window(
        TITLE, url, width=1440, height=900, min_size=(1180, 720),
        background_color="#0E0E0F", text_select=False,
    )
    dialogs.set_window(window)

    def on_drop(event: dict) -> None:
        """File dropped onto the window: tell the page the absolute paths of the files."""
        files = (event.get("dataTransfer") or {}).get("files") or []
        found = [f["pywebviewFullPath"] for f in files if f.get("pywebviewFullPath")]
        if found:
            detail = json.dumps({"paths": found})
            window.evaluate_js(f"window.dispatchEvent(new CustomEvent('scenepack:file-drop', {{detail: {detail}}}))")

    def on_loaded() -> None:
        window.evaluate_js(_ENABLE_DROP_JS)
        window.dom.document.events.drop += DOMEventHandler(on_drop, prevent_default=True)

    def on_closing() -> None:
        for job in list(JOBS._jobs.values()):
            if job.status in ("queued", "running"):
                job.cancel_event.set()
        deadline = time.time() + 4
        while time.time() < deadline and any(j.status in ("queued", "running") for j in JOBS._jobs.values()):
            time.sleep(0.1)

    window.events.loaded += on_loaded
    window.events.closing += on_closing
    webview.start(storage_path=str(paths.DATA_DIR / "webview"), private_mode=False)
    # The window is gone. Worker threads (inference, ffmpeg readers, the HTTP server) would keep the
    # process alive and holding the port, and the next launch would talk to a dead backend.
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
