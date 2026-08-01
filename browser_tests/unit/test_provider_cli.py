"""Unit tests for _provider_cli / Codex readiness under a GUI PATH (#434).

Dev-only. Run from the repo root:

    python -m unittest browser_tests.unit.test_provider_cli

Guards #434: ComfyUI Desktop launches its Python server with a minimal GUI PATH
(``/usr/bin:/bin:/usr/sbin:/sbin``), so ``shutil.which()`` cannot see a CLI the
user installed under ``~/.local/bin`` (the Codex installer's target). The pre-fix
``_provider_cli`` used ``shutil.which()`` only, so it reported Codex
``{"cli":false,"auth":true,"ready":false}`` even though the executable existed —
and the panel silently fell back to another backend. The fix also probes
well-known user/local bin dirs that a restricted GUI PATH omits.
"""

import importlib.util
import os
import stat
import sys
import tempfile
import unittest

_REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def _load_init():
    spec = importlib.util.spec_from_file_location(
        "cmcp_panel_init_cli", os.path.join(_REPO, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_init()


class ProviderCliGuiPath(unittest.TestCase):
    def setUp(self):
        # Simulate the restricted GUI PATH: nothing resolves via which().
        self._orig_which = mod.shutil.which
        mod.shutil.which = lambda name: None
        # Point the GUI fallback at a throwaway bin dir (platform-independent, so
        # the test exercises the resolution loop on Windows CI too).
        self._bindir = tempfile.mkdtemp(prefix="cmcp-bin-")
        self._orig_fallback = mod._gui_fallback_bin_dirs
        mod._gui_fallback_bin_dirs = lambda: (self._bindir,)

    def tearDown(self):
        mod.shutil.which = self._orig_which
        mod._gui_fallback_bin_dirs = self._orig_fallback

    def _install(self, name):
        path = os.path.join(self._bindir, name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\n")
        # Make it executable so os.access(..., X_OK) is honest on POSIX (Windows
        # treats any existing file as executable).
        os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return path

    def test_absent_everywhere_is_false(self):
        # which() -> None and nothing in the fallback dir: honestly not present.
        self.assertFalse(mod._provider_cli("codex"))

    def test_resolved_in_fallback_dir(self):
        # The #434 repro: which() misses it, but ~/.local/bin/codex exists.
        self._install("codex")
        self.assertTrue(mod._provider_cli("codex"))

    def test_non_executable_is_not_resolved(self):
        # A present-but-not-executable file must not read as an installed CLI on
        # POSIX (Windows X_OK is loose, so skip the negative there).
        if sys.platform == "win32":
            self.skipTest("Windows os.access X_OK does not honor the exec bit")
        path = os.path.join(self._bindir, "codex")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("#!/bin/sh\n")
        os.chmod(path, stat.S_IRUSR)  # readable, not executable
        self.assertFalse(mod._provider_cli("codex"))

    def test_which_still_wins_when_on_path(self):
        # If which() DOES resolve it, no fallback probe is needed.
        mod.shutil.which = lambda name: "/somewhere/on/path/" + name
        self.assertTrue(mod._provider_cli("codex"))

    def test_provider_state_ready_when_cli_in_fallback_and_auth_present(self):
        # End-to-end: cli found via fallback + ~/.codex/auth.json present => ready.
        self._install("codex")
        home = tempfile.mkdtemp(prefix="cmcp-home-")
        orig_expanduser = os.path.expanduser
        os.path.expanduser = lambda p: home if p == "~" else orig_expanduser(p)
        try:
            os.makedirs(os.path.join(home, ".codex"), exist_ok=True)
            with open(os.path.join(home, ".codex", "auth.json"), "w", encoding="utf-8") as fh:
                fh.write("{}")
            state = mod._provider_state("codex")
            self.assertEqual(state, {"cli": True, "auth": True, "ready": True})
        finally:
            os.path.expanduser = orig_expanduser

    def test_provider_state_not_ready_pre_fix_scenario(self):
        # No fallback resolution (empty bin dir) reproduces the pre-fix defect:
        # cli:false, ready:false even though auth exists.
        home = tempfile.mkdtemp(prefix="cmcp-home-")
        orig_expanduser = os.path.expanduser
        os.path.expanduser = lambda p: home if p == "~" else orig_expanduser(p)
        try:
            os.makedirs(os.path.join(home, ".codex"), exist_ok=True)
            with open(os.path.join(home, ".codex", "auth.json"), "w", encoding="utf-8") as fh:
                fh.write("{}")
            state = mod._provider_state("codex")
            self.assertEqual(state, {"cli": False, "auth": True, "ready": False})
        finally:
            os.path.expanduser = orig_expanduser


class GuiFallbackBinDirs(unittest.TestCase):
    def test_windows_has_no_fallback(self):
        orig = mod.sys.platform
        mod.sys.platform = "win32"
        try:
            self.assertEqual(mod._gui_fallback_bin_dirs(), ())
        finally:
            mod.sys.platform = orig

    def test_non_windows_includes_user_local_bin(self):
        orig = mod.sys.platform
        mod.sys.platform = "darwin"
        try:
            dirs = mod._gui_fallback_bin_dirs()
            self.assertIn(os.path.join(os.path.expanduser("~"), ".local", "bin"), dirs)
            self.assertIn("/usr/local/bin", dirs)
            self.assertIn("/opt/homebrew/bin", dirs)
        finally:
            mod.sys.platform = orig


if __name__ == "__main__":
    unittest.main()
