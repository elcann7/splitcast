"""Run the API with waitress (threaded, Range-capable, no dev-server reloader)."""
from __future__ import annotations

import os
import threading

from waitress import create_server

from . import runtime
from .api import create_app

HOST = "127.0.0.1"
PORT = int(os.environ.get("SCENEPACK_PORT") or 8756)   # SCENEPACK_PORT: run a second instance (tests)


def make_server(host: str = HOST, port: int = PORT):
    return create_server(create_app(), host=host, port=port, threads=16, channel_timeout=300)


def serve_in_thread(host: str = HOST, port: int = PORT):
    srv = make_server(host, port)
    threading.Thread(target=srv.run, name="api-server", daemon=True).start()
    threading.Thread(target=runtime.init, name="ort-init", daemon=True).start()
    return srv


if __name__ == "__main__":  # python -m scenepack.server
    srv = make_server()
    threading.Thread(target=runtime.init, daemon=True).start()
    print(f"Splitcast API on http://{HOST}:{PORT}", flush=True)
    srv.run()
