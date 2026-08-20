// #1467 — pasted chat text silently dropped before reaching the agent.
//
// Two silent content-loss paths on the composer, tested at two different depths.
//
// The paste handler is exercised as SHIPPED: its listener is sliced out of the
// panel source and evaluated against doubles, so these tests fail if the routing
// decision is reverted, and they cannot pass against a copy of the handler that
// no longer exists. The decision itself lives in web/js/lib/composer-paste.js and
// is tested directly for the cases a DOM cannot reach cheaply.
//
// The orphaned-token guard sits inside the 250-line submit handler, which cannot
// be rebuilt in a synthetic scope; it is pinned at the source level instead —
// including its ORDER relative to resetAttachments(), because a guard that reads
// the registry after it is cleared reports every token as orphaned.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PASTE_TEXT_THRESHOLD,
  PASTE_TEXT_LINE_THRESHOLD,
  isLargePaste,
  planComposerPaste,
  orphanAttachmentTokens,
} from "../../web/js/lib/composer-paste.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// The shipped paste listener, rebuilt against doubles.
// ---------------------------------------------------------------------------

/** Slice the composer's `paste` listener out of the panel source. */
function shippedPasteListenerSource() {
  const open = `input.addEventListener("paste", (ev) => {`;
  const start = PANEL_SRC.indexOf(open);
  assert.notEqual(start, -1, "the composer's paste listener is no longer findable — update this harness");
  const close = "\n  });";
  const end = PANEL_SRC.indexOf(close, start);
  assert.notEqual(end, -1, "the paste listener's end is no longer findable — update this harness");
  return PANEL_SRC.slice(start, end + close.length);
}

/**
 * Run the SHIPPED listener over one synthetic clipboard and report what it did.
 * Every collaborator is a double, so the only real logic under test is the
 * handler's own routing plus the real planComposerPaste it calls.
 */
function runShippedPaste({ file = null, text = "" }) {
  const calls = { handleFile: [], handlePastedText: [], insertAtCaret: [], prevented: 0, stopped: 0 };
  let listener = null;
  const input = {
    addEventListener(type, fn) {
      if (type === "paste") listener = fn;
    },
  };
  // eslint-disable-next-line no-new-func -- the point is to run the shipped source
  const register = new Function(
    "input",
    "handleFile",
    "handlePastedText",
    "insertAtCaret",
    "planComposerPaste",
    shippedPasteListenerSource(),
  );
  register(
    input,
    (f) => calls.handleFile.push(f),
    (t) => calls.handlePastedText.push(t),
    (t) => calls.insertAtCaret.push(t),
    planComposerPaste,
  );
  assert.ok(listener, "the sliced source did not register a paste listener");
  listener({
    clipboardData: {
      items: file ? [{ kind: "file", getAsFile: () => file }] : [{ kind: "string" }],
      getData: (fmt) => (fmt === "text/plain" ? text : ""),
    },
    preventDefault() {
      calls.prevented += 1;
    },
    stopPropagation() {
      calls.stopped += 1;
    },
  });
  return calls;
}

const BIG = "prompt line that goes on and on. ".repeat(40); // ~1.3 KB, like the report

test("#1467 a clipboard carrying BOTH a file and a large text keeps the text", () => {
  const file = { name: "image.png", type: "image/png" };
  const calls = runShippedPaste({ file, text: BIG });
  // The regression: the file branch called preventDefault() and returned, so the
  // text was discarded AND the browser's own insertion was suppressed.
  assert.deepEqual(calls.handlePastedText, [BIG]);
  assert.deepEqual(calls.handleFile, [file]);
  assert.equal(calls.prevented, 1);
  assert.equal(calls.stopped, 1);
});

test("#1467 a clipboard carrying a file and a SHORT text still places the text", () => {
  const file = { name: "image.png", type: "image/png" };
  const calls = runShippedPaste({ file, text: "a red car" });
  assert.deepEqual(calls.insertAtCaret, ["a red car"], "short text must be inserted by hand — default is suppressed");
  assert.deepEqual(calls.handleFile, [file]);
  assert.deepEqual(calls.handlePastedText, []);
});

