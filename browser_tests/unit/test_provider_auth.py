"""Unit tests for _provider_auth("claude") readiness (#378).

Dev-only. Run from the repo root:

    python -m unittest browser_tests.unit.test_provider_auth

Guards #378: an empty ~/.claude/.credentials.json (claudeAiOauth present but
accessToken/refreshToken both blank, as left after `claude` signs out) must NOT
report Claude as authenticated. The pre-fix code returned True on mere file
existence, so the panel offered Claude sessions that then failed auth.
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

_REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def _load_init():
    spec = importlib.util.spec_from_file_location(
        "cmcp_panel_init", os.path.join(_REPO, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_init()


class ProviderAuthClaude(unittest.TestCase):
    def setUp(self):
        self._home = tempfile.mkdtemp(prefix="cmcp-home-")
        self._orig_expanduser = os.path.expanduser
        os.path.expanduser = lambda p: (
            self._home if p == "~" else self._orig_expanduser(p)
        )
        os.makedirs(os.path.join(self._home, ".claude"), exist_ok=True)

    def tearDown(self):
        os.path.expanduser = self._orig_expanduser

    def _write(self, obj):
        path = os.path.join(self._home, ".claude", ".credentials.json")
        with open(path, "w", encoding="utf-8") as fh:
            if isinstance(obj, str):
                fh.write(obj)
            else:
                json.dump(obj, fh)

    def test_populated_oauth_is_ready(self):
        self._write({"claudeAiOauth": {"accessToken": "at", "refreshToken": "rt"}})
        self.assertIs(mod._provider_auth("claude"), True)

    def test_only_refresh_token_is_ready(self):
        self._write({"claudeAiOauth": {"accessToken": "", "refreshToken": "rt"}})
        self.assertIs(mod._provider_auth("claude"), True)

    def test_empty_oauth_is_not_ready(self):
        # The #378 repro: file exists, tokens blank -> must be False, not True.
        self._write({"claudeAiOauth": {"accessToken": "", "refreshToken": ""}})
        self.assertIs(mod._provider_auth("claude"), False)

    def test_whitespace_only_token_is_not_ready(self):
        self._write({"claudeAiOauth": {"accessToken": "   ", "refreshToken": ""}})
        self.assertIs(mod._provider_auth("claude"), False)

    def test_non_string_token_is_not_ready(self):
        # true / [..] / number are truthy but not usable OAuth tokens.
        for bad in (True, ["x"], 123, {"k": "v"}):
            self._write({"claudeAiOauth": {"accessToken": bad, "refreshToken": ""}})
            self.assertIs(mod._provider_auth("claude"), False, msg=repr(bad))

    def test_missing_oauth_key_is_not_ready(self):
        self._write({"something_else": True})
        self.assertIs(mod._provider_auth("claude"), False)

    def test_null_oauth_is_not_ready(self):
        self._write({"claudeAiOauth": None})
        self.assertIs(mod._provider_auth("claude"), False)

    def test_malformed_json_is_not_ready(self):
        self._write("{ not valid json")
        self.assertIs(mod._provider_auth("claude"), False)

    def test_non_object_top_level_is_not_ready(self):
        self._write([1, 2, 3])
        self.assertIs(mod._provider_auth("claude"), False)

    def test_absent_file_falls_through(self):
        # No credentials file: non-darwin -> False, darwin -> None (Keychain).
        os.remove(os.path.join(self._home, ".claude", ".credentials.json")) if os.path.isfile(
            os.path.join(self._home, ".claude", ".credentials.json")
        ) else None
        result = mod._provider_auth("claude")
        if sys.platform == "darwin":
            self.assertIsNone(result)
        else:
            self.assertIs(result, False)


if __name__ == "__main__":
    unittest.main()
