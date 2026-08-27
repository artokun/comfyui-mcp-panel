// #1958 — CivitAI browser surface: Upscaler must be a reachable tab, sample
// URLs must be orchestrator-fetchable, open/clear receipts must echo state.
//
// Three QA gaps on 0.15.114. Tests fail on the unfixed gaps and pass on the
// shipped helpers + wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CIVITAI_TAB_DEFS,
  CIVITAI_UNTABBED_TYPES,
  civitaiTabCatalog,
  civitaiTypeNote,
  civitaiUnseenTypes,
  civitaiVisibleType,
  resolveCivitaiTab,
  summarizeClearHighlight,
  summarizeOpenCivitai,
} from "../../web/js/lib/civitai-tabs.js";
import {
  CIVITAI_MEDIA_PROXY_PATH,
  civitaiPageUrl,
  civitaiProxyMediaPath,
  normalizeCivitaiResultUrls,
} from "../../web/js/lib/civitai-sample-urls.js";
import { serializeCivitaiResults } from "../../web/js/cmcp-civitai-ui.js";

const uiSrc = () => readFile(new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url), "utf8");
const panelSrc = () => readFile(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

// ── 1. Upscaler (and Poses / Embeddings) are real tabs ─────────────────────

test("#1958 upscalers tab maps to CivitAI type Upscaler", () => {
  const up = CIVITAI_TAB_DEFS.find((t) => t.key === "upscalers");
  assert.ok(up, "upscalers must be a tab — otherwise every search looks like total:0");
  assert.equal(up.model, "Upscaler");
  assert.equal(civitaiVisibleType("upscalers"), "Upscaler");
  assert.equal(resolveCivitaiTab("upscaler"), "upscalers", "singular alias must land");
  assert.equal(resolveCivitaiTab("Upscaler"), "upscalers");
});

test("#1958 embeddings and poses tabs exist too", () => {
  assert.equal(civitaiVisibleType("embeddings"), "TextualInversion");
  assert.equal(resolveCivitaiTab("textualinversion"), "embeddings");
  assert.equal(civitaiVisibleType("poses"), "Poses");
  assert.equal(resolveCivitaiTab("pose"), "poses");
});

test("#1958 catalog lists every pane tab the UI can switch to", () => {
  const keys = civitaiTabCatalog().map((t) => t.key);
  for (const need of ["images", "videos", "checkpoints", "loras", "upscalers", "embeddings", "poses", "workflows", "favorites"]) {
    assert.ok(keys.includes(need), `catalog missing ${need}`);
  }
});

test("#1958 unknown tab keys are refused, not silently remapped", () => {
  assert.equal(resolveCivitaiTab("nope"), null);
  assert.equal(resolveCivitaiTab(""), null);
  assert.equal(resolveCivitaiTab(undefined), null);
});

test("#1958 a checkpoints empty grid names Upscaler as unseen", () => {
  const note = civitaiTypeNote({ tab: "checkpoints", total: 0, error: null, loading: false });
  assert.match(note, /Checkpoint/);
  assert.match(note, /Upscaler \(tab: upscalers\)/);
  assert.match(note, /TextualInversion \(tab: embeddings\)/);
  assert.match(note, /Poses \(tab: poses\)/);
  assert.match(note, /NOT evidence/i);
  assert.ok(civitaiUnseenTypes("checkpoints").includes("Upscaler"));
  assert.ok(CIVITAI_UNTABBED_TYPES.includes("VAE"));
});

test("#1958 typeNote is omitted when the grid is not an empty success", () => {
  assert.equal(civitaiTypeNote({ tab: "checkpoints", total: 3, error: null, loading: false }), undefined);
  assert.equal(civitaiTypeNote({ tab: "checkpoints", total: 0, error: { status: 503 }, loading: false }), undefined);
  assert.equal(civitaiTypeNote({ tab: "checkpoints", total: 0, error: null, loading: true }), undefined);
});

test("WIRING: TABS in the UI include upscalers/embeddings/poses", async () => {
  const src = await uiSrc();
  const start = src.indexOf("\nconst TABS = ");
  assert.notEqual(start, -1);
  const rest = src.slice(start + 1);
  const endRel = rest.search(/\nconst SUBFOLDER = /);
  const block = endRel === -1 ? rest.slice(0, 2000) : rest.slice(0, endRel);
  for (const key of ["upscalers", "embeddings", "poses"]) {
    assert.match(block, new RegExp(`key: "${key}"`), `TABS must declare ${key}`);
  }
  assert.match(block, /model: "Upscaler"/);
  assert.match(block, /model: "TextualInversion"/);
  assert.match(block, /model: "Poses"/);
  // i18n getters — a bare label: would freeze English at import.
  assert.match(block, /get label\(\) \{ return tr\("civitai_ui\.upscalers"/);
});

test("WIRING: driveSwitchTab resolves aliases via resolveCivitaiTab", async () => {
  const src = await uiSrc();
  const body = src.slice(src.indexOf("function driveSwitchTab"));
  const fn = body.slice(0, body.indexOf("async function driveSearch"));
  assert.match(fn, /resolveCivitaiTab\(key\)/);
  assert.match(fn, /known:/);
});

// ── 2. Sample URLs the orchestrator can actually fetch ─────────────────────

test("#1958 api.apiURL-prefixed proxy paths collapse to the exact media route", () => {
  const q = "uuid=abc&transform=width%3D450&ext=jpeg";
  const want = `${CIVITAI_MEDIA_PROXY_PATH}?${q}`;
  assert.equal(
    civitaiProxyMediaPath(`/api/comfyui_mcp_panel/civitai/media?${q}`),
    want,
  );
  assert.equal(
    civitaiProxyMediaPath(`http://127.0.0.1:8188/api/comfyui_mcp_panel/civitai/media?${q}`),
    want,
  );
  assert.equal(
    civitaiProxyMediaPath(`http://127.0.0.1:8188/comfyui_mcp_panel/civitai/media?${q}`),
    want,
  );
  assert.equal(civitaiProxyMediaPath(want), want);
});

test("#1958 non-proxy thumbs pass through so existing urls stay intact", () => {
  assert.equal(civitaiProxyMediaPath("/proxy/thumb/101.jpeg"), "/proxy/thumb/101.jpeg");
  assert.equal(civitaiProxyMediaPath(""), null);
  assert.equal(civitaiProxyMediaPath(null), null);
});

test("#1958 protocol-relative and backslash URLs are not rewritten into a fetchable path", () => {
  // The orchestrator refuses these for SSRF. Rewriting them into the proxy
  // path would launder a hostile URL into a same-origin fetch.
  assert.equal(civitaiProxyMediaPath("//evil.example/x"), null);
  assert.equal(civitaiProxyMediaPath("/\\evil.example/x"), null);
});

test("#1958 serializeCivitaiResults emits fetchable proxy paths + a civitai.com pageUrl", () => {
  const q = "uuid=a&ext=jpeg";
  const out = serializeCivitaiResults(
    [{
      id: 42, name: "ESRGAN 4x", creator: "x", type: "Upscaler",
      coverUrl: `http://127.0.0.1:8188/api/comfyui_mcp_panel/civitai/media?${q}`,
    }],
    { model: true },
  );
  assert.deepEqual(out.items[0].urls, [`${CIVITAI_MEDIA_PROXY_PATH}?${q}`]);
  assert.equal(out.items[0].pageUrl, "https://civitai.com/models/42");
  assert.equal(out.items[0].gated, false);
});

test("#1958 pageUrl is the public civitai.com page, not a proxy thumb", () => {
  assert.equal(civitaiPageUrl({ kind: "model", id: 5 }), "https://civitai.com/models/5");
  assert.equal(civitaiPageUrl({ kind: "image", id: 101 }), "https://civitai.com/images/101");
  assert.equal(civitaiPageUrl({ kind: "video", id: 102 }), "https://civitai.com/images/102");
  assert.equal(civitaiPageUrl({ kind: "model", id: null }), null);
});

test("#1958 gated:false + proxy thumb is the shape the orchestrator will fetch", () => {
  // Regression for the QA: images:2, gated:false, and still no IMAGE blocks —
  // because urls[0] was an origin+/api URL the orchestrator skipped.
  const urls = normalizeCivitaiResultUrls([
    "http://127.0.0.1:8188/api/comfyui_mcp_panel/civitai/media?uuid=a&ext=jpeg",
    "http://127.0.0.1:8188/api/comfyui_mcp_panel/civitai/media?uuid=a&ext=jpeg&full=1",
  ]);
  assert.equal(urls[0].startsWith("/"), true);
  assert.equal(urls[0].startsWith("/comfyui_mcp_panel/civitai/media?"), true);
  assert.equal(urls[0].includes("/api/"), false);
});

test("WIRING: serializeCivitaiResults actually calls the URL helpers", async () => {
  const src = await uiSrc();
  const fn = src.slice(src.indexOf("export function serializeCivitaiResults"));
  const body = fn.slice(0, fn.indexOf("export function civitaiErrorState"));
  assert.match(body, /normalizeCivitaiResultUrls\(/);
  assert.match(body, /civitaiPageUrl\(\{ kind/);
});

// ── 3. open / clear echo state ─────────────────────────────────────────────

test("#1958 open receipt echoes tab/query/docked/filters, not a bare ok", () => {
  const r = summarizeOpenCivitai({
    tab: "upscalers",
    query: "ESRGAN",
    filters: { modelSort: "Most Downloaded", browsingLevels: [1, 2] },
    docked: true,
    renderRev: 3,
  });
  assert.equal(r.ok, true);
  assert.equal(r.tab, "upscalers");
  assert.equal(r.query, "ESRGAN");
  assert.equal(r.docked, true);
  assert.equal(r.visibleType, "Upscaler");
  assert.equal(r.filters.modelSort, "Most Downloaded");
  assert.deepEqual(r.filters.browsingLevels, [1, 2]);
  assert.equal(r.sortApplied, false, "keyword search cannot honour modelSort");
  assert.ok(r.tabs.some((t) => t.key === "upscalers" && t.type === "Upscaler"));
});

test("#1958 open receipt copies browsingLevels rather than aliasing live state", () => {
  const live = [1, 2];
  const r = summarizeOpenCivitai({ tab: "loras", query: "", browsingLevels: live, docked: false });
  live.push(8);
  assert.deepEqual(r.filters.browsingLevels, [1, 2]);
  assert.equal(r.docked, false);
});

test("#1958 clear-highlight receipt reports how many ids were cleared", () => {
  assert.deepEqual(summarizeClearHighlight({ cleared: 3, renderRev: 9 }), {
    ok: true, cleared: 3, renderRev: 9,
  });
  assert.equal(summarizeClearHighlight({}).cleared, 0);
  assert.equal(summarizeClearHighlight({ cleared: -1 }).cleared, 0);
});

test("WIRING: driveClearHighlight returns summarizeClearHighlight (not a bare ok)", async () => {
  const src = await uiSrc();
  const body = src.slice(src.indexOf("function driveClearHighlight"));
  const fn = body.slice(0, body.indexOf("function driveOpenLightbox"));
  assert.match(fn, /summarizeClearHighlight\(\{ cleared/);
  assert.match(fn, /const cleared = state\.highlightOrder\.length/);
  assert.equal(fn.includes("return { ok: true }"), false, "bare {ok:true} is the #1958 gap");
});

test("WIRING: driveGetResults attaches typeNote on an empty grid", async () => {
  const src = await uiSrc();
  const body = src.slice(src.indexOf("async function driveGetResults"));
  const fn = body.slice(0, body.indexOf("async function driveHighlight"));
  assert.match(fn, /civitaiTypeNote\(\{/);
  assert.match(fn, /unseenTypes: civitaiUnseenTypes\(state\.tab\)/);
  assert.match(fn, /tabs: civitaiTabCatalog\(\)/);
});

test("WIRING: open_civitai echos getState instead of a bare {ok:true}", async () => {
  const src = await panelSrc();
  // The HANDLER (object method), not the dispatcher `onOpenCivitai(msg) || {ok:true}`.
  const i = src.indexOf("onOpenCivitai(msg) {");
  assert.notEqual(i, -1, "handler must still be the object method onOpenCivitai(msg) {");
  const body = src.slice(i, src.indexOf("onCivitaiCmd(msg)", i));
  assert.match(body, /civitai\?\.getState/);
  assert.match(body, /return \{ ok: true, \.\.\.st \}/);
  // The old receipt — a lone `{ ok: true }` with no applied state — must not
  // still be the success path.
  assert.equal(
    /^\s*return \{ ok: true \};\s*$/m.test(body),
    false,
    "onOpenCivitai must not still return a bare {ok:true}",
  );
});

test("WIRING: driveGetState echoes query/filters/tabs like search does", async () => {
  const src = await uiSrc();
  const body = src.slice(src.indexOf("function driveGetState"));
  const fn = body.slice(0, body.indexOf("function driveClose"));
  assert.match(fn, /query: state\.query/);
  assert.match(fn, /summarizeSearchFilters\(\{/);
  assert.match(fn, /tabs: civitaiTabCatalog\(\)/);
});
