"""ComfyUI MCP Panel — sidebar driven by an autonomous background agent.

Two jobs:

1. Serve the sidebar panel JS (``web/js/comfyui-mcp-panel.js``) to the ComfyUI
   frontend via ``WEB_DIRECTORY`` (this pack ships no Python nodes).

2. Best-effort **auto-start the panel orchestrator** so the panel "just works":
   open ComfyUI, type in the Agent sidebar. The orchestrator
   (``npx -y comfyui-mcp --panel-orchestrator``) owns the loopback bridge the
   panel connects to and drives it with a background Claude Agent SDK session
   running on the user's Claude SUBSCRIPTION — no LLM API keys, and the user's
   interactive Claude session stays free.

Prerequisites for the agent to work: Node.js/``npx`` on PATH, and a Claude login
(run ``claude`` once, or ``claude setup-token``). If either is missing the panel
still loads and shows how to finish setup.

Env knobs:
- ``COMFYUI_MCP_NO_AUTOSPAWN=1`` — don't auto-start (e.g. you run the
  orchestrator yourself).
- ``COMFYUI_MCP_BRIDGE_PORT`` — bridge port to check/own (default 9101).
- ``COMFYUI_URL`` — ComfyUI the agent generates against (auto-detected otherwise).
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


def _maybe_start_orchestrator():
    global _orchestrator_proc

    if os.environ.get("COMFYUI_MCP_NO_AUTOSPAWN", "").lower() in ("1", "true", "yes"):
        return

    # Someone already owns the bridge port (a manual orchestrator, or another
    # ComfyUI instance) — don't spawn a second one; it could never bind anyway.
    if _port_in_use(_BRIDGE_HOST, _BRIDGE_PORT):
        _log(
            "bridge port {} already in use — assuming the panel orchestrator is "
            "running.".format(_BRIDGE_PORT)
        )
        return

    npx = shutil.which("npx") or shutil.which("npx.cmd")
    if not npx:
        _log(
            "Node.js/npx not found on PATH — can't auto-start the panel agent. "
            "Install Node, then run: npx -y comfyui-mcp --panel-orchestrator"
        )
        return

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
        _log(
            "could not auto-start the panel orchestrator: {}\n"
            "  Start it manually: npx -y comfyui-mcp --panel-orchestrator".format(exc)
        )
        return

    _log(
        "started the panel orchestrator (pid {}) on ws://{}:{} — the agent runs "
        "on your Claude subscription. Sign in with `claude` if prompts fail.".format(
            _orchestrator_proc.pid, _BRIDGE_HOST, _BRIDGE_PORT
        )
    )
    atexit.register(_stop_orchestrator)


def _stop_orchestrator():
    global _orchestrator_proc
    if _orchestrator_proc and _orchestrator_proc.poll() is None:
        try:
            _orchestrator_proc.terminate()
        except Exception:
            pass
    _orchestrator_proc = None


_maybe_start_orchestrator()
