// #1964 — Lightbox read contract for the CivitAI pane.
//
// "Ask agent to download" already routes user intent to an agent that cannot
// see the view it comes from. These tests fail if the shipped read
// (`panel_civitai_results` / `civitai_results`) still omits the live lightbox,
// and they fail if someone "fixes" that by re-fetching the public CivitAI API
// instead of copying the pane's already-open view (#1962: RED is not on the API).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  serializeCivitaiLightbox,
  htmlToPlain,
  civitaiDownloadSubfolder,
  CIVITAI_NOTE_CAP,
} from "../../web/js/lib/civitai-lightbox-read.js";

const LIB = new URL("../../web/js/lib/civitai-lightbox-read.js", import.meta.url);
const UI = new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url);
const PANEL = new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url);
const SHELL = new URL("../../web/js/cmcp-sidepanel-ui.js", import.meta.url);

const int8 = {
  id: 401, name: "V4.0 INT8 CONVROT", baseModel: "Flux.1 D",
  fileName: "krea-v4-int8.safetensors",
  descriptionHtml: "<p>download link is already in my discord</p>",
  trainedWords: ["krea"],
  availability: "Public",
  earlyAccessEndsAt: null,
  earlyAccessConfig: null,
  files: [{
    id: 11, name: "krea-v4-int8.safetensors", sizeKB: 6500, type: "Model",
    format: "SafeTensor", primary: true,
    pickleScanResult: "Success", virusScanResult: "Success",
    hashes: { SHA256: "aa", AutoV2: "bb" },
  }],
  examples: [
    { id: 91, type: "image", author: "sean", reactions: 3, thumbnailUrl: "/t/91", fullUrl: "/f/91" },
    { id: 92, type: "image", author: "sean", reactions: 0, gated: true, thumbnailUrl: "/t/92", fullUrl: "/f/92" },
  ],
};
const bf16 = {
  id: 402, name: "V7.0 BF16", baseModel: "Flux.1 D",
  fileName: "krea-v7-bf16.safetensors",
  descriptionHtml: null,
  trainedWords: [],
  availability: "EarlyAccess",
  earlyAccessEndsAt: "2026-09-01T00:00:00.000Z",
  earlyAccessConfig: { timeframe: 14, chargeForDownload: true, downloadPrice: 2500 },
  files: [{
    id: 12, name: "krea-v7-bf16.safetensors", sizeKB: 24.48 * 1024, type: "Model",
    format: "SafeTensor", primary: true,
    pickleScanResult: "Success", virusScanResult: "Success",
    hashes: { SHA256: "cc" },
  }],
  examples: [],
};
const fp8 = {
  id: 403, name: "v5.0 Converted FP8", baseModel: "Flux.1 D",
  fileName: "krea-v5-fp8.safetensors",
  trainedWords: [],
  files: [{
    id: 13, name: "krea-v5-fp8.safetensors", sizeKB: 12000, type: "Model",
    format: "SafeTensor", primary: true,
  }],
  examples: [],
};

const detail = {
  id: 2731187,
  name: "Moody Krea 2 Mix (uncensored)",
  type: "Checkpoint",
  creator: "cutie",
  descriptionHtml: "<p>model-level note</p>",
  versions: [bf16, int8, fp8],
};

function modelView(version = int8) {
  return { open: true, kind: "model", loading: false, detail, version };
}

test("closed lightbox is an honest close, not a missing field", () => {
  assert.deepEqual(serializeCivitaiLightbox(null), { open: false });
  assert.deepEqual(serializeCivitaiLightbox({}), { open: false });
  assert.deepEqual(serializeCivitaiLightbox({ open: false }), { open: false });
});

test("model lightbox returns the FULL version ladder with the ACTIVE selection", () => {
  // Field-tested: the grid only named the 24.48 GB BF16 "best match", so the
  // agent warned it would not fit a 16 GB card while INT8/FP8 sat one pill away.
  const out = serializeCivitaiLightbox(modelView(int8));
  assert.equal(out.open, true);
  assert.equal(out.kind, "model");
  assert.equal(out.loading, false);
  assert.equal(out.id, 2731187);
  assert.equal(out.title, "Moody Krea 2 Mix (uncensored)");
  assert.equal(out.creator, "cutie");
  assert.equal(out.versions.length, 3);
  assert.deepEqual(out.versions.map((v) => v.name), [
    "V7.0 BF16", "V4.0 INT8 CONVROT", "v5.0 Converted FP8",
  ]);
  const selected = out.versions.filter((v) => v.selected);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].name, "V4.0 INT8 CONVROT");
  assert.equal(out.selectedVersion.id, 401);
  assert.equal(out.selectedVersion.name, "V4.0 INT8 CONVROT");
});

