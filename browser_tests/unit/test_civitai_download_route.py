"""aiohttp-LEVEL integration tests for the /civitai/download route.

Unlike the pure-function tests, these mount the REAL route (via
civitai_proxy.register, exactly as __init__.py does) in a live aiohttp
Application and drive it with an aiohttp test client, against a mock "civitai"
upstream. This exercises the actual server flow — StreamResponse
prepare()/write()/write_eof(), manual redirect following, the auth-redirect →
401 short-circuit, and the HTML-200 → 401 guard — so a handler exception or a
StreamResponse misuse (which a standalone harness silently passes) is caught.

The live 502 that slipped past two review rounds was a served-route failure
this class of test exists to prevent.

Run:
    python -m unittest browser_tests.unit.test_civitai_download_route
    python browser_tests/unit/test_civitai_download_route.py
"""

import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "py"))

from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

import civitai_proxy as cp  # noqa: E402

# A tiny real zip (STORE, one entry "a.json" = "{}") — enough to prove the
# byte-stream survives the proxy intact.
import io  # noqa: E402
import zipfile  # noqa: E402


def _tiny_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("a.json", "{}")
    return buf.getvalue()


ZIP_BYTES = _tiny_zip()


def _build_app(mock_base):
    """Mount the real download route, pointed at a mock upstream, plus the mock
    civitai endpoints the route follows."""
    routes = web.RouteTableDef()
    cp.register(routes, web)
    app = web.Application()

    # Mock upstream: /dl/models/{id} mimics civitai's download endpoint. The
    # route requires a numeric versionId, so the scenarios are keyed by digits:
    #   1 = direct 200 zip, 2 = 307→B2 (redirect-follow), 3 = gated /login,
    #   4 = HTML-200 login wall.
    async def mock_download(request):
        vid = request.match_info["vid"]
        if vid == "1":
            return web.Response(body=ZIP_BYTES, content_type="application/zip")
        if vid == "2":
            # civitai 307s to a signed B2 URL; we send an ABSOLUTE https URL on
            # the same mock host and rely on the SSRF stubs (below) to allow it.
            raise web.HTTPTemporaryRedirect(location=str(request.url.with_path("/b2/file.zip")))
        if vid == "3":
            raise web.HTTPTemporaryRedirect(
                location="/login?returnUrl=%2Fmodel-versions%2F3&reason=download-auth"
            )
        if vid == "4":
            return web.Response(text="<!DOCTYPE html><html>login</html>",
                                content_type="text/html")
        return web.Response(status=404)

    async def mock_b2(request):
        return web.Response(body=ZIP_BYTES, content_type="application/zip")

    app.add_routes(routes)
    app.router.add_get("/dl/models/{vid}", mock_download)
    app.router.add_get("/b2/file.zip", mock_b2)
    return app


class DownloadRouteIntegration(unittest.TestCase):
    def _run(self, coro):
        return asyncio.new_event_loop().run_until_complete(coro)

    async def _client(self, mock_base, *, allow_local_redirect=False):
        app = _build_app(mock_base)
        server = TestServer(app)
        client = TestClient(server)
        await client.start_server()
        # point the route's upstream at THIS test server
        cp._DOWNLOAD_BASE = str(client.make_url("/dl/models/"))
        if allow_local_redirect:
            # the mock B2 hop is on 127.0.0.1 — normally blocked; allow it so
            # the redirect-follow + stream path is exercised end to end
            self._orig_hostok = cp._redirect_host_ok
            self._orig_pub = cp._resolves_public
            cp._redirect_host_ok = lambda h: True

            async def _pub(_h):
                return True

            cp._resolves_public = _pub
        return client

    def tearDown(self):
        if hasattr(self, "_orig_hostok"):
            cp._redirect_host_ok = self._orig_hostok
        if hasattr(self, "_orig_pub"):
            cp._resolves_public = self._orig_pub

    def test_direct_200_streams_the_zip(self):
        async def go():
            client = await self._client("mock")
            try:
                resp = await client.get("/comfyui_mcp_panel/civitai/download?versionId=1")
                self.assertEqual(resp.status, 200)
                body = await resp.read()
                self.assertEqual(body, ZIP_BYTES)
                self.assertEqual(body[:2], b"PK")  # real zip magic survived the stream
            finally:
                await client.close()
        self._run(go())

    def test_http_redirect_downgrade_is_rejected(self):
        # The mock B2 hop is an http URL (the test server is http). Even with
        # the host allow-listed, the https-only guard must reject it (502) — no
        # downgrade to a plaintext hop. The real https b2.civitai.com hop is
        # exercised by the live-curl check documented in the PR; here we lock in
        # that the redirect-follow path runs without raising and enforces https.
        async def go():
            client = await self._client("mock", allow_local_redirect=True)
            try:
                resp = await client.get("/comfyui_mcp_panel/civitai/download?versionId=2")
                self.assertEqual(resp.status, 502)
                self.assertIn("redirect target not allowed", await resp.text())
            finally:
                await client.close()
        self._run(go())

    def test_gated_login_redirect_returns_clean_401(self):
        async def go():
            client = await self._client("mock")
            try:
                resp = await client.get("/comfyui_mcp_panel/civitai/download?versionId=3")
                self.assertEqual(resp.status, 401)  # NOT 502
                self.assertIn("sign-in required", (await resp.json())["error"])
            finally:
                await client.close()
        self._run(go())

    def test_html_200_login_wall_returns_401(self):
        async def go():
            client = await self._client("mock")
            try:
                resp = await client.get("/comfyui_mcp_panel/civitai/download?versionId=4")
                self.assertEqual(resp.status, 401)
            finally:
                await client.close()
        self._run(go())

    def test_bad_version_id_400(self):
        async def go():
            client = await self._client("mock")
            try:
                resp = await client.get("/comfyui_mcp_panel/civitai/download?versionId=not-a-number")
                self.assertEqual(resp.status, 400)
            finally:
                await client.close()
        self._run(go())


if __name__ == "__main__":
    unittest.main()
