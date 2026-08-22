/**
 * #1608 — `panel_open_workflow` reported UNKNOWN / no `workflow_uuid` on a
 * faithful open because live rgthree Seed `properties.randomMin` /
 * `randomMax` differed from the serialized payload.
 *
 * MEASURED from rgthree Seed (`src_web/comfyui/seed.ts`): the constructor
 * stamps `randomMin: 0`, `randomMax: 1125899906842624` before LiteGraph
 * merges the saved bag, and `onPropertyChanged` Number()-coerces and clamps
 * the same two keys. A file that omitted them, or stored them as a different
 * numeric type, cannot round-trip. Authored widgets and the node set were
 * intact; the open verifier treated the frontend-computed bounds as lost
 * content.
 *
 * The check admits exactly that rewrite. Any other property key, and any
 * other per-node field that is not already characterised (`size` height-only,
 * `inputs` rebuild), must still refuse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { nodePropertiesDifferOnlyByRandomRangeNormalization } from "../../web/js/lib/node-properties-random-range.js";
import { graphRootReproducesStateContent } from "../../web/js/lib/graph-binding.js";

const SEED = "Seed (rgthree)";
const DEFAULTS = { randomMin: 0, randomMax: 1125899906842624 };

const node = (id, extra = {}) => ({
  id,
  type: extra.type ?? SEED,
  pos: [0, 0],
  size: [200, 100],
  widgets_values: extra.widgets_values ?? [-1],
  ...extra,
});

test("identical properties bags are trivially explained", () => {
  const n = node(1, { properties: { ...DEFAULTS, ver: "1" } });
  assert.equal(
    nodePropertiesDifferOnlyByRandomRangeNormalization([n], [structuredClone(n)]),
    true,
  );
});

test("constructor fill — live stamps defaults the file never saved — is explained", () => {
  // The reported shape: saved bag omitted the keys; the constructor left them.
  const saved = [node(1, { properties: { ver: "1" } })];
  const live = [node(1, { properties: { ver: "1", ...DEFAULTS } })];
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization(saved, live), true);
});

test("a missing properties bag vs constructor defaults is explained", () => {
  const saved = [node(1)];
  const live = [node(1, { properties: { ...DEFAULTS } })];
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization(saved, live), true);
});

test("a numeric rewrite of only randomMin/randomMax is explained", () => {
  const saved = [node(1, { properties: { randomMin: "0", randomMax: "1125899906842624" } })];
  const live = [node(1, { properties: { ...DEFAULTS } })];
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization(saved, live), true);
});

test("an unrelated properties KEY is NOT explained", () => {
  const saved = [node(1, { properties: { ver: "v1", ...DEFAULTS } })];
  const live = [node(1, { properties: { ver: "1", ...DEFAULTS } })];
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization(saved, live), false);
});

test("randomMin plus an unrelated key still refuses — the bag is not allowlisted", () => {
  const saved = [node(1, { properties: { ver: "1" } })];
  const live = [node(1, { properties: { ver: "1", cnr_id: "rgthree", ...DEFAULTS } })];
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization(saved, live), false);
});

test("unreadable properties prove NOTHING (false, not true)", () => {
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization(null, []), false);
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization([node(1)], undefined), false);
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization([null], [node(1)]), false);
  for (const bad of [null, [1, 2], "string"]) {
    assert.equal(
      nodePropertiesDifferOnlyByRandomRangeNormalization(
        [node(1, { properties: { ...DEFAULTS } })],
        [node(1, { properties: bad })],
      ),
      false,
      JSON.stringify(bad),
    );
  }
});

test("a node whose id/type moved is not paired and refuses", () => {
  assert.equal(
    nodePropertiesDifferOnlyByRandomRangeNormalization(
      [node(1, { properties: { ...DEFAULTS } })],
      [{ ...node(1, { properties: { ...DEFAULTS } }), type: "KSampler" }],
    ),
    false,
  );
});

test("every node's bag must be explained, not just one", () => {
  const saved = [node(1, { properties: {} }), node(2, { properties: { ver: "1" } })];
  const live = [node(1, { properties: { ...DEFAULTS } }), node(2, { properties: { ver: "2" } })];
  assert.equal(nodePropertiesDifferOnlyByRandomRangeNormalization(saved, live), false);
});

test("a THROWING properties bag proves nothing — the catch must answer false", () => {
  // The getter has to sit on a key we actually READ. `randomMin`/`randomMax` are
  // skipped without reading, so a throw there never reaches the catch — the same
  // lesson node-inputs-rebuild's first hostile-slot test had to learn.
  const hostile = { ...DEFAULTS };
  Object.defineProperty(hostile, "ver", {
    enumerable: true,
    get() {
      throw new Error("hostile getter");
    },
  });
  assert.equal(
    nodePropertiesDifferOnlyByRandomRangeNormalization(
      [node(1, { properties: { ...DEFAULTS, ver: "1" } })],
      [node(1, { properties: hostile })],
    ),
    false,
  );
});

// ── WIRING: the check must actually gate the verdict ────────────────────────
//
// Mutation found that deleting the gate from graph-binding left every test above
// green — they exercise the pure function, which cannot see whether anything
// calls it. These drive the real `graphRootReproducesStateContent`.

const graphOf = (nodes) => ({ serialize: () => ({ nodes }) });

test("#1608 the reporter's case: only randomMin/randomMax differ, and the open is PROVEN", () => {
  // No `loadRanToCompletion`: this is a field-level account, not the watched-
  // restore ground. The reporter's panel could not license that ground and still
  // had to publish the fence.
  const saved = {
    nodes: [
      node(12, { properties: { ver: "1.0.0" } }),
      node(4, { type: "KSampler", widgets_values: [20, "euler"] }),
    ],
  };
  const live = graphOf([
    node(12, { properties: { ver: "1.0.0", ...DEFAULTS } }),
    node(4, { type: "KSampler", widgets_values: [20, "euler"] }),
  ]);
  const verdict = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(verdict.proven, true, "the reporter's case must stop refusing");
  assert.equal(verdict.exact, false, "…but it is not byte-identical, and must not claim to be");
  assert.deepEqual(verdict.fields, [], "properties must not ride into geometry_rewritten");
  assert.equal(verdict.normalizedOnly, false, "this ground does not claim a watched restore");
});

test("#1608 a numeric rewrite of the same two keys is also PROVEN", () => {
  const saved = { nodes: [node(1, { properties: { randomMin: 5, randomMax: 99 } })] };
  const live = graphOf([node(1, { properties: { ...DEFAULTS } })]);
  const verdict = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(verdict.proven, true);
  assert.deepEqual(verdict.fields, []);
});

test("WIRING: a pack-version stamp still refuses through the real gate", () => {
  const saved = { nodes: [node(1, { properties: { ver: "v1", ...DEFAULTS } })] };
  const live = graphOf([node(1, { properties: { ver: "1", ...DEFAULTS } })]);
  assert.equal(graphRootReproducesStateContent({ rootGraph: live, state: saved }).proven, false);
});

test("WIRING: a widget value still refuses — random-range is not a blanket properties pass", () => {
  const saved = { nodes: [node(1, { properties: { ...DEFAULTS }, widgets_values: [-1] })] };
  const live = graphOf([node(1, { properties: { randomMin: 1, ...DEFAULTS }, widgets_values: [47] })]);
  const verdict = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(verdict.proven, false);
  assert.equal(verdict.presentationOnly, false);
});

test("WIRING: random-range plus a height-only size is PROVEN, and only size is disclosed", () => {
  const saved = { nodes: [node(1, { size: [200, 100], properties: { ver: "1" } })] };
  const live = graphOf([
    node(1, { size: [200, 60], properties: { ver: "1", ...DEFAULTS } }),
  ]);
  const verdict = graphRootReproducesStateContent({ rootGraph: live, state: saved });
  assert.equal(verdict.proven, true);
  assert.deepEqual(verdict.fields, ["size"], "geometry_rewritten may only name the height");
});

test("WIRING: source guard — the open content proof actually calls the check", () => {
  const src = readFileSync(new URL("../../web/js/lib/graph-binding.js", import.meta.url), "utf8");
  assert.match(src, /import \{ nodePropertiesDifferOnlyByRandomRangeNormalization \}/);
  assert.match(
    src,
    /if \(!nodePropertiesDifferOnlyByRandomRangeNormalization\(state\?\.nodes, actualState\?\.nodes\)\)/,
  );
});
