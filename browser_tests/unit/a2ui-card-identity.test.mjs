// #832 — a card the agent was just handed must survive a repaint.
//
// `panel_ui_render` returns a `card_id`; `panel_ui_update` names it. A history
// repaint landing between the two — with no user click, no dismissal, no tab
// switch — invalidated that id, because the repaint path was DIFFERENT code from
// the create path: creating produced a live, registered handle, while repainting
// the same record produced an inert clone with a brand-new id and no
// registration.
//
// This file drives the real `renderA2UICard` against a minimal DOM to pin the
// half that is a pure function of its arguments (does an id survive a re-mount?),
// and reads the panel source for the wiring that only exists inside the DOM
// closure. Both matter: an id that can be reused is useless if the repaint path
// does not reuse it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ── minimal DOM ────────────────────────────────────────────────────────────
// Only what the card renderer touches, plus the handful of globals the vendored
// Lit bundle reads at module scope. Deliberately small: a fuller shim would let
// the module rely on behaviour this file does not actually model.
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = { cssText: "" };
    this.dataset = {};
    this.hidden = false;
    this.className = "";
    this._text = "";
    this._listeners = new Map();
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  set textContent(v) { this._text = String(v ?? ""); this.children = []; }
  get textContent() { return this._text; }
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { for (const x of c) this.children.push(x); }
  replaceChildren(...c) { this.children = [...c]; }
  remove() {}
  setAttribute(k, v) { this[k] = v; }
  removeAttribute(k) { delete this[k]; }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
}

