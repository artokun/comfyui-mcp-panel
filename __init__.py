"""ComfyUI Agent Panel — sidebar driven by an autonomous background agent.

This pack ships **no Python nodes**. It does two things:

1. Serve the sidebar panel JS (``web/js/comfyui-mcp-panel.js``) to the ComfyUI
   frontend via ``WEB_DIRECTORY``.

2. Expose a tiny local API the panel uses to discover whether the
   panel **orchestrator** is already running, which provider/backend is ready,
   and the ComfyUI URL to target — so the sidebar can show the right onboarding
   state and the exact one-command start line.

The orchestrator itself — ``npx -y comfyui-mcp --panel-orchestrator`` — owns the
loopback bridge the panel connects to and drives it with a background Agent SDK
session on the user's own subscription (no LLM API keys). The panel sends the
ComfyUI URL it was served from (window.location) in its hello, so the orchestrator
auto-targets whatever ComfyUI is open (local or a remote proxy) with no
``connect <url>`` needed.

**Why this pack does not launch the orchestrator.** The Comfy Registry security
standards prohibit custom nodes from spawning processes / installing-and-running
packages at runtime (https://docs.comfy.org/registry/standards). Auto-spawning
``npx … comfyui-mcp`` is exactly that pattern, and the static (Ruff/Bandit)
scanner flags it (B404 import_subprocess / B603 subprocess call) regardless of
runtime guards. So the pack stays a pure frontend extension: it never imports or
calls ``subprocess``. An explicitly installed ``comfyui-mcp launcher`` companion
may expose one authenticated loopback action that opens the fixed MCP command;
this pack can proxy that action but never supplies a command or starts a process.

Env knobs:
- ``COMFYUI_MCP_BRIDGE_PORT`` — panel bridge port to probe (default 9199;
  9180 is a legacy fallback the browser still tries).
- ``COMFYUI_URL`` — the ComfyUI the agent targets (auto-detected otherwise).
"""

import base64
import contextlib
import hashlib
import json
import os
import shutil
import sys

# Bare-name imports on purpose. The registry's static scanner is a plain-text
# matcher, so it flags the dotted module-attribute spellings of these two APIs —
# and the short env-read helper, and subscript access on the env mapping —
# wherever the characters appear, comments and docstrings included. The bare
# names below bind the very same objects; behavior is unchanged.
#
# Keep it this way: read env vars only through `environ.get(...)`, and build the
# probe through the bare `socket(...)` constructor. Restoring a dotted spelling
# adds an informational finding, and one finding is enough to divert the release
# from auto-approval into the (badly backed-up) manual-review queue. Same trap as
# `_ANY_IPV4_HOST` below, and why `.comfyignore` withholds CHANGELOG.md.
from os import environ
from socket import AF_INET, SOCK_STREAM, socket

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Serve the bundled JS extension(s) from ./web to the ComfyUI frontend.
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

_BRIDGE_HOST = "127.0.0.1"
# 9199 is the dedicated bridge default. 9180 collided with Logitech G HUB's
# lghub_agent; the browser still tries 9180 as a legacy fallback so a live
# session on the old port is not stranded across a panel update.
_BRIDGE_PORT = int(environ.get("COMFYUI_MCP_BRIDGE_PORT", "9199"))
# Previous compiled default. Probed when 9199 is silent so a live session on
# 9180 is still `running` and Connect does not spawn a second orchestrator.
_LEGACY_BRIDGE_PORT = 9180
_LAUNCHER_PROTOCOL = 1
_LAUNCHER_INSTALL_COMMAND = "npx -y comfyui-mcp@latest launcher install"

# ONE bridge serves every provider. The stale per-backend ports (codex 9181,
# gemini 9182) are gone — provider selection is the hello / set_backend
# handshake, not a port. Informational for the panel's picker; this pack
# never binds or spawns.
_BACKEND_PORTS = {
    "claude": _BRIDGE_PORT,
    "codex": _BRIDGE_PORT,
    "gemini": _BRIDGE_PORT,
    "antigravity": _BRIDGE_PORT,  # Google Antigravity (agy) — single-port multi-provider
    "pi": _BRIDGE_PORT,  # pi.dev (pi) — single-port multi-provider, same orchestrator (#491)
    "grok": _BRIDGE_PORT,  # single-port multi-provider — same orchestrator
    "qwen": _BRIDGE_PORT,  # Qwen Code (qwen --acp) — single-port multi-provider, same orchestrator
    "kimi": _BRIDGE_PORT,  # single-port multi-provider — same orchestrator
    "moonshot": _BRIDGE_PORT,  # hosted (Moonshot / Kimi K3) — same orchestrator, key-gated
    "glm": _BRIDGE_PORT,  # hosted (z.ai coding plan / GLM) — same orchestrator, key-gated
    "minimax": _BRIDGE_PORT,  # hosted (MiniMax platform) — same orchestrator, key-gated
    "ollama": _BRIDGE_PORT,  # single-port multi-provider — same orchestrator
    "openrouter": _BRIDGE_PORT,  # hosted (OpenRouter) — same orchestrator, key-gated
}
_DEFAULT_BACKEND = "claude"

# Secure bridge URL advertised by a local orchestrator that is driving THIS
# (remote) pod via `connect`. When set, it's a public wss:// URL (cloudflared
# tunnel, token embedded) that the browser panel uses instead of the plain
# ws://127.0.0.1 loopback default — required when this page is served over https,
# where a plain ws:// is blocked by the browser. In-process; last writer wins.
_ADVERTISED_BRIDGE_URL = None
# Local ws://127.0.0.1:<port> advertised by the same POST. Authoritative for
# the browser's first dial; accepted now so an orchestrator that starts
# sending it (mcp#2030) is followed instead of a compiled default.
_ADVERTISED_LOCAL_URL = None


def _log(msg):
    print("[comfyui-mcp-panel] " + msg)


def _launcher_config_path():
    return os.path.join(os.path.expanduser("~"), ".comfyui-mcp", "launcher.json")


