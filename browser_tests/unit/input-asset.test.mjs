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
  filterServerConfirmedInputSubfolderCandidates,
  inputPathsUseWindowsSeparators,
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

test("#513: server-confirmed nested input media is not reported missing", async () => {
  const candidates = [
    { node_id: 11, file: "root.png" },
    { node_id: 12, file: "codex_stage\\mask.png" },
    { node_id: 13, file: "codex_stage/missing.png" },
    { node_id: 14, file: "codex_stage/mask.png" },
  ];
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(candidates, async (file) => {
    probes.push(file);
    return file.includes("mask.png");
  });
  assert.deepEqual(result, [candidates[0], candidates[2]]);
  assert.deepEqual(probes, ["codex_stage\\mask.png", "codex_stage/missing.png"]);
});

test("#513: nested input media stays missing when the server probe fails", async () => {
  const candidate = { node_id: 12, file: "codex_stage/mask.png" };
  const result = await filterServerConfirmedInputSubfolderCandidates([candidate], async () => {
    throw new Error("offline");
  });
  assert.deepEqual(result, [candidate]);
});

test("splitInputAssetRef: POSIX semantics keep a backslash literal (#513 review)", () => {
  // On a POSIX server ComfyUI resolves `dir\file.png` as a LITERAL filename, not
  // a nested path — the split must NOT invent a subfolder the server won't use.
  assert.deepEqual(splitInputAssetRef("dir\\missing.png", { backslashIsSeparator: false }), {
    subfolder: "",
    filename: "dir\\missing.png",
  });
  // A forward slash still splits on POSIX.
  assert.deepEqual(splitInputAssetRef("dir/missing.png", { backslashIsSeparator: false }), {
    subfolder: "dir",
    filename: "missing.png",
  });
});

test("inputPathsUseWindowsSeparators: sys.platform 'win32' AND legacy os.name 'nt' enable Windows semantics", () => {
  // ComfyUI ≥ 0.4.0 reports Python's sys.platform ("win32" on Windows) in
  // /system_stats; older servers reported os.name ("nt"). BOTH must read as
  // Windows — the nt-only check sent EVERY modern Windows server down the POSIX
  // branch, so an existing `dir\file.png` stayed falsely reported missing on the
  // platform this PR exists for (#513 review regression).
  assert.equal(inputPathsUseWindowsSeparators({ system: { os: "win32" } }), true);
  assert.equal(inputPathsUseWindowsSeparators({ system: { os: "nt" } }), true);
  // POSIX servers keep POSIX semantics — including Cygwin/MSYS2 Pythons
  // (sys.platform "cygwin"/"msys"), whose os.path is posixpath, so a backslash
  // is a literal filename character there.
  assert.equal(inputPathsUseWindowsSeparators({ system: { os: "posix" } }), false);
  assert.equal(inputPathsUseWindowsSeparators({ system: { os: "linux" } }), false);
  assert.equal(inputPathsUseWindowsSeparators({ system: { os: "darwin" } }), false);
  assert.equal(inputPathsUseWindowsSeparators({ system: { os: "cygwin" } }), false);
  assert.equal(inputPathsUseWindowsSeparators({ system: { os: "msys" } }), false);
  // Unknown / malformed payloads fail CLOSED to POSIX semantics.
  assert.equal(inputPathsUseWindowsSeparators({ system: {} }), false);
  assert.equal(inputPathsUseWindowsSeparators({}), false);
  assert.equal(inputPathsUseWindowsSeparators(null), false);
});

test("#513 review: POSIX server — a backslash value is NEVER probed as a nested path", async () => {
  // The false-PASS from the review: `dir\missing.png` is genuinely missing on a
  // POSIX server (LoadImage looks for the literal name), while `dir/missing.png`
  // EXISTS. Splitting the backslash away would probe the existing file and
  // suppress a real miss. POSIX semantics must leave the value un-probed and the
  // candidate reported.
  const candidate = { node_id: 12, file: "dir\\missing.png" };
  let probed = 0;
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async () => {
      probed += 1;
      return true; // would confirm dir/missing.png — must never be consulted
    },
    { backslashIsSeparator: false },
  );
  assert.equal(probed, 0);
  assert.deepEqual(result, [candidate]);
});

test("#513 review: POSIX server — a forward-slash nested value is still probed and cleared", async () => {
  const candidate = { node_id: 12, file: "dir/mask.png" };
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async () => true,
    { backslashIsSeparator: false },
  );
  assert.deepEqual(result, []);
});

test("#513 review: Windows server — a backslash value splits and probes as nested", async () => {
  const candidate = { node_id: 12, file: "dir\\mask.png" };
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async (file) => {
      probes.push(file);
      return true;
    },
    { backslashIsSeparator: true },
  );
  assert.deepEqual(probes, ["dir\\mask.png"]);
  assert.deepEqual(result, []);
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
