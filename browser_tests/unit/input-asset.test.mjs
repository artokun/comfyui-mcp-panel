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
  parseAnnotatedFilepath,
  filterServerConfirmedInputSubfolderCandidates,
  inputPathsUseWindowsSeparators,
  addComboOption,
  inputAssetViewQuery,
  probeInputAssetPresence,
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

test("parseAnnotatedFilepath: strips [output]/[input]/[temp] and keeps the subfolder intact", () => {
  assert.deepEqual(parseAnnotatedFilepath("detailed/Anima_00005_.png [output]"), {
    name: "detailed/Anima_00005_.png",
    type: "output",
    annotated: true,
  });
  assert.deepEqual(parseAnnotatedFilepath("clip.mp4 [temp]"), {
    name: "clip.mp4",
    type: "temp",
    annotated: true,
  });
  assert.deepEqual(parseAnnotatedFilepath("sub/pic.png [input]"), {
    name: "sub/pic.png",
    type: "input",
    annotated: true,
  });
});

test("parseAnnotatedFilepath: unannotated defaults to input; lookalikes are untouched", () => {
  assert.deepEqual(parseAnnotatedFilepath("plain.png"), {
    name: "plain.png",
    type: "input",
    annotated: false,
  });
  // An unknown root is not ComfyUI's annotation shape — treated as a literal name.
  assert.deepEqual(parseAnnotatedFilepath("odd.png [output2]"), {
    name: "odd.png [output2]",
    type: "input",
    annotated: false,
  });
  // Brackets mid-name are not a suffix annotation.
  assert.deepEqual(parseAnnotatedFilepath("a [output] b.png"), {
    name: "a [output] b.png",
    type: "input",
    annotated: false,
  });
});

test("parseAnnotatedFilepath: UNSPACED suffix is still an annotation (upstream endswith + fixed slice)", () => {
  // folder_paths.annotated_filepath recognizes the suffix with NO preceding
  // space and slices a FIXED 9/8/7 chars — one more than the bracketed suffix —
  // so an unspaced value loses one trailing filename char too. Quirky, but it is
  // the exact path LoadImage resolves, so the probe must mirror it.
  assert.deepEqual(parseAnnotatedFilepath("foo[output]"), {
    name: "fo", // "foo[output]"[:-9]
    type: "output",
    annotated: true,
  });
  assert.deepEqual(parseAnnotatedFilepath("clip[temp]"), {
    name: "cli", // "clip[temp]"[:-7]
    type: "temp",
    annotated: true,
  });
  assert.deepEqual(parseAnnotatedFilepath("sub/pic.png[input]"), {
    name: "sub/pic.pn", // "sub/pic.png[input]"[:-8]
    type: "input",
    annotated: true,
  });
});

test("parseAnnotatedFilepath: a bare suffix (or suffix+1 char) clamps to an empty name, like Python", () => {
  // name[:-N] past the string start yields "" in Python; JS slice must clamp the
  // same way rather than eat a trailing char.
  assert.deepEqual(parseAnnotatedFilepath("[output]"), { name: "", type: "output", annotated: true });
  assert.deepEqual(parseAnnotatedFilepath("[input]"), { name: "", type: "input", annotated: true });
  assert.deepEqual(parseAnnotatedFilepath("[temp]"), { name: "", type: "temp", annotated: true });
  assert.deepEqual(parseAnnotatedFilepath("x[temp]"), { name: "", type: "temp", annotated: true });
});

test("#743: [output]-annotated path with subfolder and an EXISTING file is NOT reported missing", async () => {
  const candidate = { node_id: 1363, file: "detailed/Anima_00005_.png [output]" };
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async (file, ref) => {
      probes.push({ file, ref });
      return true; // server confirms <output>/detailed/Anima_00005_.png
    },
  );
  assert.deepEqual(result, []);
  // The probe must target the OUTPUT root with the annotation STRIPPED and the
  // subfolder intact — not a literal "[output]"-suffixed name under input/.
  assert.deepEqual(probes, [
    {
      file: "detailed/Anima_00005_.png [output]",
      ref: { filename: "Anima_00005_.png", subfolder: "detailed", type: "output" },
    },
  ]);
});

test("#743: [output]-annotated path that is genuinely ABSENT is still reported", async () => {
  const candidate = { node_id: 1363, file: "detailed/Anima_99999_.png [output]" };
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async () => false, // /view?type=output 404s
  );
  assert.deepEqual(result, [candidate]);
});