test("selected version carries file name, size, format, verification, Early Access", () => {
  const int8Out = serializeCivitaiLightbox(modelView(int8)).selectedVersion;
  assert.equal(int8Out.fileName, "krea-v4-int8.safetensors");
  assert.equal(int8Out.files[0].name, "krea-v4-int8.safetensors");
  assert.equal(int8Out.files[0].sizeKB, 6500);
  assert.equal(int8Out.files[0].format, "SafeTensor");
  assert.equal(int8Out.files[0].pickleScanResult, "Success");
  assert.equal(int8Out.files[0].virusScanResult, "Success");
  assert.deepEqual(int8Out.files[0].hashes, { SHA256: "aa", AutoV2: "bb" });
  assert.equal(int8Out.earlyAccess.availability, "Public");

  const ea = serializeCivitaiLightbox(modelView(bf16)).selectedVersion.earlyAccess;
  assert.equal(ea.availability, "EarlyAccess");
  assert.equal(ea.endsAt, "2026-09-01T00:00:00.000Z");
  assert.equal(ea.chargeForDownload, true);
  assert.equal(ea.downloadPrice, 2500);
});

test("creator note is the lightbox description text, not HTML", () => {
  const out = serializeCivitaiLightbox(modelView(int8));
  assert.equal(out.creatorNote, "download link is already in my discord");
  assert.equal(htmlToPlain("<p>download link is already in my discord</p>"),
    "download link is already in my discord");
});

test("a version without its own note falls back to the model description", () => {
  const out = serializeCivitaiLightbox(modelView(fp8));
  assert.equal(out.creatorNote, "model-level note");
});

test("downloadTarget is the CURRENT pill, not the grid's first-version file", () => {
  const out = serializeCivitaiLightbox(modelView(int8));
  assert.deepEqual(out.downloadTarget, {
    model_id: 2731187,
    model_version_id: 401,
    versionName: "V4.0 INT8 CONVROT",
    type: "Checkpoint",
    subfolder: "checkpoints",
    fileName: "krea-v4-int8.safetensors",
  });
  assert.equal(civitaiDownloadSubfolder("LORA"), "loras");
  assert.notEqual(out.downloadTarget.model_version_id, bf16.id,
    "must not silently report the BF16 'best match' the grid showed");
});

test("examples honor the gated contract (flag, keep URLs, never bytes)", () => {
  const out = serializeCivitaiLightbox(modelView(int8));
  assert.equal(out.examples.length, 2);
  assert.equal(out.examples[0].gated, false);
  assert.deepEqual(out.examples[0].urls, ["/t/91", "/f/91"]);
  assert.equal(out.examples[1].gated, true);
  for (const ex of out.examples) {
    for (const u of ex.urls) assert.equal(typeof u, "string");
  }
});

test("Ask-agent payload drops examples (items 1–4 only) and still names the pill", () => {
  const out = serializeCivitaiLightbox(modelView(int8), { forDownload: true });
  assert.deepEqual(out.examples, []);
  assert.equal(out.title, "Moody Krea 2 Mix (uncensored)");
  assert.equal(out.selectedVersion.name, "V4.0 INT8 CONVROT");
  assert.equal(out.creatorNote, "download link is already in my discord");
  assert.equal(out.downloadTarget.model_version_id, 401);
  assert.equal(out.versions.length, 3);
});

test("a still-loading model lightbox is open, not closed", () => {
  const out = serializeCivitaiLightbox({
    open: true, kind: "model", loading: true,
    id: 2731187, title: "Moody Krea 2 Mix (uncensored)", creator: "cutie",
  });
  assert.equal(out.open, true);
  assert.equal(out.loading, true);
  assert.equal(out.id, 2731187);
  assert.equal(out.title, "Moody Krea 2 Mix (uncensored)");
  assert.equal(out.selectedVersion, null);
  assert.equal(out.downloadTarget, null);
});

test("media lightbox reports the open item and the gating flag", () => {
  const out = serializeCivitaiLightbox({
    open: true, kind: "media",
    item: {
      id: 77, type: "image", author: "alice", reactions: 4,
      thumbnailUrl: "/t/77", fullUrl: "/f/77",
    },
    index: 2, total: 10, done: false,
  });
  assert.equal(out.open, true);
  assert.equal(out.kind, "media");
  assert.equal(out.id, 77);
  assert.equal(out.creator, "alice");
  assert.equal(out.index, 2);
  assert.equal(out.total, 10);
  assert.equal(out.more, true);
  assert.equal(out.item.gated, false);
});

