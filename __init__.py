"""ComfyUI Agent Panel — sidebar driven by an autonomous background agent.

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
- ``COMFYUI_MCP_BRIDGE_PORT`` — panel bridge port to check/own (default 9180).
- ``COMFYUI_URL`` — ComfyUI the agent generates against (auto-detected otherwise).
- ``COMFYUI_MCP_NO_AUTOSPAWN=1`` — the Connect route won't spawn; it only reports
  status (use when you run the orchestrator yourself).
"""

import atexit
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Serve the bundled JS extension(s) from ./web to the ComfyUI frontend.
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_BRIDGE_HOST = "127.0.0.1"
_BRIDGE_PORT = int(os.environ.get("COMFYUI_MCP_BRIDGE_PORT", "9180"))

# Backend -> bridge port map. "claude" keeps today's default (9180) so the
# existing no-backend path is byte-for-byte unchanged; "codex" gets its own port
# (9181) and "gemini" the next (9182) so all can run side by side. Extend this
# dict to add backends. The default port (COMFYUI_MCP_BRIDGE_PORT, normally 9180)
# is treated as the claude port so a custom override still maps to "claude".
_BACKEND_PORTS = {
    "claude": _BRIDGE_PORT,
    "codex": 9181,
    "gemini": 9182,
}
_DEFAULT_BACKEND = "claude"


def _backend_port(backend):
    """Bridge port for a backend id; falls back to the claude/default port."""
    return _BACKEND_PORTS.get((backend or _DEFAULT_BACKEND).lower(), _BRIDGE_PORT)


# Provider-CLI binary names per backend (Windows resolves .cmd/.exe via PATHEXT,
# but mirror the defensive npx lookup elsewhere and probe the variants too).
_PROVIDER_CLIS = {
    "claude": ("claude", "claude.cmd", "claude.exe"),
    "codex": ("codex", "codex.cmd", "codex.exe"),
    "gemini": ("gemini", "gemini.cmd", "gemini.exe"),
}


def _provider_cli(provider):
    """True if the provider's CLI binary is resolvable on PATH."""
    return any(shutil.which(name) for name in _PROVIDER_CLIS.get(provider, ()))


def _provider_auth(provider):
    """Whether a usable login/credential for the provider exists on disk.

    Returns True/False, or None ("unknown") for Claude on macOS, whose token
    lives in the login Keychain rather than a file we can cheaply read — callers
    treat unknown as 'don't block' so a logged-in mac user isn't told to sign in.
    Package-presence is NOT a signal: `npx -y comfyui-mcp` bundles both provider
    SDKs as optional deps, so the only thing that distinguishes a usable backend
    is an actual login."""
    home = os.path.expanduser("~")
    if provider == "claude":
        if os.path.isfile(os.path.join(home, ".claude", ".credentials.json")):
            return True
        # macOS stores the OAuth token in Keychain — unreadable from here. Report
        # unknown so a CLI-present mac user is taken as ready rather than nagged.
        if sys.platform == "darwin":
            return None
        return False
    if provider == "codex":
        return os.path.isfile(os.path.join(home, ".codex", "auth.json"))
    if provider == "gemini":
        # The gemini CLI caches the browser-based Google OAuth (Code Assist) login
        # at ~/.gemini/oauth_creds.json (GEMINI_DIR is ~/.gemini on every OS,
        # %USERPROFILE%\.gemini on Windows). No API key — a present creds file is
        # the on-disk signal that a Google login exists, mirroring codex's auth.json.
        return os.path.isfile(os.path.join(home, ".gemini", "oauth_creds.json"))
    return False


def _provider_state(provider):
    """Per-provider readiness for the panel onboarding flow.

    `ready` means the agent can actually run on this provider: its CLI is on PATH
    AND a login exists. `cli`/`auth` are reported separately so the panel can tell
    'install the CLI' apart from 'sign in'; `auth` is null when unknown (macOS
    Keychain), and unknown-with-cli still counts as ready."""
    cli = _provider_cli(provider)
    auth = _provider_auth(provider)
    ready = bool(cli and auth is not False)
    return {"cli": cli, "auth": auth, "ready": ready}


