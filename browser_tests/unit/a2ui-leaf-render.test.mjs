// #1854 — the A2UI leaf adapter renders Text/Divider/Image as plain DOM,
// SYNCHRONOUSLY.
//
// These assertions would all have FAILED against the previous implementation,
// and that is the point of the file. That version returned an empty
// span.cmcp-a2ui-lit-leaf immediately and populated it only after a dynamic
// import of the 234 KB vendored @a2ui/lit bundle resolved — so a leaf was
// briefly blank, a repaint in that window needed a stale-mount guard, and
// nothing in the suite noticed because no test asserted leaf CONTENT.
//
// The old suite passing over an empty span is exactly why this file exists.

import { test } from "node:test";
import assert from "node:assert/strict";

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = "";
    this.textContent = "";
    this.src = "";
    this.alt = "";
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
}
globalThis.document = { createElement: (t) => new El(t) };

const { mountA2uiLeaf, mountStandardComponent } = await import(
  "../../web/js/cmcp-a2ui-lit-adapter.js"
);

test("#1854: Text renders its text synchronously into the leaf wrapper", () => {
  const el = mountA2uiLeaf({ type: "Text", text: "hello world" });
  assert.equal(el.tagName, "SPAN");
  assert.equal(el.className, "cmcp-a2ui-lit-leaf");
  assert.equal(el.dataset.a2uiType, "Text");
  // The whole point: content is present on return, not after a microtask.
  assert.equal(el.textContent, "hello world");
});

test("#1854: Text with a non-string body renders empty rather than 'undefined'", () => {
  assert.equal(mountA2uiLeaf({ type: "Text" }).textContent, "");
  assert.equal(mountA2uiLeaf({ type: "Text", text: 42 }).textContent, "");
});

test("#1854: Divider renders an hr inside the wrapper", () => {
  const el = mountA2uiLeaf({ type: "Divider" });
  assert.equal(el.dataset.a2uiType, "Divider");
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].tagName, "HR");
});

test("#1854: Image renders an img carrying src, with caption as alt", () => {
  const el = mountA2uiLeaf({ type: "Image", src: "/view?filename=a.png", caption: "a cat" });
  assert.equal(el.dataset.a2uiType, "Image");
  assert.equal(el.children.length, 1);
  const img = el.children[0];
  assert.equal(img.tagName, "IMG");
  assert.equal(img.src, "/view?filename=a.png");
  assert.equal(img.alt, "a cat");
});

test("#1854: Image without a caption still gets an explicit empty alt", () => {
  // Never the string "undefined", which a screen reader would announce.
  const img = mountA2uiLeaf({ type: "Image", src: "blob:x" }).children[0];
  assert.equal(img.alt, "");
});

test("#1854: an unmapped leaf type throws rather than rendering something wrong", () => {
  assert.throws(() => mountA2uiLeaf({ type: "Button", label: "no" }), /unmapped leaf type Button/);
});

test("#1854: mountStandardComponent is the same entry point cmcp-a2ui.js calls", () => {
  const el = mountStandardComponent({ type: "Text", text: "via entry point" });
  assert.equal(el.textContent, "via entry point");
});
