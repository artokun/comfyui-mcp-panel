/**
 * #1417 — an image the browser cannot load must SAY so.
 *
 * `panel_show_media` was handed an 18 MB, 2048x2048, 16-bit PNG as a ComfyUI `/view`
 * reference. It replied `ok:true, count:3, painted:3, unconfirmed:0, unrenderable:[]`,
 * and its own probe — run from the ORCHESTRATOR, which is not the thing that has to
 * decode the bytes — reported the reference returned media. The user saw nothing, and
 * asked "where is the image". Nothing anywhere reported a failure.
 *
 * This is #909 for the other half of the media pipeline: that issue gave `<video>` a
 * decode message and left `<img>` silent. What the panel can honestly do is the same —
 * replace the blank with a sentence, and offer the original.
 *
 * Driven against the SHIPPED function, not a copy of it: `paintImageLoadFailure` is
 * lifted out of the monolith with `new Function` and run over a DOM stub, so an error
 * really does have to remove the image and paint the notice. The wiring — that an
 * `<img>` anywhere in the panel is subscribed to it — cannot be reached that way and is
 * pinned at the two call sites instead: a helper nobody calls fixes nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The SHIPPED translator. No catalog is loaded in this process, which is the state `tr`
// is built to survive: every call returns its English fallback, so the assertions below
// read the English the panel actually renders and still fail if that English changes.
import { tr } from "../../web/js/lib/i18n.js";

const PANEL = readFileSync(fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)), "utf8");

function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const bodyOpen = src.indexOf(") {", start);
  if (bodyOpen === -1) return null;
  let depth = 0;
  for (let i = bodyOpen + 2; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return null;
}

// ── the smallest DOM the function touches ──────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = "";
    this.type = "";
    this.textContent = "";
    this._listeners = new Map();
  }
  appendChild(c) {
    return this.insertBefore(c, null);
  }
  get nextSibling() {
    const at = this.parentNode ? this.parentNode.children.indexOf(this) : -1;
    return at > -1 ? (this.parentNode.children[at + 1] ?? null) : null;
  }
  insertBefore(node, ref) {
    node.remove();
    const at = ref == null ? this.children.length : this.children.indexOf(ref);
    assert.notEqual(at, -1, "an insertBefore reference must be a child");
    this.children.splice(at, 0, node);
    node.parentNode = this;
    return node;
  }
  remove() {
    const at = this.parentNode ? this.parentNode.children.indexOf(this) : -1;
    if (at > -1) this.parentNode.children.splice(at, 1);
    this.parentNode = null;
  }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  dispatch(t) {
    for (const fn of this._listeners.get(t) || []) fn({ type: t, target: this, stopPropagation() {} });
  }
}

/** The shipped failure painter over the stub document, plus what it opened. */
function loadPainter() {
  const fn = namedFunctionSource(PANEL, "paintImageLoadFailure");
  assert.ok(fn, "paintImageLoadFailure not found in the panel");
  const opened = [];
  const document = { createElement: (t) => new El(t) };
  const openMediaUrl = (u) => opened.push(u);
  const paint = new Function("document", "tr", "openMediaUrl", `${fn}; return paintImageLoadFailure;`)(
    document,
    tr,
    openMediaUrl,
  );
  return { paint, opened };
}

/** A card shaped like the one paintImage builds: the <img>, then its caption. */
function cardWithImage() {
  const card = new El("div");
  const img = new El("img");
  const caption = new El("div");
  caption.className = "cmcp-media-caption";
  card.appendChild(img);
  card.appendChild(caption);
  return { card, img, caption };
}

const failedBox = (root) => root.children.find((c) => c.className === "cmcp-media-failed");
const textOf = (el) => (el ? el.children.map((c) => c.textContent).join(" | ") : "");

test("#1417 a picture that fails to load is replaced by a sentence, not blank space", () => {
  const { paint } = loadPainter();
  const { card, img } = cardWithImage();
  paint(card, img, { url: "/view?filename=field_360_stereo_OU.png&type=output" });
  assert.equal(card.children.includes(img), false, "the broken <img> must not stay on the card");
  const box = failedBox(card);
  assert.ok(box, "a visible failure state must be painted");
  assert.match(textOf(box), /This image could not be loaded\./);
});

