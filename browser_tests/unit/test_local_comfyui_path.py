"""#1647 — advertise the running ComfyUI base, not a stale inherited path."""

import importlib.util
import os
import sys
import types
import unittest
from unittest.mock import patch


_REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")


def _load_init():
    spec = importlib.util.spec_from_file_location(
        "cmcp_panel_init_local_path", os.path.join(_REPO, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mod = _load_init()


class LocalComfyUiPath(unittest.TestCase):
    def test_live_folder_paths_wins_over_stale_environment_override(self):
        folder_paths = types.ModuleType("folder_paths")
        folder_paths.base_path = r"E:\ComfyUI\running"
        with patch.dict(mod.environ, {"COMFYUI_PATH": r"C:\ComfyUI\stale"}), patch.dict(
            sys.modules, {"folder_paths": folder_paths}
        ):
            self.assertEqual(mod._local_comfyui_path(), r"E:\ComfyUI\running")

    def test_environment_override_is_fallback_when_folder_paths_is_unavailable(self):
        with patch.dict(mod.environ, {"COMFYUI_PATH": r"C:\ComfyUI\configured"}), patch.dict(
            sys.modules, {"folder_paths": None}
        ):
            self.assertEqual(mod._local_comfyui_path(), r"C:\ComfyUI\configured")

    def test_blank_live_base_falls_back_to_environment_override(self):
        folder_paths = types.ModuleType("folder_paths")
        folder_paths.base_path = "  "
        with patch.dict(mod.environ, {"COMFYUI_PATH": r"C:\ComfyUI\configured"}), patch.dict(
            sys.modules, {"folder_paths": folder_paths}
        ):
            self.assertEqual(mod._local_comfyui_path(), r"C:\ComfyUI\configured")


if __name__ == "__main__":
    unittest.main()
