import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MEDIA_COLLAPSE_KEY,
  MAX_COLLAPSED_ENTRIES,
  mediaCollapseId,
  createMediaCollapseStore,
} from "../../web/js/lib/media-collapse.js";

// Per-item collapse state for chat media cards (#818). A run that produces a 4K
// still or a 15-second clip renders at full card width in the transcript
// forever; the only existing affordance (⛶) goes the other way. These tests pin
// the store that remembers what the user hid — the identity it keys on, the
// bounds that keep it out of sessionStorage's way, and the degradation when
// storage refuses to play along.

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (k) => (values.has(k) ? values.get(k) : null),
    setItem: (k, v) => values.set(k, v),
  };
}

// ── Identity ───────────────────────────────────────────────────────────────

test("the id is stable for one url and different for another", () => {
  const a = mediaCollapseId("/view?filename=out_00001_.png&type=output");
  assert.equal(a, mediaCollapseId("/view?filename=out_00001_.png&type=output"));
  assert.notEqual(a, mediaCollapseId("/view?filename=out_00002_.png&type=output"));
});

test("the id is fixed width regardless of url size — a data: URI cannot bloat storage", () => {
  const tiny = mediaCollapseId("/view?filename=a.png");
  const huge = mediaCollapseId(`data:image/png;base64,${"A".repeat(4_000_000)}`);
  assert.equal(tiny.length, 16);
  assert.equal(huge.length, 16);
  assert.match(huge, /^[0-9a-f]{16}$/);
});

test("two long urls sharing a head and tail still differ — the length is keyed in", () => {
  // The sampled hash reads only the ends, which is exactly the shape a query
  // string variant takes. Without the length in the key these would collide.
  const head = "x".repeat(600);
  const tail = "y".repeat(600);
  assert.notEqual(
    mediaCollapseId(`${head}AAAA${tail}`),
    mediaCollapseId(`${head}AAAAA${tail}`),
  );
});

test("nothing keyable is null, not a shared bucket every card falls into", () => {
  assert.equal(mediaCollapseId(""), null);
  assert.equal(mediaCollapseId("   "), null);
  assert.equal(mediaCollapseId(null), null);
  assert.equal(mediaCollapseId(undefined), null);
  assert.equal(mediaCollapseId(42), null);
  assert.equal(mediaCollapseId({}), null);
});

test("surrounding whitespace does not mint a second id for one url", () => {
  assert.equal(mediaCollapseId(" /view?filename=a.png "), mediaCollapseId("/view?filename=a.png"));
});

// ── Round trip ─────────────────────────────────────────────────────────────

test("a collapse survives a reload — a fresh store over the same storage agrees", () => {
  const storage = memoryStorage();
  const first = createMediaCollapseStore(storage);
  assert.equal(first.isCollapsed("/view?filename=clip.mp4"), false);
  first.setCollapsed("/view?filename=clip.mp4", true);

  const reloaded = createMediaCollapseStore(storage);
  assert.equal(reloaded.isCollapsed("/view?filename=clip.mp4"), true);
  assert.equal(reloaded.isCollapsed("/view?filename=other.mp4"), false);
});

test("it writes under the panel's namespaced sessionStorage key", () => {
  const storage = memoryStorage();
  createMediaCollapseStore(storage).setCollapsed("/view?filename=a.png", true);
  assert.equal(MEDIA_COLLAPSE_KEY, "comfyui-mcp.panel.collapsedMedia");
  assert.ok(storage.values.has(MEDIA_COLLAPSE_KEY));
  assert.deepEqual(JSON.parse(storage.values.get(MEDIA_COLLAPSE_KEY)), [
    mediaCollapseId("/view?filename=a.png"),
  ]);
});

test("expanding removes the id rather than leaving a tombstone", () => {
  const storage = memoryStorage();
  const store = createMediaCollapseStore(storage);
  store.setCollapsed("/view?filename=a.png", true);
  store.setCollapsed("/view?filename=a.png", false);
  assert.deepEqual(store.ids(), []);
  assert.equal(createMediaCollapseStore(storage).isCollapsed("/view?filename=a.png"), false);
});

test("toggle returns the state now in effect", () => {
  const store = createMediaCollapseStore(memoryStorage());
  assert.equal(store.toggle("/view?filename=a.png"), true);
  assert.equal(store.isCollapsed("/view?filename=a.png"), true);
  assert.equal(store.toggle("/view?filename=a.png"), false);
  assert.equal(store.isCollapsed("/view?filename=a.png"), false);
});

