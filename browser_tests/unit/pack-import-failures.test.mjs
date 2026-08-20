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
  dropLivePackImportFailures,
  packsProvidingType,
  nodeMapPackCount,
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
  // Bounded by the end of the API branch, not by a character count. A fixed 900-char window
  // had roughly forty characters of headroom left, so the next line added anywhere in the
  // reply — a comment included — silently pushed the last two assertions out of scope and
  // failed a wiring test that was still perfectly satisfied. It measured prose, not code.
  const end = src.indexOf('"graph is not a UI workflow', i);
  assert.ok(end > i, "the non-API refusal that follows the branch must still be recognisable");
  const block = src.slice(i, end);
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

// ---------------------------------------------------------------------------
// #1447: an import-failure note must not name a pack that is currently live.
// ---------------------------------------------------------------------------

test("#1447 a pack that currently provides types is dropped from the note", () => {
  // ReActorFaceSwap in the live /object_info is proof comfyui-reactor-node
  // registered. Naming it as the reason VideoToImages is missing is the report.
  const live = {
    KSampler: { python_module: "nodes" },
    ReActorFaceSwap: { python_module: "custom_nodes.comfyui-reactor-node" },
  };
  assert.deepEqual(
    dropLivePackImportFailures(["comfyui-reactor-node"], live),
    [],
  );
});

test("#1447 hyphen/underscore/case in the folder still identify the same pack", () => {
  const live = {
    ReActorFaceSwap: { python_module: "custom_nodes.comfyui_reactor_node.nodes" },
  };
  assert.deepEqual(
    dropLivePackImportFailures(["ComfyUI-Reactor-Node"], live),
    [],
  );
});

test("#1447 a pack with NO live types is kept — that is still the #775 case", () => {
  // ComfyUI-LTXVideo failed to import, so none of ITS types are in /object_info.
  // Core LTX nodes from comfy_extras do not exonerate it.
  const live = {
    KSampler: { python_module: "nodes" },
    LTXVImgToVideo: { python_module: "comfy_extras.nodes_lt" },
  };
  assert.deepEqual(
    dropLivePackImportFailures(["ComfyUI-LTXVideo", "comfyui-reactor-node"], live),
    ["ComfyUI-LTXVideo", "comfyui-reactor-node"],
  );
});

test("#1447 no python_module evidence leaves the list alone", () => {
  // A stub map without python_module must not silently eat the #775 note.
  assert.deepEqual(
    dropLivePackImportFailures(["ComfyUI-LTXVideo"], { KSampler: {} }),
    ["ComfyUI-LTXVideo"],
  );
  assert.deepEqual(dropLivePackImportFailures(["ComfyUI-LTXVideo"], null), [
    "ComfyUI-LTXVideo",
  ]);
});

