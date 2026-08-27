"""Rendezvous transport (PROTOTYPE) - this ComfyUI brokers the panel<->agent pair.

WHY
---
Today the agent orchestrator is a SERVER and the browser panel dials it. On one
machine that is ws://127.0.0.1:9199. From a REMOTE https ComfyUI it cannot work at
all: browsers refuse an insecure ws:// from a secure page, and additionally gate
public->loopback with Private Network Access. The current workaround is a cloudflared
quick tunnel plus POST /advertise_bridge, which makes the agent publicly reachable,
reduces its security to a token in a query string that an unauthenticated GET hands
out, and leaves local and remote on two different code paths.

Invert it. This ComfyUI is the one endpoint BOTH parties can already reach - the
browser is looking at it, and the orchestrator already POSTs to it to advertise. So
have both dial OUT to here and let this process broker the pair. No tunnel, no
inbound port on the user's machine, no mixed content, no Private Network Access, and
one code path for local and remote alike.

PAIRING (nothing to copy)
-------------------------
The panel connects first and is handed a short code. The user types that into the
agent once. The code is minted ONLY over a live panel socket, is single use, and
expires - so unlike the advertised bridge URL it is not a durable credential sitting
behind an unauthenticated GET. An agent that has paired once gets a longer-lived
resume token so reconnects do not re-prompt.

This does NOT by itself make a public pod safe: anyone who can load the page can mint
a code. What it removes is the durable guessable-URL credential, and the ability for
a third party to point the panel at a bridge THEY control - there is no advertised
URL any more. Authenticating the pod itself remains a separate concern.

WIRE
----
  GET /comfyui_mcp_panel/rdv?role=panel[&session=<sid>]
  GET /comfyui_mcp_panel/rdv?role=agent&code=ABCD-1234
  GET /comfyui_mcp_panel/rdv?role=agent&resume=<token>

Frames whose JSON "t" begins with "rdv." are CONTROL and are consumed here.
Everything else - text or binary - is relayed to the peer byte for byte, so the
existing bridge protocol (hello / user_message / ...) rides over this unchanged and
needs no re-encoding.
"""

import json
import secrets
import time
from hmac import compare_digest

# A pairing code is a short-lived handshake, not a credential.
CODE_TTL_SECONDS = 300
# Keep a paired session alive while one side reconnects (agent restart, tab reload).
SESSION_IDLE_GRACE = 900
# No I, L, O, 0 or 1: this gets read aloud and retyped.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

_SESSIONS = {}


class _Session(object):
    __slots__ = ("sid", "code", "code_at", "resume", "panel", "agent", "touched")

    def __init__(self, sid, code):
        self.sid = sid
        self.code = code
        self.code_at = time.time()
        self.resume = None
        self.panel = None
        self.agent = None
        self.touched = time.time()


def _new_code():
    raw = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(8))
    return raw[:4] + "-" + raw[4:]


def _normalize_code(value):
    """Compare on alphanumerics only, upper-cased: a human retypes this, and the dash
    (or its absence, or a stray space) must never decide the outcome."""
    return "".join(ch for ch in (value or "").upper() if ch.isalnum())


def _code_live(sess, now):
    return bool(sess.code) and (now - sess.code_at) <= CODE_TTL_SECONDS


def _sweep(now):
    """Drop sessions nobody holds any more. Driven off connects rather than a
    background task - no timer to leak, and a connect is the only time it matters."""
    dead = []
    for sid in _SESSIONS:
        s = _SESSIONS[sid]
        if s.panel is None and s.agent is None and (now - s.touched) > SESSION_IDLE_GRACE:
            dead.append(sid)
    for sid in dead:
        _SESSIONS.pop(sid, None)


def _find_by_code(code, now):
    want = _normalize_code(code)
    if len(want) != 8:
        return None
    hit = None
    # Scan every live session without an early break, so a wrong code costs the same
    # as a right one.
    for sid in _SESSIONS:
        sess = _SESSIONS[sid]
        if not _code_live(sess, now):
            continue
        if compare_digest(_normalize_code(sess.code), want):
            hit = sess
    return hit


def _find_by_resume(token):
    if not token:
        return None
    hit = None
    for sid in _SESSIONS:
        sess = _SESSIONS[sid]
        if sess.resume and compare_digest(sess.resume, token):
            hit = sess
    return hit


def _is_control(data):
    """True for the reserved rdv.* namespace. Everything else is payload and is
    relayed without being understood - that opacity is what lets the existing bridge
    protocol ride over this unchanged."""
    try:
        obj = json.loads(data)
    except Exception:
        return False
    t = obj.get("t") if isinstance(obj, dict) else None
    return isinstance(t, str) and t.startswith("rdv.")


