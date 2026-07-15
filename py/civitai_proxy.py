"""Same-origin CivitAI proxy for the panel's browser UI.

A browser cannot call ``civitai.red`` directly: CORS blocks it and JS cannot set
the ``User-Agent`` / ``Referer`` bot-gate headers CivitAI requires. So the panel's
CivitAI modal talks to these ComfyUI-origin routes instead, and this module — which
runs in the ComfyUI process — makes the real, header-injected calls server-side.

Routes (all under ``/comfyui_mcp_panel/civitai``):
  GET/POST /api            JSON passthrough to an allow-listed CivitAI host.
  GET      /media          Stream CDN image/video bytes (for <img>/<video> src).
  GET      /oauth/start    Begin the OAuth (PKCE) sign-in; returns the authorize URL.
  GET      /oauth/callback OAuth redirect target; exchanges the code for tokens.
  GET      /oauth/status   Whether a valid session exists.
  POST     /oauth/logout   Drop the stored session.

The CivitAI OAuth tokens and the optional ``CIVITAI_API_TOKEN`` never reach the
browser — only this server-side module reads them.
"""

import base64
import hashlib
import json
import os
import time
from urllib.parse import urlencode, urlparse

# --- CivitAI contract (mirrors comfyui-mcp-mobile/lib/features/civitai) ---------
_API_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Referer": "https://civitai.red/",
}
_CDN_BASE = "https://image.civitai.com"
_CDN_TOKEN = "xG1nkqKTMzGDvpLrqFT7WA"

# Only these hosts may be proxied (SSRF guard).
_ALLOWED_HOSTS = frozenset(
    {
        "civitai.red",
        "search-new.civitai.com",
        "image.civitai.com",
        "auth.civitai.com",
    }
)

_OAUTH_CLIENT_ID = "1913e640-a9f7-4a4e-ae14-844d3b347555"  # public native client, no secret
_OAUTH_SCOPE = "262177"  # UserRead | MediaRead | CollectionsRead
_OAUTH_AUTHORIZE = "https://auth.civitai.com/api/auth/oauth/authorize"
_OAUTH_TOKEN = "https://auth.civitai.com/api/auth/oauth/token"
_CALLBACK_PATH = "/comfyui_mcp_panel/civitai/oauth/callback"


def _token_path():
    """Server-side JSON file holding the OAuth session. Under the ComfyUI user dir
    when available, else the pack directory."""
    try:
        import folder_paths  # type: ignore

        base = folder_paths.get_user_directory()
    except Exception:
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    d = os.path.join(base, "comfyui-mcp-panel")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return os.path.join(d, "civitai-oauth.json")


def _load_tokens():
    try:
        with open(_token_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _save_tokens(tok):
    try:
        with open(_token_path(), "w", encoding="utf-8") as f:
            json.dump(tok, f)
    except Exception:
        pass


def _clear_tokens():
    try:
        os.remove(_token_path())
    except Exception:
        pass


# Pending PKCE flows keyed by `state` (verifier + redirect), cleared on callback.
_pending = {}


def _pkce_pair():
    verifier = base64.urlsafe_b64encode(os.urandom(48)).rstrip(b"=").decode("ascii")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def _host_ok(url):
    try:
        return urlparse(url).hostname in _ALLOWED_HOSTS
    except Exception:
        return False


async def _valid_access_token(session):
    """Return a non-expired access token, refreshing if needed; None if signed out."""
    tok = _load_tokens()
    if not tok or not tok.get("access"):
        return None
    if tok.get("exp", 0) > time.time() + 60:
        return tok["access"]
    refresh = tok.get("refresh")
    if not refresh:
        return None
    try:
        async with session.post(
            _OAUTH_TOKEN,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh,
                "client_id": _OAUTH_CLIENT_ID,
            },
            headers={"content-type": "application/x-www-form-urlencoded"},
        ) as resp:
            if resp.status != 200:
                _clear_tokens()
                return None
            data = await resp.json()
    except Exception:
        return None
    new = {
        "access": data.get("access_token"),
        "refresh": data.get("refresh_token") or refresh,
        "exp": time.time() + int(data.get("expires_in", 3600)),
    }
    if not new["access"]:
        return None
    _save_tokens(new)
    return new["access"]


