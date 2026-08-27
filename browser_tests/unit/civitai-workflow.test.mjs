// Unit tests for the CivitAI "load workflow onto canvas" plumbing
// (cmcp-civitai.js): UI/API format detection, meta.comfy extraction against
// the live payload shapes, version-file selection, and the minimal zip reader
// (civitai wraps Workflows uploads in small zips whose local headers use data
// descriptors — sizes live only in the central directory).
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { CivitaiClient } from "../../web/js/cmcp-civitai.js";
import { graphDirtyForConfirm } from "../../web/js/cmcp-civitai-ui.js";

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
 *  central directory knows them. uSizeOverride fakes the central directory's
 *  claimed uncompressed size (lying-header bomb); dupCentral appends N extra
 *  copies of each central record pointing at the SAME local header. */
function buildZip(files, { zeroLfhSizes = false, store = false, uSizeOverride = null, dupCentral = 0 } = {}) {
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
    const record = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(0), u16(0),
      u32(0), u32(data.length), u32(uSizeOverride ?? raw.length),
      u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(lfhOff), nameB,
    ]);
    central.push(record);
    for (let d = 0; d < dupCentral; d++) central.push(Buffer.from(record));
  }
  const cd = Buffer.concat(central);
  const cdOff = offset;
  push(cd);
  push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
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
  assert.deepEqual(v.files, [{
    id: 5, name: "wf.zip", sizeKB: 4.9, type: "Archive", format: "Other",
    primary: false, pickleScanResult: null, virusScanResult: null, hashes: null,
  }]);
});