# Per-backend orchestrator handles, keyed by port, so spawning codex doesn't
# clobber the tracking of a running claude orchestrator (and vice versa). The
# legacy single-process global below stays in sync with the claude port entry so
# the existing /disconnect + atexit teardown keep working unchanged.
_orchestrator_procs = {}
_orchestrator_proc = None


def _log(msg):
    print("[comfyui-mcp-panel] " + msg)


def _no_autospawn():
    return os.environ.get("COMFYUI_MCP_NO_AUTOSPAWN", "").lower() in ("1", "true", "yes")


def _truthy(val):
    """Loose truthiness for a query-string flag (?force=1 / true / yes)."""
    return str(val).lower() in ("1", "true", "yes") if val is not None else False


def _coerce_stall(val):
    """Clamp a stall-warning-seconds value to [15, 3600]; None when absent/invalid.
    Forwarded to the orchestrator as COMFYUI_MCP_STALL_S — how long a render may
    make no progress before the agent is warned it looks stalled/wedged."""
    if val is None:
        return None
    try:
        n = int(float(val))
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    return max(15, min(3600, n))


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


def _looks_like_comfyui_root(p):
    """True if ``p`` is a dir that looks like a real ComfyUI install root. A
    ComfyUI Desktop-installer *wrapper* dir has NONE of these markers, while the
    real (sometimes nested) root has at least one. Dependency-free + defensive:
    never throws."""
    try:
        if not p or not os.path.isdir(p):
            return False
        for marker in ("main.py", "output", "custom_nodes", "models"):
            if os.path.exists(os.path.join(p, marker)):
                return True
    except Exception:
        pass
    return False


def _descend_to_nested_root(candidate, source="COMFYUI_PATH"):
    """Self-heal the nested ("doubled") ComfyUI Desktop-installer layout: if
    ``candidate`` is not itself a valid root but ``candidate/ComfyUI`` is,
    descend exactly ONE level (never more — guards against re-doubling). Returns
    ``candidate`` unchanged otherwise, so this is a strict no-op for a normal,
    non-nested install. Never throws."""
    try:
        if _looks_like_comfyui_root(candidate):
            return candidate
        nested = os.path.join(candidate, "ComfyUI")
        if _looks_like_comfyui_root(nested):
            if source == "env":
                print(
                    "[comfyui-mcp-panel] COMFYUI_PATH env var '{}' looks like a "
                    "Desktop-installer wrapper; descending to nested root "
                    "'{}'.".format(candidate, nested)
                )
            return nested
    except Exception:
        pass
    return candidate


def _detect_comfyui_path():
    """Best-effort: the ComfyUI install dir, so the agent's MCP runs in LOCAL
    mode (download_model, apply_manifest / installer packs, model scans) instead
    of remote-only.

    Both the explicit env var and ComfyUI's ``folder_paths.base_path`` can point
    at a Desktop-installer wrapper whose real root is one level down
    (``<wrapper>/ComfyUI/``); validate + descend so filesystem tools target the
    actual install. If neither validates, the candidate is returned as-is
    (best-effort — never regresses prior behavior)."""
    try:
        if os.environ.get("COMFYUI_PATH"):
            return _descend_to_nested_root(os.environ["COMFYUI_PATH"], source="env")
        try:
            import folder_paths  # provided by ComfyUI at runtime

            base = getattr(folder_paths, "base_path", None)
            if base:
                return _descend_to_nested_root(base, source="folder_paths")
        except Exception:
            pass
    except Exception:
        pass
    return None


def _orchestrator_running(port=None):
    """True if something already owns the bridge port (our spawn or the user's)."""
    return _port_in_use(_BRIDGE_HOST, port if port is not None else _BRIDGE_PORT)