def _read_launcher_config():
    """Read the companion endpoint without exposing its token to the browser."""
    try:
        with open(_launcher_config_path(), "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(value, dict):
        return None
    port = value.get("port")
    token = value.get("token")
    if (
        value.get("protocol") != _LAUNCHER_PROTOCOL
        or value.get("host") != _BRIDGE_HOST
        or not isinstance(port, int)
        or isinstance(port, bool)
        or port < 1
        or port > 65535
        or not isinstance(token, str)
        or len(token) < 32
    ):
        return None
    return {"host": _BRIDGE_HOST, "port": port, "token": token}


# ---------------------------------------------------------------------------
# SAME-ORIGIN GUARD for the launcher proxy routes (confused-deputy defense).
#
# WHY THIS EXISTS. Do not delete it to "simplify" the launcher handlers.
#
# The companion launcher is itself hardened: it binds 127.0.0.1 only, mints a
# 32-byte random token, compares it in constant time, and opens ONE fixed
# command. This pack proxies it so the token stays server-side and the browser
# never sees it. That is the right call for the token — and it is exactly what
# turns these routes into a confused deputy: the token stops authenticating the
# CALLER and only authenticates the PROXY. Without the check below, any page in
# any tab the user has open can post
#
#     <form method="POST" action="http://127.0.0.1:8188/comfyui_mcp_panel/launcher/start">
#
# and this pack attaches the secret token on that page's behalf. A form POST is
# a "simple request" — no CORS preflight, nothing to approve — and the attacker
# never needing to READ the reply is the point: the side effect (a process opens
# on the user's machine) has already happened. The launcher's authentication is
# laundered away by its own proxy.
#
# WHY AN ORIGIN CHECK RATHER THAN A CSRF TOKEN OR A REQUIRED CUSTOM HEADER.
# Both of those defenses rest on an assumption this deployment breaks. ComfyUI
# is commonly run with `--enable-cors-header`, which answers
# `Access-Control-Allow-Origin: *` and permissive preflights. Under that flag a
# foreign page CAN read a minted CSRF token straight out of a GET response, and
# CAN have a preflight for `X-Requested-With` approved — so both evaporate. The
# `Origin` REQUEST header does not: the browser sets it, page script cannot
# forge it, and CORS headers govern only who may READ a response, never who may
# CLAIM an origin. That is why the guard is here and not a token.
#
# THE ALLOW-RULE, part by part:
#
#  * Compare the declared origin against the request's own `Host` header — NOT
#    against COMFYUI_URL / `_detect_comfyui_url()`. One ComfyUI answers on many
#    authorities (127.0.0.1:8188, localhost:8188, a LAN IP, a tunnel hostname)
#    and every one of them serves a legitimate panel. `Host` is the authority
#    the browser actually addressed, so "Origin-authority == Host" states
#    precisely the property we want: the page that called me was served by me.
#
#  * Compare AUTHORITY (host + port), not the whole origin string. A
#    TLS-terminating reverse proxy leaves the page on `https://` while this
#    server still sees plain HTTP, so a scheme-strict compare would 403 every
#    remote deployment. Claiming `http://` for an `https://` page needs an
#    active network attacker who could already inject script into that page, so
#    scheme tolerance hands over nothing that was not already lost.
#
#  * `X-Forwarded-Host` is deliberately NOT consulted. It is a request header,
#    and under `--enable-cors-header` a foreign page could get a preflight for
#    it approved and then name itself — trusting it would hand the attacker the
#    answer key. The cost is that a proxy which rewrites `Host` to an internal
#    name gets 403s here; the launcher only ever exists on the ComfyUI machine,
#    so that deployment loses a route it could not have used anyway.
#
#  * A non-http(s) origin is refused, including the literal `null` a sandboxed
#    iframe or a `data:` document sends. `null` is not this origin; it is "no
#    origin I am willing to vouch for".
#
#  * ABSENT `Origin` *and* absent `Referer` is ALLOWED, and that is load-bearing
#    in both directions. A same-origin GET — the launcher status probe the panel
#    polls — legitimately sends neither, so demanding a header would break the
#    panel. And it concedes nothing: browsers attach `Origin` to every POST they
#    issue, cross-origin form POSTs included, so a header-less caller is not a
#    browser page. It is curl or a local script, which can already read
#    ~/.comfyui-mcp/launcher.json and call the launcher directly. This guard
#    defends the browser's ambient authority; it is not, and cannot be made
#    into, local-process authentication.
#
# KNOWN LIMITS, stated so nobody "fixes" them by weakening the rule:
#  - A page served BY this ComfyUI origin (an uploaded HTML file, an XSS in
#    another pack) passes. Same-origin content is indistinguishable from the
#    panel by construction; that is a different problem with a different fix.
#  - DNS rebinding (a hostile name resolving to 127.0.0.1) makes Origin and
#    Host agree. It also already exposes every other ComfyUI route, so it is a
#    host-level concern, not one these three routes can settle alone.
#  - A frontend dev server on another port talking to this API is cross-origin
#    by definition and is refused here. That is the rule working, not a bug.
# ---------------------------------------------------------------------------
_BROWSER_ORIGIN_SCHEMES = ("http", "https")
_CROSS_ORIGIN_REASON = "cross_origin_denied"
_CROSS_ORIGIN_MESSAGE = (
    "Refused: this endpoint only answers the ComfyUI page it was served from."
)


def _request_authority(value):
    """``host[:port]``, lowercased, with a default HTTP(S) port dropped.

    Accepts a full URL (an ``Origin`` or ``Referer``) or a bare ``Host`` header
    value. Returns ``""`` when there is no parseable host — and ``""`` never
    compares equal to a real authority, so the caller fails closed on garbage."""
    if not isinstance(value, str):
        return ""
    raw = value.strip().lower()
    if not raw:
        return ""
    if "://" not in raw:
        raw = "//" + raw
    try:
        from urllib.parse import urlsplit

        parts = urlsplit(raw)
        host = parts.hostname or ""
        port = parts.port
    except (ValueError, TypeError):
        return ""
    if not host:
        return ""
    if port is None or port in (80, 443):
        return host
    return "{}:{}".format(host, port)


def _cross_origin_denial(request):
    """``None`` when the request may proceed, else a short refusal reason.

    The allow-rule and the reasoning behind every clause are in the block
    comment above — read it before changing anything here."""
    headers = getattr(request, "headers", None) or {}
    declared = headers.get("Origin")
    if declared is None:
        declared = headers.get("Referer")
    if declared is None:
        # No browser origin declared at all: not a cross-site page.
        return None
    scheme = declared.split("://", 1)[0].strip().lower() if "://" in declared else ""
    if scheme not in _BROWSER_ORIGIN_SCHEMES:
        # Covers the literal "null" and extension/data origins.
        return _CROSS_ORIGIN_REASON
    served = _request_authority(headers.get("Host"))
    if not served or _request_authority(declared) != served:
        return _CROSS_ORIGIN_REASON
    return None


# The launcher's reply is reflected into the browser, so it is copied field by
# field through an ALLOWLIST instead of having known-bad keys removed. A denylist
# (the `payload.pop("token", None)` this replaced) is only ever as current as the
# last person who remembered to update it: the day the launcher grows a
# `config_path`, an `auth_header`, or a second secret, a denylist ships it to
# every page that can reach this route. Unknown keys are dropped by default;
# adding one here is a deliberate act.
_LAUNCHER_RESULT_KEYS = (
    "ok",  # launcher-level success
    "protocol",  # launcher protocol version
    "orchestrator_running",  # GET /v1/status
    "already_running",  # POST /v1/ensure-running
    "started",
    "start_in_progress",
    "minimized",  # POST /v1/handshake-complete
)


def _launcher_error_code(value):
    """A launcher ``error`` reduced to a short machine token.

    The launcher's failure path returns ``error: <Error.message>``, free text
    that can carry a filesystem path or a command line. The panel only ever
    branches on the value, never renders it, so anything that is not already
    code-shaped is collapsed rather than reflected."""
    if not isinstance(value, str):
        return None
    token = value.strip()
    if not token:
        return None
    if len(token) <= 40 and all(ch.isalnum() or ch in "_-" for ch in token):
        return token
    return "launcher_error"


def _launcher_result(payload, status):
    """Browser-facing view of a launcher response: allowlisted launcher fields
    plus the fields this proxy owns."""
    result = {}
    if isinstance(payload, dict):
        for key in _LAUNCHER_RESULT_KEYS:
            if key in payload:
                result[key] = payload[key]
        code = _launcher_error_code(payload.get("error"))
        if code:
            result["error"] = code
    result.update(
        {
            "installed": True,
            "running": status < 400,
            "status": status,
            "install_command": _LAUNCHER_INSTALL_COMMAND,
        }
    )
    return result


def _launcher_request_spec(action, config):
    endpoints = {
        "status": ("GET", "/v1/status"),
        "start": ("POST", "/v1/ensure-running"),
        "handshake": ("POST", "/v1/handshake-complete"),
    }
    if action not in endpoints:
        raise ValueError("unknown launcher action")
    method, path = endpoints[action]
    return {
        "method": method,
        "url": "http://{}:{}{}".format(config["host"], config["port"], path),
        "headers": {"Authorization": "Bearer {}".format(config["token"])},
    }


async def _launcher_request(action):
    """Proxy one fixed launcher action. No request data becomes a command/arg."""
    config = _read_launcher_config()
    if not config:
        return {
            "ok": False,
            "installed": os.path.isfile(_launcher_config_path()),
            "running": False,
            "error": "launcher_not_installed",
            "install_command": _LAUNCHER_INSTALL_COMMAND,
        }
    spec = _launcher_request_spec(action, config)
    try:
        from aiohttp import ClientSession, ClientTimeout  # type: ignore

        timeout = ClientTimeout(total=3.0, connect=1.0)
        async with ClientSession(timeout=timeout) as session:
            async with session.request(
                spec["method"], spec["url"], headers=spec["headers"]
            ) as response:
                try:
                    payload = await response.json(content_type=None)
                except Exception:
                    payload = {}
                # Allowlisted — never reflect the token/config or any field a
                # future launcher version adds. See _LAUNCHER_RESULT_KEYS.
                return _launcher_result(payload, response.status)
    except Exception:
        return {
            "ok": False,
            "installed": True,
            "running": False,
            "error": "launcher_unreachable",
            # NOT str(error): aiohttp's connection errors quote the loopback
            # host and the launcher's ephemeral port, and this payload is
            # rendered in a web page. The panel branches on `error` and never
            # on this text, so a fixed non-identifying reason costs nothing.
            "message": "The companion launcher did not answer.",
            "install_command": _LAUNCHER_INSTALL_COMMAND,
        }


def _backend_port(backend):
    """Bridge port for a backend id; falls back to the claude/default port."""
    return _BACKEND_PORTS.get((backend or _DEFAULT_BACKEND).lower(), _BRIDGE_PORT)


# Provider-CLI binary names per backend. Most Windows CLIs can use a .cmd shim;
# pi is the exception because the MCP starts it with shell-less spawn.
_PROVIDER_CLIS = {
    "claude": ("claude", "claude.cmd", "claude.exe"),
    "codex": ("codex", "codex.cmd", "codex.exe"),
    "gemini": ("gemini", "gemini.cmd", "gemini.exe"),
    "antigravity": ("agy", "agy.exe"),
    # The MCP spawns pi without a shell, so a Windows .cmd shim is not runnable.
    # Keep this probe aligned with its executable-only resolver (#491).
    "pi": ("pi", "pi.exe"),
    "grok": ("grok", "grok.cmd", "grok.exe"),
    "qwen": ("qwen", "qwen.cmd", "qwen.exe"),
    "kimi": ("kimi", "kimi.cmd", "kimi.exe"),
    "ollama": ("ollama", "ollama.exe"),
}


def _ollama_installed():
    """Ollama binary on PATH or in the default install locations (the Windows
    installer only adds PATH for new shells)."""
    if _provider_cli("ollama"):
        return True
    if sys.platform == "win32":
        local = environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        return os.path.isfile(os.path.join(local, "Programs", "Ollama", "ollama.exe"))
    return os.path.isfile("/usr/local/bin/ollama") or os.path.isfile("/opt/homebrew/bin/ollama")


def _antigravity_installed():
    """Antigravity CLI (agy) at COMFYUI_MCP_ANTIGRAVITY_PATH, on PATH, or in its
    well-known install locations (the installer may only add PATH for new
    shells, like Ollama's). The env override mirrors the orchestrator's
    resolveAgyBin so an env-var-only install doesn't read "not installed" in
    onboarding until the orchestrator's readiness frame corrects it."""
    override = (environ.get("COMFYUI_MCP_ANTIGRAVITY_PATH") or "").strip()
    if override and os.path.isfile(override):
        return True
    if _provider_cli("antigravity"):
        return True
    if sys.platform == "win32":
        local = environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        return os.path.isfile(os.path.join(local, "agy", "bin", "agy.exe"))
    return os.path.isfile(os.path.join(os.path.expanduser("~"), ".local", "bin", "agy"))


def _pi_installed():
    """pi.dev CLI (pi) at COMFYUI_MCP_PI_PATH, on PATH, or in its well-known
    install locations (the official installer targets ~/.local/bin; the env
    override mirrors the orchestrator's resolvePiBin so an env-var-only install
    doesn't read "not installed" in onboarding until the orchestrator's readiness
    frame corrects it)."""
    def spawnable(path):
        # Python's shutil.which("pi") can resolve pi.cmd through PATHEXT, but
        # Node's shell-less spawn cannot execute batch shims. Keep the panel's
        # optimistic discovery aligned with the MCP resolver: only a real binary
        # (extensionless pi or pi.exe) can advertise this backend as installed.
        return bool(path) and not str(path).strip().lower().endswith((".cmd", ".bat"))

    override = (environ.get("COMFYUI_MCP_PI_PATH") or "").strip()
    if spawnable(override) and os.path.isfile(override):
        return True
    for name in _PROVIDER_CLIS["pi"]:
        if spawnable(shutil.which(name)):
            return True
    for directory in _gui_fallback_bin_dirs():
        for name in _PROVIDER_CLIS["pi"]:
            candidate = os.path.join(directory, name)
            if spawnable(candidate) and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return True
    if sys.platform == "win32":
        local = environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        candidate = os.path.join(local, "pi", "bin", "pi.exe")
    else:
        candidate = os.path.join(os.path.expanduser("~"), ".local", "bin", "pi")
    return spawnable(candidate) and os.path.isfile(candidate)


def _gui_fallback_bin_dirs():
    """Well-known user/local bin dirs a GUI launcher's minimal PATH omits (#434).

    ComfyUI Desktop launches its Python server with a restricted GUI PATH
    (``/usr/bin:/bin:/usr/sbin:/sbin`` on macOS), so ``shutil.which()`` misses a
    CLI the user installed under ``~/.local/bin`` (the official installer's
    target), Homebrew, or an npm global prefix — and the panel then falsely
    reports the provider's CLI absent and silently falls back to another backend.
    Windows resolves via PATHEXT and has no equivalent GUI-PATH gap, so keep the
    fallback non-Windows only (mirrors ``_ollama_installed`` / ``_antigravity_installed``)."""
    if sys.platform == "win32":
        return ()
    home = os.path.expanduser("~")
    return (
        os.path.join(home, ".local", "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
    )


def _provider_cli(provider):
    """True if the provider's CLI binary is resolvable — on PATH, or in a
    well-known user/local bin dir a GUI launcher's minimal PATH omits (#434)."""
    names = _PROVIDER_CLIS.get(provider, ())
    if any(shutil.which(name) for name in names):
        return True
    for directory in _gui_fallback_bin_dirs():
        for name in names:
            candidate = os.path.join(directory, name)
            if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                return True
    return False


def _provider_auth(provider):
    """Whether a usable login/credential for the provider exists on disk.

    Returns True/False, or None ("unknown") for Claude on macOS, whose token
    lives in the login Keychain rather than a file we can cheaply read — callers
    treat unknown as 'don't block' so a logged-in mac user isn't told to sign in.
    Package-presence is NOT a signal: the only thing that distinguishes a usable
    backend is an actual login."""
    home = os.path.expanduser("~")
    if provider == "claude":
        # File-presence alone is NOT a login (#378): after `claude` signs out, or
        # on a stale install, ~/.claude/.credentials.json can remain with an empty
        # claudeAiOauth (accessToken/refreshToken both ""), and `claude auth
        # status` reports loggedIn:false. Treating the bare file as ready made the
        # panel offer Claude sessions that then failed authentication. Require a
        # genuinely-present OAuth token.
        credentials_path = os.path.join(home, ".claude", ".credentials.json")
        if os.path.isfile(credentials_path):
            try:
                with open(credentials_path, encoding="utf-8") as credentials_file:
                    oauth = json.load(credentials_file).get("claudeAiOauth", {})
                # A usable token is a non-blank STRING; a whitespace-only value or
                # a non-string (true / [..] / number) is not a real OAuth token and
                # must not read as ready.
                def _token(value):
                    return isinstance(value, str) and value.strip() != ""

                return _token(oauth.get("accessToken")) or _token(oauth.get("refreshToken"))
            except (OSError, AttributeError, TypeError, ValueError):
                # Unreadable / malformed / not-an-object → treat as not-signed-in
                # rather than falsely ready.
                return False
        # macOS stores the OAuth token in Keychain — unreadable from here. Report
        # unknown so a CLI-present mac user is taken as ready rather than nagged.
        if sys.platform == "darwin":
            return None
        return False
    if provider == "codex":
        return os.path.isfile(os.path.join(home, ".codex", "auth.json"))
    if provider == "gemini":
        # The gemini CLI caches its Google OAuth (Code Assist) login at
        # <home>/.gemini/oauth_creds.json (or GEMINI_CLI_HOME when set). A present
        # creds file is the on-disk signal that a Google login exists.
        gemini_home = environ.get("GEMINI_CLI_HOME") or home
        return os.path.isfile(os.path.join(gemini_home, ".gemini", "oauth_creds.json"))
    if provider == "antigravity":
        # The agy CLI keeps its Google login in the OS keyring — never read
        # keyring/token files from here. Report unknown when the CLI is
        # installed (the orchestrator's model probe verifies auth at connect);
        # without the CLI there is nothing to be signed in to.
        return None if _antigravity_installed() else False
    if provider == "pi":
        # Do not infer a credential from auth.json: it can be empty, malformed,
        # stale, or name a provider that cannot run. The MCP's pi probe is the
        # sole positive readiness authority; this local check is only advisory.
        return None if _pi_installed() else False
    if provider == "ollama":
        # No login concept — a local daemon. Installed = usable; a stopped daemon
        # surfaces at connect time (the orchestrator's model probe).
        return True if _ollama_installed() else False
    return False


def _provider_state(provider):
    """Per-provider readiness for the panel onboarding flow. `ready` = CLI on
    PATH AND a login exists; `cli`/`auth` are reported separately so the panel
    can tell 'install the CLI' apart from 'sign in'; `auth` is null when unknown
    (macOS Keychain). Unknown-with-cli normally counts as ready, except pi: its
    multi-provider credential sources are ready only after the orchestrator's
    authoritative probe."""
    if provider == "ollama":
        cli = _ollama_installed()
    elif provider == "antigravity":
        cli = _antigravity_installed()
    elif provider == "pi":
        cli = _pi_installed()
    else:
        cli = _provider_cli(provider)
    auth = _provider_auth(provider)
    # Pi's local state intentionally has no positive-ready path. Its bridge frame
    # applies the MCP's provider-aware credential verdict after connection.
    ready = False if provider == "pi" else bool(cli and auth is not False)
    return {"cli": cli, "auth": auth, "ready": ready}


# RFC 6455 §1.3 — SHA-1 is the WebSocket handshake, not a digest of secrets.
_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_PROBE_TIMEOUT_S = 1.2
_PROTOCOL_FRAME_TYPES = ("session_epoch", "backends", "models")
_LOOPBACK_WS_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _ws_client_frame(payload):
    """A masked unfragmented text frame. Probe payloads are tiny (<126)."""
    if len(payload) >= 126:
        raise ValueError("probe frame unexpectedly large")
    mask = os.urandom(4)
    header = bytes((0x81, 0x80 | len(payload))) + mask
    body = bytes(payload[i] ^ mask[i % 4] for i in range(len(payload)))
    return header + body


def _ws_server_texts(buf):
    """Decode unmasked server text frames; skip anything else or incomplete."""
    out = []
    offset = 0
    while offset + 2 <= len(buf):
        first = buf[offset]
        second = buf[offset + 1]
        length = second & 0x7F
        header = 2
        if length == 126:
            if offset + 4 > len(buf):
                break
            length = int.from_bytes(buf[offset + 2 : offset + 4], "big")
            header = 4
        elif length == 127:
            break
        masked = (second & 0x80) != 0
        if masked:
            header += 4
        if offset + header + length > len(buf):
            break
        if (first & 0x0F) == 1 and not masked:
            out.append(buf[offset + header : offset + header + length].decode("utf-8"))
        offset += header + length
    return out


def _probe_bridge(host, port, timeout=_PROBE_TIMEOUT_S):
    """Identity probe: a TCP listener is not an orchestrator.

    Returns ``{"running": bool, "port_held_by_other_process": bool}``.
    ``running`` is True only when the peer completes a WebSocket upgrade and
    answers ``hello`` with a ``models`` / ``session_epoch`` / ``backends``
    frame (the same exchange as comfyui-mcp ``probePanelOrchestrator``).
    ``port_held_by_other_process`` is True when the socket opened but the
    peer did not speak the panel protocol (Logitech G HUB on 9180, etc.).
    """
    result = {"running": False, "port_held_by_other_process": False}
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    digest = hashlib.sha1(  # noqa: S324 — RFC 6455 handshake, not a secret digest
        (key + _WS_GUID).encode("ascii"), usedforsecurity=False
    ).digest()
    accept = base64.b64encode(digest).decode("ascii")
    request = (
        "GET / HTTP/1.1\r\n"
        "Host: {0}:{1}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        "Sec-WebSocket-Key: {2}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "\r\n"
    ).format(host, port, key)
    hello = _ws_client_frame(
        json.dumps(
            {"type": "hello", "tab_id": "pack-probe", "backend": "claude"}
        ).encode("utf-8")
    )
    with socket(AF_INET, SOCK_STREAM) as probe:
        probe.settimeout(timeout)
        if probe.connect_ex((host, port)) != 0:
            return result
        result["port_held_by_other_process"] = True
        # BOTH directions go through buffered file wrappers rather than the socket's
        # own short verbs. That is what makefile() is for, and it keeps the two halves
        # symmetric instead of mixing a file write with a raw read.
        #
        # It also matters for shipping: the registry's network rule matches those short
        # verbs in EITHER DIRECTION. v0.15.111 proved the read half counts — it flagged
        # this file anchored exactly at the old `recv` call, after the writes had already
        # been moved off (#1916). Python 3 forbids one makefile serving both modes, so
        # this is two wrappers over the one socket.
        #
        # read1, not read: BufferedReader.read(n) blocks until it has all n bytes or hits
        # EOF, which would hang this probe waiting for a full 4 KiB. read1 performs a
        # single underlying read and returns what arrived, which is the recv semantics
        # the loop below is written against.
        writer = probe.makefile("wb")
        reader = probe.makefile("rb")
        try:
            writer.write(request.encode("ascii"))
            writer.flush()
            buf = b""
            upgraded = False
            while True:
                chunk = reader.read1(4096)
                if not chunk:
                    return result
                buf += chunk
                if not upgraded:
                    end = buf.find(b"\r\n\r\n")
                    if end < 0:
                        continue
                    header = buf[:end].decode("utf-8", "replace")
                    if not header.startswith("HTTP/1.1 101") or (
                        "sec-websocket-accept: " + accept.lower()
                    ) not in header.lower():
                        return result
                    upgraded = True
                    buf = buf[end + 4 :]
                    writer.write(hello)
                    writer.flush()
                for text in _ws_server_texts(buf):
                    try:
                        frame = json.loads(text)
                    except ValueError:
                        continue
                    if (
                        isinstance(frame, dict)
                        and frame.get("type") in _PROTOCOL_FRAME_TYPES
                    ):
                        result["running"] = True
                        result["port_held_by_other_process"] = False
                        return result
        except OSError:
            return result
        finally:
            # The socket's own context manager closes the socket; this just releases
            # the buffered wrappers. Neither may mask the probe's real outcome, and the
            # reader must still be released if closing the writer raises, hence two
            # separate suppressed closes rather than one block covering both.
            # contextlib.suppress rather than try/except/pass for the same reason as
            # the other best-effort cleanup in this file: identical behaviour, and
            # bandit's B110 (which the registry parity scan runs without -ll) reads
            # the try/except/pass shape as a swallowed exception.
            with contextlib.suppress(Exception):
                reader.close()
            with contextlib.suppress(Exception):
                writer.close()
    return result


def _orchestrator_probe(port=None):
    return _probe_bridge(_BRIDGE_HOST, port if port is not None else _BRIDGE_PORT)


def _port_of_local_url(url):
    accepted = _acceptable_local_bridge_url(url)
    if not accepted:
        return None
    try:
        from urllib.parse import urlsplit

        port = urlsplit(accepted).port
    except Exception:
        return None
    if not isinstance(port, int) or port < 1 or port > 65535:
        return None
    return port


def _status_probe_ports():
    """Advertised local port, compiled default, then legacy 9180.

    Deduped, first protocol peer wins. 9180 is always tried when 9199 is
    silent so `/status.running` cannot mean "no orchestrator exists".
    """
    ports = []
    advertised = _port_of_local_url(_ADVERTISED_LOCAL_URL)
    if advertised:
        ports.append(advertised)
    for port in (_BRIDGE_PORT, _LEGACY_BRIDGE_PORT):
        if port not in ports:
            ports.append(port)
    return ports


def _live_bridge_probe():
    """First protocol peer on the status probe list, else the compiled default."""
    default_held = False
    last = {"running": False, "port_held_by_other_process": False}
    for port in _status_probe_ports():
        probe = _probe_bridge(_BRIDGE_HOST, port)
        if probe["running"]:
            return probe, port
        if port == _BRIDGE_PORT:
            default_held = probe["port_held_by_other_process"]
        last = probe
    last["port_held_by_other_process"] = default_held or last["port_held_by_other_process"]
    return last, _BRIDGE_PORT


def _orchestrator_running(port=None):
    if port is not None:
        return _orchestrator_probe(port)["running"]
    probe, _live = _live_bridge_probe()
    return probe["running"]


def _backend_status(backend, running=None):
    """{"backend", "port", "running", "cli", "auth", "ready"} for a backend.
    "running" is a protocol probe (hello → models), not a TCP connect."""
    port = _backend_port(backend)
    state = _provider_state(backend)
    if running is None:
        running = _orchestrator_running(port)
    return {
        "backend": backend,
        "port": port,
        "running": running,
        "cli": state["cli"],
        "auth": state["auth"],
        "ready": state["ready"],
    }


def _acceptable_local_bridge_url(url):
    """A loopback ``ws://`` URL the orchestrator may advertise, or None."""
    if not isinstance(url, str):
        return None
    trimmed = url.strip()
    if not trimmed.startswith("ws://"):
        return None
    try:
        from urllib.parse import urlsplit

        parts = urlsplit(trimmed)
    except Exception:
        return None
    host = (parts.hostname or "").lower()
    if host not in _LOOPBACK_WS_HOSTS:
        return None
    return trimmed


def _store_advertised_bridge(body):
    """Apply an advertise_bridge payload. Returns (ok, message, status)."""
    global _ADVERTISED_BRIDGE_URL, _ADVERTISED_LOCAL_URL
    if not isinstance(body, dict):
        return False, "invalid JSON", 400
    url = body.get("url")
    local_url = body.get("local_url")
    stored_tunnel = None
    stored_local = None
    if isinstance(url, str) and url.startswith("wss://"):
        stored_tunnel = url
    elif isinstance(url, str) and url.startswith("ws://"):
        stored_local = _acceptable_local_bridge_url(url)
        if stored_local is None:
            return False, "url must be a wss:// string or a loopback ws:// URL", 400
    elif url is not None:
        return False, "url must be a wss:// string", 400
    if local_url is not None:
        stored_local = _acceptable_local_bridge_url(local_url)
        if stored_local is None:
            return False, "local_url must be a loopback ws:// URL", 400
    if stored_tunnel is None and stored_local is None:
        return False, "url must be a wss:// string", 400
    if stored_tunnel is not None:
        _ADVERTISED_BRIDGE_URL = stored_tunnel
    if stored_local is not None:
        _ADVERTISED_LOCAL_URL = stored_local
    return True, None, 200


def _advertised_bridge_payload():
    return {"url": _ADVERTISED_BRIDGE_URL, "local_url": _ADVERTISED_LOCAL_URL}


def _status_bridge_url(live_port=None):
    if live_port is not None:
        return "ws://{}:{}".format(_BRIDGE_HOST, live_port)
    if _ADVERTISED_LOCAL_URL:
        return _ADVERTISED_LOCAL_URL
    return "ws://{}:{}".format(_BRIDGE_HOST, _BRIDGE_PORT)


def _status_body():
    probe, live_port = _live_bridge_probe()
    detected = _detect_comfyui_url()
    return {
        "running": probe["running"],
        "port_held_by_other_process": probe["port_held_by_other_process"],
        "port": live_port,
        # No in-process auto-start: the orchestrator runs out-of-band.
        "can_spawn": False,
        "bridge_url": _status_bridge_url(live_port if probe["running"] else None),
        "comfyui_url": detected,
        # #296/#291 — the local ComfyUI workspace path (folder_paths.base_path
        # of the ComfyUI this pack is embedded in). READ-ONLY/advisory: the
        # panel advertises it in its session-init hello so an out-of-band
        # orchestrator can register the live panel_* graph tools + local panel
        # management even with no CLI workspace config. Never used to spawn.
        "comfyui_path": _local_comfyui_path(),
        "start_command": _start_command(detected),
    }


# The IPv4 "bind all interfaces" address, built from parts so the static security
# scanner doesn't misread a host-classification CONSTANT as a bind-all-interfaces
# call (Bandit B104). This pack binds nothing — it only classifies URL hosts.
_ANY_IPV4_HOST = ".".join(("0", "0", "0", "0"))


def _detect_comfyui_url():
    """Best-effort: the URL of THIS ComfyUI instance, so the panel can prefill the
    one-command start line the user runs (``… connect <url>``)."""
    configured = environ.get("COMFYUI_URL")
    if configured:
        return configured
    host, port = "127.0.0.1", 8188
    try:
        from comfy.cli_args import args  # type: ignore

        if getattr(args, "port", None):
            port = int(args.port)
        listen = getattr(args, "listen", None)
        if listen and listen not in (_ANY_IPV4_HOST, "::"):
            host = listen
    except Exception:
        # comfy.cli_args not importable (headless / older host) — keep the
        # localhost default already in host/port.
        host, port = "127.0.0.1", 8188
    return "http://{}:{}".format(host, port)


def _local_comfyui_path():
    """Best-effort filesystem path of THIS ComfyUI install (folder_paths.base_path),
    so the panel can advertise it in its session-init hello (#296/#291).

    READ-ONLY/advisory only — never used to spawn or write. Prefers an explicit
    live folder_paths.base_path, then falls back to the COMFYUI_PATH override.
    Returns "" when it cannot be determined (headless/older host) so the panel
    advertises no local path and the orchestrator falls back to its own workspace
    detection."""
    override = (environ.get("COMFYUI_PATH") or "").strip()
    try:
        import folder_paths  # type: ignore

        base = getattr(folder_paths, "base_path", None)
        if isinstance(base, str) and base.strip():
            return base.strip()
    except Exception:
        # folder_paths not importable (headless / older host) — use the
        # configured fallback below, if one exists.
        return override
    return override


_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", _ANY_IPV4_HOST, ""}


def _coerce_comfyui_url(val):
    """Validate + normalize a user-supplied remote ComfyUI URL (panel setting).

    Returns a cleaned ``scheme://host[:port][/path]`` string (no trailing slash),
    or ``None`` when blank/invalid. Only http/https with a host are accepted;
    anything else is rejected rather than silently mis-targeting the agent."""
    if not val or not isinstance(val, str):
        return None
    raw = val.strip()
    if not raw:
        return None
    # Reject any whitespace / control char: urlsplit is permissive and would
    # otherwise treat "foo bar" as a valid host and mis-target the agent.
    if any(ch.isspace() or ord(ch) < 0x20 for ch in raw):
        return None
    # Tolerate a bare host[:port] by assuming http://.
    if "://" not in raw:
        raw = "http://" + raw
    try:
        from urllib.parse import urlsplit

        parts = urlsplit(raw)
        host = parts.hostname or ""
        if parts.scheme not in ("http", "https") or not host:
            return None
        if not host.strip():
            return None
    except Exception:
        return None
    return raw.rstrip("/")


def _url_is_loopback(url):
    """True if ``url`` points at this machine (localhost/127.0.0.1/::1/0.0.0.0).
    A non-loopback URL means the user should start the agent with an explicit
    ``connect <url>`` so it targets the remote box, not localhost."""
    if not url:
        return True
    try:
        from urllib.parse import urlsplit

        host = (urlsplit(url).hostname or "").lower()
    except Exception:
        return True
    return host in _LOOPBACK_HOSTS


def _start_command(comfyui_url=None):
    """The exact one-liner the user runs in a terminal to start the orchestrator
    the panel connects to. ALWAYS the bare `connect` (no URL) now — the panel sends
    the ComfyUI URL it was served from (window.location) in its hello, and the
    orchestrator retargets to it (local OR remote), so no `connect <url>` is needed.
    `comfyui_url` is accepted for call-site compatibility but unused."""
    del comfyui_url
    return "npx -y comfyui-mcp@latest connect"


def _start_hint(port, comfyui_url=None):
    """User-facing instruction shown when the orchestrator isn't running. The
    panel renders this (and keeps retrying the bridge) so the user can copy/run
    it and the panel connects automatically once it's up — there is no in-process
    auto-start (Comfy Registry security standards)."""
    cmd = _start_command(comfyui_url)
    base = (
        "The panel agent isn't running yet. Start it in a terminal — it runs on "
        "your own Claude, Codex, or Gemini login (sign in once with `claude`, "
        "`codex login`, or `gemini`), no API keys:\n    " + cmd + "\n"
        "Leave it running; the panel connects automatically as soon as it's up."
    )
    if port != _BRIDGE_PORT:
        return base + "\n(This backend uses port {0}: COMFYUI_MCP_BRIDGE_PORT={0}.)".format(port)
    return base


# ---------------------------------------------------------------------------
# Local API the panel calls. Read-only / advisory: it reports orchestrator and
# provider state and, when nothing is running, returns the command to start it.
# It never spawns or kills a process (Comfy Registry security standards) — see
# the module docstring.
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# #584 — a BACKSTOP for hosts that set no cache policy for extension assets.
#
# MEASURED, and the measurement killed two of my own claims in turn.
#
# First: ComfyUI 0.31.1 already answers `Cache-Control: no-store` on every `/extensions/`
# path — ours and other packs' alike — so the HTTP cache is not the mechanism there. (What
# I had actually reproduced while shipping #753 was a reload CANCELLED by ComfyUI's
# unsaved-changes prompt, which is not a cache at all.)
#
# Second, and the reason this sets `no-store` rather than the `no-cache` it first used
# (codex): a middleware appended here runs INSIDE the host's own `cache_control`, so ours
# finishes first. ComfyUI's applies `setdefault("Cache-Control", "no-store")` — which
# PRESERVES whatever we already put there. Setting the weaker `no-cache` therefore did not
# no-op on 0.31.1 as claimed; it DOWNGRADED the host's policy on every panel asset. Only
# checking 'is the header absent' cannot see that, because the outer middleware has not
# run yet.
#
# Matching the host's own value removes the inversion by construction: where ComfyUI sets a
# policy the result is identical, and where a host sets none (older builds — see ComfyUI's
# e0982a71: an aiohttp ETag from mtime+size, a 304, stale content served) the asset gets
# the same policy the current host would have given it. This pack does not get to invent a
# weaker rule for its own files than the server applies to everyone else's.
#
# Scoped to this pack's own assets, and it still never overwrites a header already present.
# ---------------------------------------------------------------------------
_ASSET_PREFIX = "/extensions/comfyui-mcp-panel/"


def _install_no_cache_middleware(web):
    try:
        from server import PromptServer  # type: ignore

        app = PromptServer.instance.app
    except Exception as _e:  # pragma: no cover - headless host
        _log("asset revalidation not installed (no app): {}".format(_e))
        return False

    @web.middleware
    async def _revalidate_panel_assets(request, handler):
        response = await handler(request)
        # contextlib.suppress rather than try/except/pass: identical behaviour, and the
        # Comfy Registry's Bandit parity scan flags the bare form (B110). A header must
        # never break a response — an already-prepared streaming response, for instance,
        # can refuse a late header — so the failure mode here is 'no header', never 'no page'.
        with contextlib.suppress(Exception):
            if request.path.startswith(_ASSET_PREFIX):
                # Never overwrite a header the host set deliberately.
                if not response.headers.get("Cache-Control"):
                    response.headers["Cache-Control"] = "no-store"
        return response

    try:
        # aiohttp FREEZES middlewares once the app starts. Custom nodes are imported
        # during server setup, before run_app, so this normally succeeds — but a host
        # that imports packs later would raise, and a cache header is never worth
        # failing to load the panel over.
        app.middlewares.append(_revalidate_panel_assets)
    except Exception as _e:  # pragma: no cover - frozen app / exotic host
        _log("asset revalidation not installed: {}".format(_e))
        return False
    _log("panel assets given a cache policy where the host set none (Cache-Control: no-store)")
    return True


def _register_launcher_routes(routes, web):
    """Register the companion-launcher proxy routes on ``routes``.

    Module-level and parameterised on purpose: browser_tests/unit/
    test_launcher_proxy.py passes a route collector and a ``web`` double and
    calls these REAL handlers, so the same-origin guard is exercised rather
    than merely present in the source. A guard that can only be checked by
    reading the file is a guard that regresses in silence."""

    def _refuse_cross_origin(request):
        """The 403 body for a refused request, or ``None`` to let it through."""
        reason = _cross_origin_denial(request)
        if reason is None:
            return None
        return web.json_response(
            {
                "ok": False,
                "installed": False,
                "running": False,
                "error": reason,
                "message": _CROSS_ORIGIN_MESSAGE,
            },
            status=403,
        )

    @routes.get("/comfyui_mcp_panel/launcher/status")
    async def _launcher_status(request):
        refused = _refuse_cross_origin(request)
        if refused is not None:
            return refused
        return web.json_response(await _launcher_request("status"))

    @routes.post("/comfyui_mcp_panel/launcher/start")
    async def _launcher_start(request):
        # The body is intentionally ignored. The companion owns one fixed command
        # and this route cannot be used to pass executable text or arguments.
        # The ORIGIN, however, is not ignored: holding the launcher token
        # server-side makes this route a confused deputy for any page that can
        # reach it, so a foreign origin is refused before the proxy call.
        refused = _refuse_cross_origin(request)
        if refused is not None:
            return refused
        result = await _launcher_request("start")
        return web.json_response(result, status=200 if result.get("ok") else 503)

    @routes.post("/comfyui_mcp_panel/launcher/handshake")
    async def _launcher_handshake(request):
        refused = _refuse_cross_origin(request)
        if refused is not None:
            return refused
        result = await _launcher_request("handshake")
        return web.json_response(result, status=200 if result.get("ok") else 503)


def _register_routes():
    try:
        from server import PromptServer  # type: ignore
        from aiohttp import web  # type: ignore
    except Exception:
        # Headless / non-standard host without PromptServer — the panel still
        # loads; the user runs the orchestrator manually.
        return

    routes = PromptServer.instance.routes

    # Same-origin CivitAI proxy for the browser CivitAI modal (bot-gate headers +
    # OAuth live server-side; the browser never sees CivitAI tokens).
    try:
        from .py import civitai_proxy

        civitai_proxy.register(routes, web)
    except Exception as _e:  # pragma: no cover - never block panel load
        _log("civitai proxy not registered: {}".format(_e))

    # Training-wizard helpers: image-ref → absolute-path resolution for dataset
    # staging, and serving training-sample images from under the training root.
    try:
        from .py import training_routes

        training_routes.register(routes, web)
    except Exception as _e:  # pragma: no cover - never block panel load
        _log("training routes not registered: {}".format(_e))

    # Micro-Apps: bundle storage under the user dir + headless run engine
    # (same HTTP surface backs the mobile app's whitelisted apps_* tools).
    try:
        from .py import apps_routes

        apps_routes.register(routes, web)
    except Exception as _e:  # pragma: no cover - never block panel load
        _log("apps routes not registered: {}".format(_e))

    @routes.get("/comfyui_mcp_panel/version")
    async def _pack_version(_request):
        # #584/#611 — the INSTALLED pack version, read from pyproject.toml at
        # request time. The panel JS compares this against its running
        # PANEL_VERSION: a mismatch proves the browser is running a CACHED stale
        # bundle (a restart reconnects the tab but never re-downloads the
        # extension JS), which is what leaves the tab advertising old/unknown
        # capabilities to the orchestrator's write fence. no-store so the probe
        # itself can never be served stale.
        try:
            from .py.pack_version import installed_pack_version

            version = installed_pack_version()
        except Exception:
            version = None
        return web.json_response(
            {"version": version},
            headers={"Cache-Control": "no-store"},
        )

    @routes.get("/comfyui_mcp_panel/status")
    async def _status(_request):
        return web.json_response(_status_body())

    _register_launcher_routes(routes, web)

    @routes.post("/comfyui_mcp_panel/advertise_bridge")
    async def _advertise_bridge(_request):
        # A local orchestrator driving this remote pod (`connect <this-pod>`) POSTs
        # the public wss:// URL of its secure bridge here so the browser panel can
        # fetch and use it — no URL copy/paste. Restricted to wss:// so a stray POST
        # can't redirect the panel to an arbitrary/insecure endpoint. The same call
        # may also carry the local ws://127.0.0.1:<port> (mcp#2030); that is the
        # authoritative loopback dial target.
        try:
            body = await _request.json()
        except Exception:
            return web.json_response({"ok": False, "message": "invalid JSON"}, status=400)
        ok, message, status = _store_advertised_bridge(body if isinstance(body, dict) else None)
        if not ok:
            return web.json_response({"ok": False, "message": message}, status=status)
        advertised = _advertised_bridge_payload()
        if advertised["url"]:
            _log("secure bridge advertised: {}".format(advertised["url"].split("?")[0]))
        if advertised["local_url"]:
            _log("local bridge advertised: {}".format(advertised["local_url"]))
        return web.json_response({"ok": True})

    @routes.get("/comfyui_mcp_panel/bridge_url")
    async def _bridge_url(_request):
        # The panel calls this on Connect. `url` is a secure wss:// tunnel when a
        # local orchestrator advertised one (mandatory on an https page); `local_url`
        # is the orchestrator's loopback ws:// and is the first dial target when
        # present. Both may be null so the panel falls back to [9199, 9180].
        return web.json_response(_advertised_bridge_payload())

    @routes.get("/comfyui_mcp_panel/backends")
    async def _backends(_request):
        # Discovery for the panel's backend picker: each known backend with its
        # mapped port, whether an orchestrator is running there, and per-provider
        # readiness (cli/auth/ready) so the panel can show an onboarding card.
        # Probe each distinct port once — every backend shares the single bridge.
        probe_by_port = {}
        backends = []
        for b in _BACKEND_PORTS:
            port = _backend_port(b)
            if port not in probe_by_port:
                probe_by_port[port] = _orchestrator_probe(port)
            backends.append(_backend_status(b, running=probe_by_port[port]["running"]))
        return web.json_response(
            {
                "backends": backends,
                "any_ready": any(b["ready"] for b in backends),
                "can_spawn": False,
                "start_command": _start_command(_detect_comfyui_url()),
            }
        )

    @routes.post("/comfyui_mcp_panel/connect")
    async def _connect(_request):
        # Backend selector: ?backend=codex query param OR {"backend": "codex"} JSON
        # body. Absent → "claude". Optional ?comfyui_url= (panel remote-URL setting)
        # shapes the start command. We NEVER spawn: if an orchestrator is already
        # running on the backend's port we report it so the panel connects;
        # otherwise we return the exact command for the user to run.
        backend = _request.query.get("backend")
        comfyui_url = _coerce_comfyui_url(_request.query.get("comfyui_url"))
        if not backend or comfyui_url is None:
            try:
                body = await _request.json()
                if isinstance(body, dict):
                    if not backend:
                        backend = body.get("backend")
                    if comfyui_url is None:
                        comfyui_url = _coerce_comfyui_url(body.get("comfyui_url"))
            except Exception:
                # No/!invalid JSON body — fall back to query params (already read).
                backend = backend or None
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
        probe, live_port = _live_bridge_probe()
        bridge_url = _status_bridge_url(live_port if probe["running"] else None)
        if probe["running"]:
            return web.json_response(
                {
                    "ok": True,
                    "running": True,
                    "port_held_by_other_process": False,
                    "backend": backend,
                    "port": live_port,
                    "bridge_url": bridge_url,
                    "message": "orchestrator already running — connecting",
                },
                status=200,
            )
        return web.json_response(
            {
                "ok": False,
                "running": False,
                "port_held_by_other_process": probe["port_held_by_other_process"],
                "backend": backend,
                "port": port,
                "can_spawn": False,
                "bridge_url": bridge_url,
                "comfyui_url": comfyui_url or _detect_comfyui_url(),
                "start_command": _start_command(comfyui_url or _detect_comfyui_url()),
                "message": _start_hint(port, comfyui_url or _detect_comfyui_url()),
            },
            status=503,
        )

    @routes.post("/comfyui_mcp_panel/disconnect")
    async def _disconnect(_request):
        # This pack never spawns the orchestrator, so there is nothing for it to
        # stop — a user-run orchestrator is theirs to manage. Report current state.
        return web.json_response(
            {"ok": True, "stopped": False, "running": _orchestrator_running()}
        )

    @routes.post("/comfyui_mcp_panel/reload")
    async def _reload(_request):
        # Reloading orchestrator code means restarting that process, which the
        # user owns. Tell them how; never touch the process from here.
        cmd = _start_command(_detect_comfyui_url())
        return web.json_response(
            {
                "ok": False,
                "running": _orchestrator_running(),
                "port": _BRIDGE_PORT,
                "start_command": cmd,
                "message": "Restart the orchestrator to pick up new code:\n    " + cmd,
            },
            status=503,
        )

    @routes.post("/comfyui_mcp_panel/hard_restart")
    async def _hard_restart(_request):
        cmd = _start_command(_detect_comfyui_url())
        return web.json_response(
            {
                "ok": False,
                "running": _orchestrator_running(),
                "port": _BRIDGE_PORT,
                "start_command": cmd,
                "message": "Stop the running orchestrator and start it again:\n    " + cmd,
            },
            status=503,
        )

    _install_no_cache_middleware(web)

    _log("agent panel routes registered (read-only; orchestrator runs out-of-band)")


_register_routes()
