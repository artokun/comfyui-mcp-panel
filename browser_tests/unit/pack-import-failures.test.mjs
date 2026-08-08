// panel#775/#778 — a missing node type is not proof of a missing PACK.
//
// `apiLoadNote` told the reader to "install the custom-node pack that provides
// it". I followed that advice on my own machine and it was wrong: the pack WAS
// installed and had failed to import. I then reported a missing dependency in
// the pack's manifest, on a public issue, and had to correct it.
//
// What made it convincing is worth keeping in front of whoever reads this next:
// the OTHER LTX nodes resolved, because they come from core `comfy_extras`. So 34
// of 35 types were present and exactly the pack-provided one was not — a broken
// install looked precisely like a bad manifest.
//
// The log lines below are REAL, captured from the rig that fooled me.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  packsThatFailedToImport,
  importFailureNote,
  readPackImportFailures,
} from "../../web/js/lib/pack-import-failures.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const ESC = String.fromCharCode(27);

/** Verbatim from /internal/logs on the rig, colour codes included. */
const REAL_LOG = [
  `${ESC}[33m[WARNING]${ESC}[0m Cannot import C:\\Users\\a\\ComfyUI\\custom_nodes\\ComfyUI-LTXVideo module for custom nodes: cannot import name 'interleaved_freqs_cis'`,
  `${ESC}[32m[INFO]${ESC}[0m    0.0 seconds (IMPORT FAILED): C:\\Users\\a\\ComfyUI\\custom_nodes\\comfyui-does-not-exist-99999`,
  `${ESC}[32m[INFO]${ESC}[0m    0.0 seconds (IMPORT FAILED): C:\\Users\\a\\ComfyUI\\custom_nodes\\ComfyUI-LTXVideo`,
  `${ESC}[32m[INFO]${ESC}[0m    1.2 seconds: C:\\Users\\a\\ComfyUI\\custom_nodes\\rgthree-comfy`,
].join("\n");

test("#775 it finds the packs ComfyUI said failed to import", () => {
  assert.deepEqual(packsThatFailedToImport(REAL_LOG), [
    "comfyui-does-not-exist-99999",
    "ComfyUI-LTXVideo",
  ]);
});

test("#775 a pack that imported FINE is not listed", () => {
  // The same summary line shape without the marker. Listing a healthy pack would
  // send someone to debug something that works.
  assert.ok(!packsThatFailedToImport(REAL_LOG).includes("rgthree-comfy"));
});

test("#775 only the pack NAME is reported, never the full path", () => {
  // These messages get pasted into public issues. An absolute path leaks the
  // user's directory layout and their username for no diagnostic gain.
  for (const name of packsThatFailedToImport(REAL_LOG)) {
    assert.ok(!name.includes("\\"), `leaked a path: ${name}`);
    assert.ok(!name.includes("/"), `leaked a path: ${name}`);
    assert.ok(!/Users|home/i.test(name), `leaked a home directory: ${name}`);
  }
});

test("#775 posix paths and duplicates behave", () => {
  const log = [
    "[INFO] 0.0 seconds (IMPORT FAILED): /home/u/ComfyUI/custom_nodes/My-Pack",
    "[INFO] 0.0 seconds (IMPORT FAILED): /home/u/ComfyUI/custom_nodes/My-Pack",
  ].join("\n");
  assert.deepEqual(packsThatFailedToImport(log), ["My-Pack"]);
});

test("#775 nothing to find is an empty list, not a guess", () => {
  assert.deepEqual(packsThatFailedToImport(""), []);
  assert.deepEqual(packsThatFailedToImport("all packs loaded fine\n"), []);
  assert.deepEqual(packsThatFailedToImport(null), []);
});

test("#775 the note contradicts the 'install it' advice", () => {
  // This is the whole point: the standing message says install the pack, and
  // that cannot work for a pack which is already there and failing to load.
  const note = importFailureNote(["ComfyUI-LTXVideo"]);
  assert.match(note, /BEFORE INSTALLING ANYTHING/);
  assert.match(note, /ComfyUI-LTXVideo/);
  assert.match(note, /installing it again will not help/);
  assert.match(note, /registers NONE of its nodes/);
});

test("#775 it does NOT claim the failed pack owns the missing types", () => {
  // Establishing that needs the pack's NODE_CLASS_MAPPINGS, which the browser
  // cannot read. Asserting it would be the same overreach that produced the
  // wrong public diagnosis in the first place.
  const note = importFailureNote(["ComfyUI-LTXVideo"]);
  assert.match(note, /does not prove it owns the missing types/);
  assert.match(note, /first thing to rule out/);
});

