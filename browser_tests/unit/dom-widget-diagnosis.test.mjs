import { test } from "node:test";
import assert from "node:assert/strict";
import { describeNonValueBearingWidget } from "../../web/js/lib/widget-write.js";

/**
 * #698 — panel_set_widget on a non-value-bearing DOM widget (PixaromaPrompt's
 * `pix_prompt_ui`) wrote, reverted, and reported "did not retain the requested
 * value" — which reads as transient and retryable when it is structural.
 *
 * The safety property under test is as much about what this does NOT do: it is
 * diagnosis appended to an ALREADY-OBSERVED failure, never a gate. So a plain
 * widget must contribute nothing at all.
 */

test("a plain value widget contributes NO diagnosis (this must never become a gate)", () => {
  // The load-bearing negative. If this ever returns text for an ordinary widget,
  // the message starts blaming DOM-backing for unrelated failures.
  assert.equal(describeNonValueBearingWidget({ name: "seed", value: 5 }), "");
  assert.equal(describeNonValueBearingWidget({ name: "text", value: "", options: {} }), "");
  assert.equal(describeNonValueBearingWidget({ name: "cfg", options: { min: 0, max: 10 } }), "");
});

test("serialize:false alone is NOT treated as non-value-bearing (#715)", () => {
  // LoadImage's `upload` button is serialize:false and perfectly healthy. Gating
  // or blaming on that flag is exactly the false-refusal #715 removed.
  assert.equal(describeNonValueBearingWidget({ name: "upload", serialize: false }), "");
});

test("a DOM-element widget is identified, and the message says retrying will not help", () => {
  const d = describeNonValueBearingWidget({ name: "pix_prompt_ui", element: {} });
  assert.notEqual(d, "");
  assert.match(d, /DOM-backed display widget/i);
  assert.match(d, /Retrying will not help/i);
  // Must point at where the value actually lives — the thing the reporter had to
  // discover by reading the pack's source.
  assert.match(d, /node\.properties/);
});

test("a widget with getValue/setValue accessors is identified even without an element", () => {
  const d = describeNonValueBearingWidget({
    name: "pix_prompt_ui",
    options: { getValue: () => null, setValue: () => {} },
  });
  assert.notEqual(d, "");
  assert.match(d, /getValue\/setValue/);
  assert.match(d, /Retrying will not help/i);
});

test("it never throws on malformed widgets", () => {
  for (const w of [null, undefined, 0, "str", [], { options: null }, { options: 7 }]) {
    assert.doesNotThrow(() => describeNonValueBearingWidget(w));
    assert.equal(typeof describeNonValueBearingWidget(w), "string");
  }
});

test("the diagnosis is a suffix — it never replaces the observed wrote/became facts", () => {
  // The caller appends this to the existing message; it must read as an addition,
  // not as a substitute for the evidence.
  const d = describeNonValueBearingWidget({ name: "x", element: {} });
  assert.ok(d.startsWith(" "), "must append cleanly after the observed-facts sentence");
  assert.ok(!/did not retain/.test(d), "must not restate the observation");
});

// ── #698: the refusal must be a ROUTE, not just a diagnosis ───────────────
//
// The message already said the real value lives on the node ("commonly
// node.properties") and that retrying will not help. What the reporter still had
// nothing to act on was WHICH properties this node has, or which tool writes them —
// they worked around it with a different node type instead.
//
// PixaromaPrompt keeps its prompt in `properties.promptState.text`, reachable with
// panel_set_property. So the refusal now names the properties that exist.

const domWidget = { name: "pix_prompt_ui", element: {}, options: {} };

test("#698 names the node's actual properties and the tool that writes them", () => {
  const node = { id: 44, properties: { promptState: { text: "" }, mode: "a" } };
  const msg = describeNonValueBearingWidget(domWidget, node);
  assert.match(msg, /"promptState"/);
  assert.match(msg, /"mode"/);
  assert.match(msg, /panel_set_property/);
  assert.match(msg, /panel_query_graph/);
});

test("#698 refuses to say WHICH property backs the widget", () => {
  // Load-bearing. A heuristic pairing would eventually point an agent at an
  // unrelated property and have it overwrite real node state — a destructive wrong
  // answer in place of an honest dead end.
  const node = { id: 44, properties: { promptState: { text: "" } } };
  const msg = describeNonValueBearingWidget(domWidget, node);
  // The exact clause, not a substring of it: changing "WHICH property" to "The first
  // property" leaves "cannot be determined from here" intact while inverting the claim.
  assert.match(msg, /WHICH property backs this widget cannot be determined from here/);
  assert.ok(!/first property/i.test(msg), "must not point at a specific property");
  assert.match(msg, /verify against the canvas/i);
});

test("#698 the structural diagnosis survives — this is additive", () => {
  const msg = describeNonValueBearingWidget(domWidget, { id: 1, properties: { a: 1 } });
  assert.match(msg, /DOM-backed display widget/);
  assert.match(msg, /Retrying will not help/);
});

test("#698 a node with NO properties adds nothing — no empty route", () => {
  for (const node of [undefined, null, { id: 1 }, { id: 1, properties: {} }, { id: 1, properties: [] }]) {
    const msg = describeNonValueBearingWidget(domWidget, node);
    assert.match(msg, /DOM-backed display widget/, "the structural half still fires");
    assert.ok(!/panel_set_property/.test(msg), `must not offer a route for ${JSON.stringify(node)}`);
  }
});

test("#698 a healthy value widget still gets NOTHING, node or no node", () => {
  // The #715 line: serialize:false is normal on working widgets, so this must never
  // become a pre-emptive verdict.
  const node = { id: 2, properties: { anything: 1 } };
  assert.equal(describeNonValueBearingWidget({ name: "seed", value: 5 }, node), "");
  assert.equal(describeNonValueBearingWidget({ name: "t", value: "", options: {} }, node), "");
});

test("#698 a property-heavy node is capped but reports the true count", () => {
  const properties = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`p${i}`, i]));
  const msg = describeNonValueBearingWidget(domWidget, { id: 3, properties });
  assert.match(msg, /30 properties/);
  assert.match(msg, /… and 18 more/);
  assert.ok(!/"p29"/.test(msg));
});

// ── WIRING ────────────────────────────────────────────────────────────────
test("WIRING: the failure branch passes the NODE, or the route can never appear", async () => {
  // Every test above calls the helper directly, so dropping `targetNode` at the call
  // site leaves them all green while the property names silently vanish from the real
  // message. widget-write's failure path needs a live graph to drive, so pin it here.
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../web/js/lib/widget-write.js", import.meta.url), "utf8");
  // `valueWidget`/`valueNode` are the widget the write ASSIGNED and the node that owns
  // it (comfyui-mcp#1707) — the same pair the read-back above it just failed on. Passing
  // the promoted INNER pair here would describe a widget this write never touched.
  assert.ok(src.includes("describeNonValueBearingWidget(valueWidget, valueNode);"),
    "the observed-revert branch must pass the widget that was written and its node");
  // And it must stay in the OBSERVED-failure branch — never a pre-emptive gate (#715).
  const idx = src.indexOf("describeNonValueBearingWidget(valueWidget, valueNode);");
  const before = src.slice(Math.max(0, idx - 1200), idx);
  assert.ok(before.includes("did not retain the"),
    "must remain attached to the observed-revert failure, not a preflight");
});
