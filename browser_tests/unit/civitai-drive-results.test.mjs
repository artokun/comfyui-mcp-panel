// Unit tests for the agent-drive results serializer (cmcp-civitai-ui.js).
//
// `serializeCivitaiResults` is the pure core behind the `civitai_results` bridge
// cmd: it turns the modal's in-memory `state.items` (media) / `state.models`
// (models) into the agent contract shape — id, kind, title, creator,
// baseModel/type, stats, prompt, urls. The invariant that matters most: it
// returns METADATA + URLs ONLY, never image bytes, and clamps `limit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serializeCivitaiResults } from "../../web/js/cmcp-civitai-ui.js";

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
  });
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