globalThis.HTMLElement = class {};
globalThis.Document = class { };
globalThis.Document.prototype.adoptedStyleSheets = [];
globalThis.CSSStyleSheet = class { replaceSync() {} get cssRules() { return []; } };
globalThis.customElements = { define() {}, get() { return undefined; } };
globalThis.document = {
  adoptedStyleSheets: [],
  createElement: (t) => new El(t),
  createElementNS: (_ns, t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  createComment: () => ({ nodeType: 8 }),
  createDocumentFragment: () => new El("#fragment"),
  // The vendored Lit bundle walks a template fragment when the card renders
  // through the Lit adapter. That render is ASYNCHRONOUS and lands after the
  // test that triggered it, so without this it surfaces as an unhandled
  // rejection that fails the file while every assertion passes. Nothing here
  // asserts over Lit's output — the walker only has to terminate.
  createTreeWalker: () => ({ currentNode: null, nextNode: () => null }),
};
globalThis.window = globalThis;

const { renderA2UICard, renderA2UIInert, validateA2UISpec } = await import("../../web/js/cmcp-a2ui.js");

const spec = () =>
  validateA2UISpec({
    root: "c",
    components: [
      { id: "c", type: "Column", children: ["t", "b"] },
      { id: "t", type: "Text", text: "Which sampler?" },
      { id: "b", type: "Button", label: "Euler", reply: "euler" },
    ],
  }).spec;

// ── the id has to be re-usable ─────────────────────────────────────────────

test("a card minted without an id gets a fresh one", () => {
  const a = renderA2UICard(spec(), {});
  const b = renderA2UICard(spec(), {});
  assert.match(a.cardId, /^a2ui-/);
  assert.notEqual(a.cardId, b.cardId, "two independent cards are two cards");
});

test("re-mounting with an id keeps it — the agent's handle survives", () => {
  const first = renderA2UICard(spec(), {});
  const remounted = renderA2UICard(spec(), { cardId: first.cardId });
  assert.equal(remounted.cardId, first.cardId);
  assert.equal(remounted.el.dataset.cardId, first.cardId, "the DOM must agree with the handle");
  assert.notEqual(remounted.el, first.el, "it is a NEW element carrying the SAME identity");
});

test("a blank or non-string id is ignored rather than adopted", () => {
  // An empty id would make every such card collide in the registry.
  for (const cardId of ["", null, undefined, 0, {}, []]) {
    const h = renderA2UICard(spec(), { cardId });
    assert.match(h.cardId, /^a2ui-/, `cardId ${JSON.stringify(cardId)} must not be adopted`);
  }
});

test("a re-mounted card is live — it can still be updated and resolved", () => {
  const first = renderA2UICard(spec(), {});
  const remounted = renderA2UICard(spec(), { cardId: first.cardId });
  assert.equal(remounted.isResolved(), false);
  assert.equal(remounted.update(spec()), true, "an unresolved card accepts an update");
  remounted.resolve("euler");
  assert.equal(remounted.isResolved(), true);
  assert.equal(remounted.update(spec()), false, "a resolved card refuses one");
});

test("renderA2UIInert still produces a resolved, non-interactive card", () => {
  // Unchanged behaviour for records that WERE answered — nothing may answer
  // them twice.
  const el = renderA2UIInert(spec(), "euler");
  assert.ok(el, "inert render still returns an element");
});

// ── the wiring that lives in the DOM closure ───────────────────────────────

const PANEL = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");

test("create and repaint share ONE mount path", () => {
  // Two paths is how they drifted: only one of them registered the card.
  assert.match(PANEL, /function mountLiveA2UICard\(rec\) \{/);
  assert.match(PANEL, /const handle = mountLiveA2UICard\(rec\);/, "appendA2UICard mounts through it");
  assert.match(PANEL, /mountLiveA2UICard\(m\);/, "paintA2UIRecord mounts through it");
});

test("the mount reuses the record's id and writes it back", () => {
  const fn = PANEL.slice(
    PANEL.indexOf("function mountLiveA2UICard"),
    PANEL.indexOf("function appendA2UICard"),
  );
  assert.ok(fn.length > 0, "mountLiveA2UICard must precede appendA2UICard");
  assert.match(fn, /cardId: rec\.cardId/, "a re-mount must pass the existing id");
  assert.match(fn, /rec\.cardId = handle\.cardId;/, "the first mount must persist the minted id");
  assert.match(fn, /liveA2uiCards\.set\(handle\.cardId, \{ handle, rec \}\)/);
});

test("the record is created with its id BEFORE it is persisted", () => {
  // A record persisted without a cardId cannot be re-registered on replay, so
  // the order here is load-bearing rather than stylistic.
  const fn = PANEL.slice(PANEL.indexOf("function appendA2UICard"), PANEL.indexOf("function paintA2UIRecord"));
  assert.ok(fn.indexOf("mountLiveA2UICard(rec)") < fn.indexOf("record(rec)"), "mount, then record");
});

test("an UNRESOLVED record repaints live; a RESOLVED one stays inert", () => {
  const fn = PANEL.slice(PANEL.indexOf("function paintA2UIRecord"), PANEL.indexOf("function setChatSurfaceForCards"));
  assert.match(fn, /if \(m\.resolved\) \{[\s\S]{0,200}renderA2UIInert\(m\.spec, m\.choice\)/);
  assert.match(fn, /mountLiveA2UICard\(m\);/);
});

test("the previous-view guard is untouched — resetFeed still clears the registry", () => {
  // This is what keeps a ui_update naming another thread's card refusing. The
  // fix restores the CURRENT thread's cards; it does not widen the window.
  const fn = PANEL.slice(PANEL.indexOf("function resetFeed"), PANEL.indexOf("function newChat"));
  assert.match(fn, /liveA2uiCards\.clear\(\);/);
});

test("the card surface is recomputed AFTER the replay, not only before it", () => {
  // resetFeed() runs its own setChatSurfaceForCards() against an EMPTY registry.
  // Without a second pass, a repainted unresolved surface:"wide" card would come
  // back live in a narrowed sidebar.
  const fn = PANEL.slice(PANEL.indexOf("function paintThread"), PANEL.indexOf("function resumableSessionId"));
  assert.match(fn, /setChatSurfaceForCards\(\);/);
});
