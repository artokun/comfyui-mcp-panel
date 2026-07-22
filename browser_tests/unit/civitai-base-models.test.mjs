// Unit tests for the base-model filter vocabulary (cmcp-civitai.js).
//
// Civitai accepts ONLY its own `BaseModel` enum strings for `baseModels=`; an
// unknown value returns nothing rather than erroring, so a typo or an omission
// fails SILENTLY — the model simply appears not to exist in the browser. That
// makes this list worth asserting on directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_MODELS, ACTIVE_BASE_MODELS } from "../../web/js/cmcp-civitai.js";

test("base model list has no duplicates", () => {
  const dupes = BASE_MODELS.filter((x, i) => BASE_MODELS.indexOf(x) !== i);
  assert.deepEqual(dupes, [], `duplicate base models: ${dupes.join(", ")}`);
});

test("every active base model is also in the full list", () => {
  // The dropdown groups by this set; an entry missing from BASE_MODELS would
  // be unreachable in the UI no matter how it is grouped.
  const orphans = [...ACTIVE_BASE_MODELS].filter((x) => !BASE_MODELS.includes(x));
  assert.deepEqual(orphans, [], `active but not listed: ${orphans.join(", ")}`);
});

test("the list covers the families Civitai is currently pushing", () => {
  // These are exactly the ones the previous hardcoded list predated. Their
  // absence is what made the filter feel broken: searching "flux 2" or
  // "z-image" returned nothing at all.
  const current = [
    "Flux.2 D", "Flux.2 Klein 9B", "Flux.2 Klein 4B", "Flux.1 Krea",
    "ZImageTurbo", "ZImageBase", "Krea 2", "LTXV 2.3", "LTXV2",
    "Wan Video 2.5 T2V", "Wan Video 2.5 I2V", "Wan Video 2.7", "Wan Image 2.7",
    "Qwen 2", "Pony V7", "Anima", "HiDream-O1", "Hunyuan 1",
  ];
  const missing = current.filter((x) => !BASE_MODELS.includes(x));
  assert.deepEqual(missing, [], `missing current base models: ${missing.join(", ")}`);
  for (const m of current) {
    assert.ok(ACTIVE_BASE_MODELS.has(m), `${m} should be grouped as current, not legacy`);
  }
});

test("retired families are kept but classed as legacy", () => {
  // Kept, because old models still carry these tags and users filter for them
  // deliberately; sunk, because they return next to nothing on a fresh feed.
  for (const m of ["SD 2.0 768", "SVD", "SVD XT", "Playground v2", "SDXL 0.9"]) {
    assert.ok(BASE_MODELS.includes(m), `${m} should still be selectable`);
    assert.ok(!ACTIVE_BASE_MODELS.has(m), `${m} should be grouped as legacy`);
  }
});

test("no entry has stray whitespace that would break the query string", () => {
  for (const m of BASE_MODELS) {
    assert.equal(m, m.trim(), `"${m}" has leading/trailing whitespace`);
    assert.ok(m.length > 0, "empty base model entry");
  }
});
