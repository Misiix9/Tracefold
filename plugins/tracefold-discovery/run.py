#!/usr/bin/env python3
"""Tracefold Discovery plugin entrypoint.

Tracefold starts this file with whatever Python interpreter it can find, on a loopback
port it chose. Discovery needs FastAPI, Playwright and a private Chromium build, which
cannot be shipped inside a plugin package, so the first launch prepares a private
environment under the plugin's persistent data directory.

The host gives a plugin 120 seconds to answer its health check, and installing Chromium
takes longer than that on most connections. So this process binds the port immediately
and answers `/api/health` with a progress page that reports what it is doing. Once the
environment is ready it hands the port to the real server and supervises it, which keeps
the process tree the host started intact on both Windows and Unix.

Nothing here opens a browser window. Chromium is launched later, by Discovery itself,
only for an interactive login or a background Playwright crawl.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REQUIREMENTS = ROOT / "requirements.txt"

# Import names, not distribution names: this is what actually has to resolve at runtime.
REQUIRED_MODULES = (
    "fastapi",
    "uvicorn",
    "playwright",
    "httpx",
    "openpyxl",
    "pydantic",
    "cryptography",
    "keyring",
    "jsonpath_ng",
)

STATE = {
    "state": "starting",
    "step": "Preparing Discovery…",
    "detail": "",
    "error": "",
    "warning": "",
}
STATE_LOCK = threading.Lock()


def set_state(**values: str) -> None:
    with STATE_LOCK:
        STATE.update(values)


def read_state() -> dict[str, str]:
    with STATE_LOCK:
        return dict(STATE)


def resolve_port() -> int:
    argv = sys.argv[1:]
    if "--port" in argv:
        index = argv.index("--port")
        if index + 1 < len(argv):
            return int(argv[index + 1])
    return int(os.environ.get("TRACEFOLD_PLUGIN_PORT") or 8765)


def resolve_data_dir() -> Path:
    """Persistent plugin data lives outside the installed code, so updates keep it."""
    argv = sys.argv[1:]
    if "--data-dir" in argv:
        index = argv.index("--data-dir")
        if index + 1 < len(argv):
            return Path(argv[index + 1]).expanduser().resolve()
    supplied = os.environ.get("TRACEFOLD_PLUGIN_DATA_DIR")
    if supplied:
        return Path(supplied).expanduser().resolve()
    return ROOT / ".tracefold"


def modules_available(interpreter: Path | None = None) -> bool:
    if interpreter is None:
        from importlib.util import find_spec

        try:
            return all(find_spec(name) is not None for name in REQUIRED_MODULES)
        except (ImportError, ValueError):
            return False
    probe = "import importlib.util,sys;" + "sys.exit(0 if all(importlib.util.find_spec(n) for n in %r) else 1)" % (
        list(REQUIRED_MODULES),
    )
    try:
        return subprocess.run([str(interpreter), "-c", probe], timeout=120).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def venv_interpreter(data_dir: Path) -> Path:
    runtime = data_dir / "runtime"
    if os.name == "nt":
        return runtime / "Scripts" / "python.exe"
    return runtime / "bin" / "python"


def requirements_stamp() -> str:
    try:
        return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()
    except OSError:
        return ""


def runtime_environment(data_dir: Path) -> dict[str, str]:
    """Keep Discovery's Chromium inside the plugin's own data directory.

    Playwright otherwise downloads into a shared per-user cache, which would leave a large
    orphan behind when the plugin is removed. An explicit PLAYWRIGHT_BROWSERS_PATH set by
    the user or the environment always wins, so a managed installation keeps working.
    """
    environment = dict(os.environ)
    environment.setdefault("PLAYWRIGHT_BROWSERS_PATH", str(data_dir / "browsers"))
    environment["TRACEFOLD_DISCOVERY_DATA_DIR"] = str(data_dir)
    return environment


def stamp_path(data_dir: Path) -> Path:
    return data_dir / "runtime" / ".tracefold-requirements"


def runtime_is_current(data_dir: Path) -> bool:
    """A changed requirements.txt must reinstall rather than run against stale packages."""
    try:
        return stamp_path(data_dir).read_text(encoding="utf-8").strip() == requirements_stamp()
    except OSError:
        return False


class BootstrapHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:  # noqa: D102 - quiet by design
        return

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        # Tracefold displays plugins inside its own window; nothing else may frame this.
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self'; script-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; "
            "frame-ancestors 'self' tauri://localhost http://tauri.localhost https://tauri.localhost",
        )
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            self._send(200, json.dumps({"status": "starting"}).encode(), "application/json")
            return
        if path == "/api/bootstrap":
            self._send(200, json.dumps(read_state()).encode(), "application/json")
            return
        if path == "/bootstrap.css":
            self._send(200, BOOTSTRAP_CSS.encode("utf-8"), "text/css; charset=utf-8")
            return
        if path == "/bootstrap.js":
            self._send(200, BOOTSTRAP_JS.encode("utf-8"), "text/javascript; charset=utf-8")
            return
        self._send(200 if path == "/" else 404, BOOTSTRAP_PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        self._send(503, json.dumps({"detail": "Discovery is still preparing."}).encode(), "application/json")


BOOTSTRAP_CSS = """
:root{--canvas:#f3f0e9;--surface:#fcfaf6;--text:#262522;--muted:#68635b;--line:#d8d1c6;
--accent:#783d49;--danger:#b13e32;color-scheme:light}
html[data-theme=dark]{--canvas:#1c1b1a;--surface:#252321;--text:#f2ede4;--muted:#b9b0a4;
--line:#443e38;--accent:#dea6af;--danger:#f1a194;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
font-family:Lexend,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.55;
background:var(--canvas);color:var(--text)}
.card{width:100%;max-width:520px;padding:30px;border:1px solid var(--line);border-radius:12px;
background:var(--surface)}
h1{margin:0 0 10px;font-size:21px;font-weight:600}
p{margin:8px 0;color:var(--muted)}
.step{margin:18px 0 6px;color:var(--text);font-weight:500}
.detail{font-size:11px;font-family:ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
.bar{height:4px;border-radius:999px;background:var(--line);overflow:hidden;margin:14px 0 4px}
.bar span{display:block;height:100%;width:35%;border-radius:999px;background:var(--accent);
animation:slide 1.5s ease-in-out infinite}
@keyframes slide{0%{margin-left:-35%}100%{margin-left:100%}}
@media (prefers-reduced-motion: reduce){.bar span{animation:none;width:100%}}
.error{color:var(--danger);white-space:pre-wrap}
.hidden{display:none}
"""

BOOTSTRAP_JS = """
var params = new URLSearchParams(location.search);
var theme = params.get('tracefoldTheme');
if (theme === 'dark' || theme === 'light') {
  document.documentElement.dataset.theme = theme;
} else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
  document.documentElement.dataset.theme = 'dark';
}
var ready = false;
function show(id, value) {
  var element = document.getElementById(id);
  element.textContent = value || '';
  element.classList.toggle('hidden', !value);
}
function reload(delay) {
  ready = true;
  setTimeout(function () { location.reload(); }, delay);
}
function poll() {
  if (ready) return;
  fetch('/api/bootstrap', { cache: 'no-store' }).then(function (response) {
    return response.json();
  }).then(function (state) {
    document.getElementById('step').textContent = state.step || '';
    document.getElementById('detail').textContent = state.detail || '';
    show('error', state.error);
    show('warning', state.warning);
    if (state.error) document.getElementById('progress').classList.add('hidden');
    if (state.state === 'ready') { reload(400); return; }
    setTimeout(poll, 800);
  }).catch(function () {
    // The port is being handed to the real server; reloading finds it.
    reload(700);
  });
}
poll();
"""

BOOTSTRAP_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Preparing Tracefold Discovery</title>
<link rel="stylesheet" href="/bootstrap.css">
<script src="/bootstrap.js" defer></script>
</head><body>
<div class="card">
  <h1>Preparing Tracefold Discovery</h1>
  <p>The first launch installs Discovery's private Python environment and its own Chromium
  build. This happens once, and is kept when the plugin is updated.</p>
  <div id="progress">
    <div class="bar"><span></span></div>
    <p class="step" id="step">Starting&hellip;</p>
    <p class="detail" id="detail"></p>
  </div>
  <p class="error hidden" id="error"></p>
  <p class="detail hidden" id="warning"></p>
</div>
</body></html>
"""


def run_command(command: list[str], step: str, environment: dict[str, str] | None = None) -> tuple[bool, str]:
    set_state(step=step, detail=" ".join(Path(command[0]).name if i == 0 else c for i, c in enumerate(command))[:300])
    try:
        completed = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
            timeout=3600,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    if completed.returncode != 0:
        return False, (completed.stdout or "")[-1500:]
    return True, ""


def prepare_runtime(data_dir: Path) -> Path | None:
    """Create the private environment. Returns the interpreter, or None on failure."""
    runtime = data_dir / "runtime"
    interpreter = venv_interpreter(data_dir)

    if not interpreter.is_file():
        set_state(step="Creating Discovery's private Python environment…")
        ok, detail = run_command([sys.executable, "-m", "venv", str(runtime)], "Creating the Python environment…")
        if not ok or not interpreter.is_file():
            set_state(
                state="failed",
                error="Discovery could not create its Python environment.\n\n"
                "On Debian or Ubuntu install python3-venv, then reopen the plugin.\n\n" + detail,
            )
            return None

    ok, detail = run_command(
        [str(interpreter), "-m", "pip", "install", "--upgrade", "pip"],
        "Updating the package installer…",
    )
    if not ok:
        # An outdated pip is usually still usable; only a failed dependency install is fatal.
        set_state(warning="The package installer could not be updated; continuing.")

    ok, detail = run_command(
        [str(interpreter), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(REQUIREMENTS)],
        "Installing Discovery's dependencies… (this can take a few minutes)",
    )
    if not ok:
        set_state(
            state="failed",
            error="Discovery could not install its dependencies.\n\n"
            "Check that this computer can reach the Python package index, then reopen the plugin.\n\n"
            + detail,
        )
        return None

    ok, detail = run_command(
        [str(interpreter), "-m", "playwright", "install", "chromium"],
        "Downloading Discovery's private Chromium build…",
        runtime_environment(data_dir),
    )
    if not ok:
        # Bearer-token discovery and test runs still work without a browser, so this is a
        # warning rather than a failure. Interactive login will report it when used.
        set_state(
            warning="Chromium could not be installed. Browser login and authenticated "
            "crawling will not work until it is available; bearer-token testing still works.",
        )

    try:
        stamp_path(data_dir).write_text(requirements_stamp(), encoding="utf-8")
    except OSError:
        pass
    return interpreter


def serve(port: int, data_dir: Path) -> int:
    """Run the real Discovery server in this process."""
    os.environ.update(runtime_environment(data_dir))
    sys.path.insert(0, str(ROOT))
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=port, reload=False, log_level="warning")
    return 0