def _backend_status(backend):
    """{"backend", "port", "running"} for a backend. "running" means an
    orchestrator is reachable on its port: prefer the lockfile (present + its pid
    alive), but a lockfile-less process holding the port still counts as running so
    a user-managed orchestrator isn't reported dead."""
    port = _backend_port(backend)
    lock = _read_lock(port)
    if lock and _pid_alive(lock.get("pid")):
        running = True
    else:
        # No (valid) lockfile — fall back to a raw port probe (covers a user-run
        # orchestrator or one started before lockfiles).
        running = _orchestrator_running(port)
    state = _provider_state(backend)
    return {
        "backend": backend,
        "port": port,
        "running": running,
        # Readiness for the onboarding flow: ready = CLI on PATH + a login on disk.
        "cli": state["cli"],
        "auth": state["auth"],
        "ready": state["ready"],
    }


# ---------------------------------------------------------------------------
# Orphan detection. The orchestrator writes a lockfile naming its real pid and
# the ComfyUI pid that launched it. If a previous ComfyUI session left an
# orchestrator squatting the bridge port, we can identify it (its parent pid is
# dead) and replace it on Connect — so a restart never gets trapped talking to a
# stale agent on old code.
# ---------------------------------------------------------------------------
def _lock_path(port=None):
    return os.path.join(
        tempfile.gettempdir(),
        "comfyui-mcp-panel-orch-{}.json".format(port if port is not None else _BRIDGE_PORT),
    )