test("collapsing twice does not duplicate the id or churn storage", () => {
  const storage = memoryStorage();
  let writes = 0;
  const counted = { ...storage, setItem: (k, v) => { writes += 1; storage.setItem(k, v); } };
  const store = createMediaCollapseStore(counted);
  store.setCollapsed("/view?filename=a.png", true);
  store.setCollapsed("/view?filename=a.png", true);
  assert.equal(writes, 1);
  assert.deepEqual(store.ids(), [mediaCollapseId("/view?filename=a.png")]);
});

test("expanding something never collapsed writes nothing", () => {
  let writes = 0;
  const store = createMediaCollapseStore({ getItem: () => null, setItem: () => { writes += 1; } });
  assert.equal(store.setCollapsed("/view?filename=a.png", false), false);
  assert.equal(writes, 0);
});

// ── Bounds ─────────────────────────────────────────────────────────────────

test("the remembered list is capped, evicting the OLDEST decision", () => {
  const storage = memoryStorage();
  const store = createMediaCollapseStore({ ...storage, limit: 3 });
  for (const n of [1, 2, 3, 4]) store.setCollapsed(`/view?filename=${n}.png`, true);
  assert.equal(store.ids().length, 3);
  assert.equal(store.isCollapsed("/view?filename=1.png"), false, "oldest evicted");
  assert.equal(store.isCollapsed("/view?filename=4.png"), true, "newest kept");
});

test("an over-cap list already in storage is trimmed on read, newest kept", () => {
  const ids = Array.from({ length: 5 }, (_, i) => mediaCollapseId(`/view?filename=${i}.png`));
  const storage = memoryStorage({ [MEDIA_COLLAPSE_KEY]: JSON.stringify(ids) });
  const store = createMediaCollapseStore({ ...storage, limit: 2 });
  assert.deepEqual(store.ids(), ids.slice(-2));
});

test("the default cap is a real, positive bound", () => {
  assert.ok(Number.isInteger(MAX_COLLAPSED_ENTRIES) && MAX_COLLAPSED_ENTRIES > 0);
});

test("a nonsense limit falls back to the default rather than disabling the store", () => {
  for (const limit of [0, -5, Number.NaN, "many", null]) {
    const store = createMediaCollapseStore({ ...memoryStorage(), limit });
    store.setCollapsed("/view?filename=a.png", true);
    assert.equal(store.isCollapsed("/view?filename=a.png"), true, `limit ${String(limit)}`);
  }
});

// ── Degradation ────────────────────────────────────────────────────────────

test("corrupt stored values are discarded, not repaired into false state", () => {
  for (const raw of ["not json", "{}", '"a"', "null", "17", "[1,2,3]", '[""]']) {
    const store = createMediaCollapseStore(memoryStorage({ [MEDIA_COLLAPSE_KEY]: raw }));
    assert.deepEqual(store.ids(), [], `raw ${raw}`);
  }
});

test("a mixed array keeps its usable ids and drops the junk", () => {
  const good = mediaCollapseId("/view?filename=a.png");
  const store = createMediaCollapseStore(
    memoryStorage({ [MEDIA_COLLAPSE_KEY]: JSON.stringify([good, null, 7, "", good, "b"]) }),
  );
  assert.deepEqual(store.ids(), [good, "b"]);
});

test("a throwing getItem leaves a working, empty store instead of a broken panel", () => {
  const store = createMediaCollapseStore({
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => {},
  });
  assert.equal(store.isCollapsed("/view?filename=a.png"), false);
  assert.equal(store.toggle("/view?filename=a.png"), true);
});

test("a throwing setItem still holds the state for the life of the page", () => {
  // Quota, or a privacy mode. The user clicked collapse; the card must collapse.
  const store = createMediaCollapseStore({
    getItem: () => null,
    setItem: () => { throw new Error("QuotaExceededError"); },
  });
  assert.equal(store.setCollapsed("/view?filename=a.png", true), true);
  assert.equal(store.isCollapsed("/view?filename=a.png"), true);
});

test("no storage at all is a working store, not a throw", () => {
  const store = createMediaCollapseStore();
  assert.equal(store.isCollapsed("/view?filename=a.png"), false);
  assert.equal(store.toggle("/view?filename=a.png"), true);
  assert.equal(store.isCollapsed("/view?filename=a.png"), true);
});

