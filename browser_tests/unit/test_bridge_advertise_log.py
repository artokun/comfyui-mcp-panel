"""#2162 — the bridge advertisement must not eat ComfyUI's log ring buffer.

ComfyUI keeps the log that ``GET /internal/logs`` serves in a size-capped
``deque`` (``app/logger.py``), and ``LogInterceptor.write`` appends **one entry
per ``sys.stdout.write()`` call**, each stamped with its own ``datetime.now()``.
Two independent defects met there:

* the orchestrator re-POSTs ``/comfyui_mcp_panel/advertise_bridge`` on a 5 s
  heartbeat and again on every panel hello (both deliberate, see comfyui-mcp
  ``syncReadvertise``), and the pack logged *every* accepted POST — ~720 lines
  an hour, which evicted every startup, model-load and traceback line;
* ``print()`` writes the text and the ``"\\n"`` as two separate calls, so each
  panel line cost two ring slots and rendered as a message with the *next*
  entry's timestamp concatenated onto it, plus a bare ``<ts> -``.

These tests drive the REAL ``_log``, the REAL ``_log_bridge_advertisement`` and
the REAL POST handler (registered by the shipped ``_register_routes`` against a
route collector). Nothing here inspects source text.

Run from the repo root:

    python -m unittest browser_tests.unit.test_bridge_advertise_log
"""

import asyncio
import datetime
import importlib.util
import io
import os
import sys
import types
import unittest

_REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def _load_init():
    spec = importlib.util.spec_from_file_location(
        "cmcp_panel_init_advert_log", os.path.join(_REPO, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_init()


class _Ring(io.TextIOBase):
    """ComfyUI's LogInterceptor, reduced to the part that matters here.

    One deque entry per ``write()`` call, each carrying its own timestamp —
    copied from ``app/logger.py``. ``render()`` reproduces what a reader of
    ``/internal/logs`` sees when it joins the entries.
    """

    def __init__(self):
        self.entries = []

    def write(self, data):
        self.entries.append({"t": datetime.datetime.now().isoformat(), "m": data})
        return len(data)

    def render(self):
        return "".join(e["t"] + " - " + e["m"] for e in self.entries)


class _CaptureStdout:
    def __init__(self):
        self.ring = _Ring()

    def __enter__(self):
        self._old = sys.stdout
        sys.stdout = self.ring
        return self.ring

    def __exit__(self, *exc):
        sys.stdout = self._old
        return False


class _Response:
    def __init__(self, payload, status):
        self.payload = payload
        self.status = status


class _Web:
    """Stand-in for aiohttp.web — the handlers only use json_response."""

    @staticmethod
    def json_response(payload, status=200, headers=None):
        del headers
        return _Response(payload, status)


class _Routes:
    """Route collector shaped like aiohttp's RouteTableDef."""

    def __init__(self):
        self.handlers = {}

    def get(self, path):
        return self._register("GET", path)

    def post(self, path):
        return self._register("POST", path)

    def _register(self, method, path):
        def decorate(handler):
            self.handlers[(method, path)] = handler
            return handler

        return decorate


class _JsonRequest:
    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


def _register_panel_routes():
    """Run the SHIPPED ``_register_routes`` and return its route collector.

    ``_register_routes`` bails out unless ``server.PromptServer`` and
    ``aiohttp.web`` import, so stand both in. This is what makes the assertions
    below cover the call site: a fix that lives only in the helper, with the
    route still logging every POST, fails here.
    """
    routes = _Routes()
    prompt_server = types.SimpleNamespace(
        instance=types.SimpleNamespace(routes=routes)
    )
    fake_server = types.ModuleType("server")
    fake_server.PromptServer = prompt_server
    fake_aiohttp = types.ModuleType("aiohttp")
    fake_aiohttp.web = _Web
    saved = {name: sys.modules.get(name) for name in ("server", "aiohttp")}
    sys.modules["server"] = fake_server
    sys.modules["aiohttp"] = fake_aiohttp
    try:
        # Registration itself logs a few "not registered" lines (the relative
        # imports cannot resolve for a file-loaded module); capture and discard
        # them so only the handler's own output is measured.
        with _CaptureStdout():
            mod._register_routes()
    finally:
        for name, value in saved.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value
    return routes


_ADVERTISE_ROUTE = ("POST", "/comfyui_mcp_panel/advertise_bridge")

_TUNNEL = "wss://tunnel.example/bridge?token=abc"
_TUNNEL_LINE = "[comfyui-mcp-panel] secure bridge advertised: wss://tunnel.example/bridge\n"
_LOCAL = "ws://127.0.0.1:9199"
_LOCAL_LINE = "[comfyui-mcp-panel] local bridge advertised: ws://127.0.0.1:9199\n"


class _AdvertiseStateTest(unittest.TestCase):
    def setUp(self):
        self._saved = (
            mod._ADVERTISED_BRIDGE_URL,
            mod._ADVERTISED_LOCAL_URL,
            mod._LOGGED_BRIDGE_LINE,
            mod._LOGGED_LOCAL_LINE,
        )
        mod._ADVERTISED_BRIDGE_URL = None
        mod._ADVERTISED_LOCAL_URL = None
        mod._LOGGED_BRIDGE_LINE = None
        mod._LOGGED_LOCAL_LINE = None

    def tearDown(self):
        (
            mod._ADVERTISED_BRIDGE_URL,
            mod._ADVERTISED_LOCAL_URL,
            mod._LOGGED_BRIDGE_LINE,
            mod._LOGGED_LOCAL_LINE,
        ) = self._saved


class LogLineFraming(unittest.TestCase):
    def test_one_log_call_is_exactly_one_ring_entry_terminated_by_a_newline(self):
        with _CaptureStdout() as ring:
            mod._log("secure bridge advertised: wss://tunnel.example/bridge")
        self.assertEqual(
            [e["m"] for e in ring.entries],
            ["[comfyui-mcp-panel] secure bridge advertised: wss://tunnel.example/bridge\n"],
        )

    def test_consecutive_lines_do_not_concatenate_timestamps(self):
        # The reported symptom: "…trycloudflare.com/2026-09-01T19:07:18.981112 - "
        # — a second entry's timestamp landing inside the first entry's text
        # because the message was written unterminated.
        with _CaptureStdout() as ring:
            mod._log("first")
            mod._log("second")
        rendered = ring.render()
        self.assertEqual(len(ring.entries), 2)
        for line in rendered.splitlines():
            self.assertTrue(
                line.startswith(ring.entries[0]["t"][:4]),
                msg="a rendered line must start with its own timestamp: " + repr(line),
            )
        self.assertNotIn(" - \n", rendered)
        self.assertIn("[comfyui-mcp-panel] first\n", rendered)
        self.assertIn("[comfyui-mcp-panel] second\n", rendered)


class AdvertisementIsLoggedOnChangeOnly(_AdvertiseStateTest):
    def announce(self, url=None, local_url=None):
        with _CaptureStdout() as ring:
            messages = mod._log_bridge_advertisement(
                {"url": url, "local_url": local_url}
            )
        return messages, [e["m"] for e in ring.entries]

    def test_first_advertisement_is_announced(self):
        messages, written = self.announce(url=_TUNNEL, local_url=_LOCAL)
        self.assertEqual(len(messages), 2)
        self.assertEqual(written, [_TUNNEL_LINE, _LOCAL_LINE])

    def test_the_five_second_heartbeat_is_silent(self):
        self.announce(url=_TUNNEL, local_url=_LOCAL)
        # A minute of the orchestrator's setInterval(…, 5000) re-advertise.
        for _ in range(12):
            messages, written = self.announce(url=_TUNNEL, local_url=_LOCAL)
            self.assertEqual(messages, [])
            self.assertEqual(written, [])

    def test_a_burst_of_identical_advertisements_collapses_to_one_line(self):
        # A fresh connection produced seven duplicate pairs within ~10 ms
        # (one per subscriber), per the issue's follow-up reproduction.
        lines = []
        for _ in range(7):
            _, written = self.announce(url=_TUNNEL, local_url=_LOCAL)
            lines.extend(written)
        self.assertEqual(lines, [_TUNNEL_LINE, _LOCAL_LINE])

    def test_a_new_tunnel_url_speaks_again(self):
        self.announce(url=_TUNNEL, local_url=_LOCAL)
        messages, written = self.announce(
            url="wss://other.example/bridge?token=abc", local_url=_LOCAL
        )
        self.assertEqual(
            written,
            ["[comfyui-mcp-panel] secure bridge advertised: wss://other.example/bridge\n"],
        )
        self.assertEqual(len(messages), 1)

    def test_a_reconnect_that_moves_the_loopback_port_speaks_again(self):
        self.announce(url=_TUNNEL, local_url=_LOCAL)
        _, written = self.announce(url=_TUNNEL, local_url="ws://127.0.0.1:9180")
        self.assertEqual(
            written, ["[comfyui-mcp-panel] local bridge advertised: ws://127.0.0.1:9180\n"]
        )

    def test_a_token_rotation_on_the_same_tunnel_stays_silent(self):
        # The token is stripped before logging, so a re-issued token renders an
        # identical line — repeating it tells the reader nothing.
        self.announce(url=_TUNNEL)
        _, written = self.announce(url="wss://tunnel.example/bridge?token=zzz")
        self.assertEqual(written, [])


class AdvertiseRouteIsQuietOnRepeat(_AdvertiseStateTest):
    """The call site, not just the helper — the shipped POST handler."""

    def setUp(self):
        super().setUp()
        self.routes = _register_panel_routes()
        self.handler = self.routes.handlers[_ADVERTISE_ROUTE]

    def post(self, body):
        with _CaptureStdout() as ring:
            response = asyncio.run(self.handler(_JsonRequest(body)))
        return response, [e["m"] for e in ring.entries]

    def test_the_heartbeat_writes_one_line_however_often_it_posts(self):
        written = []
        for _ in range(13):
            response, lines = self.post({"url": _TUNNEL, "local_url": _LOCAL})
            self.assertEqual(response.status, 200)
            self.assertIs(response.payload["ok"], True)
            written.extend(lines)
        self.assertEqual(written, [_TUNNEL_LINE, _LOCAL_LINE])

    def test_the_route_still_announces_a_changed_tunnel(self):
        self.post({"url": _TUNNEL})
        _, lines = self.post({"url": "wss://moved.example/bridge?token=abc"})
        self.assertEqual(
            lines,
            ["[comfyui-mcp-panel] secure bridge advertised: wss://moved.example/bridge\n"],
        )

    def test_a_rejected_payload_is_neither_stored_nor_logged(self):
        response, lines = self.post({"url": "http://evil.example"})
        self.assertEqual(response.status, 400)
        self.assertEqual(lines, [])
        self.assertIsNone(mod._ADVERTISED_BRIDGE_URL)


if __name__ == "__main__":
    unittest.main()