def register(routes, web):
    """Register the CivitAI proxy routes on ``PromptServer.instance.routes``."""
    import aiohttp  # ComfyUI ships aiohttp

    def _session():
        return aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30))

    async def _authed_headers(session, want_auth):
        headers = dict(_API_HEADERS)
        if want_auth:
            access = await _valid_access_token(session)
            if access:
                headers["Authorization"] = "Bearer " + access
        return headers

    @routes.post("/comfyui_mcp_panel/civitai/api")
    async def _civitai_api(request):
        # Body: {url, method?, headers?, body?, auth?}. `url` must be an allow-listed
        # CivitAI host. Retries 503/429 with backoff (mirrors the mobile _get()).
        try:
            spec = await request.json()
        except Exception:
            return web.json_response({"error": "invalid JSON"}, status=400)
        url = spec.get("url")
        if not isinstance(url, str) or not _host_ok(url):
            return web.json_response({"error": "url host not allowed"}, status=400)
        method = (spec.get("method") or "GET").upper()
        extra = spec.get("headers") if isinstance(spec.get("headers"), dict) else {}
        body = spec.get("body")

        async with _session() as session:
            headers = await _authed_headers(session, bool(spec.get("auth")))
            headers.update(extra)
            data = None
            if body is not None:
                data = body if isinstance(body, str) else json.dumps(body)
                headers.setdefault("content-type", "application/json")
            for attempt in range(3):
                try:
                    async with session.request(
                        method, url, data=data, headers=headers
                    ) as resp:
                        if resp.status in (429, 503) and attempt < 2:
                            import asyncio

                            await asyncio.sleep(0.35 * (2**attempt))
                            continue
                        text = await resp.text()
                        return web.Response(
                            body=text,
                            status=resp.status,
                            content_type="application/json",
                        )
                except Exception as e:  # network flake
                    if attempt == 2:
                        return web.json_response({"error": str(e)}, status=502)
        return web.json_response({"error": "unreachable"}, status=502)

    @routes.get("/comfyui_mcp_panel/civitai/media")
    async def _civitai_media(request):
        # ?uuid=&transform=&ext=  → stream the CDN bytes with bot-gate headers.
        uuid = request.query.get("uuid", "")
        transform = request.query.get("transform", "width=450")
        ext = request.query.get("ext", "jpeg")
        if not uuid:
            return web.Response(status=400, text="uuid required")
        url = "{}/{}/{}/{}/x.{}".format(_CDN_BASE, _CDN_TOKEN, uuid, transform, ext)
        async with _session() as session:
            try:
                async with session.get(url, headers=_API_HEADERS) as resp:
                    if resp.status != 200:
                        return web.Response(status=resp.status)
                    ctype = resp.headers.get("Content-Type", "application/octet-stream")
                    payload = await resp.read()
                    return web.Response(
                        body=payload,
                        content_type=ctype.split(";")[0],
                        headers={"Cache-Control": "public, max-age=86400"},
                    )
            except Exception as e:
                return web.Response(status=502, text=str(e))

    @routes.get("/comfyui_mcp_panel/civitai/oauth/start")
    async def _oauth_start(request):
        origin = request.query.get("origin", "")
        if not origin.startswith("http"):
            return web.json_response({"error": "origin required"}, status=400)
        verifier, challenge = _pkce_pair()
        state = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=").decode("ascii")
        redirect = origin.rstrip("/") + _CALLBACK_PATH
        _pending[state] = {"verifier": verifier, "redirect": redirect, "at": time.time()}
        # prune stale pending flows (>10 min)
        for k in [k for k, v in _pending.items() if time.time() - v["at"] > 600]:
            _pending.pop(k, None)
        params = {
            "response_type": "code",
            "client_id": _OAUTH_CLIENT_ID,
            "redirect_uri": redirect,
            "scope": _OAUTH_SCOPE,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        return web.json_response({"authorize_url": _OAUTH_AUTHORIZE + "?" + urlencode(params)})

    @routes.get("/comfyui_mcp_panel/civitai/oauth/callback")
    async def _oauth_callback(request):
        code = request.query.get("code")
        state = request.query.get("state")
        pend = _pending.pop(state, None) if state else None
        if not code or not pend:
            return web.Response(
                status=400,
                content_type="text/html",
                text="<h3>CivitAI sign-in failed</h3><p>You can close this window.</p>",
            )
        async with _session() as session:
            try:
                async with session.post(
                    _OAUTH_TOKEN,
                    data={
                        "grant_type": "authorization_code",
                        "code": code,
                        "redirect_uri": pend["redirect"],
                        "client_id": _OAUTH_CLIENT_ID,
                        "code_verifier": pend["verifier"],
                    },
                    headers={"content-type": "application/x-www-form-urlencoded"},
                ) as resp:
                    data = await resp.json()
            except Exception as e:
                return web.Response(status=502, content_type="text/html", text=str(e))
        access = data.get("access_token")
        if not access:
            return web.Response(
                status=400,
                content_type="text/html",
                text="<h3>CivitAI sign-in failed</h3><p>You can close this window.</p>",
            )
        _save_tokens(
            {
                "access": access,
                "refresh": data.get("refresh_token"),
                "exp": time.time() + int(data.get("expires_in", 3600)),
            }
        )
        return web.Response(
            content_type="text/html",
            text=(
                "<html><body style='font-family:sans-serif;background:#18181b;"
                "color:#eee;padding:2rem'><h3>Signed in to CivitAI ✓</h3>"
                "<p>You can close this window and return to ComfyUI.</p>"
                "<script>window.close()</script></body></html>"
            ),
        )

    @routes.get("/comfyui_mcp_panel/civitai/oauth/status")
    async def _oauth_status(_request):
        async with _session() as session:
            access = await _valid_access_token(session)
        return web.json_response({"signed_in": bool(access)})

    @routes.post("/comfyui_mcp_panel/civitai/oauth/logout")
    async def _oauth_logout(_request):
        _clear_tokens()
        return web.json_response({"ok": True})
