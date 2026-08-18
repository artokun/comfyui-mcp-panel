/**
 * #1273 — cg-use-everywhere materialises its broadcast links into the prompt
 * inside its own queuePrompt patch, so every input its `extra.ue_links` record
 * names is queue-time volatile (see the module header of
 * web/js/lib/use-everywhere-links.js for the measured mechanism). These tests
 * pin the pair computation, including the subgraph routing that produced the
 * field report's `103:48 anything`-style diff tokens.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ueQueueTimeLinkPairs } from "../../web/js/lib/use-everywhere-links.js";

const link = (id, origin_id, origin_slot, target_id, target_slot) => ({
  id,
  origin_id,
  origin_slot,
  target_id,
  target_slot,
});

test("#1273 a plain broadcast names the downstream input at the root prefix", () => {
  const root = {
    _nodes: [
      { id: 4, inputs: [], outputs: [{ name: "MODEL", links: [] }] },
      { id: 22, inputs: [{ name: "clip", link: null }, { name: "steps", link: null }] },
    ],
    extra: {
      ue_links: [{ downstream: 22, downstream_slot: 0, upstream: 4, upstream_slot: 0, controller: 48, type: "CLIP" }],
    },
  };
  assert.deepEqual([...ueQueueTimeLinkPairs(root)].sort(), ["22 clip"],
    "exactly the injected input is volatile — the sibling input stays drift-covered");
});

test("#1273 no UE record (or a malformed one) yields no pairs and never throws", () => {
  assert.equal(ueQueueTimeLinkPairs(null).size, 0);
  assert.equal(ueQueueTimeLinkPairs({}).size, 0);
  assert.equal(ueQueueTimeLinkPairs({ _nodes: [], extra: {} }).size, 0);
  assert.equal(ueQueueTimeLinkPairs({ _nodes: [], extra: { ue_links: "not-an-array" } }).size, 0);
  assert.equal(ueQueueTimeLinkPairs({ _nodes: [], extra: { ue_links: [null, 42] } }).size, 0);
});

test("#1273 a STALE record (deleted node or slot) contributes nothing — fail toward detecting drift", () => {
  const root = {
    _nodes: [{ id: 22, inputs: [{ name: "clip", link: null }] }],
    extra: {
      ue_links: [
        { downstream: 99, downstream_slot: 0, upstream: 4, upstream_slot: 0, controller: 48, type: "CLIP" },
        { downstream: 22, downstream_slot: 7, upstream: 4, upstream_slot: 0, controller: 48, type: "CLIP" },
      ],
    },
  };
  assert.equal(ueQueueTimeLinkPairs(root).size, 0,
    "the injection cannot happen for these either, so nothing needs excluding");
});

test("#1273 a broadcast into a SUBGRAPH INSTANCE's input panel routes to every inner consumer of the slot", () => {
  // The field report's shape: subgraph 103 holds UE senders 48/49/50 fed from
  // the subgraph input panel; the root record targets instance 103's slot, and
  // the flattened diff showed `103:48 anything`-style tokens.
  const subgraph = {
    _nodes: [
      { id: 48, inputs: [{ name: "anything", link: 101 }] },
      { id: 22, inputs: [{ name: "clip", link: null }] },
    ],
    links: { 101: link(101, -10, 0, 48, 0) },
    inputNode: { slots: [{ linkIds: [101] }] },
    extra: {
      ue_links: [{ downstream: 22, downstream_slot: 0, upstream: 48, upstream_slot: 0, controller: 48, type: "CLIP" }],
    },
  };
  const root = {
    _nodes: [
      { id: 103, inputs: [{ name: "clip", link: null }], subgraph },
      { id: 106, inputs: [{ name: "clip", link: null }] },
    ],
    links: {},
    extra: {
      ue_links: [
        { downstream: 103, downstream_slot: 0, upstream: 5, upstream_slot: 0, controller: 9, type: "CLIP" },
        { downstream: 106, downstream_slot: 0, upstream: 5, upstream_slot: 1, controller: 9, type: "CLIP" },
      ],
    },
  };
  const pairs = ueQueueTimeLinkPairs(root);
  assert.ok(pairs.has("103 clip"), "the instance's own slot pair (harmless — instances flatten away)");
  assert.ok(pairs.has("103:48 anything"), "the inner consumer of the fed panel slot — the field report's token");
  assert.ok(pairs.has("103:22 clip"), "the subgraph's own broadcast record applies at the instance prefix");
  assert.ok(pairs.has("106 clip"), "a root broadcast target at the root prefix");
  assert.equal(pairs.size, 4, "nothing beyond the routable injections");
});

test("#1273 a broadcast into the subgraph OUTPUT panel (-20) routes to the outer consumers of the instance's output slot", () => {
  const subgraph = {
    _nodes: [{ id: 7, inputs: [], outputs: [{ name: "IMAGE", links: [] }] }],
    links: {},
    inputNode: { slots: [] },
    extra: {
      ue_links: [{ downstream: -20, downstream_slot: 0, upstream: 7, upstream_slot: 0, controller: 8, type: "IMAGE" }],
    },
  };
  const root = {
    _nodes: [
      { id: 10, inputs: [], outputs: [{ name: "IMAGE", links: [55] }], subgraph },
      { id: 30, inputs: [{ name: "images", link: 55 }, { name: "filename_prefix", link: null }] },
    ],
    links: { 55: link(55, 10, 0, 30, 0) },
    extra: {},
  };
  const pairs = ueQueueTimeLinkPairs(root);
  assert.deepEqual([...pairs], ["30 images"],
    "the injected inner link resolves on the outer consumer once queued");
});

test("#1273 the -20 record at the ROOT (no instance) routes nowhere", () => {
  const root = {
    _nodes: [{ id: 7, inputs: [] }],
    extra: { ue_links: [{ downstream: -20, downstream_slot: 0, upstream: 7, upstream_slot: 0, controller: 8, type: "IMAGE" }] },
  };
  assert.equal(ueQueueTimeLinkPairs(root).size, 0);
});

test("#1273 a SHARED subgraph definition is walked once per instance prefix", () => {
  const subgraph = {
    _nodes: [{ id: 22, inputs: [{ name: "clip", link: null }] }],
    links: {},
    inputNode: { slots: [] },
    extra: {
      ue_links: [{ downstream: 22, downstream_slot: 0, upstream: 48, upstream_slot: 0, controller: 48, type: "CLIP" }],
    },
  };
  const root = {
    _nodes: [
      { id: 10, inputs: [], subgraph },
      { id: 11, inputs: [], subgraph },
    ],
    extra: {},
  };
  const pairs = ueQueueTimeLinkPairs(root);
  assert.ok(pairs.has("10:22 clip") && pairs.has("11:22 clip"),
    "both instances' flattened prompt keys are covered");
});

test("#1273 panel-slot routing recurses through a nested subgraph instance", () => {
  const inner = {
    _nodes: [{ id: 5, inputs: [{ name: "model", link: 201 }] }],
    links: { 201: link(201, -10, 0, 5, 0) },
    inputNode: { slots: [{ linkIds: [201] }] },
    extra: {},
  };
  const middle = {
    _nodes: [{ id: 6, inputs: [{ name: "model", link: 101 }], subgraph: inner }],
    links: { 101: link(101, -10, 0, 6, 0) },
    inputNode: { slots: [{ linkIds: [101] }] },
    extra: {},
  };
  const root = {
    _nodes: [{ id: 10, inputs: [{ name: "model", link: null }], subgraph: middle }],
    extra: {
      ue_links: [{ downstream: 10, downstream_slot: 0, upstream: 1, upstream_slot: 0, controller: 2, type: "MODEL" }],
    },
  };
  const pairs = ueQueueTimeLinkPairs(root);
  assert.ok(pairs.has("10:6 model"), "the middle instance's own slot");
  assert.ok(pairs.has("10:6:5 model"), "the innermost consumer at the full colon path");
});
