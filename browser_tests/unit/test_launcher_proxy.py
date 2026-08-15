"""Security/shape tests for the process-free companion-launcher proxy."""

import importlib.util
import json
import os
import tempfile
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


if __name__ == "__main__":
    unittest.main()
