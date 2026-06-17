"""ComfyUI MCP Panel — sidebar driven by an autonomous background agent.

Two jobs:

1. Serve the sidebar panel JS (``web/js/comfyui-mcp-panel.js``) to the ComfyUI
   frontend via ``WEB_DIRECTORY`` (this pack ships no Python nodes).

2. Expose a tiny **local** API the panel's **Connect** button calls to start the
   panel orchestrator on demand. The orchestrator
   (``npx -y comfyui-mcp --panel-orchestrator``) owns the loopback bridge the
   panel connects to and drives it with a background Claude Agent SDK session
   running on the user's Claude SUBSCRIPTION — no LLM API keys, and the user's
   interactive Claude session stays free.

The orchestrator is started **only when the user clicks Connect** (an explicit,
authenticated, local action through ComfyUI's own server) — never at import
time. Prerequisites for the agent to work: Node.js/``npx`` on PATH, and a Claude
login (run ``claude`` once, or ``claude setup-token``).

Env knobs:
- ``COMFYUI_MCP_BRIDGE_PORT`` — bridge port to check/own (default 9101).
- ``COMFYUI_URL`` — ComfyUI the agent generates against (auto-detected otherwise).
- ``COMFYUI_MCP_NO_AUTOSPAWN=1`` — the Connect route won't spawn; it only reports
  status (use when you run the orchestrator yourself).
"""

import atexit
import os
import shutil
import socket
import subprocess

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Serve the bundled JS extension(s) from ./web to the ComfyUI frontend.
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_BRIDGE_HOST = "127.0.0.1"
_BRIDGE_PORT = int(os.environ.get("COMFYUI_MCP_BRIDGE_PORT", "9101"))
_orchestrator_proc = None


def _log(msg):
    print("[comfyui-mcp-panel] " + msg)


def _no_autospawn():
    return os.environ.get("COMFYUI_MCP_NO_AUTOSPAWN", "").lower() in ("1", "true", "yes")


def _port_in_use(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.3)
        return sock.connect_ex((host, port)) == 0


def _detect_comfyui_url():
    """Best-effort: generate against THIS ComfyUI instance."""
    if os.environ.get("COMFYUI_URL"):
        return os.environ["COMFYUI_URL"]
    host, port = "127.0.0.1", 8188
    try:
        from comfy.cli_args import args  # type: ignore

        if getattr(args, "port", None):
            port = int(args.port)
        listen = getattr(args, "listen", None)
        if listen and listen not in ("0.0.0.0", "::"):
            host = listen
    except Exception:
        pass
    return "http://{}:{}".format(host, port)


def _orchestrator_running():
    """True if something already owns the bridge port (our spawn or the user's)."""
    return _port_in_use(_BRIDGE_HOST, _BRIDGE_PORT)


def _start_orchestrator():
    """Start the panel orchestrator on demand. Returns (ok: bool, message: str).

    Called only from the Connect route — i.e. an explicit user action — never at
    import time. Idempotent: if the bridge port is already owned, it's a no-op.
    """
    global _orchestrator_proc

    if _orchestrator_running():
        return True, "already running"

    if _no_autospawn():
        return False, (
            "auto-start is disabled (COMFYUI_MCP_NO_AUTOSPAWN). Start it yourself: "
            "npx -y comfyui-mcp --panel-orchestrator"
        )

    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        return False, (
            "Node.js/npx not found on PATH. Install Node, then click Connect again "
            "(or run: npx -y comfyui-mcp --panel-orchestrator)."
        )

    env = dict(os.environ)
    env["COMFYUI_URL"] = _detect_comfyui_url()
    # Beacon: the orchestrator watches this PID (ComfyUI) and shuts itself down
    # when ComfyUI exits — including crashes/hard-kills where atexit never fires.
    env["COMFYUI_MCP_PARENT_PID"] = str(os.getpid())
    # Subscription lane: the background agent authenticates via the on-disk Claude
    # login, never an API key.
    env.pop("ANTHROPIC_API_KEY", None)

    cmd = [npx, "-y", "comfyui-mcp", "--panel-orchestrator"]
    kwargs = {"env": env, "stdin": subprocess.DEVNULL}
    # Detach so a transient signal to ComfyUI doesn't kill the agent mid-turn;
    # atexit still tears it down on a clean ComfyUI shutdown.
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True

    try:
        _orchestrator_proc = subprocess.Popen(cmd, **kwargs)
    except Exception as exc:  # noqa: BLE001 - surface any spawn failure to the user
        return False, "could not start the panel orchestrator: {}".format(exc)

    atexit.register(_stop_orchestrator)
    _log(
        "started the panel orchestrator (pid {}) on ws://{}:{} — runs on your "
        "Claude subscription.".format(_orchestrator_proc.pid, _BRIDGE_HOST, _BRIDGE_PORT)
    )
    return True, "started (pid {})".format(_orchestrator_proc.pid)


def _stop_orchestrator():
    global _orchestrator_proc
    if _orchestrator_proc and _orchestrator_proc.poll() is None:
        try:
            _orchestrator_proc.terminate()
        except Exception:
            pass
    _orchestrator_proc = None


# ---------------------------------------------------------------------------
# Local API the panel's Connect button calls. Registering aiohttp routes at
# import is standard for custom nodes (no subprocess is spawned here); the
# orchestrator only launches when the user POSTs /connect.
# ---------------------------------------------------------------------------
def _register_routes():
    try:
        from server import PromptServer  # type: ignore
        from aiohttp import web  # type: ignore
    except Exception:
        # Headless / non-standard host without PromptServer — the panel still
        # loads; the user runs the orchestrator manually.
        return

    routes = PromptServer.instance.routes

    @routes.get("/comfyui_mcp_panel/status")
    async def _status(_request):
        return web.json_response(
            {
                "running": _orchestrator_running(),
                "port": _BRIDGE_PORT,
                "can_spawn": not _no_autospawn() and bool(shutil.which("npx") or shutil.which("npx.cmd")),
            }
        )

    @routes.post("/comfyui_mcp_panel/connect")
    async def _connect(_request):
        ok, message = _start_orchestrator()
        return web.json_response(
            {"ok": ok, "running": _orchestrator_running(), "port": _BRIDGE_PORT, "message": message},
            status=200 if ok else 503,
        )

    @routes.post("/comfyui_mcp_panel/disconnect")
    async def _disconnect(_request):
        # Only stops an orchestrator THIS pack spawned; a user-run one is left be.
        spawned = _orchestrator_proc is not None
        _stop_orchestrator()
        return web.json_response({"ok": True, "stopped": spawned, "running": _orchestrator_running()})


_register_routes()