test("a long creator note is capped so the receipt stays bounded", () => {
  const long = `<p>${"x".repeat(CIVITAI_NOTE_CAP + 80)}</p>`;
  const out = serializeCivitaiLightbox({
    open: true, kind: "model", loading: false,
    detail: { ...detail, versions: [{ ...int8, descriptionHtml: long }], descriptionHtml: null },
    version: { ...int8, descriptionHtml: long },
  });
  assert.equal(out.creatorNote.length, CIVITAI_NOTE_CAP + 1);
  assert.ok(out.creatorNote.endsWith("…"));
});

test("the serializer is pure: no fetch, no CivitAI host, no image bytes", async () => {
  const src = await readFile(LIB, "utf8");
  assert.equal(/fetch\s*\(/.test(src), false, "a fetch here would be the #1962 public-API workaround");
  assert.equal(/civitai\.com/.test(src), false, "must not name the public API host");
  assert.equal(/fetchModelDetail/.test(src), false);
  assert.equal(/_get\s*\(/.test(src), false);
  assert.equal(/arrayBuffer|blob\b|uint8array/i.test(src), false);
});

test("WIRING: panel_civitai_results actually returns the live lightbox", async () => {
  const src = await readFile(UI, "utf8");
  assert.match(src, /import \{ serializeCivitaiLightbox \} from "\.\/lib\/civitai-lightbox-read\.js";/,
    "the pane-path serializer must be imported");

  const ret = src.slice(src.indexOf("async function driveGetResults"));
  const body = ret.slice(0, ret.indexOf("async function driveHighlight"));
  assert.ok(body.includes("lightbox: serializeCivitaiLightbox(_readLightbox())"),
    "driveGetResults must copy the LIVE reader — without this the agent still cannot see the lightbox");
  assert.equal(body.includes("fetchModelDetail"), false,
    "the shipped read must not re-fetch model detail");
  assert.equal(/civitai\.com/.test(body), false,
    "the shipped read must not hit the public CivitAI API");
});

test("WIRING: the live reader is the open lightbox, not a stale close", async () => {
  const src = await readFile(UI, "utf8");
  assert.ok(src.includes("function setLightboxReader("),
    "openModelDetail / openViewer must install a live reader");
  assert.ok(src.includes("kind: \"model\""),
    "the model-detail surface (Ask agent to download) must be readable");
  assert.ok(src.includes("kind: \"media\""),
    "the media lightbox must be readable too");
  // Version pills mutate `version`; the reader must close over that binding
  // so a later civitai_results sees the pill the user clicked, not versions[0].
  const openModel = src.slice(src.indexOf("async function openModelDetail"));
  const body = openModel.slice(0, src.indexOf("async function pickModel") - src.indexOf("async function openModelDetail"));
  assert.ok(body.includes("setLightboxReader("), "openModelDetail must install the reader");
  assert.ok(body.includes("return { open: true, kind: \"model\", loading: false, detail, version }"),
    "the reader must close over the SELECTED version binding");
});

test("WIRING: Ask agent to download carries the current lightbox (items 1–4)", async () => {
  const src = await readFile(UI, "utf8");
  const pick = src.slice(src.indexOf("async function pickModel"));
  const body = pick.slice(0, src.indexOf("// ── filters") - src.indexOf("async function pickModel"));
  assert.ok(body.includes("serializeCivitaiLightbox("),
    "the click must attach the live view, not just model_id + version id");
  assert.ok(body.includes("forDownload: true"),
    "the click payload is items 1–4 (identity, versions, files, note), not the examples grid");
  assert.ok(body.includes("Live CivitAI lightbox (what I'm looking at)"),
    "the agent-side event must name the view so it cannot be mistaken for a search result");
});

test("WIRING: the shipped cmd is civitai_results, not a new tool name", async () => {
  // Vocabulary is vendored; a new lightbox-named panel tool would not exist on
  // the orchestrator. The read has to ride the already-shipped results path.
  const panel = await readFile(PANEL, "utf8");
  const start = panel.indexOf("onCivitaiCmd(msg) {");
  assert.ok(start >= 0, "onCivitaiCmd handler must exist");
  const body = panel.slice(start, panel.indexOf("onTrainingCmd(msg) {", start));
  assert.ok(body.includes('case "civitai_results": return h.civitai.getResults'),
    "civitai_results is the shipped read");
  assert.equal(body.includes("fetchModelDetail"), false);
  const shell = await readFile(SHELL, "utf8");
  assert.ok(shell.includes('getResults: (a) => _driveOf("civitai"'),
    "the side-panel facade must still route getResults at the live pane");
});