test("#1447 panel_add_node of VideoToImages does not name a live ReActor pack", async () => {
  // The shipped add-node guard, on the reporter's sequence: ReActorFaceSwap is
  // on the backend, VideoToImages is not, the log still has an old reactor
  // IMPORT FAILED line. The refusal must stay a refusal and must not append
  // that pack as if it owned the missing type.
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "VideoToImages", {
    getFreshObjectInfo: async () => ({
      KSampler: { python_module: "nodes" },
      ReActorFaceSwap: { python_module: "custom_nodes.comfyui-reactor-node" },
    }),
    wasTypeEverDefined: () => false,
    readImportFailures: async () => ["comfyui-reactor-node"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an absent type must still be refused");
  assert.match(err.message, /Unknown node type "VideoToImages"/);
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
  assert.doesNotMatch(err.message, /FAILED TO IMPORT/);
});

test("#1447 a leftover failure is labelled as not owning the requested type", async () => {
  // A pack that really did fail (no live types) is still worth naming — #775 —
  // but must not read as the cause of an unrelated class_type.
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "VideoToImages", {
    getFreshObjectInfo: async () => ({
      KSampler: { python_module: "nodes" },
      ReActorFaceSwap: { python_module: "custom_nodes.comfyui-reactor-node" },
    }),
    wasTypeEverDefined: () => false,
    readImportFailures: async () => ["comfyui-reactor-node", "ComfyUI-LTXVideo"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.match(err.message, /ComfyUI-LTXVideo/);
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
  // #1544 made this claim stronger and moved it to the FRONT. #1447 shipped it as a
  // trailing "does not prove it provides X — the failure may be unrelated", and a
  // reporter read straight past it to the pack name. Same finding, stated where it
  // is read; the ordering assertion is what stops it drifting back to a footnote.
  assert.match(err.message, /not the cause of this missing type/);
  assert.match(err.message, /Nothing ties it to "VideoToImages"/);
  assert.ok(
    err.message.indexOf("not the cause of this missing type") <
      err.message.indexOf("ComfyUI-LTXVideo"),
    "the qualifier must come before the pack name",
  );
});

test("#1447 importFailureNote itself drops a live pack", () => {
  const note = importFailureNote(["comfyui-reactor-node"], {
    forType: "VideoToImages",
    liveDefs: {
      ReActorFaceSwap: { python_module: "custom_nodes.comfyui-reactor-node" },
    },
  });
  assert.equal(note, "");
});

test("#1523 a subgraph UUID never gets a pack-import note — no pack can own it", () => {
  // The reporter's type. ReActor failed to import on that canvas; naming it as
  // the reason a loaded SAM3 subgraph could not be added is the whole issue.
  const note = importFailureNote(["comfyui-reactor-node"], {
    forType: "6e7ab3ea-96aa-470f-9b94-3d9d0e01f481",
  });
  assert.equal(note, "");
});

test("#1523 panel_add_node of a subgraph UUID does not name an unrelated failed pack", async () => {
  const { assertAddNodeResolvableRefreshing, subgraphUuidAddRefusal } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const uuid = "6e7ab3ea-96aa-470f-9b94-3d9d0e01f481";
  const err = await assertAddNodeResolvableRefreshing({}, uuid, {
    getFreshObjectInfo: async () => ({
      KSampler: { python_module: "nodes" },
    }),
    wasTypeEverDefined: () => false,
    readImportFailures: async () => ["comfyui-reactor-node"],
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an unloaded subgraph UUID must still be refused");
  assert.equal(err.message, subgraphUuidAddRefusal(uuid, { loaded: false, registered: false }));
  assert.doesNotMatch(err.message, /comfyui-reactor-node/);
  assert.doesNotMatch(err.message, /FAILED TO IMPORT/);
});

test("#1523 WIRING: the panel supplies the live root graph to the add-node resolver", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /getRootGraph: \(\) => capturedContext\?\.rootGraph \?\? capturedContext\?\.graph/);
});

test("#1180: a hanging log read cannot outlive the refusal it is explaining", async () => {
  // readComfyLogText runs while EXPLAINING a refusal, against the same server whose
  // half-open connection is the reason the refusal is being written. Its catch handles a
  // fetch that FAILS; a fetch that never settles is caught by nothing — so graph_add_node
  // parked here after every other fetch on that path had been bounded. A diagnostic must
  // not outlive the thing it diagnoses.
  const { readComfyLogText, COMFY_LOG_READ_TIMEOUT_MS } = await import("../../web/js/lib/comfy-log.js");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = () => new Promise(() => {});
    const started = Date.now();
    const text = await Promise.race([
      readComfyLogText({ fileURL: (r) => r }, { timeoutMs: 120 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("the log read never settled")), 3000)),
    ]);
    assert.equal(text, "", "a log that cannot be read says nothing — its documented answer");
    assert.ok(Date.now() - started < 2000, "…and says it on the bound, not eventually");
  } finally {
    globalThis.fetch = original;
  }
  // Real, but short: the log only sharpens a message the caller can already write.
  assert.ok(COMFY_LOG_READ_TIMEOUT_MS > 0 && COMFY_LOG_READ_TIMEOUT_MS <= 5000);
});

test("#1180: the bound covers the BODY, not just the response head", async () => {
  // The test above stalls `fetch` itself, and a bound around `fetch` alone passes it —
  // which is how this shipped half-done. `fetch` resolves the moment the response HEAD
  // arrives; the bytes stream afterwards, inside `res.json()`. A server that sends
  // headers and then stops is the SAME half-open connection the bound exists for, and it
  // parked on the body read with the bound already satisfied.
  //
  // Stalling the body rather than the handshake is the only shape that tells the two apart.
  const { readComfyLogText } = await import("../../web/js/lib/comfy-log.js");
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
    const started = performance.now();
    const text = await Promise.race([
      readComfyLogText({ fileURL: (r) => r }, { timeoutMs: 120 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the body read never settled: the bound stops at the headers")), 3000),
      ),
    ]);
    assert.equal(text, "", "a log whose body never arrives says nothing, same as one that never connected");
    assert.ok(performance.now() - started < 2000, "…and says it on the bound");
  } finally {
    globalThis.fetch = original;
  }
});

// --- #1544: a failed pack is the CAUSE only when the node map says it owns the type ---
//
// `panel_add_node PreviewVideo` was refused with "coldinfire_fal_privacy FAILED TO
// IMPORT at startup" attached. Nothing connected them. The note had a trailing
// hedge, and it did not survive contact with a reader: the sentence that leads
// with a pack name is the one that gets acted on.
//
// The fixture mirrors a real `/customnode/getmappings` payload — BOTH key shapes
// occur in one response (repo URL and bare registry id), and the three packs below
// are the three the live 5583-entry map really does list for PreviewVideo.
const NODE_MAP = {
  "https://github.com/khanhlvg/vertex-ai-comfyui-nodes": [
    ["PreviewVideo", "VertexImagen"],
    { title_aux: "[Unofficial] Vertex AI Custom Nodes for ComfyUI" },
  ],
  "llm-toolkit": [["PreviewVideo"], { title_aux: "ComfyUI LLM Toolkit" }],
  "https://github.com/lightricks/ComfyUI-LTXVideo.git": [
    ["LTXVAddGuide", "LTXVPreprocess"],
    { title_aux: "ComfyUI-LTXVideo" },
  ],
};

/** A live /object_info with no custom-node pack in common with the failures. */
const CORE_ONLY_DEFS = { KSampler: { python_module: "nodes" } };

test("#1544 the reported refusal no longer blames an unrelated failed pack", () => {
  const note = importFailureNote(["coldinfire_fal_privacy"], {
    forType: "PreviewVideo",
    liveDefs: CORE_ONLY_DEFS,
    nodeMap: NODE_MAP,
  });
  // The map lists three packs for PreviewVideo and coldinfire_fal_privacy is not
  // one of them, so nothing may present it as the reason.
  assert.doesNotMatch(note, /BEFORE INSTALLING ANYTHING/);
  assert.match(note, /SEPARATE ISSUE, not the cause of this missing type/);
  assert.match(note, /ComfyUI-Manager's node map does not link it to that type/);
  assert.match(note, /do not reinstall it expecting "PreviewVideo" to appear/);

  // ORDER is the fix. The pack is still disclosed — a failed import is a real
  // problem — but the reader meets "not the cause" before they meet the name.
  // Assert the position, not just the presence: the pre-#1544 note contained the
  // very same hedge words and still read as an accusation because they came last.
  assert.match(note, /coldinfire_fal_privacy/);
  assert.ok(
    note.indexOf("not the cause of this missing type") < note.indexOf("coldinfire_fal_privacy"),
    "the disclaimer must precede the pack name, or it is the old bug with more words",
  );
});

test("#1544 ownership PROVEN still gets #775's causal note", () => {
  // The case #775 was filed about: the pack really did fail, and it really is why
  // the type is missing. That advice must not be watered down by this change.
  // Doubles as the key-shape test: a `.git`-suffixed repo URL must match the
  // folder name the IMPORT FAILED log line prints.
  const note = importFailureNote(["ComfyUI-LTXVideo"], {
    forType: "LTXVAddGuide",
    liveDefs: CORE_ONLY_DEFS,
    nodeMap: NODE_MAP,
  });
  assert.match(note, /BEFORE INSTALLING ANYTHING/);
  assert.match(note, /"LTXVAddGuide" is provided by ComfyUI-LTXVideo/);
  assert.match(note, /installing it again will not help/);
  assert.match(note, /Ownership is from ComfyUI-Manager's node map/);
  assert.doesNotMatch(note, /SEPARATE ISSUE/);
});

test("#1544 when ownership is proven, ONLY the owner is named", () => {
  const note = importFailureNote(["coldinfire_fal_privacy", "ComfyUI-LTXVideo"], {
    forType: "LTXVAddGuide",
    liveDefs: CORE_ONLY_DEFS,
    nodeMap: NODE_MAP,
  });
  assert.match(note, /provided by ComfyUI-LTXVideo/);
  // Re-listing the unrelated failure inside the one message that finally has a
  // definite answer would put the ambiguity straight back.
  assert.doesNotMatch(note, /coldinfire_fal_privacy/);
  assert.match(note, /that line/, "one named pack means one log line, not 'those lines'");
});

test("#1544 no map means ownership was NOT CHECKED, and says so", () => {
  // Manager disabled, legacy, or unreachable. "We did not check" and "we checked
  // and found nothing" send the reader to different next steps, so they must not
  // arrive as the same sentence.
  const note = importFailureNote(["coldinfire_fal_privacy"], {
    forType: "PreviewVideo",
    liveDefs: CORE_ONLY_DEFS,
  });
  assert.match(note, /SEPARATE ISSUE, not the cause of this missing type/);
  assert.match(note, /node map could not be read, so ownership was not checked/);
  assert.doesNotMatch(note, /does not link it to that type/);
});

test("#1544 POSITIVE evidence only — a map that omits the pack never drops it", () => {
  // The tempting next step is "the map knows this pack and its class list omits the
  // type, so it is not the owner". Measured against a live map, 4 of the 59
  // installed packs it recognises share NO class with their own /object_info
  // entries — the catalogue lags a pack's releases. Acting on that would silently
  // discard real import failures: #775's fault with the sign flipped. The failure
  // must survive, demoted but disclosed.
  const note = importFailureNote(["ComfyUI-LTXVideo"], {
    forType: "PreviewVideo",
    liveDefs: CORE_ONLY_DEFS,
    nodeMap: NODE_MAP,
  });
  assert.match(note, /ComfyUI-LTXVideo/, "a real failure is never silently dropped");
  assert.match(note, /SEPARATE ISSUE/);
});

test("#1544 packsProvidingType reads the class list, and claims nothing else", () => {
  assert.deepEqual(
    [...packsProvidingType(NODE_MAP, "PreviewVideo")].sort(),
    ["llm-toolkit", "vertex-ai-comfyui-nodes"],
  );
  assert.deepEqual([...packsProvidingType(NODE_MAP, "LTXVAddGuide")], ["comfyui-ltxvideo"]);
  // Nothing to go on ⇒ no owners, which is the branch that handles not knowing.
  assert.equal(packsProvidingType(NODE_MAP, "NoSuchType").size, 0);
  assert.equal(packsProvidingType(null, "PreviewVideo").size, 0);
  assert.equal(packsProvidingType({}, "PreviewVideo").size, 0);
  assert.equal(packsProvidingType(NODE_MAP, "").size, 0);
  // The ARRAY payload shape carries ids and titles, never a class list we have
  // seen — so it yields no owners rather than a guessed field name.
  assert.equal(packsProvidingType([{ id: "x", nodenames: ["PreviewVideo"] }], "PreviewVideo").size, 0);
});

test("#1544 panel_add_node PreviewVideo: the shipped guard, end to end", async () => {
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "PreviewVideo", {
    getFreshObjectInfo: async () => CORE_ONLY_DEFS,
    wasTypeEverDefined: () => false,
    readImportFailures: async () => ["coldinfire_fal_privacy"],
    readNodeMap: async () => NODE_MAP,
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an absent type must still be refused");
  assert.match(err.message, /Unknown node type "PreviewVideo"/);
  assert.match(err.message, /SEPARATE ISSUE, not the cause of this missing type/);
  assert.doesNotMatch(err.message, /BEFORE INSTALLING ANYTHING/);
});

test("#1544 a node-map read that throws leaves the refusal intact", async () => {
  // Manager unreachable on the refusal path. A diagnostic must never replace the
  // refusal it exists to explain.
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "PreviewVideo", {
    getFreshObjectInfo: async () => CORE_ONLY_DEFS,
    wasTypeEverDefined: () => false,
    readImportFailures: async () => ["coldinfire_fal_privacy"],
    readNodeMap: async () => {
      throw new Error("Manager is not reachable");
    },
  }).then(
    () => null,
    (e) => e,
  );
  assert.match(err.message, /Unknown node type "PreviewVideo"/);
  assert.match(err.message, /ownership was not checked/);
});

test("#1544 the ~1.4MB node map is read ONLY when a failure needs adjudicating", async () => {
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const run = async (type, failures, liveDefs = CORE_ONLY_DEFS) => {
    let reads = 0;
    await assertAddNodeResolvableRefreshing({}, type, {
      getFreshObjectInfo: async () => liveDefs,
      wasTypeEverDefined: () => false,
      readImportFailures: async () => failures,
      readNodeMap: async () => {
        reads++;
        return NODE_MAP;
      },
    }).catch(() => {});
    return reads;
  };

  assert.equal(await run("PreviewVideo", []), 0, "nothing failed: nothing to adjudicate");
  assert.equal(
    await run("VideoToImages", ["comfyui-reactor-node"], {
      ...CORE_ONLY_DEFS,
      ReActorFaceSwap: { python_module: "custom_nodes.comfyui-reactor-node" },
    }),
    0,
    "#1447 dropped the only failure: the map cannot change the answer",
  );
  assert.equal(
    await run("2fd9c1ea-1f4c-4b1e-9a3e-8f2b7c6d5e40", ["coldinfire_fal_privacy"]),
    0,
    "#1523 a subgraph UUID has no pack owner to look up",
  );
  assert.equal(await run("PreviewVideo", ["coldinfire_fal_privacy"]), 1, "…and exactly once when it does");
});

test("#1544 WIRING: the add-node guard is handed the Manager node map", () => {
  // A one-line injection is invisible to every helper-level test above: the whole
  // ownership check is inert if the panel never passes `readNodeMap`. Pin the CALL
  // SITE, in the same options object that wires #775's log reader.
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf("readImportFailures: () => readPackImportFailures(api),");
  assert.ok(i > 0, "the #775 add-node wiring must still be there to anchor on");
  const block = src.slice(i, i + 1200);
  assert.match(
    block,
    /readNodeMap: \(\) => managerGet\("customnode\/getmappings\?mode=cache"\)/,
    "panel_add_node must fetch the ownership map, or #1544 ships as dead code",
  );
});

test("#1544 a 200 that is not a catalogue is NOT a completed ownership check", () => {
  // #808's finding, one layer down. Manager answers `{}` when it assembled its list
  // from none of channel, cache or bundled copy; a captive proxy answers 200 with a
  // sign-in page. Both are objects. Reporting "the node map does not link it to that
  // type" about either asserts a check that never ran — the same unearned claim
  // #1544 exists to stop.
  const forEmpty = (nodeMap) =>
    importFailureNote(["coldinfire_fal_privacy"], {
      forType: "PreviewVideo",
      liveDefs: CORE_ONLY_DEFS,
      nodeMap,
    });

  for (const payload of [{}, { error: "sign in" }, { "some-pack": { title: "no class list" } }]) {
    const note = forEmpty(payload);
    assert.match(note, /returned no usable node catalogue, so ownership could not be checked/);
    assert.doesNotMatch(note, /does not link it to that type/);
    assert.match(note, /SEPARATE ISSUE/, "still non-causal either way");
  }

  // A populated catalogue that genuinely lacks the link keeps the stronger wording.
  assert.match(forEmpty(NODE_MAP), /does not link it to that type/);
});

test("#1544 nodeMapPackCount counts what is checkable, not what is present", () => {
  assert.equal(nodeMapPackCount(NODE_MAP), 3);
  assert.equal(nodeMapPackCount({}), 0);
  assert.equal(nodeMapPackCount({ error: "sign in" }), 0);
  assert.equal(nodeMapPackCount({ pack: [["A"], {}], broken: { no: "classes" } }), 1);
  assert.equal(nodeMapPackCount(null), 0);
  assert.equal(nodeMapPackCount("<html>"), 0);
  assert.equal(nodeMapPackCount([["A"]]), 0, "an array payload carries no class list we can read");
});

test("#1544 two DIFFERENT packs that normalise alike never prove ownership", () => {
  // Real collision from the live catalogue: ComfyUI-OmniSVG (A043-studios) and
  // ComfyUI_OmniSVG (smthemex) are separate projects by separate authors. Under the
  // #1447 `packKey` normalisation — which strips every non-alphanumeric — they are
  // one key, and a failed A043 install would have been named as the proven owner of
  // a class only smthemex provides. That is #1544's own bug restated with MORE
  // confidence, which is strictly worse than the hedge it replaced.
  //
  // Measured on the live 5583-entry map: `packKey` leaves 79 keys claimed by more
  // than one entry, 72 of which disagree about class names. Keeping separators takes
  // that to 3, at no cost to the installed-folder hit rate (59/75 either way).
  const COLLIDING = {
    "https://github.com/A043-studios/ComfyUI-OmniSVG": [
      ["OmniSVG Model Loader"],
      { title_aux: "ComfyUI-OmniSVG" },
    ],
    "https://github.com/smthemex/ComfyUI_OmniSVG": [
      ["SVG Saver"],
      { title_aux: "ComfyUI_OmniSVG" },
    ],
  };
  // Each is proven owner of its OWN class, and of nothing else.
  assert.deepEqual([...packsProvidingType(COLLIDING, "OmniSVG Model Loader")], ["comfyui-omnisvg"]);
  assert.deepEqual([...packsProvidingType(COLLIDING, "SVG Saver")], ["comfyui_omnisvg"]);

  // The hyphen pack failed; the underscore pack owns the requested class. Nothing
  // may present the hyphen pack as the cause.
  const note = importFailureNote(["ComfyUI-OmniSVG"], {
    forType: "SVG Saver",
    liveDefs: CORE_ONLY_DEFS,
    nodeMap: COLLIDING,
  });
  assert.match(note, /SEPARATE ISSUE/);
  assert.doesNotMatch(note, /is provided by/);
});

test("#1544 entries under ONE key must agree before that key owns a type", () => {
  // The 3 collisions that survive separator-preserving keys. Aliases of a single
  // pack list the same classes and still promote; two projects filed under one key
  // that disagree promote nothing.
  const ALIASES = {
    "https://github.com/x/Same-Pack": [["ClassA"], {}],
    "https://github.com/x/Same-Pack.git": [["ClassA"], {}],
  };
  assert.deepEqual([...packsProvidingType(ALIASES, "ClassA")], ["same-pack"], "agreeing aliases promote");

  const DISAGREE = {
    "https://github.com/one/Dup-Pack": [["ClassA"], {}],
    "https://github.com/two/Dup-Pack": [["ClassB"], {}],
  };
  assert.equal(packsProvidingType(DISAGREE, "ClassA").size, 0, "one entry omits it ⇒ not proven");
  assert.equal(packsProvidingType(DISAGREE, "ClassB").size, 0);
});

test("#1544 a map HIT promotes through the shipped guard, not just the helper", async () => {
  // Review gap: the other resolver test asserts SEPARATE ISSUE, which is ALSO the
  // no-map wording — so discarding the fetched map (`await readNodeMap()` without
  // assigning it) would still have passed every test here. The cost test proves the
  // injector is CALLED and the wiring test proves the panel PASSES it; neither
  // proves the fetched payload reaches importFailureNote. This does: the map owns
  // the type, so the refusal must carry the causal wording.
  const { assertAddNodeResolvableRefreshing } = await import(
    "../../web/js/lib/node-resolve.js"
  );
  const err = await assertAddNodeResolvableRefreshing({}, "LTXVAddGuide", {
    getFreshObjectInfo: async () => CORE_ONLY_DEFS,
    wasTypeEverDefined: () => false,
    readImportFailures: async () => ["ComfyUI-LTXVideo"],
    readNodeMap: async () => NODE_MAP,
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, "an absent type must still be refused");
  assert.match(err.message, /Unknown node type "LTXVAddGuide"/);
  assert.match(err.message, /BEFORE INSTALLING ANYTHING/);
  assert.match(err.message, /"LTXVAddGuide" is provided by ComfyUI-LTXVideo/);
  assert.match(err.message, /Ownership is from ComfyUI-Manager's node map/);
  assert.doesNotMatch(err.message, /SEPARATE ISSUE/);
});
