"""aiohttp-LEVEL integration tests for the /civitai/api passthrough route (#705).

The panel's user-facing CivitAI error now QUOTES the upstream response body, so
this route's contract matters in a way it did not before: it must hand the body
back verbatim with the upstream status — whatever shape that body is in (JSON,
HTML, empty) — and it must bound what it buffers without ever truncating a body
into unparseable garbage.

These mount the REAL route via civitai_proxy.register — exactly as __init__.py
does — in a live aiohttp Application, driven against a mock "civitai" upstream.

Run (needs aiohttp, i.e. ComfyUI's interpreter):
    python -m unittest browser_tests.unit.test_civitai_api_route
    python browser_tests/unit/test_civitai_api_route.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "py"))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

import civitai_proxy as cp  # noqa: E402

# The exact body CivitAI served during the outage reported in #705 (the em dash
# is spelled as an escape so this file stays plain ASCII).
OUTAGE_BODY = '{"error":"Model search is temporarily overloaded \\u2014 please retry."}'
# A CDN/edge error page: a 5xx that never reached the API at all.
HTML_BODY = "<!DOCTYPE html><html><body><h1>503 Service Temporarily Unavailable</h1></body></html>"


def _build_app():
    """Mount the real /api route plus the mock upstream it proxies to."""
    routes = web.RouteTableDef()
    cp.register(routes, web)

    async def mock_models(request):
        case = request.query.get("case", "ok")
        if case == "outage":
            return web.Response(body=OUTAGE_BODY, status=503, content_type="application/json")
        if case == "html":
            return web.Response(body=HTML_BODY, status=503, content_type="text/html")
        if case == "empty":
            return web.Response(body=b"", status=503)
        if case == "terminal":
            return web.Response(
                body='{"error":"Invalid enum value for sort"}',
                status=400,
                content_type="application/json",
            )
        if case == "oversize":
            # Deliberately past whatever cap is in force for this test.
            filler = "x" * (cp._API_CAP + 1024)
            return web.Response(
                body='{"items":"' + filler + '"}', status=200, content_type="application/json"
            )
        if case == "undersize":
            # Comfortably under the cap: must survive byte for byte.
            filler = "y" * max(1, cp._API_CAP // 2)
            return web.Response(
                body='{"items":"' + filler + '"}', status=200, content_type="application/json"
            )
        if case == "echo_auth":
            # An upstream that reflects the request's auth header back into its
            # error body.
            return web.Response(
                body='{"error":"rejected: ' + request.headers.get("Authorization", "none") + '"}',
                status=401,
                content_type="application/json",
            )
        return web.Response(body='{"items":[1,2,3]}', status=200, content_type="application/json")

    app = web.Application()
    app.add_routes(routes)
    app.router.add_get("/api/v1/models", mock_models)
    return app


class ApiPassthrough(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = TestClient(TestServer(_build_app()))
        await self.client.start_server()
        self.upstream = str(self.client.make_url("/")).rstrip("/") + "/api/v1/models"
        # The route proxies allow-listed hosts only; point that check at the
        # mock server for the duration of the test (same stubbing approach the
        # /download route's integration test uses for its SSRF guards).
        self._host_ok = cp._host_ok
        cp._host_ok = lambda url: True
        self._cap = cp._API_CAP

    async def asyncTearDown(self):
        cp._host_ok = self._host_ok
        cp._API_CAP = self._cap
        await self.client.close()

    async def _post(self, case):
        return await self.client.post(
            "/comfyui_mcp_panel/civitai/api", json={"url": self.upstream + "?case=" + case}
        )

    # --- the body must reach the panel, which is what #705 depends on ---------

    async def test_error_body_is_forwarded_verbatim_with_the_upstream_status(self):
        """#705's premise: the actionable sentence must survive the proxy."""
        resp = await self._post("outage")
        self.assertEqual(resp.status, 503)
        self.assertEqual(await resp.text(), OUTAGE_BODY)

    async def test_html_error_page_is_forwarded_not_swallowed(self):
        resp = await self._post("html")
        self.assertEqual(resp.status, 503)
        self.assertEqual(await resp.text(), HTML_BODY)

    async def test_empty_error_body_keeps_its_status(self):
        resp = await self._post("empty")
        self.assertEqual(resp.status, 503)
        self.assertEqual(await resp.text(), "")

    async def test_terminal_4xx_body_is_forwarded_too(self):
        resp = await self._post("terminal")
        self.assertEqual(resp.status, 400)
        self.assertIn("Invalid enum value", await resp.text())

    async def test_success_body_is_unchanged(self):
        resp = await self._post("ok")
        self.assertEqual(resp.status, 200)
        self.assertEqual(await resp.json(), {"items": [1, 2, 3]})

    # --- the bound, and the thing the bound must never do --------------------

    async def test_a_body_under_the_cap_survives_intact(self):
        """A truncated body would be a NEW misleading error in place of the old
        one, so the cap must be invisible to anything legitimately sized."""
        cp._API_CAP = 256 * 1024
        resp = await self._post("undersize")
        self.assertEqual(resp.status, 200)
        self.assertEqual(len((await resp.json())["items"]), cp._API_CAP // 2)

    async def test_an_over_cap_body_is_refused_rather_than_truncated(self):
        cp._API_CAP = 256 * 1024
        resp = await self._post("oversize")
        self.assertEqual(resp.status, 502)
        body = await resp.json()
        self.assertIn("exceeded", body["error"])
        # The defining property: nothing partial is handed onward.
        self.assertNotIn("xxxx", body["error"])
        self.assertLess(len(await resp.text()), 1024)
        # This refusal is OURS, so it must be attributed to us and must not be
        # advertised as worth retrying — the panel would otherwise narrate the
        # proxy's own limit as a transient CivitAI outage.
        self.assertEqual(body["source"], cp._PROXY_SOURCE)
        self.assertIs(body["retryable"], False)

    # --- proxy-authored errors declare who spoke and whether to retry ---------

    async def test_proxy_authored_errors_are_tagged_and_classified(self):
        """`source` keeps the panel from quoting our guard rails as CivitAI's
        words; `retryable` keeps it from advising a retry that cannot work. The
        status alone carries neither fact — our 502 covers both a transient
        "could not reach CivitAI" and a permanent allow-list refusal."""
        cp._host_ok = self._host_ok  # this test wants the REAL allow-list
        resp = await self.client.post(
            "/comfyui_mcp_panel/civitai/api", json={"url": "not-a-url"}
        )
        self.assertEqual(resp.status, 400)
        body = await resp.json()
        self.assertEqual(body["source"], cp._PROXY_SOURCE)
        self.assertIs(body["retryable"], False)
        self.assertIn("allow-list", body["error"])

    async def test_an_unreachable_upstream_is_marked_retryable(self):
        # Point the route at a port nothing is listening on: the request fails at
        # the socket, which IS worth retrying, and must say so.
        resp = await self.client.post(
            "/comfyui_mcp_panel/civitai/api",
            json={"url": "http://127.0.0.1:1/api/v1/models"},
        )
        self.assertEqual(resp.status, 502)
        body = await resp.json()
        self.assertEqual(body["source"], cp._PROXY_SOURCE)
        self.assertIs(body["retryable"], True)
        self.assertIn("could not reach CivitAI", body["error"])

    # --- where redaction lives, pinned on purpose ----------------------------

    async def test_the_proxy_forwards_bodies_verbatim_by_design(self):
        """An upstream can echo the request's auth header back into its error
        body. The proxy does NOT rewrite bodies; the redaction that keeps a
        credential off the screen lives where the text is DISPLAYED (the browser
        client's describeUpstreamFailure). This pins that split so a later change
        cannot quietly assume the proxy is scrubbing on its behalf."""
        resp = await self._post("echo_auth")
        self.assertEqual(resp.status, 401)
        # No OAuth session exists here, so no Authorization header was sent at
        # all — the proxy only attaches one when a stored session is present.
        self.assertIn("none", await resp.text())


if __name__ == "__main__":
    unittest.main()
