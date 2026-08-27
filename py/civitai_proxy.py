"""Same-origin CivitAI proxy for the panel's browser UI.

A browser cannot call ``civitai.red`` directly: CORS blocks it and JS cannot set
the ``User-Agent`` / ``Referer`` bot-gate headers CivitAI requires. So the panel's
CivitAI modal talks to these ComfyUI-origin routes instead, and this module — which
runs in the ComfyUI process — makes the real, header-injected calls server-side.

Routes (all under ``/comfyui_mcp_panel/civitai``):
  GET/POST /api            JSON passthrough to an allow-listed CivitAI host.
  GET      /media          Stream CDN image/video bytes (for <img>/<video> src).
  GET      /download       Stream a model-version file (workflow .json/.zip);
                           follows civitai's 307 to the signed CDN URL here,
                           dropping the Authorization header on the hop.
  GET      /oauth/start    Begin the OAuth (PKCE) sign-in; returns the authorize URL.
  GET      /oauth/callback OAuth redirect target; exchanges the code for tokens.
  GET      /oauth/status   Whether a valid session exists.
  POST     /oauth/logout   Drop the stored session.

The CivitAI OAuth tokens and the optional ``CIVITAI_API_TOKEN`` never reach the
browser — only this server-side module reads them.
"""

import base64
import hashlib
import ipaddress
import json
import logging
import os
import socket
import time
from urllib.parse import urlencode, urlparse

_log = logging.getLogger("comfyui_mcp_panel.civitai")

# --- CivitAI contract (mirrors comfyui-mcp-mobile/lib/features/civitai) ---------
_API_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    ),
    "Referer": "https://civitai.red/",
}
_CDN_BASE = "https://image.civitai.com"
_CDN_KEY = "xG1nkqKTMzGDvpLrqFT7WA"
# Model-version file download endpoint. A module constant (not an inline literal)
# so the aiohttp-level integration test can point it at a local mock server.
_DOWNLOAD_BASE = "https://civitai.red/api/download/models/"

# Upper bound on a single proxied JSON body (/api). /media and /download were
# both capped and /api was not, so an accidental or hostile multi-hundred-MB
# upstream body was buffered whole inside the ComfyUI process and then shipped to
# the browser. Generous for anything CivitAI really returns — a 100-item
# /v1/models page is a few hundred KB.
#
# An over-cap body is REFUSED, never truncated: half a JSON document would reach
# the panel as an unparseable body, i.e. a brand-new misleading error substituted
# for the one #705 removed. Module-level (like _DOWNLOAD_BASE) so the
# aiohttp-level test can shrink it instead of moving 16 MB through the loopback.
_API_CAP = 16 * 1024 * 1024

# Marker stamped on error bodies THIS MODULE generates, so the panel can tell
# them apart from a body CivitAI produced (#705). Without it the browser sees
# only "some JSON with an error field" and would quote our own guard rails back
# at the user as "CivitAI said: redirect target not allowed" — the same class of
# misattribution the issue is about, just pointed the other way. Bodies forwarded
# from upstream are NEVER stamped: an absent marker means CivitAI spoke.
_PROXY_SOURCE = "comfyui-mcp-panel"


def _proxy_error(web, message, status, retryable=False):
    """A JSON error THIS proxy authored, tagged so the panel attributes it to the
    panel rather than to CivitAI.

    ``retryable`` is declared here rather than inferred from the status, because
    the status belongs to US and says nothing about whether trying again helps: a
    502 from the "could not reach CivitAI" path is worth retrying, and a 502 from
    the redirect allow-list guard is a deterministic refusal that will fail
    identically forever. Guessing from the number would tell the user to retry a
    request that cannot succeed — the wrong-advice half of #705.
    """
    return web.json_response(
        {"error": message, "source": _PROXY_SOURCE, "retryable": bool(retryable)},
        status=status,
    )


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
# UserRead(1) | MediaRead(32) | CollectionsRead(131072) | CollectionsWrite(262144)
# | SocialWrite(524288) — SocialWrite is what reaction.toggle needs; the original
# 262177 mislabeled 262144 as CollectionsRead, so likes/collections 403'd.
_OAUTH_SCOPE = "917537"
_OAUTH_AUTHORIZE = "https://auth.civitai.com/api/auth/oauth/authorize"
_OAUTH_EXCHANGE_URL = "https://auth.civitai.com/api/auth/oauth/token"
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
        _log.debug("civitai token-store op failed", exc_info=True)
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
        _log.debug("civitai token-store op failed", exc_info=True)