test("#1964: _versionFromJson keeps Early Access + file verification from the pane fetch", () => {
  // The lightbox read serializes these off the already-fetched version object.
  // Dropping them here would force a public-API re-fetch, which cannot see RED.
  const client = new CivitaiClient({ apiURL: (p) => p });
  const v = client._versionFromJson({
    id: 11, name: "V4.0 INT8 CONVROT",
    availability: "EarlyAccess",
    earlyAccessEndsAt: "2026-09-01T00:00:00.000Z",
    earlyAccessConfig: { timeframe: 7, chargeForDownload: true, downloadPrice: 500, extra: "drop-me" },
    files: [{
      id: 7, name: "model.safetensors", sizeKB: 4200, type: "Model",
      primary: true, pickleScanResult: "Success", virusScanResult: "Success",
      hashes: { SHA256: "abc", AutoV2: "def" },
      metadata: { format: "SafeTensor" },
    }],
  }, [1]);
  assert.equal(v.availability, "EarlyAccess");
  assert.equal(v.earlyAccessEndsAt, "2026-09-01T00:00:00.000Z");
  assert.deepEqual(v.earlyAccessConfig, {
    timeframe: 7, chargeForDownload: true, downloadPrice: 500,
  });
  assert.equal(v.files[0].primary, true);
  assert.equal(v.files[0].pickleScanResult, "Success");
  assert.equal(v.files[0].virusScanResult, "Success");
  assert.deepEqual(v.files[0].hashes, { SHA256: "abc", AutoV2: "def" });
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

// ── zip-bomb caps (injected small so the tests stay KB-sized) ───────────────
test("zipEntries rejects archives past the entry-count cap", () => {
  const bytes = buildZip([
    ["a.json", "{}"], ["b.json", "{}"], ["c.json", "{}"],
  ]);
  const caps = { ...CivitaiClient.ZIP_CAPS, entries: 2 };
  assert.throws(() => CivitaiClient.zipEntries(bytes, caps),
    (e) => e.zipCap === true && /too many entries/.test(e.message));
});

test("zipReadText aborts inflation past the per-entry cap", async () => {
  const big = JSON.stringify({ ...UI_GRAPH, pad: "x".repeat(500) });
  const bytes = buildZip([["big.json", big]]);
  const caps = { ...CivitaiClient.ZIP_CAPS, entryBytes: 100 };
  const [e] = CivitaiClient.zipEntries(bytes, caps);
  await assert.rejects(() => CivitaiClient.zipReadText(bytes, e, caps),
    (err) => err.zipCap === true && /entry too large/.test(err.message));
});

test("a LYING-LOW uSize is ignored — the STREAMING counter catches the real inflation", async () => {
  // The killer case: central-directory uSize claims 5 bytes (so any declared-
  // size pre-check would wave it through), the well-compressed cSize is tiny,
  // but it actually inflates to ~2MB from a highly repetitive payload. The
  // streaming counter must abort mid-inflation — never materialize the 2MB.
  const bomb = JSON.stringify({ ...UI_GRAPH, pad: "A".repeat(2_000_000) });
  const bytes = buildZip([["liar.json", bomb]], { uSizeOverride: 5 });
  const caps = { ...CivitaiClient.ZIP_CAPS, entryBytes: 4096 }; // 4KB — far below 2MB
  const [e] = CivitaiClient.zipEntries(bytes, caps);
  assert.equal(e.uSize, 5);                    // the lie is in place
  assert.ok(e.cSize < 4096);                   // compressed blob itself is tiny
  await assert.rejects(() => CivitaiClient.zipReadText(bytes, e, caps),
    (err) => err.zipCap === true && /entry too large/.test(err.message));
  await assert.rejects(() => CivitaiClient.workflowsFromZip(bytes, caps),
    (err) => err.zipCap === true);
});

test("workflowsFromZip rejects archives past the AGGREGATE cap", async () => {
  const entry = JSON.stringify({ ...UI_GRAPH, pad: "x".repeat(40) }); // ~190B each
  const bytes = buildZip([["a.json", entry], ["b.json", entry]]);
  const caps = { ...CivitaiClient.ZIP_CAPS, totalBytes: 250 }; // one fits, two don't
  await assert.rejects(() => CivitaiClient.workflowsFromZip(bytes, caps),
    (err) => err.zipCap === true && /unpacks too large/.test(err.message));
});

test("aggregate cap counts UTF-8 BYTES, not UTF-16 code units", async () => {
  // Each entry pads with a 3-byte-UTF-8 / 1-UTF-16-unit char, so byte length is
  // ~3× the string length. Two entries: ~24KB of bytes but only ~8K code
  // units. A byte cap between them must catch the second; a string-length
  // counter (the bug) would see 8K < the cap and wave it through.
  const pad = "の".repeat(4000);                 // 12000 UTF-8 bytes, 4000 UTF-16 units
  const entry = JSON.stringify({ ...UI_GRAPH, pad });
  const bytes = buildZip([["a.json", entry], ["b.json", entry]], { zeroLfhSizes: true });
  const oneByteLen = new TextEncoder().encode(entry).length;
  const oneStrLen = entry.length;
  assert.ok(oneByteLen > oneStrLen * 2);         // multibyte confirmed
  // cap: one entry fits, two exceed it in BYTES but NOT in UTF-16 units
  const caps = { ...CivitaiClient.ZIP_CAPS, totalBytes: Math.floor(oneByteLen * 1.5) };
  assert.ok(caps.totalBytes > oneStrLen * 2);    // a string counter would pass both
  await assert.rejects(() => CivitaiClient.workflowsFromZip(bytes, caps),
    (err) => err.zipCap === true && /unpacks too large/.test(err.message));
  // control: a byte cap that fits both loads both
  const roomy = { ...CivitaiClient.ZIP_CAPS, totalBytes: oneByteLen * 3 };
  assert.equal((await CivitaiClient.workflowsFromZip(bytes, roomy)).length, 2);
});

test("duplicate central-directory records aimed at one local header are deduped", () => {
  // bomb trick: N directory records × one compressed blob = N× inflation
  const bytes = buildZip([["a.json", JSON.stringify(UI_GRAPH)]], { dupCentral: 3 });
  const entries = CivitaiClient.zipEntries(bytes);
  assert.equal(entries.length, 1);
});

test("central records whose spans run past the buffer stop the walk", () => {
  const bytes = buildZip([["a.json", "{}"]]);
  // patch the central record's nameLen to a huge value (record sig scan)
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint16(i + 28, 0xffff, true); break; }
  }
  assert.deepEqual(CivitaiClient.zipEntries(bytes), []);
});