def run_child(interpreter: Path, port: int, data_dir: Path) -> int:
    """Supervise the real server as a child process.

    Deliberately not os.exec: the host tracks the process it started, and replacing this
    process image would orphan the server on Windows, where the host kills a process tree
    by the identifier it holds.
    """
    command = [str(interpreter), str(ROOT / "run.py"), "--serve", "--port", str(port), "--data-dir", str(data_dir)]
    child = subprocess.Popen(command, cwd=str(ROOT), env=runtime_environment(data_dir))
    try:
        return child.wait()
    except KeyboardInterrupt:
        child.terminate()
        return child.wait()


def main() -> int:
    port = resolve_port()
    data_dir = resolve_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)

    if "--serve" in sys.argv[1:]:
        return serve(port, data_dir)

    # Already runnable as launched: a development checkout, or a host interpreter that
    # happens to have everything.
    if modules_available():
        return serve(port, data_dir)

    interpreter = venv_interpreter(data_dir)
    if interpreter.is_file() and runtime_is_current(data_dir) and modules_available(interpreter):
        return run_child(interpreter, port, data_dir)

    # The port must answer before the host's health check expires, so bind it now and
    # report progress while the environment is built.
    server = ThreadingHTTPServer(("127.0.0.1", port), BootstrapHandler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    prepared = prepare_runtime(data_dir)
    if prepared is None:
        # Keep serving the explanation instead of dying into an empty frame.
        thread.join()
        return 1

    set_state(state="ready", step="Starting Discovery…", detail="")
    # Let the page observe the ready state before the port changes hands.
    threading.Event().wait(0.6)
    server.shutdown()
    server.server_close()
    return run_child(prepared, port, data_dir)


if __name__ == "__main__":
    raise SystemExit(main())
