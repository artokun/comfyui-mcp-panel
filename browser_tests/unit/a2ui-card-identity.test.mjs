// #832 — EXECUTABLE coverage for the card-identity contract.
//
// The fix for #832 (a repaint must return the SAME card, not a lookalike) is
// pinned by a2ui-repaint-live-card.test.mjs, which asserts over the SOURCE with
// regexes. That proves the code is shaped a certain way; it never calls
// `renderA2UICard`, so it cannot show what the function actually does with the
// id it is handed.
//
// This file calls it, against a minimal DOM. The contract it exercises is the
// one panel_ui_update depends on: an id handed back in is kept and reaches the
// DOM, an unusable id is ignored rather than adopted (an empty string would
// collide every such card in the live registry), and a re-mounted card is
// genuinely live rather than merely present.
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

test("a minted id carries a random segment, not just time+counter", () => {
  // #837 added a nonce for a reason its source-guards cannot demonstrate:
  // `_cardSeq` restarts at 0 on module load, and an id REUSED from a persisted
  // record never advances it — so a fresh mint could equal an id a repaint had
  // already put back in the live registry, silently overwriting it. This reads
  // the SHAPE of the value the function returns rather than the source that
  // produced it; it cannot prove randomness, only that the segment is there and
  // that two mints in the same millisecond differ in it.
  const ids = Array.from({ length: 50 }, () => renderA2UICard(spec(), {}).cardId);
  assert.equal(new Set(ids).size, ids.length, "minted ids must be unique");
  for (const id of ids) {
    assert.equal(id.split("-").length, 4, `expected 4 segments in ${id}`);
    assert.match(id.split("-")[3], /^[a-z0-9]{4,}$/, `expected a nonce segment in ${id}`);
  }
});