// ── dirty-check fails CLOSED ────────────────────────────────────────────────
test("graphDirtyForConfirm treats every uncertainty as dirty", () => {
  assert.equal(graphDirtyForConfirm(undefined), true);           // no ctx at all
  assert.equal(graphDirtyForConfirm({}), true);                  // getter missing
  assert.equal(graphDirtyForConfirm({ graphIsDirty: 7 }), true); // not callable
  assert.equal(graphDirtyForConfirm({ graphIsDirty: () => { throw new Error("x"); } }), true);
  assert.equal(graphDirtyForConfirm({ graphIsDirty: () => undefined }), true); // non-boolean
  assert.equal(graphDirtyForConfirm({ graphIsDirty: () => "no" }), true);
  // and it still trusts a definite answer
  assert.equal(graphDirtyForConfirm({ graphIsDirty: () => false }), false);
  assert.equal(graphDirtyForConfirm({ graphIsDirty: () => true }), true);
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

// ── #882: the confirm gate must not trust a flag a node cannot set ─────────

test("WIRING #882: graphIsDirty captures the canvas before reading isModified", () => {
  // `isModified` comes from a snapshot ComfyUI takes on USER INPUT events only, so a
  // value a NODE wrote leaves it false while the canvas already differs from the
  // file. This gate fails closed for an UNREADABLE flag — it said so — but a STALE
  // flag is readable and wrong, so the overwrite confirmation was skipped and an
  // unsaved canvas clobbered without asking.
  //
  // The provider is a closure inside the panel needing a live DOM, so it is pinned
  // at source; the behaviour it feeds (`graphDirtyForConfirm`) is unit-tested above.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const site = src.slice(src.indexOf("graphIsDirty: () => {"), src.indexOf("loadGraph: async (graph)"));
  assert.ok(site.length > 0, "the provider must exist");
  assert.ok(
    site.includes("captureCanvasIntoTracker(wf)"),
    "it must capture before reading the flag",
  );
  // Synchronous caller: a capture it cannot wait for, or one that threw, leaves the
  // flag not known to be current — the same position as unreadable, so confirm.
  assert.ok(
    /captured === "pending" \|\| captured === "failed" \|\| captured === "unverified"/.test(site),
    "an unwaitable, failed or unverified capture must fall back to confirming",
  );
  const captureAt = site.indexOf("captureCanvasIntoTracker(wf)");
  const readAt = site.lastIndexOf("return wf.isModified;");
  assert.ok(captureAt < readAt, "the capture must precede the read");
});

test("WIRING #882: the shared capture reports WHY it could not capture", () => {
  // A boolean would force both callers to guess, which is the shape of the bug: the
  // close guard can await a pending capture, the synchronous confirm gate cannot,
  // and neither may treat "could not capture" as "not dirty".
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const fn = src.slice(
    src.indexOf("function captureCanvasIntoTracker(wf) {"),
    src.indexOf("function captureWasSuppressed(tracker) {"),
  );
  assert.ok(fn.length > 0, "the helper must exist");
  for (const verdict of [
    '"unavailable"',
    '"captured"',
    '"pending"',
    '"failed"',
    '"inactive"',
    '"unverified"',
  ]) {
    assert.ok(fn.includes(verdict), `it must be able to report ${verdict}`);
  }
  // "captured" must rest on EVIDENCE, not on the call returning. Upstream returns the
  // same `undefined` for a real snapshot and for every silent no-op (mid-undo, open
  // change transaction, graph loading), so claiming success from a bare return would
  // authorise a close on a stale flag — this bug exactly (codex).
  assert.ok(
    /after\.value !== before\.value\) return "captured"/.test(fn),
    "a replaced snapshot object must be accepted as proof the capture landed",
  );
  assert.ok(
    fn.includes("captureWasSuppressed(tracker)"),
    "an unproven capture must be checked against the documented no-op windows",
  );
  assert.ok(
    /suppressed \|\| captureWasSuppressed\(tracker\) \? "unverified" : "captured"/.test(fn),
    "a possibly-suppressed capture must report unverified, not captured",
  );
  // Suppression is sampled TWICE — at call time and again when the verdict is taken —
  // because an asynchronous capture does its work later, so the window that matters
  // may open after the first sample (codex).
  assert.equal(
    (fn.match(/captureWasSuppressed\(tracker\)/g) || []).length,
    2,
    "suppression must be sampled at call time and again at verdict time",
  );
  // `activeState` is a plain field today, but a version making it a throwing accessor
  // must not blow past these callers — every read goes through the guarded reader.
  assert.ok(
    /const readState = \(\) => \{\s*try \{/.test(fn),
    "the snapshot must be read through a guard",
  );
  // Exactly one read of the raw field, and it is the one inside the guard.
  assert.equal(
    (fn.match(/tracker\.activeState/g) || []).length,
    1,
    "no unguarded activeState read may remain",
  );
  assert.ok(
    /try \{\s*return \{ ok: true, value: tracker\.activeState \};/.test(fn),
    "the single raw read must be the guarded one",
  );
  // A read that THREW must report failure, not a successful read of `undefined` —
  // otherwise every verdict silently compares undefined to undefined and claims proof.
  assert.ok(
    /catch \{\s*return \{ ok: false, value: undefined \};/.test(fn),
    "a throwing snapshot read must report ok:false",
  );
  // And an unreadable snapshot BEFORE the call means no evidence can be established
  // at all, so the verdict must be unverified rather than proceeding blind.
  assert.ok(
    /if \(!before\.ok\) return \{ verdict: "unverified" \};/.test(fn),
    "an unreadable snapshot must short-circuit to unverified",
  );
  // Written as an early return for the non-thenable case, so accept either polarity —
  // what matters is that thenability is what separates "captured" from "pending".
  assert.ok(
    /typeof result\.then [!=]== "function"/.test(fn),
    "a thenable must be reported as pending",
  );
  assert.ok(fn.includes("} catch {"), "a throwing capture must not propagate");

  // Only the ACTIVE workflow may be flushed. Upstream `captureCanvasState()` returns
  // early for a non-active tracker, so asking would report a capture that never
  // happened — and an inactive tab was already frozen by ComfyUI's `deactivate()`.
  assert.ok(
    fn.includes("wf !== active) return { verdict: \"inactive\" }"),
    "a non-active workflow must be reported inactive rather than flushed",
  );
  // But "inactive" may only be claimed on a READABLE identity. `activeWorkflowRef()`
  // answers null both when nothing is active and when the lookup threw, and reading
  // null as inactive would trust a stale flag on the very target needing capture.
  assert.ok(
    /if \(!active\) return \{ verdict: "unverified" \};/.test(fn),
    "an unreadable active-workflow identity must not be dismissed as inactive",
  );
  // `checkState` is deprecated upstream (it warns, then delegates), so the current
  // name must be preferred and the old one kept only as the fallback.
  assert.ok(
    /capture\s*=\s*tracker\?\.captureCanvasState\s*\?\?\s*tracker\?\.checkState/.test(fn),
    "the non-deprecated capture must be preferred over checkState",
  );
  // `settled` must derive from the capture's OWN promise. Calling the capture a
  // second time to await would run it twice — and a capture that sees a change is not
  // a read: it pushes an undo entry and clears redo.
  // `settled` must be a REAL promise. A callable thenable can return a non-promise from
  // `.then()`, and awaiting that yields undefined — matching no verdict, so it would
  // slip past the refusal into the stale flag.
  assert.ok(
    /settled = Promise\.resolve\(result\)\.then\(landed, \(\) => "failed"\)/.test(fn),
    "the pending verdict must normalise the capture's own promise",
  );
  // Even ASKING whether the result is thenable can throw, if `then` is an accessor.
  assert.ok(
    /isThenable = !!result && typeof result\.then === "function";/.test(fn),
    "thenability must be probed inside a guard",
  );
  assert.equal(
    (fn.match(/capture\.call\(tracker\)/g) || []).length,
    1,
    "the capture must be invoked exactly once",
  );
});

test("WIRING #882: closing awaits a pending capture and refuses a failed one", () => {
  // The close executor is async, so unlike the confirm gate it CAN wait — and a
  // capture that failed leaves the tracker knowably behind, so the flag proves
  // nothing and the close must refuse rather than discard.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const site = src.slice(
    src.indexOf("const captured = captureCanvasIntoTracker(target);"),
    src.indexOf("await s.closeWorkflow(target);"),
  );
  assert.ok(site.length > 0, "the close guard must capture");
  // Await the capture's OWN promise. An earlier draft started a SECOND capture and
  // swallowed its rejection, so a rejected capture still read as "pending" and the
  // close went ahead on a stale flag — the very failure this guard exists to stop.
  assert.ok(site.includes("await captured.settled"), "a pending capture must be awaited");
  // An empty verdict must land on the refusal side, never slip through to the flag.
  assert.ok(
    (site.match(/\?\? "unverified"/g) || []).length >= 2,
    "an absent verdict must default to unverified on both branches",
  );
  assert.ok(
    !site.includes("changeTracker.checkState()"),
    "it must not start a second capture to await",
  );
  // The refusal must key off the SETTLED verdict, not the provisional one, or a
  // capture that rejects after being awaited is still treated as merely pending.
  assert.ok(
    /verdict === "failed" \|\| verdict === "unverified"/.test(site),
    "a failed OR unproven capture must refuse",
  );
  assert.ok(site.includes("target.isModified && !force"), "the original guard must remain");
  // The refusal must stay escapable, or a data-loss bug becomes a cannot-close bug.
  assert.ok(site.includes("!force"), "force:true must still be able to close");
});

test("WIRING #882: the no-op windows are read defensively", () => {
  // Upstream returns early — no throw, no signal — while a graph loads, while an
  // undo restores, and inside an open change transaction. These are the documented
  // conditions; an unreadable tracker must answer "suppressed" so the destructive
  // callers confirm instead of assuming.
  const src = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const fn = src.slice(
    src.indexOf("function captureWasSuppressed(tracker) {"),
    src.indexOf("function activeWorkflowRef() {"),
  );
  assert.ok(fn.length > 0, "the helper must exist");
  for (const flag of ["_restoringState", "changeCount", "isLoadingGraph"]) {
    assert.ok(fn.includes(flag), `it must account for ${flag}`);
    // And each must be checked for PRESENCE first. A renamed field would otherwise
    // read `undefined`, compare false, and silently delete a refusal signal instead
    // of degrading safely — the frontend would have changed shape unnoticed.
    assert.ok(
      new RegExp(`typeof tracker\\?[^;]*\\b${flag}\\b === "undefined"\\) return true;`).test(fn),
      `a missing ${flag} must be treated as suppressed, not as absent-and-safe`,
    );
  }
  assert.ok(/catch\s*{\s*\n?\s*return true;/.test(fn), "an unreadable tracker must not claim a capture");
});