def _read_lock(port=None):
    try:
        with open(_lock_path(port), "r") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _pid_alive(pid):
    """Best-effort liveness probe. Uses psutil (ComfyUI ships it); never uses
    os.kill(pid, 0) on Windows — there it would TERMINATE the process."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    try:
        import psutil  # type: ignore

        return psutil.pid_exists(pid)
    except Exception:
        pass
    if os.name == "nt":
        return True  # can't safely probe without psutil — assume alive, never kill
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False
    except Exception:
        return True


def _process_started_at_ms(pid):
    """Process creation time in epoch milliseconds, or None if unknown.

    psutil-only (ComfyUI ships it) — deliberately NO subprocess / no constructed
    script, so the pack stays clean for the Registry security scanner. If psutil
    is unavailable, identity checks degrade gracefully to pid-liveness (see
    _same_process)."""
    try:
        import psutil  # type: ignore

        return int(psutil.Process(int(pid)).create_time() * 1000)
    except Exception:
        return None


def _current_process_started_at_ms():
    return _process_started_at_ms(os.getpid())


def _same_process(pid, started_at_ms):
    """True only when pid is alive and, if provided, its creation time matches."""
    if not _pid_alive(pid):
        return False
    try:
        expected = int(started_at_ms) if started_at_ms is not None else None
    except (TypeError, ValueError):
        expected = None
    if expected is None:
        return True  # legacy lockfile: no identity data, fall back to liveness
    actual = _process_started_at_ms(pid)
    if actual is None:
        # Couldn't read the start time (no psutil + PowerShell failed). The pid IS
        # alive — don't false-positive "different process" and kill a healthy
        # orchestrator; fall back to liveness. The panel-side handshake (no
        # "connected" without the orchestrator's models frame) is the backstop if
        # this rare path ever lets a stale process through.
        return True
    return abs(actual - expected) <= 2000


def _lock_parent_is_current(lock):
    if not lock:
        return False
    return (
        lock.get("parent") == os.getpid()
        and _same_process(lock.get("parent"), lock.get("parentStartedAt"))
    )


def _lock_parent_is_gone(lock):
    if not lock:
        return False
    parent = lock.get("parent")
    if not parent:
        return False
    return not _same_process(parent, lock.get("parentStartedAt"))


def _kill_pid(pid, started_at_ms=None):
    """Terminate a pid via psutil, but ONLY while it still verifies as OUR panel
    orchestrator — re-checking identity (cmdline + creation time) immediately
    before every terminate()/kill() call.

    This closes a TOCTOU pid-reuse race: the caller checks identity, but the
    orchestrator can exit and the OS can recycle its pid before the signal lands.
    Without the re-check we could terminate whatever now holds that pid — a user's
    shell, node, editor, anything. So we never signal a pid that doesn't, at the
    instant of signalling, still look like our orchestrator. psutil-only (no
    shell/taskkill); if psutil is unavailable we don't kill (return False) and the
    caller surfaces a "fully restart ComfyUI" message."""
    try:
        import psutil  # type: ignore
    except Exception:
        return False

    def _still_ours():
        # Must look like our orchestrator AND (when we recorded its start time) be
        # the SAME process instance — not a pid-reuse impostor.
        if not _is_orchestrator_process(pid):
            return False
        if started_at_ms is not None and not _same_process(pid, started_at_ms):
            return False
        return True

    try:
        if not _still_ours():
            _log(
                "refusing to kill pid {} — not (or no longer) a verified panel "
                "orchestrator; possible pid reuse. Left untouched.".format(pid)
            )
            return False
        proc = psutil.Process(int(pid))
        proc.terminate()
        try:
            proc.wait(timeout=3)
            return True
        except Exception:
            # Still alive after terminate → escalate to kill, but ONLY if it's
            # STILL our orchestrator (it may have exited + had its pid reused
            # during the wait window).
            if not _still_ours():
                _log(
                    "not escalating to kill pid {} — identity changed during "
                    "wait (pid reuse?). Left untouched.".format(pid)
                )
                return False
            proc.kill()
            return True
    except Exception:
        return False


def _is_orchestrator_process(pid):
    """True only if `pid` is alive AND looks like OUR panel orchestrator
    (`node … --panel-orchestrator`). Guards _kill_pid against terminating a
    reused pid that now belongs to an unrelated process (Windows pid reuse)."""
    try:
        import psutil  # type: ignore

        cmd = " ".join(psutil.Process(int(pid)).cmdline()).lower()
        return "--panel-orchestrator" in cmd
    except Exception:
        return False  # can't verify → never kill


def _kill_orchestrator_tree(pid, started_at_ms=None):
    """Kill a VERIFIED orchestrator AND its child process tree, then reap them.

    A soft reload terminates only the orchestrator's own pid — but the Claude
    Agent SDK spawns child processes (its shell, helper binaries). If one of those
    wedges (e.g. a dead shell after a re-auth) and is orphaned rather than killed,
    the wedge survives the respawn and the user is stuck (Task Manager / reboot).
    Hard restart kills the whole tree so the fresh orchestrator starts truly clean.

    Safe by construction: we only ever snapshot/kill the tree of a pid that
    verifies as our orchestrator (cmdline + recorded creation time), so every
    descendant is by definition our agent's own subprocess — never a user's. If
    the root doesn't verify, nothing is touched."""
    try:
        import psutil  # type: ignore
    except Exception:
        return False

    # Snapshot descendants WITH their creation times, under a verified parent.
    snapshot = []  # list of (psutil.Process, create_time)
    try:
        if _is_orchestrator_process(pid) and (
            started_at_ms is None or _same_process(pid, started_at_ms)
        ):
            for ch in psutil.Process(int(pid)).children(recursive=True):
                try:
                    snapshot.append((ch, ch.create_time()))
                except Exception:
                    pass
    except Exception:
        snapshot = []

    # Kill the root via the identity-re-verifying helper. Only if it confirms the
    # root was ours do we reap the snapshotted descendants.
    killed_root = _kill_pid(pid, started_at_ms)
    if not killed_root:
        return False

    # A snapshotted child can exit and have its pid reused before we signal it, so
    # NEVER signal a child whose pid no longer maps to the same process. Read the
    # creation time FRESH (a cached psutil.Process would return the stale value) and
    # only signal on an exact match — same guard rigor as _kill_pid uses for the root.
    def _same_child(proc, ct):
        try:
            return abs(psutil.Process(proc.pid).create_time() - ct) <= 0.02
        except Exception:
            return False  # gone or unreadable → don't signal

    for proc, ct in snapshot:
        if _same_child(proc, ct):
            try:
                proc.terminate()
            except Exception:
                pass
    try:
        psutil.wait_procs([p for p, _ in snapshot], timeout=3)
    except Exception:
        pass
    for proc, ct in snapshot:
        if _same_child(proc, ct):
            try:
                proc.kill()
            except Exception:
                pass
    return True


