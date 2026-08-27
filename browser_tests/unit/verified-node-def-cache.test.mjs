import test from "node:test";
import assert from "node:assert/strict";

import { createVerifiedNodeDefCache } from "../../web/js/lib/verified-node-def-cache.js";

function context() {
  return {
    app: {},
    graph: {},
    rootGraph: {},
    workflow: {},
  };
}

test("#1709 reuses only a verified class on the same backend and graph binding", () => {
  const cache = createVerifiedNodeDefCache();
  const binding = context();
  const def = { input: { required: { seed: ["INT", {}] } } };
  const generation = cache.generation();

  assert.equal(cache.set("VRAM_Debug", def, { epoch: 3, context: binding, generation }), true);
  assert.equal(cache.get("VRAM_Debug", { epoch: 3, context: binding, generation }), def);
  assert.equal(cache.get("NeverVerified", { epoch: 3, context: binding, generation }), undefined);
  assert.equal(cache.get("VRAM_Debug", { epoch: 4, context: binding, generation }), undefined);
  assert.equal(
    cache.get("VRAM_Debug", { epoch: 3, context: { ...binding, workflow: {} }, generation }),
    undefined,
  );
  assert.equal(
    cache.get("VRAM_Debug", { epoch: 3, context: { ...binding, graph: {} }, generation }),
    undefined,
  );
});

test("#1709 a failed replacement restores fenced proof, and a successful one drops it", () => {
  const cache = createVerifiedNodeDefCache();
  const binding = context();
  const def = { input: { required: { seed: ["INT", {}] } } };
  const generation = cache.generation();

  assert.equal(cache.set("VRAM_Debug", def, { epoch: 0, context: binding, generation }), true);
  cache.beginReplacement();
  assert.equal(cache.isReplacementPending(), true);
  assert.ok(cache.generation() > generation, "replacement advances the write fence");
  assert.equal(
    cache.get("VRAM_Debug", { epoch: 0, context: binding, generation: cache.generation() }),
    undefined,
    "proof cannot authorize while the replacement is unresolved",
  );
  assert.equal(
    cache.set("Other", { input: { required: {} } }, { epoch: 0, context: binding, generation: cache.generation() }),
    false,
    "an in-flight writer cannot repopulate proof during replacement",
  );

  assert.equal(cache.retainAfterReplacementFailure({ epoch: 0, socketDown: false }), true);
  assert.equal(cache.isReplacementPending(), false);
  assert.equal(
    cache.get("VRAM_Debug", { epoch: 0, context: binding, generation: cache.generation() }),
    def,
    "a silent replacement restores the previously verified class",
  );

  cache.beginReplacement();
  cache.acceptReplacement();
  assert.equal(cache.isReplacementPending(), false);
  assert.equal(
    cache.get("VRAM_Debug", { epoch: 0, context: binding, generation: cache.generation() }),
    undefined,
    "an authoritative whole map retires per-class proof",
  );
});

test("#1709 a down socket during replacement discards proof instead of restoring it", () => {
  const cache = createVerifiedNodeDefCache();
  const binding = context();
  const generation = cache.generation();
  assert.equal(
    cache.set("VRAM_Debug", { input: { required: {} } }, { epoch: 3, context: binding, generation }),
    true,
  );
  cache.beginReplacement();
  assert.equal(cache.retainAfterReplacementFailure({ epoch: 3, socketDown: true }), false);
  assert.equal(
    cache.get("VRAM_Debug", { epoch: 3, context: binding, generation: cache.generation() }),
    undefined,
  );
});

test("#1709 invalidating a class removes its reuse proof, and invalid inputs never enter", () => {
  const cache = createVerifiedNodeDefCache();
  const binding = context();
  const def = { input: { required: {} } };
  const generation = cache.generation();

  assert.equal(cache.set("VRAM_Debug", def, { epoch: 0, context: binding, generation }), true);
  cache.invalidate("VRAM_Debug");
  assert.ok(cache.generation() > generation, "invalidation advances the write fence");
  assert.equal(cache.get("VRAM_Debug", { epoch: 0, context: binding, generation }), undefined);
  assert.equal(
    cache.set("Never", null, { epoch: 0, context: binding, generation: cache.generation() }),
    false,
  );
  assert.equal(
    cache.set("Never", {}, { epoch: 0, context: binding, generation }),
    false,
    "a late writer from before invalidation cannot repopulate proof",
  );
  const currentGeneration = cache.generation();
  assert.equal(
    cache.set("Never", {}, { epoch: 0, context: binding, generation: currentGeneration }),
    true,
  );
  cache.clear();
  assert.equal(
    cache.get("Never", { epoch: 0, context: binding, generation: currentGeneration }),
    undefined,
  );
});
