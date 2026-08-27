// Unit tests for the agent-drive results serializer (cmcp-civitai-ui.js).
//
// `serializeCivitaiResults` is the pure core behind the `civitai_results` bridge
// cmd: it turns the modal's in-memory `state.items` (media) / `state.models`
// (models) into the agent contract shape — id, kind, title, creator,
// baseModel/type, stats, prompt, urls. The invariant that matters most: it
// returns METADATA + URLs ONLY, never image bytes, and clamps `limit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeCivitaiResults, CIVITAI_PROMPT_CAP, civitaiErrorState } from "../../web/js/cmcp-civitai-ui.js";

// Media rows as produced by CivitaiClient._fromRest / _fromMeili.
const mediaRows = [
  {
    id: 101, type: "image", author: "alice", modelName: "FLUX.1-dev",
    reactions: 42, prompt: "a cat astronaut",
    thumbnailUrl: "/proxy/thumb/101.jpeg", fullUrl: "/proxy/full/101.jpeg",
  },
  {
    id: 102, type: "video", author: "bob", modelName: "Wan 2.2",
    reactions: 7, prompt: null,
    thumbnailUrl: "/proxy/thumb/102.jpeg", fullUrl: "/proxy/full/102.mp4",
  },
];

// Model rows as produced by CivitaiClient._modelFromJson.
const modelRows = [
  {
    id: 5, name: "Dreamy LoRA", creator: "carol", baseModel: "SDXL 1.0",
    type: "LORA", downloadCount: 1234, thumbsUp: 88, coverUrl: "/proxy/cover/5.jpeg",
  },
];

test("media serialization matches the contract shape", () => {
  const out = serializeCivitaiResults(mediaRows, { model: false, loading: false });
  assert.equal(out.total, 2);
  assert.equal(out.loading, false);
  assert.equal(out.items.length, 2);

  const [a, b] = out.items;
  assert.deepEqual(a, {
    id: 101, kind: "image", title: null, creator: "alice",
    baseModel: "FLUX.1-dev", type: "image",
    stats: { reactions: 42 }, prompt: "a cat astronaut",
    urls: ["/proxy/thumb/101.jpeg", "/proxy/full/101.jpeg"],
    pageUrl: "https://civitai.com/images/101",
    gated: false, // has a thumbnail + not flagged → visible
  });
  assert.equal(b.kind, "video"); // type:"video" → kind:"video"
  assert.equal(b.prompt, null);
  assert.deepEqual(b.urls, ["/proxy/thumb/102.jpeg", "/proxy/full/102.mp4"]);
});

test("model serialization matches the contract shape", () => {
  const out = serializeCivitaiResults(modelRows, { model: true, loading: true });
  assert.equal(out.total, 1);
  assert.equal(out.loading, true);
  assert.deepEqual(out.items[0], {
    id: 5, kind: "model", title: "Dreamy LoRA", creator: "carol",
    baseModel: "SDXL 1.0", type: "LORA",
    stats: { downloadCount: 1234, thumbsUp: 88 },
    prompt: null, urls: ["/proxy/cover/5.jpeg"],
    pageUrl: "https://civitai.com/models/5",
    gated: false, // has a cover + not flagged → visible
  });
});

test("gated / blurred results are flagged so a vision consumer withholds pixels (mcp#623)", () => {
  // Media: an item flagged gated (rating outside enabled levels), and one with no
  // thumbnail at all (also rendered as a blurred placeholder by the grid).
  const media = [
    { id: 1, type: "image", author: "a", reactions: 0, gated: true, thumbnailUrl: "/t/1", fullUrl: "/f/1" },
    { id: 2, type: "image", author: "b", reactions: 0, thumbnailUrl: null, fullUrl: null },
    { id: 3, type: "image", author: "c", reactions: 0, thumbnailUrl: "/t/3", fullUrl: "/f/3" },
  ];
  const out = serializeCivitaiResults(media, { model: false });
  assert.equal(out.items[0].gated, true); // explicitly gated
  assert.equal(out.items[1].gated, true); // no thumbnail → blurred placeholder
  assert.equal(out.items[2].gated, false); // visible
  // Models: a model with no usable cover is treated as gated too.
  const models = [
    { id: 9, name: "No Cover", creator: "d", coverUrl: null },
    { id: 10, name: "Has Cover", creator: "e", coverUrl: "/c/10" },
  ];
  const mout = serializeCivitaiResults(models, { model: true });
  assert.equal(mout.items[0].gated, true);
  assert.equal(mout.items[1].gated, false);
});

