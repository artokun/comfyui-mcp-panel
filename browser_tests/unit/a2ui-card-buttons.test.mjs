// #1407 — A2UI Card buttons must fire a user message on click.
//
// Buttons rendered by panel_ui_render looked clickable but produced no
// user_message. The Button leaf was mounted through the vendored a2ui/lit
// Shadow DOM (`a2ui-surface`); on ComfyUI frontend 1.49.6 that catalog's
// action callback never runs, so ctx.choose() / onAction never ran.
//
// The shipped path is now a native <button> whose click handler calls
// buttonReplyText + ctx.choose. This file drives that path through
// renderA2UICard (the function panel_ui_render actually calls) against a
// minimal DOM — the same harness as a2ui-card-identity.test.mjs — and
// pins the structural contract that Button is NOT a Lit leaf.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buttonReplyText } from "../../web/js/lib/chat-serialize.js";

// ── minimal DOM ────────────────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = { cssText: "" };
    this.dataset = {};
    this.hidden = false;
    this.className = "";
    this.disabled = false;
    this.type = "";
    this._text = "";
    this._listeners = new Map();
    this.classList = {
      add: (...names) => {
        const set = new Set(String(this.className).split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        this.className = [...set].join(" ");
      },
      remove() {},
      toggle() {},
      contains: (n) => String(this.className).split(/\s+/).includes(n),
    };
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
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    const out = [];
    const walkEl = (el) => {
      for (const c of el.children || []) {
        if (matches(c, sel)) out.push(c);
        walkEl(c);
      }
    };
    walkEl(this);
    return out;
  }
  click() {
    if (this.disabled) return;
    for (const fn of this._listeners.get("click") || []) fn({ type: "click", target: this });
  }
  focus() {}
}

function matches(el, sel) {
  if (sel.startsWith(".")) return String(el.className).split(/\s+/).includes(sel.slice(1));
  return el.tagName === String(sel).toUpperCase();
}

globalThis.HTMLElement = class {};
globalThis.Document = class {};
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
  createTreeWalker: () => ({ currentNode: null, nextNode: () => null }),
};
globalThis.window = globalThis;

const { renderA2UICard, validateA2UISpec } = await import("../../web/js/cmcp-a2ui.js");

const a2uiSrc = readFileSync(fileURLToPath(new URL("../../web/js/cmcp-a2ui.js", import.meta.url)), "utf8");
const adapterSrc = readFileSync(fileURLToPath(new URL("../../web/js/cmcp-a2ui-lit-adapter.js", import.meta.url)), "utf8");

function walk(el, out = []) {
  if (!el) return out;
  out.push(el);
  for (const c of el.children || []) walk(c, out);
  return out;
}

function cardButtons(root) {
  return walk(root).filter((el) => el.tagName === "BUTTON" && String(el.className).split(/\s+/).includes("cmcp-a2ui-btn"));
}

function cardSpec() {
  const r = validateA2UISpec({
    root: "card",
    components: [
      { id: "card", type: "Card", children: ["yes", "no"] },
      { id: "yes", type: "Button", label: "Approve", reply: "approved" },
      { id: "no", type: "Button", label: "Reject", reply: "rejected" },
    ],
  });
  assert.equal(r.ok, true, r.errors?.join("; "));
  return r.spec;
}

function submitSpec() {
  const r = validateA2UISpec({
    root: "col",
    components: [
      { id: "col", type: "Column", children: ["email", "go"] },
      { id: "email", type: "TextField", name: "email", label: "Email", value: "a@b.com" },
      { id: "go", type: "Button", label: "Send", reply: "submit", submit: true },
    ],
  });
  assert.equal(r.ok, true, r.errors?.join("; "));
  return r.spec;
}

function buttonOf(spec, id) {
  return spec.components.find((c) => c.id === id);
}

// ── structure: Button is light-DOM HTML, not a Lit a2ui-surface ───────────

test("#1407 Button is not a Lit leaf — frontend 1.49.6 never fires that action callback", () => {
  // The 1.49.6 failure was the catalog Shadow DOM path. Pinning the native
  // <button> + buttonReplyText/ctx.choose wiring means a re-route through
  // a2ui-surface fails this file before it can ship silent clicks again.
  assert.match(
    a2uiSrc,
    /case "Button": \{\s*\/\/ Native HTML[\s\S]*?document\.createElement\("button"\)/,
  );
  assert.match(a2uiSrc, /ctx\.choose\(btn, buttonReplyText\(c, ctx\.fields\)\)/);
  assert.doesNotMatch(
    a2uiSrc,
    /case "Text":\s*case "Button":\s*case "Divider":/,
    "Button must not share the Lit leaf switch with Text/Divider/Image",
  );
  assert.match(a2uiSrc, /case "Text":\s*case "Divider":\s*case "Image":/);
  assert.doesNotMatch(adapterSrc, /if \(c\.type === "Button"\)/);
  assert.doesNotMatch(adapterSrc, /component: "Button"/);
});

test("#1407 Lit still mounts Text, Divider, and Image", () => {
  assert.match(adapterSrc, /case "Text":/);
  assert.match(adapterSrc, /case "Divider":/);
  assert.match(adapterSrc, /case "Image":/);
});

// ── executable: a click on the shipped card fires onAction ────────────────

test("#1407 clicking a Card Button sends the reply and resolves the card", () => {
  const spec = cardSpec();
  const actions = [];
  const handle = renderA2UICard(spec, { onAction: (t) => actions.push(t) });
  const buttons = cardButtons(handle.el);
  assert.equal(buttons.length, 2, "both Card buttons must be native <button>s at render time");
  assert.equal(walk(handle.el).filter((el) => el.dataset?.a2uiType === "Button").length, 0);

  const approve = buttons.find((b) => b.textContent === buttonOf(spec, "yes").label);
  assert.ok(approve, "the Approve button must be the native control, not a Lit wrapper");
  approve.click();

  assert.deepEqual(actions, [buttonReplyText(buttonOf(spec, "yes"))]);
  assert.equal(handle.isResolved(), true);
  assert.equal(approve.disabled, true);
});

test("#1407 a second click after resolve does not fire again", () => {
  const spec = cardSpec();
  const actions = [];
  const handle = renderA2UICard(spec, { onAction: (t) => actions.push(t) });
  const buttons = cardButtons(handle.el);
  const approve = buttons.find((b) => b.textContent === buttonOf(spec, "yes").label);
  const reject = buttons.find((b) => b.textContent === buttonOf(spec, "no").label);
  approve.click();
  approve.click();
  reject.click();
  assert.deepEqual(actions, [buttonReplyText(buttonOf(spec, "yes"))]);
  assert.equal(handle.isResolved(), true);
});

test("#1407 a submit Button click serializes live field values", () => {
  const spec = submitSpec();
  const actions = [];
  const handle = renderA2UICard(spec, { onAction: (t) => actions.push(t) });
  const inputs = walk(handle.el).filter((el) => el.tagName === "INPUT");
  assert.equal(inputs.length, 1);
  const [btn] = cardButtons(handle.el);
  assert.ok(btn);
  btn.click();
  const field = buttonOf(spec, "email");
  assert.deepEqual(
    actions,
    [buttonReplyText(buttonOf(spec, "go"), [{ name: field.name, read: () => inputs[0].value }])],
  );
});