def _delete_lock(port=None):
    """Remove the orchestrator lockfile (best-effort) so a fresh orchestrator
    self-registers cleanly after a hard restart."""
    try:
        os.remove(_lock_path(port))
    except Exception:
        pass


def _port_owner_pid(host, port):
    """Pid LISTENING on (host, port), or None. psutil-only. Lets us identify a
    lockfile-less zombie squatting the bridge port so Connect can reclaim it."""
    try:
        import psutil  # type: ignore

        for c in psutil.net_connections(kind="inet"):
            try:
                if (
                    c.status == psutil.CONN_LISTEN
                    and c.laddr
                    and int(c.laddr.port) == int(port)
                    and c.pid
                ):
                    return c.pid
            except Exception:
                continue
    except Exception:
        return None
    return None


def _start_orchestrator(backend=_DEFAULT_BACKEND, port=None, force=False, stall_seconds=None):
    """Start the panel orchestrator on demand. Returns (ok: bool, message: str).

    Called only from the Connect route — i.e. an explicit user action — never at
    import time. Idempotent: if the bridge port is already owned, it's a no-op.

    `backend` selects the provider ("claude" default | "codex"); `port` is the
    bridge port it should own (defaults to the backend's mapped port). The default
    call — ``_start_orchestrator()`` → claude on _BRIDGE_PORT (9180) — is the
    historical no-backend path, byte-for-byte unchanged.

    `force` (the panel's auto-reclaim safety net) RECLAIMS a WEDGED orchestrator
    that still looks healthy by the lockfile (our ComfyUI launched it, its pid is
    alive) but whose agent backend is dead — the "bridge open but no panel agent
    responded" wedge. Without force we'd reuse it ("already running") and stay
    stuck; with force we kill+respawn it. CRITICAL SAFETY: force still only ever
    kills a process VERIFIED as our panel orchestrator (_is_orchestrator_process,
    cmdline check) and never a different live ComfyUI's orchestrator — a truly
    foreign process on the port is reported, never killed.
    """
    global _orchestrator_proc

    backend = (backend or _DEFAULT_BACKEND).lower()
    if port is None:
        port = _backend_port(backend)

    if _orchestrator_running(port):
        lock = _read_lock(port)
        parent = lock.get("parent") if lock else None
        opid = lock.get("pid") if lock else None
        # Healthy + ours (our ComfyUI launched it and its pid is alive) → reuse,
        # UNLESS the caller forced a reclaim. A force request means the panel
        # connected to this bridge but got NO orchestrator handshake (no models
        # frame) within its generous timeout, i.e. the lockfile says "healthy" but
        # the agent is actually dead. Fall through to the reclaim branch below so we
        # kill+respawn it (verified-orchestrator-only) instead of reusing the wedge.
        if lock and _lock_parent_is_current(lock) and _pid_alive(opid) and not force:
            return True, "already running"

        # Otherwise the port is held by something that isn't a healthy orchestrator
        # of ours. Decide whether to RECLAIM it (kill + respawn) or bail. Reclaim
        # only a process we can VERIFY is a panel orchestrator (cmdline check), so
        # a genuinely foreign squatter is never killed.
        reclaim_pid = None
        reclaim_started = None
        if lock and _pid_alive(opid) and _is_orchestrator_process(opid):
            if parent and parent != os.getpid() and not _lock_parent_is_gone(lock):
                # A different, still-live ComfyUI owns it — leave it alone.
                return False, (
                    "the panel bridge port {} is owned by another live ComfyUI "
                    "(pid {}). Close it or set COMFYUI_MCP_BRIDGE_PORT to a "
                    "different port for this instance.".format(port, parent)
                )
            # Our orchestrator but not healthy (orphaned ComfyUI, or wedged) → reclaim.
            reclaim_pid, reclaim_started = opid, lock.get("pidStartedAt")
        else:
            # No (valid) lockfile, or its pid is dead, but the port is held. Find
            # the actual port owner: a lockfile-less panel-orchestrator ZOMBIE (the
            # "won't reconnect" bug) gets reclaimed; a truly foreign process is left.
            owner = _port_owner_pid(_BRIDGE_HOST, port)
            if owner and _is_orchestrator_process(owner):
                reclaim_pid = owner
            elif owner:
                return False, (
                    "the panel bridge port {} is held by another process that isn't a "
                    "panel orchestrator. Close it, or set COMFYUI_MCP_BRIDGE_PORT to a "
                    "free port.".format(port)
                )
            # owner unknown (couldn't read) → fall through; the bind will fail loudly
            # if the port really is still held.

        if reclaim_pid is not None:
            if _no_autospawn():
                return True, "reconnecting to your orchestrator"  # user-managed; don't kill
            _log("reclaiming panel bridge port {} from orchestrator pid {}".format(port, reclaim_pid))
            _kill_orchestrator_tree(reclaim_pid, reclaim_started)
            _delete_lock(port)
            for _ in range(20):
                if not _port_in_use(_BRIDGE_HOST, port):
                    break
                time.sleep(0.1)
            if _port_in_use(_BRIDGE_HOST, port):
                return False, (
                    "the panel bridge port {} is still held and couldn't be freed — "
                    "fully restart ComfyUI.".format(port)
                )
        # Port freed (or never really held) — fall through and spawn a fresh one.

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
    _cpath = _detect_comfyui_path()
    if _cpath:
        # Local mode for the agent: download_model / apply_manifest (packs) / scans.
        env["COMFYUI_PATH"] = _cpath
    # Beacon: the orchestrator watches this PID (ComfyUI) and shuts itself down
    # when ComfyUI exits — including crashes/hard-kills where atexit never fires.
    env["COMFYUI_MCP_PARENT_PID"] = str(os.getpid())
    _parent_started_at = _current_process_started_at_ms()
    if _parent_started_at is not None:
        env["COMFYUI_MCP_PARENT_STARTED_AT_MS"] = str(_parent_started_at)
    # Pin the orchestrator to its bridge port (claude=9180 default, codex=9181).
    env["COMFYUI_MCP_BRIDGE_PORT"] = str(port)
    # Select the agent backend. Only set when non-default so the claude path emits
    # the exact same env it always has (the orchestrator defaults to claude too).
    if backend != _DEFAULT_BACKEND:
        env["PANEL_AGENT_BACKEND"] = backend
    # Render-stall warning threshold (from the panel setting). Only set when given
    # so an unset setting leaves the orchestrator's own default (180s) in place.
    if stall_seconds is not None:
        env["COMFYUI_MCP_STALL_S"] = str(stall_seconds)
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
        proc = subprocess.Popen(cmd, **kwargs)
    except Exception as exc:  # noqa: BLE001 - surface any spawn failure to the user
        return False, "could not start the panel orchestrator: {}".format(exc)

    _orchestrator_procs[port] = proc
    # Keep the legacy single-process global pointing at the default (claude) port's
    # proc, so the existing /disconnect + atexit teardown behave exactly as before.
    if port == _BRIDGE_PORT:
        _orchestrator_proc = proc

    atexit.register(_stop_orchestrator)
    _log(
        "started the panel orchestrator (pid {}) on ws://{}:{} (backend={}) — runs "
        "on your subscription.".format(proc.pid, _BRIDGE_HOST, port, backend)
    )
    return True, "started (pid {})".format(proc.pid)


