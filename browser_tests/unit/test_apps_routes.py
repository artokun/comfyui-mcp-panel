"""Unit tests for the pure helpers in py/apps_routes.py (manifest sanitize,
prompt validate, run-patch, bundle-path containment).

Dev-only. Run from the repo root:

    python -m unittest browser_tests.unit.test_apps_routes
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "py"))

import apps_routes as ar  # noqa: E402

UUID = "123e4567-e89b-42d3-a456-426614174000"


class BundleDir(unittest.TestCase):
    def test_uuid_contained(self):
        root = os.path.realpath(os.path.join(tempfile.gettempdir(), "apps-root"))
        path = ar._bundle_dir(root, UUID)
        self.assertTrue(path.startswith(root + os.sep), path)

    def test_non_uuid_rejected(self):
        root = os.path.realpath(os.path.join(tempfile.gettempdir(), "apps-root"))
        for bad in ("", "..", "../etc", "not-a-uuid", UUID + "/..", None, UUID.upper() + "x"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ar._bundle_dir(root, bad)


class SanitizeManifest(unittest.TestCase):
    def test_minimal(self):
        m = ar._sanitize_manifest({"id": UUID, "name": "My App"})
        self.assertEqual(m["id"], UUID)
        self.assertEqual(m["name"], "My App")
        self.assertEqual(m["hideWorkflow"], False)
        self.assertEqual(m["appMode"], {"inputs": [], "outputs": [], "importedFromFrontend": False})

    def test_requires_id_and_name(self):
        with self.assertRaises(ValueError):
            ar._sanitize_manifest({"name": "x"})
        with self.assertRaises(ValueError):
            ar._sanitize_manifest({"id": UUID})
        with self.assertRaises(ValueError):
            ar._sanitize_manifest({"id": "nope", "name": "x"})

    def test_inputs_outputs_shaped_and_dropped_garbage(self):
        m = ar._sanitize_manifest(
            {
                "id": UUID,
                "name": "x",
                "appMode": {
                    "inputs": [
                        {"nodeId": 6, "widget": "text", "label": "Prompt", "kind": "text"},
                        {"nodeId": "no", "widget": "text"},
                        {"nodeId": 7},
                        "junk",
                    ],
                    "outputs": [{"nodeId": 9}, {"nodeId": "bad"}],
                },
                "unexpectedKey": {"should": "be dropped"},
            }
        )
        self.assertNotIn("unexpectedKey", m)
        self.assertEqual(len(m["appMode"]["inputs"]), 1)
        self.assertEqual(m["appMode"]["inputs"][0]["nodeId"], 6)
        self.assertEqual(m["appMode"]["outputs"], [{"nodeId": 9, "kind": "images"}])

    def test_widget_metadata_kept(self):
        # min/max/step + seedBehavior + nodeType flow through for the richer
        # run-form controls; a bool must NOT pose as a numeric bound.
        m = ar._sanitize_manifest(
            {
                "id": UUID,
                "name": "x",
                "appMode": {
                    "inputs": [
                        {
                            "nodeId": 3,
                            "widget": "steps",
                            "kind": "number",
                            "min": 1,
                            "max": 100,
                            "step": 0.5,
                        },
                        {
                            "nodeId": 3,
                            "widget": "seed",
                            "kind": "seed",
                            "seedBehavior": "randomize",
                            "control_after_generate": "randomize",
                            "min": True,  # bool must be dropped, not kept as 1
                        },
                        {
                            "nodeId": 4,
                            "widget": "ckpt_name",
                            "kind": "model",
                            "nodeType": "CheckpointLoaderSimple",
                        },
                    ],
                },
            }
        )
        ins = m["appMode"]["inputs"]
        self.assertEqual(ins[0]["min"], 1)
        self.assertEqual(ins[0]["max"], 100)
        self.assertEqual(ins[0]["step"], 0.5)
        self.assertEqual(ins[1]["seedBehavior"], "randomize")
        self.assertEqual(ins[1]["control_after_generate"], "randomize")
        self.assertNotIn("min", ins[1])  # bool rejected
        self.assertEqual(ins[2]["nodeType"], "CheckpointLoaderSimple")

    def test_truncation(self):
        m = ar._sanitize_manifest({"id": UUID, "name": "n" * 500, "description": "d" * 9000})
        self.assertEqual(len(m["name"]), 120)
        self.assertEqual(len(m["description"]), 4000)

    def test_partial_update_omits_unsent_fields(self):
        # for_update with no description key must NOT emit one — otherwise
        # manifest.update(patch) wipes the saved description on publish/hide.
        patch = ar._sanitize_manifest({"published": {"slug": "a/b"}}, for_update=True)
        self.assertNotIn("description", patch)
        self.assertNotIn("name", patch)
        self.assertNotIn("id", patch)
        patch = ar._sanitize_manifest({"description": "new"}, for_update=True)
        self.assertEqual(patch["description"], "new")


class ValidatePrompt(unittest.TestCase):
    def test_api_format_ok(self):
        p = {"6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a"}}}
        self.assertEqual(ar._validate_prompt_json(p), p)

    def test_rejects_garbage(self):
        for bad in ({}, [], {"x": {"class_type": "A", "inputs": {}}}, {"6": {"inputs": {}}}, {"6": {"class_type": "A"}}):
            with self.assertRaises(ValueError, msg=repr(bad)):
                ar._validate_prompt_json(bad)


class ApplyPatch(unittest.TestCase):
    PROMPT = {
        "3": {"class_type": "KSampler", "inputs": {"seed": 1, "steps": 20}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["4", 1]}},
    }

    def test_patches_widget_values(self):
        out = ar._apply_patch(self.PROMPT, {"6.text": "a dog", "3.seed": 42})
        self.assertEqual(out["6"]["inputs"]["text"], "a dog")
        self.assertEqual(out["3"]["inputs"]["seed"], 42)
        # original untouched (copy, not in-place)
        self.assertEqual(self.PROMPT["6"]["inputs"]["text"], "a cat")

    def test_dotted_widget_names_split_on_first_dot_only(self):
        prompt = {"5": {"class_type": "LoraLoader", "inputs": {"lora_1.name": "x.safetensors"}}}
        out = ar._apply_patch(prompt, {"5.lora_1.name": "y.safetensors"})
        self.assertEqual(out["5"]["inputs"]["lora_1.name"], "y.safetensors")

    def test_strict_unknown_targets(self):
        for key in ("99.text", "6.nope", "garbage", ".text", "6."):
            with self.assertRaises(ValueError, msg=key):
                ar._apply_patch(self.PROMPT, {key: "v"})


if __name__ == "__main__":
    unittest.main()
