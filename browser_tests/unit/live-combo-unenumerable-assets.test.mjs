// panel#1357 — the combo list is not an authority over a file it cannot enumerate.
//
// Reported: `upload_image` put `AgentLibrary/HaReen/Main-9-1.png` in the input
// directory, `panel_set_widget` wrote it and answered `server_confirmed: true`
// (its #387 /view probe), and `panel_get_errors` then listed that exact value as
// `missing_asset` in the same session. Both files were on disk; switching to
// root-level filenames made the "error" vanish.
//
// Cause: `LoadImage.INPUT_TYPES` builds its list from `os.listdir(input_dir)`
// filtered by `isfile` — TOP LEVEL only — while `folder_paths.get_annotated_filepath`
// resolves nested paths fine. So `sub/dir/x.png` can never be a member of that
// combo, and `options.includes(value)` returning false says nothing whatsoever
// about whether the file exists. Same for an `[output]`/`[temp]`-annotated value,
// which resolves against a different root entirely.
//
// The #745 live scan now asks the SERVER about exactly those values, using the same
// probe set_widget used to confirm them — so the two can no longer contradict — and
// abstains (UNKNOWN) when the server will not answer, rather than inventing a miss.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  scanComboAvailability,
  comboConfigsOf,
  uncheckedNodesNote,
} from "../../web/js/lib/live-combo-availability.js";
import { inputAssetProbeVerdict } from "../../web/js/lib/input-asset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");
const INPUT_ASSET_JS = join(HERE, "../../web/js/lib/input-asset.js");

/** An /object_info/<class> body in the shape verified live in #745. */
const classBody = (name, required) => ({ [name]: { input: { required } } });

const node = (id, type, widgets) => ({ id, type, widgets });

/** The verified live LoadImage shape: top-level input files, `{image_upload: true}`. */
const LOAD_IMAGE = classBody("LoadImage", {
  image: [["root.png", "other.png"], { image_upload: true }],
  upload: ["IMAGEUPLOAD", {}],
});

/** A NON-upload file combo. folder_paths lists checkpoints RECURSIVELY, so a
 *  nested value there really is enumerable and its absence really is an answer. */
const CKPT = classBody("CheckpointLoaderSimple", {
  ckpt_name: [["SDXL/base.safetensors"], {}],
});

const NESTED = "AgentLibrary/HaReen/Main-9-1.png";
/** The 17:40Z reproduction: ComfyUI paste names duplicates `image (N).png`. */
const PASTED = "pasted/image (992).png";

test("#1357 a server-CONFIRMED nested upload value is not reported at all", async () => {
  const probed = [];
  const r = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value: NESTED }])],
    async () => LOAD_IMAGE,
    {
      confirmServerAsset: (value, ref) => {
        probed.push({ value, ...ref });
        return true;
      },
    },
  );
  assert.deepEqual(r.unavailable, []);
  assert.deepEqual(r.unknown, []);
  // Probed at the path LoadImage itself would resolve.
  assert.deepEqual(probed, [
    { value: NESTED, filename: "Main-9-1.png", subfolder: "AgentLibrary/HaReen", type: "input" },
  ]);
});

test("#1357 a pasted LoadImage value with spaces is not reported when the server has it", async () => {
  const probed = [];
  const r = await scanComboAvailability(
    [node(46, "LoadImage", [{ name: "image", value: PASTED }])],
    async () => LOAD_IMAGE,
    {
      confirmServerAsset: (value, ref) => {
        probed.push({ value, ...ref });
        return true;
      },
    },
  );
  assert.deepEqual(r.unavailable, []);
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(probed, [
    { value: PASTED, filename: "image (992).png", subfolder: "pasted", type: "input" },
  ]);
});

test("#1357 a nested upload value the server says is ABSENT is still reported", async () => {
  // The fix must not become a blanket amnesty for anything with a slash in it.
  const r = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value: NESTED }])],
    async () => LOAD_IMAGE,
    { confirmServerAsset: () => false },
  );
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].value, NESTED);
  assert.equal(r.unavailable[0].kind, "missing_asset");
  assert.deepEqual(r.unknown, []);
});