test("every serialized url is a string, never image bytes/blobs", () => {
  const out = serializeCivitaiResults(mediaRows, { model: false });
  for (const it of out.items) {
    assert.ok(Array.isArray(it.urls));
    for (const u of it.urls) assert.equal(typeof u, "string");
  }
});

test("limit is honored and clamped to [1,200]", () => {
  const many = Array.from({ length: 300 }, (_, i) => ({
    id: i, type: "image", author: "x", reactions: 0,
    thumbnailUrl: `/t/${i}`, fullUrl: `/f/${i}`,
  }));
  assert.equal(serializeCivitaiResults(many, { limit: 5 }).items.length, 5);
  assert.equal(serializeCivitaiResults(many, { limit: 1000 }).items.length, 200); // clamped
  assert.equal(serializeCivitaiResults(many, { limit: 0 }).items.length, 20); // invalid → default
  assert.equal(serializeCivitaiResults(many, { limit: -3 }).items.length, 20); // invalid → default
  assert.equal(serializeCivitaiResults(many).items.length, 20); // default
  // total always reflects the full source, not the truncated page.
  assert.equal(serializeCivitaiResults(many, { limit: 5 }).total, 300);
});

test("missing/empty urls are dropped, not emitted as null/undefined", () => {
  const partial = [{ id: 1, type: "image", author: "z", reactions: 0, thumbnailUrl: "/t/1", fullUrl: null }];
  const out = serializeCivitaiResults(partial, { model: false });
  assert.deepEqual(out.items[0].urls, ["/t/1"]);
});

test("non-array source is tolerated", () => {
  const out = serializeCivitaiResults(null, { model: false });
  assert.deepEqual(out, { items: [], total: 0, loading: false });
});

// ---- #599: the agent-facing error must distinguish the failure CAUSE ----
// transport (NO HTTP response was received; which hop failed is undetermined,
// and CivitAI is NOT excluded) vs an upstream CivitAI error (HTTP status
// present) vs a true empty result (no error object at all).

test("#599: a transport failure keeps status null and carries kind", () => {
  const err = Object.assign(new Error("…no HTTP response; hop undetermined…"), {
    status: null, kind: "transport",
  });
  assert.deepEqual(civitaiErrorState(err), {
    status: null,
    message: "…no HTTP response; hop undetermined…",
    kind: "transport",
  });
});

test("#599: an upstream CivitAI error carries its HTTP status and no kind", () => {
  const err = Object.assign(new Error("CivitAI API 503: Service Unavailable"), { status: 503 });
  assert.deepEqual(civitaiErrorState(err), {
    status: 503,
    message: "CivitAI API 503: Service Unavailable",
  });
});

test("#599: a plain error without a status is recorded without kind", () => {
  assert.deepEqual(civitaiErrorState(new Error("boom")), { status: null, message: "boom" });
});

test("long prompts are capped to the token budget with an ellipsis", () => {
  const long = "x".repeat(CIVITAI_PROMPT_CAP + 500);
  const out = serializeCivitaiResults(
    [{ id: 1, type: "image", author: "a", reactions: 0, prompt: long, thumbnailUrl: "/t/1", fullUrl: "/f/1" }],
    { model: false },
  );
  const p = out.items[0].prompt;
  assert.equal(p.length, CIVITAI_PROMPT_CAP + 1); // cap + the "…"
  assert.ok(p.endsWith("…"));
  // A short prompt is passed through verbatim.
  const short = serializeCivitaiResults(
    [{ id: 2, type: "image", author: "a", reactions: 0, prompt: "tiny", thumbnailUrl: "/t/2", fullUrl: "/f/2" }],
    { model: false },
  );
  assert.equal(short.items[0].prompt, "tiny");
});
