"""Security/shape tests for the process-free companion-launcher proxy.

Run from the repo root:

    python -m unittest browser_tests.unit.test_launcher_proxy

These drive the REAL route handlers (via ``_register_launcher_routes`` with a
route collector and a ``web`` double) and the REAL proxy call (via a fake
``aiohttp`` in ``sys.modules``). Nothing here inspects the source text: a test
that greps for a guard passes just as happily when the guard reads
``if False:``.
"""

import asyncio
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest

_REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def _load_init():
    spec = importlib.util.spec_from_file_location(
        "cmcp_panel_init_launcher", os.path.join(_REPO, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_init()


class LauncherConfig(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="cmcp-launcher-home-")
        self.path = os.path.join(self.home, ".comfyui-mcp", "launcher.json")
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.old_path = mod._launcher_config_path
        mod._launcher_config_path = lambda: self.path

    def tearDown(self):
        mod._launcher_config_path = self.old_path

    def write(self, value):
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(value, handle)

    def valid(self):
        return {
            "protocol": 1,
            "host": "127.0.0.1",
            "port": 49123,
            "token": "t" * 43,
            "updated_at": "2026-08-14T00:00:00.000Z",
        }

    def test_accepts_only_loopback_protocol_v1_with_private_token(self):
        self.write(self.valid())
        self.assertEqual(
            mod._read_launcher_config(),
            {"host": "127.0.0.1", "port": 49123, "token": "t" * 43},
        )
        for key, value in (
            ("protocol", 2),
            ("host", "0.0.0.0"),  # nosec B104 - rejected config fixture; nothing binds
            ("port", 0),
            ("port", True),
            ("token", "short"),
        ):
            broken = self.valid()
            broken[key] = value
            self.write(broken)
            self.assertIsNone(mod._read_launcher_config(), msg=(key, value))

    def test_request_surface_is_fixed_and_carries_no_body_or_command(self):
        config = {  # nosec B105 - inert bearer-token fixture
            "host": "127.0.0.1",
            "port": 49123,
            "token": "secret",
        }
        self.assertEqual(
            mod._launcher_request_spec("start", config),
            {
                "method": "POST",
                "url": "http://127.0.0.1:49123/v1/ensure-running",
                "headers": {"Authorization": "Bearer secret"},
            },
        )
        self.assertNotIn("body", mod._launcher_request_spec("start", config))
        with self.assertRaises(ValueError):
            mod._launcher_request_spec("run-arbitrary-command", config)

    def test_missing_or_malformed_config_is_not_installed(self):
        self.assertIsNone(mod._read_launcher_config())
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{ malformed")
        self.assertIsNone(mod._read_launcher_config())


class _Headers:
    """Case-insensitive header mapping, like aiohttp's CIMultiDict."""

    def __init__(self, values=None):
        self._values = {str(k).lower(): v for k, v in (values or {}).items()}

    def get(self, key, default=None):
        return self._values.get(str(key).lower(), default)


class _Request:
    def __init__(self, headers=None):
        self.headers = _Headers(headers)


class _Response:
    def __init__(self, payload, status):
        self.payload = payload
        self.status = status


class _Web:
    """Stand-in for aiohttp.web — only json_response is used by the handlers."""

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


_STATUS_ROUTE = ("GET", "/comfyui_mcp_panel/launcher/status")
_START_ROUTE = ("POST", "/comfyui_mcp_panel/launcher/start")
_HANDSHAKE_ROUTE = ("POST", "/comfyui_mcp_panel/launcher/handshake")

_PAGE_HOST = "127.0.0.1:8188"
_PAGE_ORIGIN = "http://127.0.0.1:8188"


class LauncherRouteOrigin(unittest.TestCase):
    """The launcher proxy holds the launcher's bearer token, so any page that
    can reach these routes borrows it. Drive the handlers and prove a foreign
    origin never reaches the proxy call."""

    def setUp(self):
        self.routes = _Routes()
        mod._register_launcher_routes(self.routes, _Web)
        self.calls = []
        self.result = {"ok": True, "installed": True, "running": True, "started": True}
        self.old_request = mod._launcher_request

        async def _fake_request(action):
            self.calls.append(action)
            return dict(self.result)

        mod._launcher_request = _fake_request

    def tearDown(self):
        mod._launcher_request = self.old_request

    def call(self, route, headers):
        handler = self.routes.handlers[route]
        return asyncio.run(handler(_Request(headers)))

    def test_cross_origin_post_is_refused_before_the_launcher_is_touched(self):
        response = self.call(
            _START_ROUTE, {"Host": _PAGE_HOST, "Origin": "https://evil.example"}
        )
        self.assertEqual(response.status, 403)
        self.assertEqual(response.payload["error"], "cross_origin_denied")
        self.assertIs(response.payload["ok"], False)
        # The refusal is worthless if the process already started: a form POST
        # never reads the reply, the side effect IS the attack.
        self.assertEqual(self.calls, [])

    def test_same_origin_post_is_allowed(self):
        response = self.call(
            _START_ROUTE, {"Host": _PAGE_HOST, "Origin": _PAGE_ORIGIN}
        )
        self.assertEqual(response.status, 200)
        self.assertIs(response.payload["ok"], True)
        self.assertEqual(self.calls, ["start"])

    def test_same_site_get_without_an_origin_header_still_works(self):
        # A same-origin GET sends neither Origin nor Referer. Demanding one
        # would break the status probe the panel polls.
        response = self.call(_STATUS_ROUTE, {"Host": _PAGE_HOST})
        self.assertEqual(response.status, 200)
        self.assertEqual(self.calls, ["status"])

    def test_cross_origin_get_is_refused_too(self):
        response = self.call(
            _STATUS_ROUTE, {"Host": _PAGE_HOST, "Origin": "http://evil.example:8188"}
        )
        self.assertEqual(response.status, 403)
        self.assertEqual(self.calls, [])

    def test_handshake_route_is_guarded_as_well(self):
        refused = self.call(
            _HANDSHAKE_ROUTE, {"Host": _PAGE_HOST, "Origin": "http://evil.example"}
        )
        self.assertEqual(refused.status, 403)
        self.assertEqual(self.calls, [])
        allowed = self.call(_HANDSHAKE_ROUTE, {"Host": _PAGE_HOST, "Origin": _PAGE_ORIGIN})
        self.assertEqual(allowed.status, 200)
        self.assertEqual(self.calls, ["handshake"])

    def test_opaque_and_look_alike_origins_are_refused(self):
        for origin in (
            "null",  # sandboxed iframe / data: document
            "",
            "chrome-extension://abcdefghijklmnop",
            "http://127.0.0.1:8189",  # neighbouring port is a different origin
            "http://127.0.0.1.evil.example:8188",  # host as a PREFIX
            "http://evil.example#http://127.0.0.1:8188",
            "http://user@evil.example",  # userinfo must not become the host
        ):
            response = self.call(_START_ROUTE, {"Host": _PAGE_HOST, "Origin": origin})
            self.assertEqual(response.status, 403, msg=origin)
        self.assertEqual(self.calls, [])

    def test_referer_stands_in_when_origin_is_absent(self):
        refused = self.call(
            _START_ROUTE, {"Host": _PAGE_HOST, "Referer": "https://evil.example/x?y=1"}
        )
        self.assertEqual(refused.status, 403)
        self.assertEqual(self.calls, [])
        allowed = self.call(
            _START_ROUTE, {"Host": _PAGE_HOST, "Referer": _PAGE_ORIGIN + "/some/page"}
        )
        self.assertEqual(allowed.status, 200)
        self.assertEqual(self.calls, ["start"])

    def test_an_origin_beats_a_same_origin_referer(self):
        # A cross-origin POST carrying a forged-looking Referer must not pass:
        # Origin is the header the browser guarantees.
        response = self.call(
            _START_ROUTE,
            {
                "Host": _PAGE_HOST,
                "Origin": "https://evil.example",
                "Referer": _PAGE_ORIGIN + "/",
            },
        )
        self.assertEqual(response.status, 403)
        self.assertEqual(self.calls, [])

    def test_a_tls_terminating_proxy_deployment_still_works(self):
        # The page is https:// while this server sees plain HTTP and a Host with
        # no port. Authority comparison (not full-origin) is what keeps this alive.
        for host, origin in (
            ("comfy.example.com", "https://comfy.example.com"),
            ("comfy.example.com:443", "https://comfy.example.com"),
            ("comfy.example.com", "https://comfy.example.com:443"),
            ("192.168.1.5:8188", "http://192.168.1.5:8188"),
        ):
            self.calls.clear()
            response = self.call(_START_ROUTE, {"Host": host, "Origin": origin})
            self.assertEqual(response.status, 200, msg=(host, origin))
            self.assertEqual(self.calls, ["start"], msg=(host, origin))

    def test_a_forwarded_host_header_cannot_vouch_for_a_foreign_origin(self):
        response = self.call(
            _START_ROUTE,
            {
                "Host": _PAGE_HOST,
                "Origin": "https://evil.example",
                "X-Forwarded-Host": "evil.example",
            },
        )
        self.assertEqual(response.status, 403)
        self.assertEqual(self.calls, [])

    def test_a_missing_host_header_fails_closed(self):
        response = self.call(_START_ROUTE, {"Origin": _PAGE_ORIGIN})
        self.assertEqual(response.status, 403)
        self.assertEqual(self.calls, [])


class _FakeResponse:
    def __init__(self, payload, status):
        self._payload = payload
        self.status = status

    async def json(self, content_type=None):
        del content_type
        return self._payload


class _FakeRequestContext:
    def __init__(self, response):
        self._response = response

    async def __aenter__(self):
        return self._response

    async def __aexit__(self, *exc_info):
        return False


class _FakeSession:
    """Minimal aiohttp.ClientSession: async context manager whose .request()
    is itself an async context manager."""

    def __init__(self, payload=None, status=200, raises=None, timeout=None):
        del timeout
        self._payload = payload
        self._status = status
        self._raises = raises
        self.requests = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    def request(self, method, url, headers=None):
        self.requests.append((method, url, headers))
        if self._raises is not None:
            raise self._raises
        return _FakeRequestContext(_FakeResponse(self._payload, self._status))


class LauncherResponseIsAllowlisted(unittest.TestCase):
    """The launcher's reply is reflected into the page, so it is copied through
    an allowlist. Driven through the real _launcher_request with a fake aiohttp."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="cmcp-launcher-proxy-")
        self.path = os.path.join(self.home, ".comfyui-mcp", "launcher.json")
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "protocol": 1,
                    "host": "127.0.0.1",
                    "port": 49123,
                    "token": "t" * 43,
                },
                handle,
            )
        self.old_path = mod._launcher_config_path
        mod._launcher_config_path = lambda: self.path
        self.old_aiohttp = sys.modules.get("aiohttp")

    def tearDown(self):
        mod._launcher_config_path = self.old_path
        if self.old_aiohttp is None:
            sys.modules.pop("aiohttp", None)
        else:
            sys.modules["aiohttp"] = self.old_aiohttp

    def install_aiohttp(self, **kwargs):
        session = _FakeSession(**kwargs)
        fake = types.ModuleType("aiohttp")
        fake.ClientSession = lambda timeout=None: session
        fake.ClientTimeout = lambda total=None, connect=None: (total, connect)
        sys.modules["aiohttp"] = fake
        return session

    def test_only_expected_keys_reach_the_browser(self):
        self.install_aiohttp(
            payload={
                "ok": True,
                "protocol": 1,
                "already_running": False,
                "started": True,
                # Everything below must be dropped: the current secret, a field a
                # future launcher might add, and one that names the user's disk.
                "token": "s3cret-bearer-token",  # nosec B105 - inert leak-detection fixture
                "auth_header": "Bearer s3cret-bearer-token",  # nosec B105 - same
                "config_path": "/home/somebody/.comfyui-mcp/launcher.json",
                "argv": ["npx", "comfyui-mcp", "--panel-orchestrator"],
            },
            status=200,
        )
        result = asyncio.run(mod._launcher_request("start"))
        self.assertIs(result["ok"], True)
        self.assertIs(result["started"], True)
        self.assertEqual(result["protocol"], 1)
        self.assertIs(result["already_running"], False)
        # Proxy-owned fields are still applied.
        self.assertIs(result["installed"], True)
        self.assertIs(result["running"], True)
        self.assertEqual(result["status"], 200)
        for leaked in ("token", "auth_header", "config_path", "argv"):
            self.assertNotIn(leaked, result, msg=leaked)
        blob = json.dumps(result)
        self.assertNotIn("s3cret-bearer-token", blob)
        self.assertNotIn("somebody", blob)

    def test_a_free_text_launcher_error_is_collapsed_to_a_code(self):
        self.install_aiohttp(
            payload={
                "ok": False,
                "error": "spawn failed: ENOENT /home/somebody/.nvm/bin/npx",
            },
            status=500,
        )
        result = asyncio.run(mod._launcher_request("start"))
        self.assertEqual(result["error"], "launcher_error")
        self.assertNotIn("somebody", json.dumps(result))

    def test_a_code_shaped_launcher_error_passes_through(self):
        self.install_aiohttp(payload={"ok": False, "error": "unauthorized"}, status=401)
        result = asyncio.run(mod._launcher_request("start"))
        self.assertEqual(result["error"], "unauthorized")
        self.assertIs(result["running"], False)

    def test_an_unreachable_launcher_does_not_name_its_host_or_port(self):
        self.install_aiohttp(
            raises=OSError("Cannot connect to host 127.0.0.1:49123 ssl:default")
        )
        result = asyncio.run(mod._launcher_request("start"))
        self.assertEqual(result["error"], "launcher_unreachable")
        blob = json.dumps(result)
        self.assertNotIn("49123", blob)
        self.assertNotIn("127.0.0.1", blob)


if __name__ == "__main__":
    unittest.main()