test("#1357 an UNANSWERABLE probe is UNKNOWN — not missing, not clean", async () => {
  // A flaky /view must not masquerade as a confirmed miss: non-membership in a
  // list that cannot contain the value is no evidence at all.
  const unanswerable = [
    () => null,
    () => undefined,
    () => {
      throw new Error("network down");
    },
    async () => {
      throw new Error("timeout");
    },
  ];
  for (const confirmServerAsset of unanswerable) {
    const r = await scanComboAvailability(
      [node(4, "LoadImage", [{ name: "image", value: NESTED }])],
      async () => LOAD_IMAGE,
      { confirmServerAsset },
    );
    assert.deepEqual(r.unavailable, []);
    assert.equal(r.unknown.length, 1);
    assert.equal(r.unknown[0].id, 4);
    assert.equal(r.unknown[0].widget, "image");
    assert.equal(r.unknown[0].value, NESTED);
    assert.match(r.unknown[0].reason, /^not checked:/);
  }
});

test("#1357 with NO probe injected the value is unknown, never a finding", async () => {
  const r = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value: NESTED }])],
    async () => LOAD_IMAGE,
  );
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.unknown.length, 1);
  assert.match(r.unknown[0].reason, /no server file check was available/);
});

test("#1357 an [output]-annotated value is unenumerable too, and probes that root", async () => {
  // folder_paths.annotated_filepath resolves this against the OUTPUT root; the
  // input combo lists bare input names, so it is never a member (#743's shape,
  // now reaching the live scan as well).
  const probed = [];
  const r = await scanComboAvailability(
    [node(9, "LoadImage", [{ name: "image", value: "detailed/Anima_00005_.png [output]" }])],
    async () => LOAD_IMAGE,
    {
      confirmServerAsset: (value, ref) => {
        probed.push(ref);
        return true;
      },
    },
  );
  assert.deepEqual(r.unavailable, []);
  assert.deepEqual(probed, [
    { filename: "Anima_00005_.png", subfolder: "detailed", type: "output" },
  ]);
});

test("#1357 a ROOT-level [temp] value is unenumerable — the annotation alone suffices", async () => {
  const probed = [];
  await scanComboAvailability(
    [node(9, "LoadImage", [{ name: "image", value: "scratch.png [temp]" }])],
    async () => LOAD_IMAGE,
    {
      confirmServerAsset: (value, ref) => {
        probed.push(ref);
        return true;
      },
    },
  );
  assert.deepEqual(probed, [{ filename: "scratch.png", subfolder: "", type: "temp" }]);
});

test("#1357 a BARE root-level name stays adjudicated by the combo", async () => {
  // The combo DOES enumerate top-level input files, so absence there is a real
  // answer and must not be softened into an unknown — nor cost a server probe.
  let probes = 0;
  const r = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value: "not-uploaded.png" }])],
    async () => LOAD_IMAGE,
    {
      confirmServerAsset: () => {
        probes += 1;
        return true;
      },
    },
  );
  assert.equal(probes, 0);
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].value, "not-uploaded.png");
});

test("#1357 a NON-upload combo is never softened, however nested the value", async () => {
  // ckpt_name's listing IS recursive, so `Other/missing.safetensors` really is
  // absent. Only an upload input's list is structurally incomplete.
  let probes = 0;
  const r = await scanComboAvailability(
    [node(2, "CheckpointLoaderSimple", [{ name: "ckpt_name", value: "Other/missing.safetensors" }])],
    async () => CKPT,
    {
      confirmServerAsset: () => {
        probes += 1;
        return true;
      },
    },
  );
  assert.equal(probes, 0);
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].kind, "missing_asset");
});

test("#1357 #240 strictness holds: a non-image extension is not cleared by /view", async () => {
  // `/view?type=input` serves ANY input file. Letting a nested `.txt` through on a
  // bare existence hit would put a value in a LoadImage image combo that fails at
  // execution — the same over-acceptance set_widget's uploadInputAccepts refuses.
  let probes = 0;
  const r = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value: "notes/readme.txt" }])],
    async () => LOAD_IMAGE,
    {
      confirmServerAsset: () => {
        probes += 1;
        return true;
      },
    },
  );
  assert.equal(probes, 0);
  assert.equal(r.unavailable.length, 1);
  assert.equal(r.unavailable[0].value, "notes/readme.txt");
});