test("#1467 a screenshot paste (file, no text) is unchanged", () => {
  const file = { name: "image.png", type: "image/png" };
  const calls = runShippedPaste({ file, text: "" });
  assert.deepEqual(calls.handleFile, [file]);
  assert.deepEqual(calls.insertAtCaret, []);
  assert.deepEqual(calls.handlePastedText, []);
  assert.equal(calls.prevented, 1, "the composer still claims a pasted file");
  assert.equal(calls.stopped, 1, "#384 — and still keeps it from ComfyUI's canvas paste handler");
});

test("#1467 a large text paste with no file still collapses to a chip", () => {
  const calls = runShippedPaste({ text: BIG });
  assert.deepEqual(calls.handlePastedText, [BIG]);
  assert.deepEqual(calls.handleFile, []);
  assert.equal(calls.prevented, 1);
  assert.equal(calls.stopped, 1, "#384 — a large paste must not reach ComfyUI's canvas paste handler");
});

test("#1467 a small text paste with no file is left entirely to the browser", () => {
  const calls = runShippedPaste({ text: "hello" });
  assert.equal(calls.prevented, 0, "claiming this event would suppress the insertion nothing replaces");
  assert.equal(calls.stopped, 0);
  assert.deepEqual(calls.handlePastedText, []);
  assert.deepEqual(calls.insertAtCaret, []);
  assert.deepEqual(calls.handleFile, []);
});

test("#1467 an item that reports kind:file but yields no File falls back to the text route", () => {
  const calls = runShippedPaste({ file: null, text: BIG });
  assert.deepEqual(calls.handleFile, []);
  assert.deepEqual(calls.handlePastedText, [BIG]);
});

// ---------------------------------------------------------------------------
// The decision itself.
// ---------------------------------------------------------------------------

test("#1467 planComposerPaste never answers with a flavour it discards", () => {
  const flavours = [
    { hasFile: false, text: "" },
    { hasFile: false, text: "short" },
    { hasFile: false, text: BIG },
    { hasFile: true, text: "" },
    { hasFile: true, text: "short" },
    { hasFile: true, text: BIG },
  ];
  for (const c of flavours) {
    const plan = planComposerPaste(c);
    assert.equal(plan.file, c.hasFile, `the file must survive ${JSON.stringify(c.text.slice(0, 8))}`);
    if (c.text) {
      assert.notEqual(plan.text, "none", "text present but the plan places none of it");
      // "default" means the browser inserts it; every other answer places it here.
      assert.ok(["attach", "insert", "default"].includes(plan.text));
    }
    // The one answer that leaves the event alone must not be paired with a claim.
    if (plan.text === "default") assert.equal(plan.file, false);
  }
});

test("#1467 isLargePaste is long OR tall, and the thresholds are exclusive/inclusive as stated", () => {
  assert.equal(isLargePaste("x".repeat(PASTE_TEXT_THRESHOLD)), false, "exactly the threshold is not over it");
  assert.equal(isLargePaste("x".repeat(PASTE_TEXT_THRESHOLD + 1)), true);
  assert.equal(isLargePaste("a\n".repeat(PASTE_TEXT_LINE_THRESHOLD - 1)), false);
  assert.equal(isLargePaste("a\n".repeat(PASTE_TEXT_LINE_THRESHOLD)), true, "a tall paste collapses however short");
  assert.equal(isLargePaste(""), false);
  assert.equal(isLargePaste(undefined), false);
});

// ---------------------------------------------------------------------------
// Orphaned attachment tokens.
// ---------------------------------------------------------------------------

test("#1467 a token whose attachment is still registered is not orphaned", () => {
  const atts = [{ id: 1, kind: "text", content: "…" }];
  assert.deepEqual(orphanAttachmentTokens("[Pasted text #1] can you read this?", atts), []);
});

