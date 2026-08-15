import { test } from "node:test";
import assert from "node:assert/strict";
import { CivitaiClient } from "../../web/js/cmcp-civitai.js";

/**
 * #712 — every CivitAI model search returned zero results with `error: null`,
 * indistinguishable from "nothing matched".
 *
 * Cause: `browsingLevels` defaults to `[1]` (PG), and `_modelFromJson` drops a
 * model outright when no cover image falls in the mask (a deliberate #515 SFW
 * guarantee). Almost no LoRA/checkpoint has a PG-rated cover, so everything
 * vanished — silently.
 *
 * The filter is NOT changed here: what it removes is a content-policy decision.
 * What is fixed is the silence, so the empty grid becomes attributable the way
 * an empty favorites feed already is (#190/#375).
 */

function clientWith(pages) {
  // Same injection shape the other civitai suites use: the monolith hands the
  // client ComfyUI's api ({fetchApi, apiURL}).
  const c = new CivitaiClient({ fetchApi: async () => ({ status: 200 }), apiURL: (p) => p });
  let i = 0;
  c._get = async () => pages[Math.min(i++, pages.length - 1)];
  return c;
}

const model = (id, nsfwLevel) => ({
  id,
  name: `m${id}`,
  modelVersions: [{ images: [{ url: `http://x/${id}.png`, nsfwLevel, type: "image" }] }],
});

test("counts what the browsing level removed", async () => {
  // Three models with mature covers, PG-only filter → all dropped.
  const c = clientWith([{ items: [model(1, 4), model(2, 8), model(3, 16)], metadata: {} }]);
  const page = await c.fetchModels({ type: "LORA", levels: [1] });
  assert.equal(page.models.length, 0, "all dropped by the level filter");
  assert.equal(page.hiddenByLevel, 3, "and the count says so — this is what was silent");
});

test("reports zero hidden when the level admits everything", async () => {
  const c = clientWith([{ items: [model(1, 1), model(2, 1)], metadata: {} }]);
  const page = await c.fetchModels({ type: "LORA", levels: [1] });
  assert.equal(page.models.length, 2);
  assert.equal(page.hiddenByLevel, 0, "a genuine result set must not claim anything was hidden");
});

test("a KEYWORD miss is not counted as level-hidden", async () => {
  // The load-bearing distinction. Counting keyword misses here would tell the
  // user to widen a browsing level that was never the reason they saw nothing.
  const c = clientWith([{ items: [model(1, 1), model(2, 1)], metadata: {} }]);
  // The client-side keyword filter only engages when BOTH query and username
  // are sent — /v1/models returns an empty page for that combination, so the
  // client sends username alone and matches the keyword locally.
  const page = await c.fetchModels({
    type: "LORA",
    levels: [1],
    query: "zzz-no-such-model",
    username: "someone",
  });
  assert.equal(page.models.length, 0, "keyword removed them");
  assert.equal(page.hiddenByLevel, 0, "but the LEVEL removed nothing");
});

test("accumulates across the thin-page hop chain, not just the last page", async () => {
  // fetchModels chases continuable empty pages; a count taken only from the
  // final hop would under-report everything the earlier hops dropped.
  const c = clientWith([
    { items: [model(1, 4), model(2, 4)], metadata: { nextCursor: "c1" } },
    { items: [model(3, 8)], metadata: { nextCursor: "c2" } },
    { items: [model(4, 1)], metadata: {} },
  ]);
  const page = await c.fetchModels({ type: "LORA", levels: [1] });
  assert.equal(page.models.length, 1, "only the PG one survives");
  assert.equal(page.hiddenByLevel, 3, "all three dropped across the hops are counted");
});

test("an empty upstream page reports nothing hidden", async () => {
  const c = clientWith([{ items: [], metadata: {} }]);
  const page = await c.fetchModels({ type: "LORA", levels: [1] });
  assert.equal(page.hiddenByLevel, 0);
});