def _clear_tokens():
    try:
        os.remove(_token_path())
    except Exception:
        _log.debug("civitai token-store op failed", exc_info=True)


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


# --- /download redirect SSRF guard -------------------------------------------
# civitai's signed download URLs live on a few CDN hosts. Live-verified 2026-07:
#   * signed-OUT / older files  → b2.civitai.com (Backblaze B2)
#   * signed-IN / newer files   → civitai's Cloudflare R2 delivery worker,
#       civitai-delivery-worker-prod.<civitai-account>.r2.cloudflarestorage.com
# A /download redirect may ONLY land on these — a compromised upstream must not
# be able to steer this server-side fetch at loopback/RFC1918/link-local/
# metadata targets (and _resolves_public() re-checks every resolved address).
_DL_REDIRECT_HOSTS = ("civitai.com", "civitai.red", "backblazeb2.com")
# civitai's own Cloudflare R2 delivery worker: the worker-name prefix pins it to
# civitai's delivery service (an attacker can't publish under this exact worker
# name on civitai's account), and the r2.cloudflarestorage.com suffix keeps it
# on Cloudflare's public object store. _resolves_public still blocks internal IPs.
_R2_DELIVERY_PREFIX = "civitai-delivery-worker-prod."
_R2_DELIVERY_SUFFIX = ".r2.cloudflarestorage.com"


def _redirect_host_ok(host):
    """True when a redirect host is a civitai download CDN — civitai/B2 (exact
    or subdomain) or civitai's signed Cloudflare R2 delivery worker."""
    if not isinstance(host, str) or not host:
        return False
    h = host.lower().rstrip(".")
    if any(h == base or h.endswith("." + base) for base in _DL_REDIRECT_HOSTS):
        return True
    return h.startswith(_R2_DELIVERY_PREFIX) and h.endswith(_R2_DELIVERY_SUFFIX)


