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

test("removePhantomLink uses graph.removeLink when present", () => {
  let removed = null;
  const graph = { removeLink: (id) => (removed = id), links: { 3: {} } };
  removePhantomLink(graph, { id: 3 });
  assert.equal(removed, 3);
});

test("removePhantomLink deletes the stored entry when no removeLink method", () => {
  const graph = { links: { 3: { id: 3 }, 4: { id: 4 } } };
  removePhantomLink(graph, { id: 3 });
  assert.equal(graph.links[3], undefined);
  assert.equal(graph.links[4].id, 4);
});

test("removePhantomLink is defensive: null link / no graph never throws", () => {
  assert.doesNotThrow(() => removePhantomLink(null, { id: 1 }));
  assert.doesNotThrow(() => removePhantomLink({ links: {} }, null));
  assert.doesNotThrow(() => removePhantomLink({ links: {} }, {}));
});

test("isWidgetBackedInput: true only when input carries a widget backlink", () => {
  assert.equal(isWidgetBackedInput({ name: "select", widget: { name: "select" } }), true);
  assert.equal(isWidgetBackedInput({ name: "latent" }), false);
  assert.equal(isWidgetBackedInput(null), false);
});