test("#743: [input]-annotated nested path is probed against the input root", async () => {
  const candidate = { node_id: 7, file: "uploads/pic.png [input]" };
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async (file, ref) => {
      probes.push(ref);
      return true;
    },
  );
  assert.deepEqual(result, []);
  assert.deepEqual(probes, [{ filename: "pic.png", subfolder: "uploads", type: "input" }]);
});

test("#743: [temp]-annotated path is probed against the temp root", async () => {
  const candidate = { node_id: 8, file: "scratch/frame.png [temp]" };
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async (file, ref) => {
      probes.push(ref);
      return true;
    },
  );
  assert.deepEqual(result, []);
  assert.deepEqual(probes, [{ filename: "frame.png", subfolder: "scratch", type: "temp" }]);
});

test("#743: ROOT-LEVEL annotated value is probed too — the combo never lists the annotated form", async () => {
  const candidate = { node_id: 9, file: "ComfyUI_00001_.png [output]" };
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async (file, ref) => {
      probes.push(ref);
      return true;
    },
  );
  assert.deepEqual(result, []);
  assert.deepEqual(probes, [{ filename: "ComfyUI_00001_.png", subfolder: "", type: "output" }]);
});

test("#743: a failed probe keeps an annotated candidate reported (fail-closed)", async () => {
  const candidate = { node_id: 10, file: "detailed/Anima_00005_.png [output]" };
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async () => {
      throw new Error("offline");
    },
  );
  assert.deepEqual(result, [candidate]);
});

test("#743: annotation is stripped BEFORE the Windows backslash split", async () => {
  const candidate = { node_id: 11, file: "detailed\\Anima_00005_.png [output]" };
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async (file, ref) => {
      probes.push(ref);
      return true;
    },
    { backslashIsSeparator: true },
  );
  assert.deepEqual(result, []);
  assert.deepEqual(probes, [{ filename: "Anima_00005_.png", subfolder: "detailed", type: "output" }]);
});

test("#743: UNSPACED root-level [output] value is probed against the output root, not skipped", async () => {
  // "foo.png[output]" is an annotation to ComfyUI (bare endswith) resolving as
  // "foo.pn" in the output root (fixed 9-char slice). A space-requiring parser
  // would misread it as a plain input value and skip the probe entirely.
  const candidate = { node_id: 12, file: "foo.png[output]" };
  const probes = [];
  const result = await filterServerConfirmedInputSubfolderCandidates(
    [candidate],
    async (file, ref) => {
      probes.push(ref);
      return true;
    },
  );
  assert.deepEqual(result, []);
  assert.deepEqual(probes, [{ filename: "foo.pn", subfolder: "", type: "output" }]);
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

function filenameParamOf(qs) {
  const part = String(qs).split("&").find((p) => p.startsWith("filename="));
  return part ? part.slice("filename=".length) : "";
}

test("#1357 a pasted filename with spaces decodes back to the file on disk", () => {
  // The 17:40Z value. URLSearchParams would emit `image+%28992%29.png`;
  // decodeURIComponent of that is `image+(992).png`, which is not on disk.
  const ref = { filename: "image (992).png", subfolder: "pasted", type: "input" };
  const qs = inputAssetViewQuery(ref);
  assert.equal(decodeURIComponent(filenameParamOf(qs)), "image (992).png");
  assert.notEqual(qs, new URLSearchParams(ref).toString());
});

test("#1357 the /view probe asks for the spaced pasted file, not a plus-encoded lookalike", async () => {
  let route = "";
  const verdict = await probeInputAssetPresence(
    { filename: "image (992).png", subfolder: "pasted", type: "input" },
    50,
    async (r) => {
      route = r;
      return { ok: false, status: 206 };
    },
  );
  assert.equal(verdict, true);
  assert.match(route, /^\/view\?/);
  assert.equal(decodeURIComponent(filenameParamOf(route.split("?")[1])), "image (992).png");
});

test("#1357 a plus in the real filename stays a plus, not a space", () => {
  const qs = inputAssetViewQuery({ filename: "a+b.png", subfolder: "", type: "input" });
  assert.equal(decodeURIComponent(filenameParamOf(qs)), "a+b.png");
});
