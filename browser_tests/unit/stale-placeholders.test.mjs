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
const registry = (...types) => (type) => types.includes(type);

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
  const stale = findStalePlaceholders([placeholder(1, "X")], () => {
    throw new Error("registry boom");
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
  assert.match(note, /definitions ARE now current/, "the refresh is not described as having failed");
  assert.match(note, /MiniMaxChunkFeedForward/, "names the classes");
  assert.match(note, /still a PLACEHOLDER/, "and what did not happen");
  assert.match(note, /does not rehydrate nodes that were created while it was unknown/, "why");
  assert.match(note, /Reload the workflow/, "the remedy");
  assert.match(note, /Save first/, "and its cost, since a reload discards unsaved work");
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