def _stop_orchestrator():
    """Terminate orchestrators THIS pack spawned. Stops every tracked backend
    process (claude on 9180, codex on 9181, …); a user-run orchestrator we never
    spawned is left running."""
    global _orchestrator_proc
    for proc in list(_orchestrator_procs.values()):
        if proc and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
    _orchestrator_procs.clear()
    # Cover the legacy global too (it always aliases the default-port proc, but be
    # defensive in case it was set without a matching map entry).
    if _orchestrator_proc and _orchestrator_proc.poll() is None:
        try:
            _orchestrator_proc.terminate()
        except Exception:
            pass
    _orchestrator_proc = None


def _reload_orchestrator():
    """Soft-reload: bounce a panel-spawned orchestrator in place so it picks up
    new code, WITHOUT touching ComfyUI. The panel resumes the chat via its saved
    session id, so the conversation continues seamlessly. Returns (ok, message).

    In NO_AUTOSPAWN mode we don't own the process, so this is a no-op spawn — the
    panel simply reconnects to the orchestrator the user manages (restart it
    yourself to pick up code changes).
    """
    if _no_autospawn():
        return True, "auto-start disabled; reconnecting to your orchestrator"

    # Stop our spawned proc AND any orchestrator named in the lockfile (covers a
    # proc spawned by a previous ComfyUI run we no longer track directly).
    _stop_orchestrator()
    lock = _read_lock()
    parent = lock.get("parent") if lock else None
    opid = lock.get("pid") if lock else None
    lock_is_ours = _lock_parent_is_current(lock)
    lock_is_orphan = _lock_parent_is_gone(lock)
    # Kill only a verified orchestrator pid — never a reused pid (pid-reuse safe).
    # _kill_pid re-verifies identity (cmdline + recorded creation time) right
    # before it signals, so a recycled pid can't be mistaken for ours and killed.
    if opid and (lock_is_ours or lock_is_orphan) and _is_orchestrator_process(opid):
        _kill_pid(opid, lock.get("pidStartedAt"))
    elif lock and parent and parent != os.getpid() and not lock_is_orphan:
        return False, (
            "the panel bridge port {} is owned by another live ComfyUI "
            "(pid {}). Not reloading it.".format(_BRIDGE_PORT, parent)
        )

    # Wait for the bridge port to free before spawning a fresh orchestrator.
    for _ in range(30):
        if not _port_in_use(_BRIDGE_HOST, _BRIDGE_PORT):
            break
        time.sleep(0.1)
    if _port_in_use(_BRIDGE_HOST, _BRIDGE_PORT):
        return False, (
            "the panel bridge port {} is still held by the previous orchestrator and "
            "couldn't be freed — try Disconnect then Connect, or fully restart "
            "ComfyUI.".format(_BRIDGE_PORT)
        )
    return _start_orchestrator()