test("#1467 a recalled message whose registry was cleared names its dead tokens", () => {
  // ↑ history recall / ✎ edit / double-Esc rewind hand back the RAW text after
  // resetAttachments() has emptied the registry.
  assert.deepEqual(orphanAttachmentTokens("[Pasted text #1] can you read this?", []), ["[Pasted text #1]"]);
});

test("#1467 an id alone never resolves a token — kind and id must both match", () => {
  const atts = [{ id: 1, kind: "image", name: "a.png" }];
  assert.deepEqual(orphanAttachmentTokens("[Image #1] [Pasted text #1]", atts), ["[Pasted text #1]"]);
});

test("#1467 every attachment kind's token is recognised", () => {
  const text = "[Image #1] [Pasted text #2] [Video #3] [File #4] [Workflow #5]";
  assert.deepEqual(orphanAttachmentTokens(text, []), [
    "[Image #1]",
    "[Pasted text #2]",
    "[Video #3]",
    "[File #4]",
    "[Workflow #5]",
  ]);
  const live = [
    { id: 1, kind: "image" },
    { id: 2, kind: "text" },
    { id: 3, kind: "video" },
    { id: 4, kind: "textfile" },
    { id: 5, kind: "workflow" },
  ];
  assert.deepEqual(orphanAttachmentTokens(text, live), []);
  // `file` (an unknown binary uploaded into input/) also carries a [File #N] token.
  assert.deepEqual(orphanAttachmentTokens("[File #4]", [{ id: 4, kind: "file" }]), []);
});

test("#1467 a repeated dead token is reported once, and a clean message reports nothing", () => {
  assert.deepEqual(orphanAttachmentTokens("[Pasted text #1] and again [Pasted text #1]", []), ["[Pasted text #1]"]);
  assert.deepEqual(orphanAttachmentTokens("just a normal question", []), []);
});

test("#1467 the token scan does not carry lastIndex between calls", () => {
  const text = "[Pasted text #1] tail";
  assert.deepEqual(orphanAttachmentTokens(text, []), ["[Pasted text #1]"]);
  assert.deepEqual(orphanAttachmentTokens(text, []), ["[Pasted text #1]"], "a shared global regex would return []");
});

// ---------------------------------------------------------------------------
// Wiring — the guard exists AND the send path reaches it, in the right order.
// ---------------------------------------------------------------------------

test("#1467 the panel imports the paste plan and the orphan scan", () => {
  assert.match(
    PANEL_SRC,
    /import \{ planComposerPaste, orphanAttachmentTokens \} from "\.\/lib\/composer-paste\.js";/,
    "the composer-paste import is gone — the helpers below are then dead code",
  );
});

test("#1467 the submit path scans for orphaned tokens BEFORE the registry is cleared", () => {
  const scan = PANEL_SRC.indexOf("const orphanedTokens = orphanAttachmentTokens(text, attachments);");
  assert.notEqual(scan, -1, "the submit path no longer scans for orphaned attachment tokens");
  const reset = PANEL_SRC.indexOf("resetAttachments();", scan);
  assert.notEqual(reset, -1, "resetAttachments() no longer follows the scan in the submit path");
  assert.ok(scan < reset, "reading the registry after it is cleared reports EVERY token as orphaned");
  // And the finding is surfaced rather than counted and dropped.
  const warn = PANEL_SRC.indexOf("panel.attachment_content_no_longer_loaded");
  assert.ok(warn > scan, "the orphaned tokens are never told to the user");
  assert.match(PANEL_SRC.slice(scan, warn + 400), /appendSystem\(/, "the warning is not appended to the chat");
});

test("#1467 the paste handler no longer returns out of the file branch", () => {
  const listener = shippedPasteListenerSource();
  assert.doesNotMatch(
    listener,
    /handleFile\(file\);\s*\n\s*return;/,
    "an early return after handleFile() is exactly the shape that discarded the pasted text",
  );
  assert.match(listener, /planComposerPaste\(\{ hasFile: !!file, text \}\)/);
});
