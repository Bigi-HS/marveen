#!/usr/bin/env python3
"""windows-resolve-wrapper.py -- Windows-side DaVinci Resolve scripting bridge (scaffold).

RUNS ON WINDOWS, not in WSL. The DaVinciResolveScript module loads the native
fusionscript.dll and is bound to the Windows Resolve install, so it cannot be imported
from WSL. This thin HTTP/JSON wrapper runs under Resolve's own Python on the Windows host
and exposes a narrow command surface; WSL reaches it via a netsh portproxy on port 8081
(see store/windows-bridges.md). This is the chosen path (b) from the Resolve spike.

Prereqs on Windows:
  1. Resolve > Preferences > System > General > "External scripting using" = Local
  2. Resolve running.
  3. Resolve's scripting env on PATH/PYTHONPATH. Typical (adjust to your install):
       set RESOLVE_SCRIPT_API=%PROGRAMDATA%\\Blackmagic Design\\DaVinci Resolve\\Support\\Developer\\Scripting
       set RESOLVE_SCRIPT_LIB=C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\fusionscript.dll
       set PYTHONPATH=%PYTHONPATH%;%RESOLVE_SCRIPT_API%\\Modules
  4. Run:  python windows-resolve-wrapper.py   (binds 127.0.0.1:8081)
     Then apply the portproxy from WSL's plan:  scripts/windows-bridge.sh plan 8081 --app Resolve

Scaffold scope: /health (no Resolve needed) and /project (name of the open project). Extend
with pipeline actions (render-queue add/start, timeline export) as the Big Ben pipeline needs
them -- keep the surface narrow and explicit; this wrapper is reachable from WSL.

Security: binds 127.0.0.1 ONLY. Exposure to WSL is solely through the operator-applied
portproxy + firewall rule, scoped to the WSL gateway. Do NOT bind 0.0.0.0.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = 8081


def get_resolve():
    """Return a connected Resolve handle, or None if unavailable (module/app missing)."""
    try:
        import DaVinciResolveScript as dvr  # Windows-only, provided by Resolve's env
    except Exception:
        return None
    try:
        return dvr.scriptapp("Resolve")
    except Exception:
        return None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            resolve = get_resolve()
            self._send(200, {"ok": True, "resolve_connected": resolve is not None})
            return
        if self.path.startswith("/project"):
            resolve = get_resolve()
            if resolve is None:
                self._send(503, {"ok": False, "error": "Resolve not reachable "
                                 "(module/app/env missing or scripting not set to Local)"})
                return
            try:
                pm = resolve.GetProjectManager()
                proj = pm.GetCurrentProject()
                name = proj.GetName() if proj else None
                self._send(200, {"ok": True, "project": name})
            except Exception as e:  # narrow surface: report, never crash the server
                self._send(500, {"ok": False, "error": str(e)})
            return
        self._send(404, {"ok": False, "error": "unknown path"})

    def log_message(self, *_):  # quiet by default
        pass


def main():
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"resolve-wrapper listening on http://{HOST}:{PORT} (health: /health, project: /project)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()


if __name__ == "__main__":
    main()
