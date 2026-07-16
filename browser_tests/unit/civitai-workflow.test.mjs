// Unit tests for the CivitAI "load workflow onto canvas" plumbing
// (cmcp-civitai.js): UI/API format detection, meta.comfy extraction against
// the live payload shapes, version-file selection, and the minimal zip reader
// (civitai wraps Workflows uploads in small zips whose local headers use data
// descriptors — sizes live only in the central directory).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { CivitaiClient } from "../../web/js/cmcp-civitai.js";

// ── fixtures ────────────────────────────────────────────────────────────────
const UI_GRAPH = {
  last_node_id: 2, last_link_id: 1,
  nodes: [{ id: 1, type: "KSampler" }, { id: 2, type: "SaveImage" }],
  links: [], groups: [], config: {}, extra: {}, version: 0.4,
};
// API/prompt format — numeric keys, each with class_type (live shape from
// tRPC image.getGenerationData, image 136187879).
const API_GRAPH = {
  10002: { class_type: "ECHOCheckpointLoaderSimple", inputs: { ckpt_name: "EMS.safetensors" } },
  10012: { class_type: "KSampler", inputs: {} },
};

/** Minimal in-memory zip builder. zeroLfhSizes mirrors civitai's real zips:
 *  bit-3 data descriptors leave the LOCAL header sizes at 0 — only the
 *  central directory knows them. */
function buildZip(files, { zeroLfhSizes = false, store = false } = {}) {
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (b) => { chunks.push(b); offset += b.length; };
  for (const [name, text] of files) {
    const nameB = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const flags = zeroLfhSizes ? 8 : 0; // bit 3: sizes follow in a data descriptor
    const lfhOff = offset;
    push(Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(0), u32(zeroLfhSizes ? 0 : data.length), u32(zeroLfhSizes ? 0 : raw.length),
      u16(nameB.length), u16(0), nameB, data,
    ]));
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(0), u32(data.length), u32(raw.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(lfhOff), nameB,
    ]));
  }
  const cd = Buffer.concat(central);
  const cdOff = offset;
  push(cd);
  push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(cdOff), u16(0),
  ]));
  return new Uint8Array(Buffer.concat(chunks));
}

// ── workflowFormat ──────────────────────────────────────────────────────────
test("workflowFormat classifies UI, API, and junk", () => {
  const f = CivitaiClient.workflowFormat;
  assert.equal(f(UI_GRAPH), "ui");
  assert.equal(f({ nodes: [] }), "ui"); // empty-but-real litegraph doc
  assert.equal(f(API_GRAPH), "api");
  assert.equal(f({}), "unknown"); // civitai's empty `workflow: {}`
  assert.equal(f(null), "unknown");
  assert.equal(f([1, 2]), "unknown");
  assert.equal(f("nodes"), "unknown");
  assert.equal(f({ 1: { foo: 1 } }), "unknown"); // numeric keys, no class_type
  assert.equal(f({ prompt: "x" }), "unknown");
});

// ── comfyGraphInfo / comfyGraph ─────────────────────────────────────────────
test("comfyGraphInfo prefers the UI workflow (live object shape)", () => {
  const info = CivitaiClient.comfyGraphInfo({ comfy: { prompt: API_GRAPH, workflow: UI_GRAPH } });
  assert.equal(info.format, "ui");
  assert.equal(info.graph.nodes.length, 2);
});

test("comfyGraphInfo falls back to API when workflow is the live empty {}", () => {
  // Regression: image 136187879 carries { prompt: <api>, workflow: {} } — the
  // old comfyGraph returned the truthy-but-empty {} and lit the ✓ badge.
  const info = CivitaiClient.comfyGraphInfo({ comfy: { prompt: API_GRAPH, workflow: {} } });
  assert.equal(info.format, "api");
  assert.equal(info.graph, API_GRAPH);
});

test("comfyGraphInfo parses legacy string-encoded shapes", () => {
  // whole comfy is a JSON string
  const s = CivitaiClient.comfyGraphInfo({ comfy: JSON.stringify({ workflow: UI_GRAPH }) });
  assert.equal(s.format, "ui");
  // workflow field is itself a JSON string
  const inner = CivitaiClient.comfyGraphInfo({ comfy: { workflow: JSON.stringify(UI_GRAPH) } });
  assert.equal(inner.format, "ui");
  assert.equal(inner.graph.nodes.length, 2);
  // unparseable string → null, never a throw
  assert.equal(CivitaiClient.comfyGraphInfo({ comfy: "not json {" }), null);
  // unparseable workflow string but valid prompt → api fallback
  const fb = CivitaiClient.comfyGraphInfo({ comfy: { workflow: "not json {", prompt: API_GRAPH } });
  assert.equal(fb.format, "api");
});

test("comfyGraphInfo handles bare graphs and empties", () => {
  assert.equal(CivitaiClient.comfyGraphInfo({ comfy: UI_GRAPH }).format, "ui");
  assert.equal(CivitaiClient.comfyGraphInfo({ comfy: API_GRAPH }).format, "api");
  assert.equal(CivitaiClient.comfyGraphInfo({ comfy: { workflow: {} } }), null);
  assert.equal(CivitaiClient.comfyGraphInfo({}), null);
  assert.equal(CivitaiClient.comfyGraphInfo(null), null);
});

test("comfyGraph stays back-compatible but no longer returns the empty {}", () => {
  assert.equal(CivitaiClient.comfyGraph({ comfy: { workflow: UI_GRAPH } }), UI_GRAPH);
  assert.equal(CivitaiClient.comfyGraph({ comfy: { workflow: {} } }), null);
  assert.equal(CivitaiClient.comfyGraph(null), null);
});