test("#1417 the notice lands WHERE the picture was — above the caption, not after it", () => {
  // The caption carries the filename (composeShowMediaReply falls back to item.filename),
  // so the two lines only read as one statement in this order. Appending would put the
  // message underneath the name it is about.
  const { paint } = loadPainter();
  const { card, img, caption } = cardWithImage();
  paint(card, img, { url: "/view?filename=a.png" });
  assert.equal(card.children.indexOf(failedBox(card)), 0);
  assert.equal(card.children.indexOf(caption), 1);
});

test("#1417 the last thing the panel can do is offered: open the original", () => {
  const { paint, opened } = loadPainter();
  const { card, img } = cardWithImage();
  const url = "/view?filename=field_360_stereo_OU.png&subfolder=stereo360&type=output";
  paint(card, img, { url });
  const btn = failedBox(card).children.find((c) => c.className === "cmcp-media-failed-open");
  assert.ok(btn, "the recovery affordance must exist");
  assert.equal(btn.textContent, "Open original");
  btn.dispatch("click");
  assert.deepEqual(opened, [url], "and it must open the master the card could not draw");
});

test("#1417 the lightbox stage gets the message WITHOUT a second Open original", () => {
  // The lightbox bar already carries that button; repeating it inside the stage is the
  // same control twice, two centimetres apart.
  const { paint } = loadPainter();
  const stage = new El("div");
  const img = new El("img");
  stage.appendChild(img);
  paint(stage, img, { url: "/view?filename=a.png", offerOpen: false });
  assert.match(textOf(failedBox(stage)), /This image could not be loaded\./);
  assert.equal(
    failedBox(stage).children.some((c) => c.className === "cmcp-media-failed-open"),
    false,
  );
});

test("#1417 a TEARDOWN is not a failure — an error from a detached image paints nothing", () => {
  // The lightbox empties its stage on every prev/next, and that fires `error` on the
  // element it just dropped. Painting there would put a failure message over the picture
  // the user actually asked for. The same guard makes a repeat dispatch on an
  // already-replaced image a no-op — one card, one notice.
  const { paint } = loadPainter();
  const { card, img } = cardWithImage();
  img.remove();
  paint(card, img, { url: "/view?filename=a.png" });
  assert.equal(failedBox(card), undefined, "a detached element explains nothing");

  const second = cardWithImage();
  paint(second.card, second.img, { url: "/view?filename=a.png" });
  paint(second.card, second.img, { url: "/view?filename=a.png" });
  assert.equal(second.card.children.filter((c) => c.className === "cmcp-media-failed").length, 1);
});

// ── the wiring: a helper nobody calls fixes nothing ────────────────────────

test("#1417 the chat image card subscribes to its own load failure", () => {
  const painter = namedFunctionSource(PANEL, "paintImage");
  assert.ok(painter, "paintImage not found");
  assert.match(
    painter,
    /img\.addEventListener\("error", \(\) => paintImageLoadFailure\(card, img, \{ url \}\)\);/,
    "paintImage must hand its <img> to the failure painter",
  );
});

test("#1417 the lightbox says it too — prev/next must not land on a silent blank", () => {
  const lightbox = namedFunctionSource(PANEL, "openMediaLightbox");
  assert.ok(lightbox, "openMediaLightbox not found");
  assert.match(
    lightbox,
    /img\.addEventListener\("error", \(\) => paintImageLoadFailure\(mediaWrap, img, \{ url: it\.url, offerOpen: false \}\)\);/,
    "the lightbox image must report its own failure",
  );
});

test("#1417 a collapsed card hides the notice with the picture", () => {
  // Otherwise a hidden card shows its stub AND a failure message underneath — the one
  // card in the log that does not obey the toggle the user just clicked.
  assert.match(PANEL, /\.cmcp-imgcard\.cmcp-media-collapsed > \.cmcp-media-failed \{ display: none; \}/);
});