test("#775 no failures means NO note — the ordinary advice stands", () => {
  // When nothing failed, "install the pack" really is the best available advice
  // and a hedge would only dilute it.
  assert.equal(importFailureNote([]), "");
  assert.equal(importFailureNote(null), "");
  assert.equal(importFailureNote(undefined), "");
});

test("#775 the reader is never handed a throw, and does not use /api", async () => {
  // The transport is the whole bug: api.fetchApi prefixes /api and this endpoint
  // is not there, so the feature was a silent no-op in every real browser while
  // these tests passed against a fake. Stub the REAL global fetch instead.
  const calls = [];
  const realFetch = globalThis.fetch;
  const api = { fileURL: (r) => `/base${r}` };
  try {
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return { ok: true, json: async () => ({ entries: [{ m: REAL_LOG }] }) };
    };
    assert.deepEqual(await readPackImportFailures(api), [
      "comfyui-does-not-exist-99999",
      "ComfyUI-LTXVideo",
    ]);
    assert.deepEqual(calls, ["/base/internal/logs/raw"], "fileURL is honoured, /api is not");
    assert.ok(!calls[0].includes("/api/"), "the /api prefix is what 404s");

    // Every failure mode still yields [] rather than throwing.
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    assert.deepEqual(await readPackImportFailures(api), []);
    globalThis.fetch = async () => { throw new Error("offline"); };
    assert.deepEqual(await readPackImportFailures(api), []);
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw new Error("bad"); } });
    assert.deepEqual(await readPackImportFailures(api), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("#775 WIRING: the load asks only when something is MISSING", () => {
  // A clean load must not pay for a log fetch — there would be nothing to say.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /import \{ readPackImportFailures \} from "\.\/lib\/pack-import-failures\.js"/);
  const i = src.indexOf("const shortfall = apiLoadShortfall(apiClone, landed);");
  assert.ok(i > 0);
  const block = src.slice(i, i + 900);
  assert.match(block, /shortfall\.length[\s\S]{0,120}readPackImportFailures/);
  assert.match(block, /note: apiLoadNote\(shortfall, importFailures\)/);
  assert.match(block, /packs_failed_to_import: importFailures/);
});

// ---------------------------------------------------------------------------
// #775 second site: panel_add_node's unknown-type refusal.
// ---------------------------------------------------------------------------

test("#775 the unknown-node refusal now NAMES the failed-import possibility", async () => {
  // This is the message people actually hit — far more often than the API-load
  // path — and it listed only "not installed, or its pack was removed". A pack
  // that IS installed and failed to import produces exactly the same absence,
  // and both listed remedies are dead ends for it.
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "LTXVImgToVideoConditionOnly", {
    getFreshObjectInfo: async () => ({ KSampler: {} }), // backend answers, type absent
    wasTypeEverDefined: () => false,
    readImportFailures: async () => ["ComfyUI-LTXVideo"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an absent type must still be refused");
  assert.match(err.message, /or its pack failed to import/);
  assert.match(err.message, /ComfyUI-LTXVideo/);
  assert.match(err.message, /installing it again will not help/);
});

test("#775 with NO failed imports the refusal is unchanged", async () => {
  // The ordinary case must not gain a hedge it does not need.
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "TotallyMadeUpNode", {
    getFreshObjectInfo: async () => ({ KSampler: {} }),
    wasTypeEverDefined: () => false,
    readImportFailures: async () => [],
  }).then(
    () => null,
    (e) => e,
  );
  assert.match(err.message, /Unknown node type "TotallyMadeUpNode"/);
  assert.doesNotMatch(err.message, /BEFORE INSTALLING ANYTHING/);
});

test("#775 a reader that THROWS does not replace the refusal", async () => {
  // The diagnostic runs while explaining a failure. If it throws, the caller
  // must still get the refusal it came for, not a second unrelated error.
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "TotallyMadeUpNode", {
    getFreshObjectInfo: async () => ({ KSampler: {} }),
    wasTypeEverDefined: () => false,
    readImportFailures: async () => {
      throw new Error("log unreachable");
    },
  }).then(
    () => null,
    (e) => e,
  );
  assert.match(err.message, /Unknown node type "TotallyMadeUpNode"/);
  assert.doesNotMatch(err.message, /log unreachable/);
});

test("#775 WIRING: the panel supplies the reader to the add-node resolver", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /readImportFailures: \(\) => readPackImportFailures\(api\)/);
});
