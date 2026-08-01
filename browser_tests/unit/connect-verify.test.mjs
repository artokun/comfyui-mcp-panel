/**
 * Unit tests for the graph_connect link-persistence verification (#397) —
 * web/js/lib/connect-verify.js. Run with `node --test`.
 *
 * Bug: LiteGraph's origin.connect() returns a TRUTHY link object even when the
 * target input is a widget-backed pseudo-input (ImpactSwitch "select") that the node
 * reverts, so panel_connect reported a persisted wire that isn't on the graph. The
 * same Reroute→select on a real socket (LatentSwitch) DOES persist.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  isLinkPersisted,
  removePhantomLink,
  isWidgetBackedInput,
} from "../../web/js/lib/connect-verify.js";

test("persisted link (LatentSwitch real socket): stored + input references it → true", () => {
  const link = { id: 7 };
  const target = { id: 20, inputs: [{ name: "select", link: 7 }] };
  const graph = { links: { 7: { id: 7, origin_id: 3, target_id: 20 } } };
  assert.equal(isLinkPersisted(graph, target, 0, link), true);
});

test("phantom link (ImpactSwitch widget input reverted): input.link null → false", () => {
  const link = { id: 9 };
  // LiteGraph handed back a link object, but the widget-backed input was reverted:
  // its `link` is null and the graph never stored the id.
  const target = { id: 20, inputs: [{ name: "select", widget: { name: "select" }, link: null }] };
  const graph = { links: {} };
  assert.equal(isLinkPersisted(graph, target, 0, link), false);
});

test("phantom link: input still points at a DIFFERENT/absent link id → false", () => {
  const link = { id: 9 };
  const target = { id: 20, inputs: [{ name: "select", link: 4 }] };
  const graph = { links: { 4: { id: 4 } } }; // link 9 never stored
  assert.equal(isLinkPersisted(graph, target, 0, link), false);
});

test("stored under graph.links but input.link mismatches → false (re-slotted node)", () => {
  const link = { id: 9 };
  const target = { id: 20, inputs: [{ name: "select", link: null }] };
  const graph = { links: { 9: { id: 9 } } };
  assert.equal(isLinkPersisted(graph, target, 0, link), false);
});

test("null link / no id / missing graph.links all fail closed", () => {
  const target = { inputs: [{ link: 1 }] };
  assert.equal(isLinkPersisted({ links: { 1: {} } }, target, 0, null), false);
  assert.equal(isLinkPersisted({ links: { 1: {} } }, target, 0, {}), false);
  assert.equal(isLinkPersisted({}, target, 0, { id: 1 }), false);
});

test("Map-backed graph.links is read via .get", () => {
  const link = { id: 5 };
  const target = { inputs: [{ link: 5 }] };
  const graph = { links: new Map([[5, { id: 5 }]]) };
  assert.equal(isLinkPersisted(graph, target, 0, link), true);
  const empty = { links: new Map() };
  assert.equal(isLinkPersisted(empty, target, 0, link), false);
});

test("removePhantomLink removes OUR dangling remnant (stored targets our slot, input unref) via removeLink", () => {
  let removed = null;
  const target = { id: 20, inputs: [{ name: "select", link: null }] };
  const graph = {
    removeLink: (id) => (removed = id),
    links: { 3: { id: 3, target_id: 20, target_slot: 0 } },
  };
  removePhantomLink(graph, target, 0, { id: 3 });
  assert.equal(removed, 3);
});

test("removePhantomLink deletes the stored entry when no removeLink method", () => {
  const target = { id: 20, inputs: [{ link: null }] };
  const graph = { links: { 3: { id: 3, target_id: 20, target_slot: 0 }, 4: { id: 4 } } };
  removePhantomLink(graph, target, 0, { id: 3 });
  assert.equal(graph.links[3], undefined);
  assert.equal(graph.links[4].id, 4);
});

test("removePhantomLink KEEPS a link a dynamic node RE-SLOTTED to another input (codex P1)", () => {
  // The link exists and is a legitimate connection, but on a DIFFERENT input slot than
  // the one we tried (2, not 0). isLinkPersisted(inIdx=0) is false, yet the link is real
  // — it must NOT be deleted.
  let removed = null;
  const target = {
    id: 20,
    inputs: [{ name: "a", link: null }, { name: "b", link: null }, { name: "select", link: 3 }],
  };
  const graph = {
    removeLink: (id) => (removed = id),
    links: { 3: { id: 3, target_id: 20, target_slot: 2 } },
  };
  removePhantomLink(graph, target, 0, { id: 3 });
  assert.equal(removed, null, "must not delete a re-slotted legitimate link");
  assert.ok(graph.links[3], "the real link survives");
});

test("removePhantomLink KEEPS a link whose stored target is a DIFFERENT node", () => {
  let removed = null;
  const target = { id: 20, inputs: [{ link: null }] };
  const graph = {
    removeLink: (id) => (removed = id),
    links: { 3: { id: 3, target_id: 99, target_slot: 0 } },
  };
  removePhantomLink(graph, target, 0, { id: 3 });
  assert.equal(removed, null);
});

test("removePhantomLink no-ops when nothing is stored (connect fully reverted)", () => {
  let removed = null;
  const target = { id: 20, inputs: [{ link: null }] };
  const graph = { removeLink: (id) => (removed = id), links: {} };
  removePhantomLink(graph, target, 0, { id: 3 });
  assert.equal(removed, null);
});

test("removePhantomLink is defensive: null link / no graph never throws", () => {
  const target = { id: 1, inputs: [{ link: null }] };
  assert.doesNotThrow(() => removePhantomLink(null, target, 0, { id: 1 }));
  assert.doesNotThrow(() => removePhantomLink({ links: {} }, target, 0, null));
  assert.doesNotThrow(() => removePhantomLink({ links: {} }, target, 0, {}));
});

test("isWidgetBackedInput: true only when input carries a widget backlink", () => {
  assert.equal(isWidgetBackedInput({ name: "select", widget: { name: "select" } }), true);
  assert.equal(isWidgetBackedInput({ name: "latent" }), false);
  assert.equal(isWidgetBackedInput(null), false);
});
