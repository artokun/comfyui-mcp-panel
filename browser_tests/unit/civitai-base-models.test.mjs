// Unit tests for the base-model filter vocabulary (cmcp-civitai.js).
//
// Civitai accepts ONLY its own `BaseModel` enum strings for `baseModels=`; an
// unknown value returns nothing rather than erroring, so a typo or an omission
// fails SILENTLY — the model simply appears not to exist in the browser. That
// makes this list worth asserting on directly.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_MODELS, ACTIVE_BASE_MODELS, tokenizeQuery, prepareQuery, matchesBaseModel,
} from "../../web/js/cmcp-civitai.js";

const search = (q) => BASE_MODELS.filter((m) => matchesBaseModel(m, prepareQuery(q)));

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

test("the searches people actually type reach the right model", () => {
  // Every one of these returned ZERO results under plain substring matching —
  // caught in the live panel, not in review. Civitai's punctuation ("Flux.2 D")
  // and interposed words ("Wan Video 2.5 T2V") defeat `includes`.
  assert.ok(search("flux 2").includes("Flux.2 D"), '"flux 2" should find Flux.2 D');
  assert.ok(search("wan 2.5").includes("Wan Video 2.5 T2V"), '"wan 2.5" should find Wan Video 2.5 T2V');
  assert.ok(search("wan 2.5").includes("Wan Video 2.5 I2V"), '"wan 2.5" should find both 2.5 variants');
  assert.ok(search("flux 2 klein").includes("Flux.2 Klein 9B"), "multi-token should narrow, not break");
  assert.ok(search("zimage").includes("ZImageTurbo"), "prefix match should reach ZImageTurbo");
  assert.ok(search("sd 3.5").includes("SD 3.5 Large"), '"sd 3.5" should find the 3.5 family');
  assert.ok(search("ltx 2.3").includes("LTXV 2.3"), '"ltx 2.3" should find LTXV 2.3');
});

test("matching stays ordered, so a query cannot match the wrong version", () => {
  // The failure mode of loosening the matcher: "flux 2" quietly matching
  // Flux.1, which would send someone to the wrong model entirely.
  assert.ok(!search("flux 2").includes("Flux.1 D"), '"flux 2" must NOT match Flux.1 D');
  assert.ok(!search("sd 3.5").includes("SD 3"), '"sd 3.5" must NOT match bare SD 3');
  assert.ok(!matchesBaseModel("Flux.2 D", tokenizeQuery("d flux")), "order must be respected");
});

test("an empty query matches everything, a nonsense one matches nothing", () => {
  assert.equal(search("").length, BASE_MODELS.length);
  assert.equal(search("   ").length, BASE_MODELS.length);
  assert.deepEqual(search("zzzznotamodel"), []);
});

test("hyphenated and spaced queries reach concatenated names", () => {
  // Names like "ZImageTurbo" and "AuraFlow" are a SINGLE token, so ordered
  // token matching alone can never reach them from a two-token query — the
  // exact failure the first version shipped with: "z-image" returned nothing.
  for (const q of ["z-image", "z image", "zimage", "Z-Image"]) {
    assert.ok(search(q).includes("ZImageTurbo"), `"${q}" should find ZImageTurbo`);
    assert.ok(search(q).includes("ZImageBase"), `"${q}" should find ZImageBase`);
  }
  assert.ok(search("aura flow").includes("AuraFlow"), '"aura flow" should find AuraFlow');
  assert.ok(search("noob ai").includes("NoobAI"), '"noob ai" should find NoobAI');
  assert.ok(search("open ai").includes("OpenAI"), '"open ai" should find OpenAI');
  assert.ok(search("hi dream").includes("HiDream"), '"hi dream" should find HiDream');
});

test("a version query does not drag in a neighbouring version", () => {
  // "wan 2.5" previously also returned "Wan Video 2.2 TI2V-5B": split into
  // ["wan","2","5"] it matched the 2 of 2.2 and the 5 of 5B. Keeping "2.5"
  // whole is what stops it — and offering the wrong Wan is worse than
  // offering none, since the user downloads it before finding out.
  const wan = search("wan 2.5");
  assert.ok(wan.includes("Wan Video 2.5 T2V"));
  assert.ok(wan.includes("Wan Video 2.5 I2V"));
  assert.ok(!wan.includes("Wan Video 2.2 TI2V-5B"), "must not offer the 2.2 model for a 2.5 search");
  assert.ok(!wan.includes("Wan Video 2.2 I2V-A14B"), "must not offer any 2.2 model for a 2.5 search");
  assert.deepEqual(wan, ["Wan Video 2.5 T2V", "Wan Video 2.5 I2V"]);
});

test("tokenizer keeps version numbers whole", () => {
  assert.deepEqual(tokenizeQuery("wan 2.5"), ["wan", "2.5"]);
  assert.deepEqual(tokenizeQuery("Flux.2 D"), ["flux", "2", "d"]);
  assert.deepEqual(tokenizeQuery("SD 3.5 Large"), ["sd", "3.5", "large"]);
  assert.deepEqual(tokenizeQuery("TI2V-5B"), ["ti2v", "5b"]);
  assert.deepEqual(tokenizeQuery(""), []);
  assert.deepEqual(tokenizeQuery(null), []);
});

test("punctuation, emoji and non-ASCII match nothing rather than everything", () => {
  // These tokenize to nothing. Treating "no tokens" as "no filter" answered a
  // nonsense search with the full list, which reads as if all 96 matched.
  for (const q of [".", "...", "___", "-", "🔥", "é", "α", "!!!"]) {
    assert.deepEqual(search(q), [], `"${q}" should match nothing`);
  }
  // ...but genuinely empty input is still "no filter".
  assert.equal(search("").length, BASE_MODELS.length);
});

test("a very long query terminates and matches nothing", () => {
  assert.deepEqual(search("a".repeat(5000)), []);
  assert.deepEqual(search("wan ".repeat(500)), []);
});

test("the enum is pinned exactly, so a silent deletion fails the suite", () => {
  // Without this, removing an unmentioned entry like "Veo 3" left every other
  // test green — the list is the filter's whole vocabulary, so it needs a
  // full-set assertion, not a spot check.
  assert.equal(BASE_MODELS.length, 96);
  assert.equal(new Set(BASE_MODELS).size, 96);
  assert.equal(ACTIVE_BASE_MODELS.size, 65);
  for (const m of ["Veo 3", "Sora 2", "Kling", "Seedance", "Tripo", "PolyGen",
                   "Hunyuan3D", "Nano Banana", "Imagen4", "ODOR", "Boogu", "Lens"]) {
    assert.ok(BASE_MODELS.includes(m), `${m} disappeared from the enum`);
  }
});

test("no entry has stray whitespace that would break the query string", () => {
  for (const m of BASE_MODELS) {
    assert.equal(m, m.trim(), `"${m}" has leading/trailing whitespace`);
    assert.ok(m.length > 0, "empty base model entry");
  }
});