test("#1357 a backslash value is split only where the SERVER would split it", async () => {
  const windows = [];
  const posix = [];
  const value = "AgentLibrary\\HaReen\\Main-9-1.png";
  const rWin = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value }])],
    async () => LOAD_IMAGE,
    {
      backslashIsSeparator: true,
      confirmServerAsset: (v, ref) => {
        windows.push(ref);
        return true;
      },
    },
  );
  assert.deepEqual(rWin.unavailable, []);
  assert.deepEqual(windows, [
    { filename: "Main-9-1.png", subfolder: "AgentLibrary/HaReen", type: "input" },
  ]);
  // On a POSIX server that backslash is a literal filename character, so the
  // value is a ROOT-level name the combo really does enumerate. Probing a path
  // the server would not resolve could clear a genuinely missing file (#513).
  const rPosix = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value }])],
    async () => LOAD_IMAGE,
    {
      backslashIsSeparator: false,
      confirmServerAsset: (v, ref) => {
        posix.push(ref);
        return true;
      },
    },
  );
  assert.deepEqual(posix, []);
  assert.equal(rPosix.unavailable.length, 1);
});

test("#1357 the default is POSIX semantics — never split a backslash on a guess", async () => {
  const r = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value: "dir\\x.png" }])],
    async () => LOAD_IMAGE,
    { confirmServerAsset: () => true },
  );
  assert.equal(r.unavailable.length, 1);
});

test("#1357 one probe per distinct FILE, not per node", async () => {
  const seen = [];
  const nodes = Array.from({ length: 20 }, (_, i) =>
    node(i, "LoadImage", [{ name: "image", value: NESTED }]));
  await scanComboAvailability(nodes, async () => LOAD_IMAGE, {
    confirmServerAsset: (v, ref) => {
      seen.push(ref);
      return true;
    },
  });
  assert.equal(seen.length, 1);
});

test("#1357 the probe cap is disclosed, never silently truncated", async () => {
  const nodes = Array.from({ length: 5 }, (_, i) =>
    node(i, "LoadImage", [{ name: "image", value: `sub${i}/x.png` }]));
  const r = await scanComboAvailability(nodes, async () => LOAD_IMAGE, {
    maxAssetProbes: 2,
    confirmServerAsset: () => true,
  });
  assert.deepEqual(r.unavailable, []);
  assert.equal(r.unknown.length, 3);
  assert.equal(r.unchecked_asset_probe_limit, 2);
  assert.match(r.unknown[0].reason, /2-file server-existence probe cap/);
});

test("#1357 a budget that dies BETWEEN the lookup and the probe abstains, not accuses", async () => {
  // Scripted so the class lookup lands inside the budget and only the FILE probe
  // falls outside it — otherwise the assertion passes for the wrong reason (the
  // class was never fetched, so nothing was judged at all).
  //   call 1 = deadline base, call 2 = the class-lookup check, call 3 = the probe.
  const clock = [0, 0, 5000];
  let i = 0;
  let probes = 0;
  const r = await scanComboAvailability(
    [node(4, "LoadImage", [{ name: "image", value: NESTED }])],
    async () => LOAD_IMAGE,
    {
      budgetMs: 1000,
      now: () => clock[Math.min(i++, clock.length - 1)],
      confirmServerAsset: () => {
        probes += 1;
        return true;
      },
    },
  );
  assert.equal(probes, 0, "the probe must not be attempted past the deadline");
  assert.deepEqual(r.unavailable, [], "an unaffordable check is not a finding");
  assert.equal(r.unknown.length, 1);
  assert.match(r.unknown[0].reason, /ran out of its shared server-call budget/);
  assert.equal(r.unchecked_budget_exhausted, true);
});

test("#1357 the class-limit flag still reads as the CLASS limit, not the probe one", async () => {
  // The two caps are different facts; collapsing them would misname what was skipped.
  const nodes = Array.from({ length: 4 }, (_, i) =>
    node(i, `Pack${i}`, [{ name: "x", value: "v" }]));
  const r = await scanComboAvailability(nodes, async (cls) => classBody(cls, { x: [["a"], {}] }), {
    maxClasses: 2,
  });
  assert.equal(r.unchecked_class_limit, 2);
  assert.equal(r.unchecked_asset_probe_limit, undefined);
  assert.equal(r.unchecked_budget_exhausted, undefined);
});

test("#1357 comboConfigsOf carries the upload flag, and separates absent from empty", async () => {
  assert.equal(comboConfigsOf({}, "Nope"), null);
  assert.equal(comboConfigsOf(null, "Nope"), null);
  const cfgs = comboConfigsOf(LOAD_IMAGE, "LoadImage");
  assert.deepEqual(cfgs.get("image"), { image_upload: true });
  // A typed input is not a combo, so it has no config entry here.
  assert.equal(cfgs.has("upload"), false);
  assert.equal(comboConfigsOf(classBody("T", { x: ["INT", {}] }), "T").size, 0);
  // A combo declared with no config object still yields a config entry, so a
  // caller can tell "combo without upload flag" from "not a combo at all".
  assert.deepEqual(comboConfigsOf(classBody("T", { x: [["a"]] }), "T").get("x"), {});
});

