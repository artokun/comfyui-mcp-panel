/**
 * Unit tests for the UPLOAD-input recognition helpers (#387) —
 * web/js/lib/input-asset.js. Run with `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  uploadInputConfig,
  uploadInputAccepts,
  splitInputAssetRef,
  addComboOption,
} from "../../web/js/lib/input-asset.js";

const DEFS = {
  LoadImage: {
    input: { required: { image: [["example.png"], { image_upload: true }] } },
  },
  LoadImageMask: {
    input: {
      required: {
        image: [["a.png"], { image_upload: true }],
        channel: [["red", "green", "blue", "alpha"]],
      },
    },
  },
  VHS_LoadVideo: {
    input: { optional: { video: [["clip.mp4"], { video_upload: true }] } },
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["sd15.safetensors"]] } },
  },
};

test("uploadInputConfig returns the config for an image_upload input", () => {
  const cfg = uploadInputConfig(DEFS, "LoadImage", "image");
  assert.ok(cfg);
  assert.equal(cfg.image_upload, true);
});

test("uploadInputConfig recognizes a video_upload input in optional inputs", () => {
  assert.ok(uploadInputConfig(DEFS, "VHS_LoadVideo", "video"));
});

test("uploadInputConfig is null for a plain combo (model loader) — strictness gate", () => {
  assert.equal(uploadInputConfig(DEFS, "CheckpointLoaderSimple", "ckpt_name"), null);
});

test("uploadInputConfig is null for a NON-upload combo on an upload node (LoadImageMask.channel)", () => {
  assert.equal(uploadInputConfig(DEFS, "LoadImageMask", "channel"), null);
  assert.ok(uploadInputConfig(DEFS, "LoadImageMask", "image"));
});

test("uploadInputConfig is defensive: missing defs / type / widget → null", () => {
  assert.equal(uploadInputConfig(null, "LoadImage", "image"), null);
  assert.equal(uploadInputConfig(DEFS, "NopeNode", "image"), null);
  assert.equal(uploadInputConfig(DEFS, "LoadImage", "nope"), null);
  assert.equal(uploadInputConfig(DEFS, "LoadImage", null), null);
});

test("uploadInputAccepts: image_upload accepts image extensions, rejects a .txt (#240 strictness)", () => {
  const cfg = { image_upload: true };
  assert.equal(uploadInputAccepts(cfg, "xyr_canvas/foo.png"), true);
  assert.equal(uploadInputAccepts(cfg, "sub/pic.JPEG"), true);
  assert.equal(uploadInputAccepts(cfg, "sub/clip.webp"), true);
  // A server-EXISTING but wrong-kind / non-loadable file must be refused.
  assert.equal(uploadInputAccepts(cfg, "xyr_canvas/notes.txt"), false);
  assert.equal(uploadInputAccepts(cfg, "sub/data.json"), false);
  assert.equal(uploadInputAccepts(cfg, "sub/clip.mp4"), false);
});

test("uploadInputAccepts: video_upload / audio_upload gate to their own kinds", () => {
  assert.equal(uploadInputAccepts({ video_upload: true }, "a/clip.mp4"), true);
  assert.equal(uploadInputAccepts({ video_upload: true }, "a/pic.png"), false);
  assert.equal(uploadInputAccepts({ audio_upload: true }, "a/song.mp3"), true);
  assert.equal(uploadInputAccepts({ audio_upload: true }, "a/pic.png"), false);
});

test("uploadInputAccepts: extensionless / dotfile / null config → false", () => {
  assert.equal(uploadInputAccepts({ image_upload: true }, "sub/noext"), false);
  assert.equal(uploadInputAccepts({ image_upload: true }, "sub/.hidden"), false);
  assert.equal(uploadInputAccepts({ image_upload: true }, "sub/trailingdot."), false);
  assert.equal(uploadInputAccepts(null, "sub/foo.png"), false);
});

test("splitInputAssetRef: nested subfolder path", () => {
  assert.deepEqual(splitInputAssetRef("xyr_canvas/foo.png"), {
    subfolder: "xyr_canvas",
    filename: "foo.png",
  });
});

test("splitInputAssetRef: deep nested path splits on the LAST slash", () => {
  assert.deepEqual(splitInputAssetRef("a/b/c/img.jpg"), { subfolder: "a/b/c", filename: "img.jpg" });
});

test("splitInputAssetRef: root-level filename has empty subfolder", () => {
  assert.deepEqual(splitInputAssetRef("foo.png"), { subfolder: "", filename: "foo.png" });
});

test("splitInputAssetRef: Windows backslashes normalized to forward slashes", () => {
  assert.deepEqual(splitInputAssetRef("xyr_canvas\\foo.png"), {
    subfolder: "xyr_canvas",
    filename: "foo.png",
  });
});

test("addComboOption adds a value to an array-backed combo in place", () => {
  const w = { options: { values: ["a.png"] } };
  assert.equal(addComboOption(w, "xyr_canvas/foo.png"), true);
  assert.deepEqual(w.options.values, ["a.png", "xyr_canvas/foo.png"]);
});

test("addComboOption is idempotent (no duplicate) and creates options if missing", () => {
  const w = { options: { values: ["a.png", "b.png"] } };
  addComboOption(w, "a.png");
  assert.deepEqual(w.options.values, ["a.png", "b.png"]);
  const w2 = {};
  assert.equal(addComboOption(w2, "x.png"), true);
  assert.deepEqual(w2.options.values, ["x.png"]);
});

test("addComboOption refuses to clobber a dynamic FUNCTION option source", () => {
  const fn = () => ["a.png"];
  const w = { options: { values: fn } };
  assert.equal(addComboOption(w, "x.png"), false);
  assert.equal(w.options.values, fn, "function source left untouched");
});
