import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MEDIA_COLLAPSE_KEY,
  MAX_COLLAPSED_ENTRIES,
  mediaCollapseId,
  createMediaCollapseStore,
  MAX_KEYABLE_URL_LENGTH,
} from "../../web/js/lib/media-collapse.js";
import { MAX_MEDIA_URL_LENGTH } from "../../web/js/lib/chat-media.js";

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

test("the id is fixed width whatever the url's size — it cannot bloat storage", () => {
  // The whole point of hashing rather than storing the url: a stored key is 16
  // characters whether the url was 20 or 8,000.
  const tiny = mediaCollapseId("/view?filename=a.png");
  const long = mediaCollapseId(`/view?filename=${"a".repeat(4000)}.png`);
  assert.match(tiny, /^[0-9a-f]{16}$/);
  assert.match(long, /^[0-9a-f]{16}$/);
});

test("a url is not confusable with the string it extends", () => {
  const base = "/view?filename=a.png";
  assert.notEqual(mediaCollapseId(base), mediaCollapseId(`${base}&type=output`));
  const head = "x".repeat(600);
  const tail = "y".repeat(600);
  assert.notEqual(
    mediaCollapseId(`${head}AAAA${tail}`),
    mediaCollapseId(`${head}AAAAA${tail}`),
  );
});

test("same length, same head and tail, different MIDDLE ⇒ different ids (codex)", () => {
  // Head + tail + length alone aliased deterministically for this pair, which
  // for a `data:` URI is not far-fetched: two renders of one size from one
  // encoder share a long header and can share a trailing chunk. Reading the url
  // whole is what separates them.
  const head = "h".repeat(2000);
  const tail = "t".repeat(2000);
  const a = `${head}${"a".repeat(2000)}${tail}`;
  const b = `${head}${"b".repeat(2000)}${tail}`;
  assert.equal(a.length, b.length);
  assert.notEqual(mediaCollapseId(a), mediaCollapseId(b));
});

test("a difference ANYWHERE in a keyable url separates the ids", () => {
  // No sampling, so no gaps: a change at any offset must be visible. An earlier
  // revision sampled fixed windows and a difference landing between two of them
  // keyed identically — for a persisted record that means one media item
  // restoring another's collapse state (codex rounds 2 and 3).
  const pad = "z".repeat(MAX_KEYABLE_URL_LENGTH);
  for (const at of [0, 1, 700, 1300, 2500, 5000, MAX_KEYABLE_URL_LENGTH - 1]) {
    const a = `${pad.slice(0, at)}A${pad.slice(at + 1)}`;
    const b = `${pad.slice(0, at)}B${pad.slice(at + 1)}`;
    assert.equal(a.length, MAX_KEYABLE_URL_LENGTH);
    assert.notEqual(mediaCollapseId(a), mediaCollapseId(b), `differ at index ${at}`);
  }
});

test("the keyable limit clears the panel's own persistable-url ceiling", () => {
  // Every url whose collapse state can outlive the page must be keyable, or the
  // feature quietly stops persisting for long /view links.
  assert.ok(
    MAX_KEYABLE_URL_LENGTH > MAX_MEDIA_URL_LENGTH,
    `keyable ${MAX_KEYABLE_URL_LENGTH} must exceed durable ${MAX_MEDIA_URL_LENGTH}`,
  );
  const long = `/view?filename=${"a".repeat(MAX_MEDIA_URL_LENGTH - 20)}`;
  assert.equal(long.length <= MAX_MEDIA_URL_LENGTH, true);
  assert.ok(mediaCollapseId(long), "a max-length durable url must still key");
});

test("a url too long to key EXACTLY gets no id at all, never an approximate one", () => {
  // A persisted role:"media" message replays without being re-validated, so an
  // imported or legacy history can carry a url no live path would write. Rather
  // than guess which of two such items the user hid, refuse to key it: the store
  // no-ops and the card still toggles for the life of the page.
  const over = "z".repeat(MAX_KEYABLE_URL_LENGTH + 1);
  assert.equal(mediaCollapseId(over), null);
  assert.equal(mediaCollapseId(`data:image/png;base64,${"A".repeat(4_000_000)}`), null);
});