test("#1357 only a 404 is 'absent'; every other outcome is 'did not answer'", () => {
  assert.equal(inputAssetProbeVerdict({ ok: true, status: 200 }), true);
  assert.equal(inputAssetProbeVerdict({ ok: false, status: 206 }), true);
  assert.equal(inputAssetProbeVerdict({ ok: false, status: 404 }), false);
  // A traversal refusal, an auth wall, a dead backend and a proxy error page are
  // NOT the server saying the file is gone. Reading any of them as `false` would
  // put a present file back under missing_asset — the #1357 regression itself.
  for (const status of [0, 400, 401, 403, 429, 500, 502, 503]) {
    assert.equal(inputAssetProbeVerdict({ ok: false, status }), null, `status ${status}`);
  }
  assert.equal(inputAssetProbeVerdict(null), null);
  assert.equal(inputAssetProbeVerdict(undefined), null);
});

test("#1357 WIRING: get_errors' live scan really is given the server probe", () => {
  // The lib can be perfect and the bug still ship if get_errors never injects the
  // probe — the scan's own default is "no probe", which abstains rather than
  // clears, so a missed wiring would be silent in every lib-level test above.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /confirmServerAsset: \(_value, ref\) =>\s*\n?\s*probeInputAssetPresence\(ref, errorsStepBudget\(/);
  assert.match(src, /backslashIsSeparator,\s*\n\s*confirmServerAsset:/);
  // Split the value the way the SERVER does, not the way the browser would.
  assert.match(
    src,
    /const backslashIsSeparator =\s*\n?\s*statsBudget > 0 \? await inputAssetServerUsesWindowsPaths\(statsBudget\) : false;/,
  );
});

test("#1357 WIRING: the probe is tri-state, and the media filter keeps its old floor", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const lib = readFileSync(INPUT_ASSET_JS, "utf8");
  assert.match(lib, /return inputAssetProbeVerdict\(res\);/);
  // The store-driven missing-media filter must still collapse "absent" and
  // "unknown" into "keep reporting" — it has a prior assertion the scan lacks,
  // and loosening it here would silently un-ship #513/#743.
  assert.match(src, /\(await probeInputAssetPresence\(ref, probeBudget\)\) === true/);
});

test("#1357 WIRING: both /view probes percent-encode the filename, not form-encode it", () => {
  // URLSearchParams encodes a space as `+`. The #1368 probe used that, so
  // `image (992).png` was asked as `image+(992).png` and 404ed as missing
  // while `/view` with encodeURIComponent (ComfyUI's own getResourceURL)
  // returned 200/206. get_errors goes through the lib probe; set_widget
  // builds the same query string.
  const src = readFileSync(PANEL_JS, "utf8");
  const lib = readFileSync(INPUT_ASSET_JS, "utf8");
  assert.match(lib, /filename=\$\{encodeURIComponent\(String\(filename\)\)\}/);
  assert.match(src, /probeAssetOnServer\(/);
  assert.match(src, /inputAssetViewQuery\(\{ filename, subfolder, type: "input" \}\)/);
  assert.doesNotMatch(src, /URLSearchParams\(\{ filename/);
});

test("#1357 WIRING: an abstention is disclosed, never left to read as clean", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /unchecked_nodes_note: uncheckedNodesNote\(liveScan\.unknown\)/);
  assert.match(src, /unchecked_asset_probe_limit: liveScan\.unchecked_asset_probe_limit/);
});

test("#1357 unchecked_nodes is worded as an abstention, not a clearance", async () => {
  const note = uncheckedNodesNote([
    { id: 1, type: "SomePackNode", reason: "node type not found in /object_info" },
    { id: 4, type: "LoadImage", widget: "image", value: NESTED, reason: "not checked: x" },
  ]);
  assert.match(note, /NOT CHECKED/);
  assert.match(note, /1 node\(s\) this scan could not judge/);
  assert.match(note, /1 widget value\(s\)/);
  assert.match(note, /abstentions, not clearances/);
  // The node bucket also holds class-cap and budget skips, whose type resolved
  // fine. The summary must not name a cause it did not read — the per-entry
  // `reason` is where the three are told apart.
  assert.doesNotMatch(note, /could not resolve/);
  assert.equal(uncheckedNodesNote([]), "");
  assert.equal(uncheckedNodesNote(null), "");
});
