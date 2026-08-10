/**
 * #981 — `panel_refresh_nodes` returned `{ok:true, refreshed:true}` while
 * `panel_get_errors` still listed the same classes as missing, after the packs were
 * installed and ComfyUI restarted.
 *
 * MEASURED on ComfyUI 0.31.1 / frontend 1.48.7: a workflow was loaded referencing an
 * absent class, the class was then registered exactly as an install would make it
 * appear, and the already-placed node was re-read:
 *
 *   registered in LiteGraph  : true
 *   node constructor title   : null     (unchanged)
 *   node constructor nodeData: false    (unchanged)
 *   node widgets             : []       (unchanged)
 *   missingNodesError store  : still reports it
 *
 * So the node does NOT come back. Clearing the missing-node store — which the frontend
 * does expose a method for — would make get_errors report clean while the canvas still
 * holds a dead node that fails at queue time. The refresh says a reload is needed
 * instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isPlaceholderNode,
  findStalePlaceholders,
  stalePlaceholderNote,
} from "../../web/js/lib/stale-placeholders.js";

/** A node whose class WAS registered: ComfyUI attaches `nodeData` to the constructor. */
const realNode = (id, type) => ({ id, type, constructor: { nodeData: { name: type }, title: type } });
/** A placeholder: instantiated while the class was unknown, so it carries no def. */
const placeholder = (id, type) => ({ id, type, constructor: {} });
/** Every type these fixtures ever place as a placeholder — i.e. what the frontend would
 *  have recorded as missing at load. The collector requires membership here, so a
 *  frontend-only node (Note, Reroute, …) can never be mistaken for a placeholder. */
const RECORDED = [
  "MiniMaxChunkFeedForward",
  "MiniMaxLowVRAMAttention",
  "OllamaImageList_CLIPGenerateText",
  "NeverInstalled",
  "StillGone",
  "CLIPTextEncode",
  "X",
];
/** `registry(...clientRegistered)` — what THIS page can instantiate now. */
const registry = (...clientRegistered) => ({
  recordedMissingTypes: RECORDED,
  isClientRegistered: (type) => clientRegistered.includes(type),
});

test("#981 a node with no nodeData is a placeholder; one with it is not", () => {
  assert.equal(isPlaceholderNode(placeholder(1, "X")), true);
  assert.equal(isPlaceholderNode(realNode(1, "X")), false);
});

test("#981 an unreadable node is NOT claimed to be a placeholder", () => {
  // Reporting a healthy node as dead would send someone reloading a workflow that was
  // fine, so absence of evidence is not treated as evidence.
  const hostile = {
    get constructor() {
      throw new Error("boom");
    },
  };
  assert.equal(isPlaceholderNode(hostile), false);
  for (const bad of [null, undefined, 42, "x"]) assert.equal(isPlaceholderNode(bad), false);
});

test("#981 the reported case: a placeholder whose class is NOW registered is stale", () => {
  const nodes = [placeholder(1, "MiniMaxChunkFeedForward")];
  assert.deepEqual(findStalePlaceholders(nodes, registry("MiniMaxChunkFeedForward")), [
    { node_id: "1", type: "MiniMaxChunkFeedForward" },
  ]);
});

test("#981 a placeholder whose class is STILL absent is NOT stale — it is genuinely missing", () => {
  // The existing missing_node_types reporting already covers that one, and nothing
  // about it is out of date. Claiming a reload would fix it would be false.
  assert.deepEqual(findStalePlaceholders([placeholder(1, "StillGone")], registry("SomethingElse")), []);
});

test("#981 a healthy node is never reported, however its class is registered", () => {
  assert.deepEqual(findStalePlaceholders([realNode(1, "CLIPTextEncode")], registry("CLIPTextEncode")), []);
});

test("#981 the reporter's three classes, mixed with healthy nodes", () => {
  const nodes = [
    realNode(1, "CLIPTextEncode"),
    placeholder(2, "MiniMaxChunkFeedForward"),
    placeholder(3, "MiniMaxLowVRAMAttention"),
    placeholder(4, "OllamaImageList_CLIPGenerateText"),
    placeholder(5, "NeverInstalled"),
  ];
  const stale = findStalePlaceholders(
    nodes,
    registry("CLIPTextEncode", "MiniMaxChunkFeedForward", "MiniMaxLowVRAMAttention", "OllamaImageList_CLIPGenerateText"),
  );
  assert.deepEqual(stale.map((s) => s.node_id), ["2", "3", "4"], "the still-absent one is not included");
});

test("#981 a registration lookup that THROWS skips that node rather than guessing", () => {
  const stale = findStalePlaceholders([placeholder(1, "X")], {
    recordedMissingTypes: RECORDED,
    isClientRegistered: () => {
      throw new Error("registry boom");
    },
  });
  assert.deepEqual(stale, [], "unknown registration status is not evidence the node is recoverable");
});