test("an over-limit url costs persistence only — never the toggle", () => {
  const storage = memoryStorage();
  const store = createMediaCollapseStore(storage);
  const over = "z".repeat(MAX_KEYABLE_URL_LENGTH + 1);
  assert.equal(store.setCollapsed(over, true), true, "the caller is told what it asked for");
  assert.equal(store.isCollapsed(over), false, "nothing was remembered");
  assert.equal(storage.values.has(MEDIA_COLLAPSE_KEY), false, "and nothing was written");
});

test("keying a max-length url stays cheap", () => {
  // Bounded by construction now — the limit is the budget.
  const url = "z".repeat(MAX_KEYABLE_URL_LENGTH);
  const started = process.hrtime.bigint();
  for (let i = 0; i < 200; i += 1) mediaCollapseId(url);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 200, `200 max-length keyings took ${ms.toFixed(1)}ms`);
});

test("a multi-megabyte data URI is rejected on LENGTH, without being read", () => {
  // A thread replay paints every card at once, so an O(n) pass over several
  // megabytes per card would be felt. The length check runs before any hashing.
  const huge = `data:image/png;base64,${"A".repeat(8_000_000)}`;
  const started = process.hrtime.bigint();
  assert.equal(mediaCollapseId(huge), null);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `expected an O(1) refusal, took ${ms.toFixed(1)}ms`);
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
  // The rule gained a third selector in #1422: `.cmcp-imgcard-failed` (the #1417
  // failure box) sits in the <img>'s slot, so a failed card must obey the toggle too.
  // `{ display: none; }` now closes the GROUPED rule, so each selector is pinned
  // individually rather than as `selector { display: none; }` pairs.
  assert.match(PANEL, /\.cmcp-imgcard\.cmcp-media-collapsed > img[\s\S]{0,200}display: none/);
  assert.match(PANEL, /\.cmcp-imgcard\.cmcp-media-collapsed > \.cmcp-video-holder,/);
  assert.match(
    PANEL,
    /\.cmcp-imgcard\.cmcp-media-collapsed > \.cmcp-imgcard-failed \{ display: none; \}/,
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

test("the image carries NO inline display — it would outrank the collapsed rule", () => {
  // codex, #818: an inline `display:block` beats any stylesheet selector, so
  // `.cmcp-media-collapsed > img { display: none }` was silently ignored and a
  // collapsed image stayed on screen under its own "hidden" stub. The <img>
  // must take `display` from the stylesheet, where the collapsed rule can win
  // on specificity.
  const painter = PANEL.slice(PANEL.indexOf("function paintImage"), PANEL.indexOf("function videoObserver"));
  const inline = /img\.style\.cssText = "([^"]*)"/.exec(painter);
  assert.ok(inline, "paintImage must still set the image's inline style");
  assert.doesNotMatch(inline[1], /display\s*:/);
  assert.match(PANEL, /\.cmcp-imgcard > img \{ display: block; \}/);
});

test("the video holder carries no inline display either", () => {
  const painter = PANEL.slice(PANEL.indexOf("function paintVideo"), PANEL.indexOf("function paintAudio"));
  const inline = /holder\.style\.cssText =\s*"([^"]*)"/.exec(painter);
  assert.ok(inline, "paintVideo must still set the holder's inline style");
  assert.doesNotMatch(inline[1], /display\s*:/);
});

test("no stray control characters reached the shipped sources", () => {
  // A NUL and a U+0001 both landed inside string literals in this feature's
  // sources during authoring — one of them made git treat the module as binary.
  // They parse, they mostly even behave, and they are invisible in review.
  const files = ["../../web/js/lib/media-collapse.js", "../../web/js/comfyui-mcp-panel.js"];
  for (const rel of files) {
    const s = readFileSync(new URL(rel, import.meta.url), "utf8");
    const at = [...s].findIndex((ch) => {
      const c = ch.charCodeAt(0);
      return c < 9 || (c > 10 && c < 13) || (c > 13 && c < 32);
    });
    assert.equal(at, -1, `${rel} has a control character at index ${at}`);
  }
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