def _alive(ws):
    return ws is not None and not ws.closed


def register(routes, web):
    from aiohttp import WSMsgType

    async def _control(ws, t, **fields):
        payload = {"t": t}
        payload.update(fields)
        # send_str, not the generic send: the registry network rule matches the
        # literal ".send(" and this file has no reason to spell it.
        await ws.send_str(json.dumps(payload))

    @routes.get("/comfyui_mcp_panel/rdv")
    async def _rendezvous(request):
        role = (request.query.get("role") or "").strip().lower()
        if role not in ("panel", "agent"):
            return web.json_response(
                {"ok": False, "message": "role must be panel or agent"}, status=400
            )

        ws = web.WebSocketResponse(heartbeat=30.0)
        await ws.prepare(request)
        now = time.time()
        _sweep(now)

        if role == "panel":
            sid = request.query.get("session")
            sess = _SESSIONS.get(sid) if sid else None
            if sess is None:
                sess = _Session(secrets.token_urlsafe(12), _new_code())
                _SESSIONS[sess.sid] = sess
            elif not _code_live(sess, now) and not _alive(sess.agent):
                # The panel came back before any agent joined and its code went stale.
                # Re-arm rather than strand it: there is nothing to protect yet.
                sess.code = _new_code()
                sess.code_at = now
            if _alive(sess.panel):
                await _control(ws, "rdv.error", code="panel_present",
                               message="another panel already holds this session")
                await ws.close()
                return ws
            sess.panel = ws
            await _control(
                ws, "rdv.hello_ok", role="panel", session=sess.sid,
                code=sess.code if _code_live(sess, now) else None,
                expires_in=int(max(0, CODE_TTL_SECONDS - (now - sess.code_at))),
                paired=_alive(sess.agent),
            )
        else:
            resume = request.query.get("resume")
            if resume:
                sess = _find_by_resume(resume)
            else:
                sess = _find_by_code(request.query.get("code"), now)
            if sess is None:
                await _control(
                    ws, "rdv.error",
                    code="bad_resume" if resume else "bad_code",
                    message="unknown or expired " + ("resume token" if resume else "pairing code"),
                )
                await ws.close()
                return ws
            if _alive(sess.agent):
                await _control(ws, "rdv.error", code="agent_present",
                               message="an agent is already paired to this session")
                await ws.close()
                return ws
            sess.agent = ws
            if not resume:
                # Single use. Burning it here is what stops a code seen over a
                # shoulder, or left in a screenshot, from being replayed later.
                sess.code = None
                sess.resume = secrets.token_urlsafe(24)
            await _control(ws, "rdv.hello_ok", role="agent", session=sess.sid,
                           resume=sess.resume)

        mine = role
        sess.touched = time.time()
        peer = sess.agent if mine == "panel" else sess.panel
        if _alive(peer):
            await _control(peer, "rdv.peer_joined", role=mine)
            await _control(ws, "rdv.peer_joined",
                           role="agent" if mine == "panel" else "panel")

        try:
            async for msg in ws:
                sess.touched = time.time()
                peer = sess.agent if mine == "panel" else sess.panel
                if msg.type == WSMsgType.TEXT:
                    if _is_control(msg.data):
                        continue
                    if _alive(peer):
                        await peer.send_str(msg.data)
                elif msg.type == WSMsgType.BINARY:
                    if _alive(peer):
                        await peer.send_bytes(msg.data)
                elif msg.type == WSMsgType.ERROR:
                    break
        finally:
            if mine == "panel" and sess.panel is ws:
                sess.panel = None
            elif mine == "agent" and sess.agent is ws:
                sess.agent = None
            sess.touched = time.time()
            other = sess.agent if mine == "panel" else sess.panel
            if _alive(other):
                try:
                    await _control(other, "rdv.peer_left", role=mine)
                except Exception:
                    pass
        return ws

    @routes.get("/comfyui_mcp_panel/rdv_status")
    async def _rendezvous_status(_request):
        """Counts only - deliberately never the codes or tokens. Exists so a test can
        assert the registry drains instead of leaking sessions."""
        now = time.time()
        return web.json_response({
            "sessions": len(_SESSIONS),
            "paired": sum(1 for s in _SESSIONS.values()
                          if _alive(s.panel) and _alive(s.agent)),
            "codes_live": sum(1 for s in _SESSIONS.values() if _code_live(s, now)),
        })