test("#981 the collector is total — malformed input yields fewer findings, never a throw", () => {
  const hostile = {
    get type() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => findStalePlaceholders([hostile, placeholder(2, "X")], registry("X")));
  assert.deepEqual(
    findStalePlaceholders([hostile, placeholder(2, "X")], registry("X")).map((s) => s.node_id),
    ["2"],
  );
  for (const bad of [null, undefined, "nope", [null], [{}]]) {
    assert.deepEqual(findStalePlaceholders(bad, registry("X")), []);
  }
  assert.deepEqual(findStalePlaceholders([placeholder(1, "X")], null), []);
});

test("#981 the note credits what the refresh DID do, and names the one thing that fixes it", () => {
  const note = stalePlaceholderNote([
    { node_id: "2", type: "MiniMaxChunkFeedForward" },
    { node_id: "3", type: "MiniMaxLowVRAMAttention" },
  ]);
  // codex r2: the predicate establishes that the CLIENT can instantiate the class now —
  // not that the definition is current, not that this refresh registered it, and nothing
  // at all about what the backend will do with the prompt. The note may claim only that.
  assert.match(note, /NOW registered in this page's client node registry/, "exactly the predicate");
  assert.doesNotMatch(note, /definitions ARE now current/, "…not currency it never checked");
  assert.doesNotMatch(note, /will still fail at queue time/, "nor a backend outcome it never measured");
  // codex r3: a registry ENTRY is not a successful createNode, and "no widgets" says
  // nothing about values arriving over links, retained properties or class defaults.
  assert.doesNotMatch(note, /can NOW instantiate/, "an entry is not a proven instantiation");
  assert.doesNotMatch(note, /does not serialize the values its class expects/, "nor a serialization claim");
  assert.match(note, /never rebuilt against the class/, "what it CAN say about the dead node");
  assert.match(note, /MiniMaxChunkFeedForward/, "names the classes");
  assert.match(note, /still a PLACEHOLDER/, "and what did not happen");
  assert.match(note, /does not rehydrate nodes that were created while it was unknown/, "why");
  // codex: "reload" on its own is ambiguous — a browser refresh restores the last
  // autosave, not necessarily the graph on screen. The remedy must name both steps.
  assert.match(note, /SAVE the workflow, then reload\/reopen that saved workflow/, "the remedy, both steps");
  // codex r4: only `constructor.nodeData` is tested per node — "no widgets" was measured
  // on one instance — and a registry entry makes a reload worth trying, not certain.
  assert.match(note, /on the instance measured for #981/, "the widgets claim is attributed");
  assert.doesNotMatch(note, /they keep no definition and no widgets/, "not asserted of every node");
  assert.match(note, /To ATTEMPT a rebuild/, "an attempt, not a guarantee");
  assert.match(note, /not a guarantee the class constructs cleanly/, "and says why it is only an attempt");
  assert.match(note, /anything not saved is not rebuilt/, "and its cost");
  assert.match(note, /browser refresh restores whatever the frontend last autosaved/, "not a plain refresh");
  assert.equal(stalePlaceholderNote([]), "", "silent when nothing is stale");
  assert.equal(stalePlaceholderNote(null), "");
});

test("#981 source guard: the refresh reports requires_reload and does NOT clear the store", () => {
  // Clearing `removeMissingNodesByType` would make get_errors report clean while the
  // canvas still holds a dead node — a worse answer than the stale one.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /verdict\.requires_reload = true/, "the refresh must say a reload is needed");
  assert.match(src, /findStalePlaceholders\(/, "and detect the condition");
  assert.ok(
    !/removeMissingNodesByType\s*\(/.test(src),
    "the missing-node store must NOT be cleared while the placeholders remain",
  );
});

test("#981 (codex): FRONTEND-ONLY nodes are never reported — the false positive that killed v1", () => {
  // MEASURED live: Note, Reroute, PrimitiveNode and MarkdownNote all lack
  // `constructor.nodeData`, so the first version reported ALL FOUR. A canvas with one
  // Note on it would have demanded a workflow reload after every refresh. They are
  // excluded because the frontend never recorded them as missing — membership in that
  // load-time record is the discriminator, not the absence of a definition.
  const nodes = ["Note", "Reroute", "PrimitiveNode", "MarkdownNote"].map((t, i) => placeholder(i + 1, t));
  const stale = findStalePlaceholders(nodes, {
    recordedMissingTypes: [], // none of them were ever missing
    isClientRegistered: () => true, // and all are instantiable
  });
  assert.deepEqual(stale, [], "a node the frontend never called missing is not a stale placeholder");
});

test("#981 (codex): BACKEND availability is not CLIENT registration", () => {
  // /object_info proves the server has the definition; it does not prove this page can
  // instantiate the class. Only the latter makes a reload capable of repairing the node,
  // so the lookup is deliberately the client registry.
  const nodes = [placeholder(1, "X")];
  const backendOnly = findStalePlaceholders(nodes, {
    recordedMissingTypes: ["X"],
    isClientRegistered: () => false, // present on the server, not registered here
  });
  assert.deepEqual(backendOnly, [], "no reload claim while the class cannot be instantiated here");
  assert.equal(findStalePlaceholders(nodes, registry("X")).length, 1, "…and one once it can");
});

test("#981 (codex) source guard: the panel feeds the load-time record and the CLIENT registry", () => {
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /const recordedMissingTypes = collectMissingAssets\(\)\.nodeTypes \?\? \[\]/, "the frontend's own record");
  assert.match(src, /findStalePlaceholders\(nodes, \{\r?\n\s*recordedMissingTypes,/, "…is what the scan is given");
  assert.match(src, /isClientRegistered: \(type\) => !!LiteGraph\?\.registered_node_types\?\.\[type\]/, "client registry");
  assert.ok(
    !/Object\.prototype\.hasOwnProperty\.call\(registry, type\)/.test(src),
    "the /object_info lookup must not come back — backend availability is a different fact",
  );
});

test("#981 (codex): a REBUILT node plus a stale missing-store snapshot is NOT a finding", () => {
  // The store is a load-time snapshot the frontend never clears, so it keeps naming a
  // type long after the node was rebuilt. The node's own state, not the record, decides:
  // the record only narrows WHICH types may be considered.
  const stale = findStalePlaceholders([realNode(1, "MiniMaxChunkFeedForward")], registry("MiniMaxChunkFeedForward"));
  assert.deepEqual(stale, [], "a node carrying a definition is healthy whatever the snapshot says");
});

test("#981 (codex): the warning PERSISTS across refreshes until the node is rebuilt", () => {
  // Registering the class does not rehydrate the node, so a second and third refresh
  // must keep saying so. The collector holds no state that could let it go quiet.
  const nodes = [placeholder(1, "MiniMaxChunkFeedForward")];
  const opts = registry("MiniMaxChunkFeedForward");
  const runs = [findStalePlaceholders(nodes, opts), findStalePlaceholders(nodes, opts), findStalePlaceholders(nodes, opts)];
  for (const r of runs) assert.deepEqual(r, [{ node_id: "1", type: "MiniMaxChunkFeedForward" }]);
  // …and goes quiet only once the reload actually replaced the node.
  nodes[0] = realNode(1, "MiniMaxChunkFeedForward");
  assert.deepEqual(findStalePlaceholders(nodes, opts), [], "silent once the rebuild happened");
});

test("#981 (codex): an UNAVAILABLE missing-node record claims nothing at all", () => {
  // If the frontend's record cannot be read the discriminator is gone, and without it
  // every frontend-only node looks like a placeholder. Absent record means silence, not
  // a fallback to the shape test that produced the false positives.
  const nodes = [placeholder(1, "Note"), placeholder(2, "Reroute"), placeholder(3, "MiniMaxChunkFeedForward")];
  for (const absent of [undefined, null, [], "boom", 42, new Set()]) {
    assert.deepEqual(
      findStalePlaceholders(nodes, { recordedMissingTypes: absent, isClientRegistered: () => true }),
      [],
      `no record (${String(absent)}) -> no claim`,
    );
  }
  // A Set is accepted when it HAS entries — the panel may hand either shape.
  assert.equal(
    findStalePlaceholders(nodes, {
      recordedMissingTypes: new Set(["MiniMaxChunkFeedForward"]),
      isClientRegistered: () => true,
    }).length,
    1,
    "and Note/Reroute stay excluded even then",
  );
});

test("#981 (codex r2) source guard: the disclosure survives the SUCCESS path of refresh_nodes", () => {
  // The producer runs the scan whatever the verdict says, so the disclosure can ride on
  // either path — but `{ok:true, refreshed:true}` discarded every extra field, so on the
  // success path the warning existed and no caller could ever see it. Found by tracing
  // the consumers of the verdict, not by reading the producer.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  assert.match(src, /if \(refreshed\) return \{ ok: true, refreshed: true, \.\.\.stale \};/, "forwarded on success");
  assert.match(src, /stale_placeholders_note: verdict\.stale_placeholders_note/, "and the note with it");
  // `ok` must stay true: the refresh did what it claims, and the reload flag is about
  // the canvas, not about the refresh having failed.
  assert.ok(!/ok: false/.test(src.slice(src.indexOf("async refresh_nodes()"), src.indexOf("graph_serialize()"))),
    "requires_reload must not be turned into a failure");
});