// ── version-file selection ──────────────────────────────────────────────────
test("workflowFiles: .json always, .zip only on Workflows models", () => {
  const version = {
    files: [
      { id: 1, name: "wf.json", type: "Model", format: "Other", sizeKB: 12 },
      { id: 2, name: "pack.zip", type: "Archive", format: "Other", sizeKB: 30 },
      { id: 3, name: "model.safetensors", type: "Model", format: "SafeTensor", sizeKB: 2048 },
    ],
  };
  assert.deepEqual(
    CivitaiClient.workflowFiles(version, "Workflows").map((f) => f.id), [1, 2]);
  // on a Checkpoint the zip is training data, not a workflow
  assert.deepEqual(
    CivitaiClient.workflowFiles(version, "Checkpoint").map((f) => f.id), [1]);
});

test("workflowFiles dedupes by (type, format) — the download API can't address duplicates", () => {
  // live shape: version 2947948 has TWO Archive/Other zips; only one is reachable
  const version = {
    files: [
      { id: 1, name: "a.zip", type: "Archive", format: "Other", sizeKB: 5 },
      { id: 2, name: "b.zip", type: "Archive", format: "Other", sizeKB: 5 },
    ],
  };
  assert.equal(CivitaiClient.workflowFiles(version, "Workflows").length, 1);
});

test("workflowFiles skips files beyond the proxy's 100MB cap", () => {
  const version = { files: [{ id: 1, name: "huge.zip", type: "Archive", format: "Other", sizeKB: 200 * 1024 }] };
  assert.deepEqual(CivitaiClient.workflowFiles(version, "Workflows"), []);
});

test("_versionFromJson carries the files list (id/name/size/type/format)", () => {
  const client = new CivitaiClient({ apiURL: (p) => p });
  const v = client._versionFromJson({
    id: 9, files: [{ id: 5, name: "wf.zip", sizeKB: 4.9, type: "Archive", metadata: { format: "Other" } }],
  }, [1]);
  assert.deepEqual(v.files, [{ id: 5, name: "wf.zip", sizeKB: 4.9, type: "Archive", format: "Other" }]);
});

// ── zip reader ──────────────────────────────────────────────────────────────
test("zipEntries walks the central directory even when LFH sizes are zeroed", () => {
  // civitai's real zips use data descriptors: LFH says size 0, only the
  // central directory is truthful (live-verified on version 2947948).
  const bytes = buildZip([["a.json", JSON.stringify(UI_GRAPH)]], { zeroLfhSizes: true });
  const entries = CivitaiClient.zipEntries(bytes);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "a.json");
  assert.equal(entries[0].method, 8);
  assert.ok(entries[0].cSize > 0); // from the central directory, not the LFH
});

test("zipReadText inflates DEFLATE and reads STORE entries", async () => {
  const text = JSON.stringify(UI_GRAPH);
  for (const store of [false, true]) {
    const bytes = buildZip([["wf.json", text]], { store, zeroLfhSizes: !store });
    const [e] = CivitaiClient.zipEntries(bytes);
    assert.equal(await CivitaiClient.zipReadText(bytes, e), text);
  }
});

test("zipEntries throws on non-zip bytes", () => {
  assert.throws(() => CivitaiClient.zipEntries(new Uint8Array([1, 2, 3, 4])), /not a zip/);
});

test("workflowsFromZip extracts graphs, skips junk, sorts UI first", async () => {
  const bytes = buildZip([
    ["readme.txt", "hello"],                          // not .json — skipped
    ["api_only.json", JSON.stringify(API_GRAPH)],     // api — kept, sorted last
    ["broken.json", "{ nope"],                        // unparseable — skipped
    ["real.json", JSON.stringify(UI_GRAPH)],          // ui — first
    ["notes.json", JSON.stringify({ hello: 1 })],     // unknown format — skipped
  ], { zeroLfhSizes: true });
  const out = await CivitaiClient.workflowsFromZip(bytes);
  assert.deepEqual(out.map((c) => [c.name, c.format]),
    [["real.json", "ui"], ["api_only.json", "api"]]);
  assert.equal(out[0].graph.nodes.length, 2);
});

// ── download plumbing ───────────────────────────────────────────────────────
test("downloadVersionFile hits the proxy download route with type/format", async () => {
  const calls = [];
  const client = new CivitaiClient({
    fetchApi: async (path) => {
      calls.push(path);
      return { ok: true, arrayBuffer: async () => new Uint8Array([80, 75]).buffer };
    },
    apiURL: (p) => p,
  });
  const bytes = await client.downloadVersionFile(2947948, { type: "Archive", format: "Other" });
  assert.deepEqual([...bytes], [80, 75]);
  const u = new URL(calls[0], "http://x");
  assert.equal(u.pathname, "/comfyui_mcp_panel/civitai/download");
  assert.equal(u.searchParams.get("versionId"), "2947948");
  assert.equal(u.searchParams.get("type"), "Archive");
  assert.equal(u.searchParams.get("format"), "Other");
});

test("downloadVersionFile surfaces the HTTP status for the sign-in hint", async () => {
  const client = new CivitaiClient({
    fetchApi: async () => ({ ok: false, status: 401 }),
    apiURL: (p) => p,
  });
  await assert.rejects(
    () => client.downloadVersionFile(1),
    (e) => e.status === 401 && /401/.test(e.message),
  );
});