def _hard_restart_orchestrator():
    """Force a truly fresh orchestrator: kill the verified orchestrator AND its
    whole child tree (clears a wedged Agent-SDK shell an in-place soft reload
    can't), delete the lockfile, then respawn. Pure Python over the local route,
    so it works even when the agent itself is unresponsive — the user's one-click
    escape from "the agent stopped answering" without Task Manager or a reboot.
    Returns (ok, message)."""
    if _no_autospawn():
        return False, (
            "auto-start is disabled (COMFYUI_MCP_NO_AUTOSPAWN) — restart your "
            "orchestrator process yourself."
        )

    _stop_orchestrator()
    lock = _read_lock()
    parent = lock.get("parent") if lock else None
    opid = lock.get("pid") if lock else None
    lock_is_ours = _lock_parent_is_current(lock)
    lock_is_orphan = _lock_parent_is_gone(lock)
    if opid and (lock_is_ours or lock_is_orphan) and _is_orchestrator_process(opid):
        _kill_orchestrator_tree(opid, lock.get("pidStartedAt"))
    elif lock and parent and parent != os.getpid() and not lock_is_orphan:
        return False, (
            "the panel bridge port {} is owned by another live ComfyUI "
            "(pid {}). Not restarting it.".format(_BRIDGE_PORT, parent)
        )

    _delete_lock()
    for _ in range(30):
        if not _port_in_use(_BRIDGE_HOST, _BRIDGE_PORT):
            break
        time.sleep(0.1)
    if _port_in_use(_BRIDGE_HOST, _BRIDGE_PORT):
        return False, (
            "the panel bridge port {} is still held after the restart — fully "
            "restart ComfyUI.".format(_BRIDGE_PORT)
        )
    return _start_orchestrator()


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

    @routes.get("/comfyui_mcp_panel/backends")
    async def _backends(_request):
        # Discovery for the panel's backend picker: each known backend with its
        # mapped port, whether an orchestrator is running there, and per-provider
        # readiness (cli/auth/ready) so the panel can show an onboarding card when
        # NEITHER provider is signed in and auto-pick a ready one otherwise.
        backends = [_backend_status(b) for b in _BACKEND_PORTS]
        return web.json_response(
            {
                "backends": backends,
                "any_ready": any(b["ready"] for b in backends),
            }
        )

    @routes.post("/comfyui_mcp_panel/connect")
    async def _connect(_request):
        # Backend selector: ?backend=codex query param OR {"backend": "codex"} JSON
        # body. Absent → "claude" (back-compat: the historical no-arg Connect path).
        # `force`/`reclaim` (query ?force=1 OR {"force": true} / {"reclaim": true}):
        # the panel's auto-reclaim safety net asks us to KILL a wedged orchestrator
        # that looks healthy by the lockfile but never handshook, and respawn fresh.
        backend = _request.query.get("backend")
        force = _truthy(_request.query.get("force")) or _truthy(_request.query.get("reclaim"))
        # Optional render-stall threshold (seconds) from the panel setting, applied
        # to the orchestrator's env on spawn.
        stall_seconds = _coerce_stall(_request.query.get("stall_seconds"))
        if not backend:
            try:
                body = await _request.json()
                if isinstance(body, dict):
                    backend = body.get("backend")
                    if not force:
                        force = bool(body.get("force") or body.get("reclaim"))
                    if stall_seconds is None:
                        stall_seconds = _coerce_stall(body.get("stall_seconds"))
            except Exception:
                backend = None
        # Reject a non-string backend with a clean 400 (e.g. {"backend": 123})
        # rather than letting .lower() raise a 500.
        if backend is not None and not isinstance(backend, str):
            return web.json_response(
                {"ok": False, "message": "backend must be a string"}, status=400
            )
        backend = (backend or _DEFAULT_BACKEND).lower()
        if backend not in _BACKEND_PORTS:
            return web.json_response(
                {"ok": False, "message": "unknown backend '{}'".format(backend)},
                status=400,
            )
        port = _backend_port(backend)
        ok, message = _start_orchestrator(backend=backend, port=port, force=force, stall_seconds=stall_seconds)
        return web.json_response(
            {
                "ok": ok,
                "running": _orchestrator_running(port),
                "backend": backend,
                "port": port,
                "forced": force,
                # The exact ws URL the panel should connect to — so the user never
                # types a port.
                "bridge_url": "ws://{}:{}".format(_BRIDGE_HOST, port),
                "message": message,
            },
            status=200 if ok else 503,
        )

    @routes.post("/comfyui_mcp_panel/disconnect")
    async def _disconnect(_request):
        # Only stops an orchestrator THIS pack spawned; a user-run one is left be.
        spawned = _orchestrator_proc is not None
        _stop_orchestrator()
        return web.json_response({"ok": True, "stopped": spawned, "running": _orchestrator_running()})

    @routes.post("/comfyui_mcp_panel/reload")
    async def _reload(_request):
        # Soft reload: respawn the orchestrator (new code) without restarting
        # ComfyUI. The panel reconnects and resumes the session afterward.
        ok, message = _reload_orchestrator()
        return web.json_response(
            {"ok": ok, "running": _orchestrator_running(), "port": _BRIDGE_PORT, "message": message},
            status=200 if ok else 503,
        )

    @routes.post("/comfyui_mcp_panel/hard_restart")
    async def _hard_restart(_request):
        # Recovery: kill the orchestrator + its whole child tree and respawn — the
        # fix for a wedged/unresponsive agent backend that a soft reload can't
        # clear. Pure Python, so it works even when the agent isn't answering.
        ok, message = _hard_restart_orchestrator()
        return web.json_response(
            {"ok": ok, "running": _orchestrator_running(), "port": _BRIDGE_PORT, "message": message},
            status=200 if ok else 503,
        )


_register_routes()
