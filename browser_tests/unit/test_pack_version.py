"""Unit tests for py/pack_version.py (#584/#611).

The /comfyui_mcp_panel/version route answers with the INSTALLED pack's version,
read from pyproject.toml at request time, so a browser tab running a cached
stale bundle can prove it and self-heal. An unreadable/malformed file must
yield None (the panel treats the probe as UNKNOWN and never reloads on it).

Dev-only. Run from the repo root:

    python -m unittest browser_tests.unit.test_pack_version
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "py"))

import pack_version as pv  # noqa: E402


class ReadPackVersion(unittest.TestCase):
    def _write(self, text):
        fd, path = tempfile.mkstemp(suffix=".toml")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        self.addCleanup(os.unlink, path)
        return path

    def test_reads_project_version(self):
        path = self._write('[project]\nname = "comfyui-mcp-panel"\nversion = "0.11.39"\n')
        self.assertEqual(pv.read_pack_version(path), "0.11.39")

    def test_missing_file_is_none_not_raise(self):
        self.assertIsNone(pv.read_pack_version(os.path.join(tempfile.gettempdir(), "no-such-pyproject.toml")))

    def test_malformed_or_versionless_is_none(self):
        self.assertIsNone(pv.read_pack_version(self._write("not toml at all = = =\n")))
        self.assertIsNone(pv.read_pack_version(self._write('[project]\nname = "x"\n')))
        self.assertIsNone(pv.read_pack_version(self._write("")))

    def test_malformed_toml_with_a_version_line_is_none_not_scraped(self):
        # codex gate round 2: a CORRUPT pyproject that happens to contain a
        # version-looking line must report UNKNOWN (no reload), not a version
        # scraped out of unparseable content — the regex fallback exists only
        # for Pythons WITHOUT tomllib.
        try:
            import tomllib  # noqa: F401
        except ImportError:
            self.skipTest("on Python < 3.11 the line-regex fallback is the intended behavior")
        path = self._write('[project\nversion = "9.9.9"\n')
        self.assertIsNone(pv.read_pack_version(path))

    def test_invalid_utf8_is_none(self):
        # codex gate round 3: non-UTF-8 bytes must not be "repaired" into a
        # parseable file — a corrupt pyproject is UNKNOWN.
        fd, path = tempfile.mkstemp(suffix=".toml")
        with os.fdopen(fd, "wb") as fh:
            fh.write(b'[project]\nversion = "1.2.3"\n# comment \xff\xfe\n')
        self.addCleanup(os.unlink, path)
        self.assertIsNone(pv.read_pack_version(path))

    def test_schema_invalid_project_field_is_none_not_raise(self):
        # codex gate round 4: valid TOML whose [project] is not a table must
        # yield None per the function contract, never AttributeError.
        self.assertIsNone(pv.read_pack_version(self._write('project = "not-a-table"\n')))

    def test_regex_fallback_when_tomllib_unavailable(self):
        # Older Pythons have no tomllib; the section-aware line fallback must
        # still resolve the [project] version this repo ships.
        path = self._write('[project]\nversion = "1.2.3"\n')
        saved = sys.modules.get("tomllib")
        sys.modules["tomllib"] = None  # importing a None entry raises ImportError
        try:
            self.assertEqual(pv.read_pack_version(path), "1.2.3")
            # …but must NOT scrape a version from outside [project] or from a
            # schema-invalid project field (codex gate round 5).
            self.assertIsNone(pv.read_pack_version(self._write('version = "9.9.9"\n')))
            self.assertIsNone(
                pv.read_pack_version(self._write('[tool.x]\nversion = "9.9.9"\n'))
            )
            self.assertIsNone(
                pv.read_pack_version(self._write('project = "not-a-table"\nversion = "9.9.9"\n'))
            )
        finally:
            if saved is None:
                sys.modules.pop("tomllib", None)
            else:
                sys.modules["tomllib"] = saved

    def test_installed_pack_version_matches_repo_pyproject(self):
        # The pack root's own pyproject.toml resolves, and to a non-empty string.
        version = pv.installed_pack_version()
        self.assertIsInstance(version, str)
        self.assertTrue(version.strip())


if __name__ == "__main__":
    unittest.main()