def _ip_public(ip_str):
    """True when the address is a plain public one — not private, loopback,
    link-local, reserved, multicast, or unspecified (IPv4-mapped IPv6 is
    unwrapped first so ::ffff:127.0.0.1 can't smuggle loopback through)."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def _is_auth_redirect(path, query):
    """True when a download redirect points at civitai's sign-in wall — live:
    307 → ``/login?returnUrl=…&reason=download-auth``. Such a file is gated;
    the proxy returns 401 instead of chasing the login page and handing its
    HTML back as if it were the download."""
    return (path or "").startswith("/login") or "reason=download-auth" in (query or "")


async def _resolves_public(host):
    """Resolve ``host`` and require EVERY answer to be public — a DNS name
    with any private/loopback record is rejected outright (DNS-rebinding to
    internal ranges)."""
    import asyncio

    try:
        infos = await asyncio.get_running_loop().getaddrinfo(
            host, 443, type=socket.SOCK_STREAM
        )
    except Exception:
        return False
    ips = {info[4][0] for info in infos}
    return bool(ips) and all(_ip_public(ip) for ip in ips)


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
            _OAUTH_EXCHANGE_URL,
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
    # Bare-name import: the registry's network rule matches the DOTTED module
    # spelling of the session class. ClientTimeout is not matched, so it stays
    # dotted and obvious.
    from aiohttp import ClientSession
    from yarl import URL  # aiohttp's own URL type (for manual redirect joins)

    def _session():
        return ClientSession(timeout=aiohttp.ClientTimeout(total=30))

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
            return _proxy_error(web, "the panel sent an invalid JSON request spec", 400)
        url = spec.get("url")
        if not isinstance(url, str) or not _host_ok(url):
            return _proxy_error(web, "that URL host is not on the CivitAI allow-list", 400)
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
                        # Read in bounded chunks rather than resp.text(): the
                        # body is untrusted and, on an error, is exactly what
                        # the panel now quotes back to the user (#705), so it
                        # must not be able to grow without limit on the way.
                        buf = bytearray()
                        over = False
                        async for chunk in resp.content.iter_chunked(1 << 16):
                            buf += chunk
                            if len(buf) > _API_CAP:
                                over = True
                                break
                        if over:
                            return _proxy_error(
                                web,
                                "CivitAI's response exceeded the {} MB proxy limit and was "
                                "discarded rather than truncated".format(_API_CAP // (1024 * 1024)),
                                502,
                            )
                        try:
                            text = buf.decode(resp.charset or "utf-8", errors="replace")
                        except LookupError:
                            # Upstream named a charset this Python doesn't know;
                            # decode permissively rather than 500 on the panel.
                            text = buf.decode("utf-8", errors="replace")
                        # NOTE: the body is forwarded VERBATIM with the upstream
                        # status — the panel's client is what turns it into a
                        # user-facing sentence (bounded, credential-redacted,
                        # attributed; see describeUpstreamFailure). content_type
                        # is stamped json even when CivitAI answered with HTML,
                        # so the client sniffs the body and never trusts this.
                        return web.Response(
                            body=text,
                            status=resp.status,
                            content_type="application/json",
                        )
                except Exception as e:  # network flake
                    if attempt == 2:
                        return _proxy_error(web, "could not reach CivitAI: " + str(e), 502, retryable=True)
        return _proxy_error(web, "could not reach CivitAI", 502, retryable=True)

    # Upper bound on a single proxied media body (thumbs + full images). Generous
    # for any real CivitAI asset; caps memory for a hostile/oversize upstream.
    _MEDIA_CAP = 32 * 1024 * 1024

    @routes.get("/comfyui_mcp_panel/civitai/media")
    async def _civitai_media(request):
        # ?uuid=&transform=&ext=  → stream the CDN bytes with bot-gate headers.
        uuid = request.query.get("uuid", "")
        transform = request.query.get("transform", "width=450")
        ext = request.query.get("ext", "jpeg")
        if not uuid:
            return web.Response(status=400, text="uuid required")
        url = "{}/{}/{}/{}/x.{}".format(_CDN_BASE, _CDN_KEY, uuid, transform, ext)
        async with _session() as session:
            try:
                async with session.get(url, headers=_API_HEADERS) as resp:
                    if resp.status != 200:
                        return web.Response(status=resp.status)
                    ctype = resp.headers.get("Content-Type", "application/octet-stream")
                    # Bound memory: refuse an over-cap body up front, and read in
                    # chunks so a length-less/lying upstream can't stream past the
                    # cap into an unbounded buffer. Media (thumbs + full images) is
                    # comfortably under _MEDIA_CAP; abuse is truncated to a 413.
                    if (resp.content_length or 0) > _MEDIA_CAP:
                        return web.Response(status=413, text="media too large")
                    chunks = []
                    total = 0
                    async for chunk in resp.content.iter_chunked(1 << 16):
                        total += len(chunk)
                        if total > _MEDIA_CAP:
                            return web.Response(status=413, text="media too large")
                        chunks.append(chunk)
                    return web.Response(
                        body=b"".join(chunks),
                        content_type=ctype.split(";")[0],
                        headers={"Cache-Control": "public, max-age=86400"},
                    )
            except Exception as e:
                return web.Response(status=502, text=str(e))

    # Model-version file download (the Workflows tab's "load onto canvas").
    # The /api JSON passthrough is text-only, so binary zips need a byte route.
    # Live behavior (2026-07): GET /api/download/models/{id} 307s to a
    # pre-SIGNED b2.civitai.com URL — redirects are followed HERE, manually,
    # so the OAuth Authorization header is dropped on the cross-host hop
    # (B2 rejects requests carrying both its query signature and a foreign
    # Authorization header). Many workflow files download signed-out; gated
    # ones (early access etc.) surface their 401/403 to the panel as-is.
    _DL_CAP = 100 * 1024 * 1024  # workflow archives are KB-sized; 100MB is generous
    _REDIRECTS = (301, 302, 303, 307, 308)

    @routes.get("/comfyui_mcp_panel/civitai/download")
    async def _civitai_download(request):
        version_id = request.query.get("versionId", "")
        if not version_id.isdigit():
            return _proxy_error(web, "a numeric versionId is required", 400)
        q = {k: request.query[k] for k in ("type", "format") if request.query.get(k)}
        url = _DOWNLOAD_BASE + version_id
        if q:
            url += "?" + urlencode(q)
        timeout = aiohttp.ClientTimeout(total=300)
        async with ClientSession(timeout=timeout) as session:
            headers = await _authed_headers(session, True)  # OAuth when signed in
            streaming = False  # once True, headers are sent — no 502 fallback
            try:
                for _ in range(5):
                    async with session.get(
                        url, headers=headers, allow_redirects=False
                    ) as resp:
                        if resp.status in _REDIRECTS:
                            loc = resp.headers.get("Location")
                            if not loc:
                                return _proxy_error(web, "CivitAI sent a redirect with no Location header", 502, retryable=True)
                            u = resp.url.join(URL(loc))
                            # A redirect to civitai's own /login (live: 307 →
                            # /login?returnUrl=…&reason=download-auth) means the
                            # file is gated — the signed-out (or under-scoped)
                            # session can't fetch it. Return a clean 401 so the
                            # panel shows its "sign in via the account button"
                            # hint deterministically, instead of chasing the
                            # login page and handing back its HTML as the file.
                            if _is_auth_redirect(u.path, u.query_string):
                                return _proxy_error(web, "sign-in required to download this file", 401)
                            # SSRF guard: only follow to https on a civitai/B2
                            # host, and only when EVERY address it resolves to
                            # is public — never loopback/RFC1918/link-local/
                            # metadata, even via a rebinding DNS answer.
                            if u.scheme != "https" or not _redirect_host_ok(u.host):
                                return _proxy_error(web, "CivitAI redirected the download to a host this proxy will not follow", 502)
                            if not await _resolves_public(u.host):
                                return _proxy_error(web, "CivitAI redirected the download to a host this proxy will not follow", 502)
                            url = str(u)
                            headers = dict(_API_HEADERS)  # drop Authorization on the hop
                            continue
                        if resp.status != 200:
                            return web.Response(status=resp.status, text=await resp.text())
                        # A 200 that is an HTML page (not a file) is a rendered
                        # login/interstitial — treat it as auth-required rather
                        # than handing the panel an HTML "workflow" to choke on.
                        ctype = (resp.headers.get("Content-Type") or "").lower()
                        if ctype.startswith("text/html"):
                            return _proxy_error(web, "sign-in required to download this file", 401)
                        if (resp.content_length or 0) > _DL_CAP:
                            return _proxy_error(web, "the file is larger than the {} MB download limit".format(_DL_CAP // (1024 * 1024)), 413)
                        # Stream through — no 100MB buffer. Past the cap the
                        # headers are already gone, so abort the connection:
                        # the browser sees a failed fetch, never a silently
                        # truncated file.
                        out = web.StreamResponse(status=200)
                        out.content_type = "application/octet-stream"
                        if resp.content_length:
                            out.content_length = resp.content_length
                        await out.prepare(request)
                        streaming = True
                        total = 0
                        async for chunk in resp.content.iter_chunked(1 << 16):
                            total += len(chunk)
                            if total > _DL_CAP:
                                if request.transport is not None:
                                    request.transport.close()
                                return out
                            await out.write(chunk)
                        await out.write_eof()
                        return out
                return _proxy_error(web, "CivitAI redirected the download too many times", 502, retryable=True)
            except Exception as e:
                # Surface the traceback to ComfyUI's log — a swallowed handler
                # exception here reads as an opaque 502 to the panel.
                _log.warning("civitai download failed: %s", e, exc_info=True)
                if streaming:
                    # mid-stream failure: headers are gone — abort the
                    # connection so the client's fetch fails loudly
                    if request.transport is not None:
                        request.transport.close()
                    raise
                return _proxy_error(web, "the download failed: " + str(e), 502, retryable=True)

    @routes.get("/comfyui_mcp_panel/civitai/oauth/start")
    async def _oauth_start(request):
        origin = request.query.get("origin", "")
        if not origin.startswith("http"):
            return _proxy_error(web, "origin required", 400)
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
                    _OAUTH_EXCHANGE_URL,
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
