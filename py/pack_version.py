"""Read the INSTALLED pack's own version from its pyproject.toml.

Backs ``GET /comfyui_mcp_panel/version`` (#584/#611): the panel JS compares its
running ``PANEL_VERSION`` against this on-disk value to detect that the browser
is still running a CACHED older bundle after a pack update (ComfyUI serves the
extension web dir with plain aiohttp static semantics, so heuristic freshness
lets a stale module graph survive restarts and plain reloads). The comparison
only works if this value is read from disk at request time — never cached at
import — so an updated pack reports its NEW version without waiting for a
Python-level reload of this module.

Read-only: this module never writes pyproject.toml (a version change publishes
to the Comfy Registry), and any unreadable/malformed file yields None rather
than raising — the route then reports ``{"version": None}`` and the panel
treats the probe as UNKNOWN (no self-heal reload), never as "mismatch".
"""

import os
import re

_VERSION_LINE_RE = re.compile(r'^version\s*=\s*"([^"]+)"\s*(?:#.*)?$')


def _version_from_project_section(text):
    """The ``version`` string from the ``[project]`` table only, or None.

    Used on Pythons WITHOUT tomllib. Section-aware (codex gate round 5): a
    bare top-level ``version`` line, a ``version`` under any OTHER table, or a
    schema-invalid ``project = "..."`` assignment all yield None rather than a
    scraped guess — a malformed probe must be UNKNOWN, never a false stale
    verdict.
    """
    in_project = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("["):
            in_project = stripped == "[project]"
            continue
        if in_project:
            match = _VERSION_LINE_RE.match(stripped)
            if match:
                return match.group(1)
    return None


def read_pack_version(pyproject_path):
    """Return the ``[project] version`` string from pyproject_path, or None.

    Uses tomllib when available (Python 3.11+); falls back to a line regex ONLY
    when tomllib is absent (older Python), so a MALFORMED pyproject on a modern
    Python yields None — a corrupt file must report "unknown" (the panel then
    never reloads), never a version scraped out of unparseable content (codex
    gate round 2). None on any failure — a missing/unparseable version must
    never break the route.
    """
    try:
        with open(pyproject_path, "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    try:
        # Strict on purpose (codex gate round 3): a corrupt byte decoded with
        # "replace" could let tomllib parse a damaged file and report a version
        # from it — a malformed file must be UNKNOWN (no reload), never a guess.
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return None
    try:
        import tomllib  # Python 3.11+
    except ImportError:
        tomllib = None
    if tomllib is not None:
        try:
            data = tomllib.loads(text)
        except Exception:
            return None  # present but unparseable — unknown, never guess
        project = data.get("project")
        if not isinstance(project, dict):
            return None  # schema-invalid (e.g. project = "x") — unknown, never raise
        version = project.get("version")
        return version if isinstance(version, str) and version else None
    match = _version_from_project_section(text)
    return match


def installed_pack_version():
    """Version of the pack this module ships in (pyproject.toml at pack root)."""
    pack_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return read_pack_version(os.path.join(pack_root, "pyproject.toml"))
