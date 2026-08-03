import test from "node:test";
import assert from "node:assert/strict";
import { sameGraphMutationContext } from "../../web/js/lib/graph-mutation-context.js";

function context(overrides = {}) {
  return {
    app: {},
    graph: {},
    rootGraph: {},
    canvas: {},
    workflow: {},
    ...overrides,
  };
}

test("an async graph preflight may commit only to its original graph context", () => {
  const original = context();
  assert.equal(sameGraphMutationContext(original, original), true);
  assert.equal(sameGraphMutationContext(original, { ...original, graph: {} }), false);
  assert.equal(sameGraphMutationContext(original, { ...original, rootGraph: {} }), false);
  assert.equal(sameGraphMutationContext(original, { ...original, workflow: {} }), false);
});

test("the caller can treat a raw workflow and its proxy as the same owner", () => {
  const raw = {};
  const proxy = { __v_raw: raw };
  const original = context({ workflow: raw });
  const after = { ...original, workflow: proxy };
  assert.equal(sameGraphMutationContext(original, after, (a, b) => a === b?.__v_raw), true);
});
