"""Unit tests for the /download redirect SSRF guard in py/civitai_proxy.py.

Dev-only (browser_tests/ never ships with the pack). Run from the repo root:

    python -m unittest browser_tests.unit.test_civitai_proxy
    # or directly:
    python browser_tests/unit/test_civitai_proxy.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "py"))

import civitai_proxy as cp  # noqa: E402


class RedirectHostAllowlist(unittest.TestCase):
    def test_civitai_and_b2_hosts_pass(self):
        for host in (
            "civitai.com",
            "b2.civitai.com",          # the live signed-out download host
            "delivery.civitai.com",
            "civitai.red",
            "api.civitai.red",
            "backblazeb2.com",
            "f004.backblazeb2.com",
            "B2.CIVITAI.COM",          # case-insensitive
            "b2.civitai.com.",         # trailing-dot FQDN form
            # live signed-IN download host — civitai's Cloudflare R2 delivery worker
            "civitai-delivery-worker-prod.5ac0637cfd0766c97916cefa3764fbdf.r2.cloudflarestorage.com",
            "CIVITAI-DELIVERY-WORKER-PROD.abc123.R2.CLOUDFLARESTORAGE.COM",  # case-insensitive
        ):
            self.assertTrue(cp._redirect_host_ok(host), host)

    def test_everything_else_is_rejected(self):
        for host in (
            "evil.com",
            "localhost",
            "127.0.0.1",
            "169.254.169.254",          # cloud metadata
            "civitai.com.evil.com",     # allow-listed name as a PREFIX
            "notcivitai.com",           # suffix match must sit on a label boundary
            "xbackblazeb2.com",
            # a foreign R2 bucket must NOT pass — only civitai's delivery worker
            "evil-bucket.abc123.r2.cloudflarestorage.com",
            "r2.cloudflarestorage.com",
            # delivery-worker prefix on a NON-r2 host must not pass either
            "civitai-delivery-worker-prod.evil.com",
            "",
            None,
            123,
        ):
            self.assertFalse(cp._redirect_host_ok(host), repr(host))


class PublicIpCheck(unittest.TestCase):
    def test_public_addresses_pass(self):
        for ip in ("142.250.72.14", "1.1.1.1", "2606:4700:4700::1111"):
            self.assertTrue(cp._ip_public(ip), ip)

    def test_internal_special_and_garbage_rejected(self):
        for ip in (
            "127.0.0.1",            # loopback
            "10.1.2.3",             # RFC1918
            "172.16.0.1",           # RFC1918
            "192.168.1.1",          # RFC1918
            "169.254.169.254",      # link-local / metadata
            "0.0.0.0",              # unspecified  # nosec B104 — test FIXTURE of addresses the proxy must BLOCK, nothing binds here
            "224.0.0.1",            # multicast
            "::1",                  # v6 loopback
            "fe80::1",              # v6 link-local
            "fd00::1",              # v6 ULA (private)
            "::ffff:127.0.0.1",     # v4-mapped loopback smuggle
            "::ffff:10.0.0.1",      # v4-mapped RFC1918 smuggle
            "not-an-ip",
            "",
        ):
            self.assertFalse(cp._ip_public(ip), ip)


class GatedDownloadRedirect(unittest.TestCase):
    def test_login_redirects_are_flagged_as_auth(self):
        # live shape: 307 → /login?returnUrl=%2Fmodel-versions%2F3125639&reason=download-auth
        self.assertTrue(cp._is_auth_redirect("/login", "returnUrl=%2Fx&reason=download-auth"))
        self.assertTrue(cp._is_auth_redirect("/login/", ""))
        # reason qualifier alone (path already rewritten) still counts
        self.assertTrue(cp._is_auth_redirect("/api/whatever", "reason=download-auth"))

    def test_real_file_redirects_are_not_auth(self):
        # the B2 signed-download hop must NOT be mistaken for a login wall
        self.assertFalse(cp._is_auth_redirect(
            "/file/civitai-modelfiles/default/841236/wan21Img2video.0OLz.zip",
            "Authorization=3_2026...&b2ContentDisposition=attachment",
        ))
        self.assertFalse(cp._is_auth_redirect("/api/download/models/2947948", "type=Archive"))
        self.assertFalse(cp._is_auth_redirect("", ""))
        self.assertFalse(cp._is_auth_redirect(None, None))


if __name__ == "__main__":
    unittest.main()