test("an unkeyable url reports the state asked for and persists nothing", () => {
  const storage = memoryStorage();
  const store = createMediaCollapseStore(storage);
  assert.equal(store.setCollapsed("", true), true);
  assert.equal(store.isCollapsed(""), false, "nothing to remember it by");
  assert.equal(storage.values.has(MEDIA_COLLAPSE_KEY), false);
});

test("ids() hands out a copy — a caller cannot mutate the store's list", () => {
  const store = createMediaCollapseStore(memoryStorage());
  store.setCollapsed("/view?filename=a.png", true);
  store.ids().push("injected");
  assert.equal(store.ids().length, 1);
});

// ── The panel wiring these tests cannot reach directly ─────────────────────
// attachMediaCollapse lives in the DOM closure. These assert the specific
// couplings whose absence would silently un-fix #818 — each one is a decision
// argued in that function's comment, and a regression would look like working
// code.

const PANEL = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

test("both media painters attach the collapse control", () => {
  for (const kind of ["image", "video"]) {
    assert.match(
      PANEL,
      new RegExp(`attachMediaCollapse\\(card, \\{[\\s\\S]{0,120}kind: "${kind}"`),
      `${kind} cards must be collapsible`,
    );
  }
});

test("collapsing a video releases the decoded element, and never mounts one", () => {
  // Collapsed media is display:none, so the observer would unmount it anyway;
  // this makes a hidden clip stop now rather than a frame later. The inverse —
  // calling mountHolderVideo on expand — would resurrect a live <video> for a
  // card scrolled off-screen, which is the observer fight the issue warned of.
  assert.match(PANEL, /onCollapse: \(\) => unmountHolderVideo\(holder\)/);
  const fn = PANEL.slice(
    PANEL.indexOf("function attachMediaCollapse"),
    PANEL.indexOf("function paintImage"),
  );
  assert.ok(fn.length > 0, "attachMediaCollapse must precede paintImage");
  // \b excludes "unmountHolderVideo" — "n" and "m" are both word characters, so
  // the boundary only matches a bare `mountHolderVideo` call.
  assert.doesNotMatch(fn, /\bmountHolderVideo\b/);
});

test("the store is wired to sessionStorage, not localStorage", () => {
  // "For the session" was the owner's decision on the issue: a collapse from
  // last week must not follow someone into a new browser session.
  assert.match(PANEL, /createMediaCollapseStore\(\{ getItem: ssGet, setItem: ssSet \}\)/);
});

test("collapse state is applied at paint time so a replayed card comes back hidden", () => {
  // paintThread replays stored media through paintImage/paintVideo, so applying
  // the state inside attachMediaCollapse is what makes reload + thread switch
  // work without a second restore path that can drift from this one.
  assert.match(PANEL, /apply\(mediaCollapse\.isCollapsed\(url\)\)/);
});

test("collapsed cards hide the media element itself, and hide the ⛶ with it", () => {
  assert.match(PANEL, /\.cmcp-imgcard\.cmcp-media-collapsed > img[\s\S]{0,120}display: none/);
  assert.match(
    PANEL,
    /\.cmcp-imgcard\.cmcp-media-collapsed > \.cmcp-video-holder \{ display: none; \}/,
  );
  assert.match(
    PANEL,
    /\.cmcp-imgcard\.cmcp-media-collapsed \.cmcp-media-expand \{ display: none; \}/,
  );
});

test("a collapsed card's toggle is not hover-gated — the way back must be visible", () => {
  assert.match(
    PANEL,
    /\.cmcp-imgcard\.cmcp-media-collapsed \.cmcp-media-collapse \{ opacity: 1; \}/,
  );
  assert.match(PANEL, /\.cmcp-imgcard\.cmcp-media-collapsed \.cmcp-media-stub \{ display: flex; \}/);
});

test("a collapsed card does not print its filename twice", () => {
  // The stub names the file, so the caption under it would repeat it. Both
  // media painters must therefore tag their caption for the rule to reach it.
  assert.match(
    PANEL,
    /\.cmcp-imgcard\.cmcp-media-collapsed \.cmcp-media-caption \{ display: none; \}/,
  );
  assert.equal(
    (PANEL.match(/cap\.className = "cmcp-media-caption";/g) || []).length,
    2,
    "both the image and the video painter must tag their caption",
  );
});

test("the control cluster does not eat clicks meant for a click-to-zoom image", () => {
  assert.match(PANEL, /\.cmcp-media-tools \{ pointer-events: none; \}/);
  assert.match(PANEL, /\.cmcp-media-tools > button \{ pointer-events: auto; \}/);
});
