// #2183 — a large live A2UI card must not be able to hide the whole chat, and
// the recovery command must still work when the agent has lost card_id.
//
// These are production-source contracts because the panel bundle builds the DOM
// at runtime and this suite intentionally has no browser. The assertions pin
// the two safety properties that are easy to regress independently: bounded
// card layout, and current-thread-only durable dismissal during rebind/reload.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
const panelSrc = read("../../web/js/comfyui-mcp-panel.js");
const a2uiSrc = read("../../web/js/cmcp-a2ui.js");

function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `could not locate ${marker}`);
  const open = source.indexOf("{", start);
  assert.ok(open >= 0, `${marker} must open a block`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  assert.fail(`${marker} block is not closed`);
}

test("#2183 bounds A2UI cards and gives oversized content its own scroll surface", () => {
  const ruleStart = a2uiSrc.indexOf(".cmcp-a2ui {");
  assert.ok(ruleStart >= 0, "the live A2UI card rule must exist");
  const ruleEnd = a2uiSrc.indexOf("}", ruleStart);
  const rule = a2uiSrc.slice(ruleStart, ruleEnd + 1);
  assert.match(rule, /max-height:\s*min\(70vh,\s*42rem,\s*calc\(100%\s*-\s*2rem\)\)/);
  assert.match(rule, /overflow-y:\s*auto/);
});

test("#2183 keeps record identity on live and inert card roots", () => {
  const mount = blockAfter(panelSrc, "function mountLiveA2UICard(");
  assert.match(mount, /handle\.el\.dataset\.messageId\s*=\s*rec\.id/);
  const paint = blockAfter(panelSrc, "function paintA2UIRecord(");
  assert.match(paint, /inert\.dataset\.messageId\s*=\s*m\.id/);
});

test("#2183 no-card_id dismissal resolves only the displayed thread and persists it", () => {
  const dismiss = blockAfter(panelSrc, "onUiDismiss(msg) {");
  assert.match(dismiss, /dismissAllLiveA2uiCards\(liveA2uiCards/);
  // Still the DISPLAYED thread, which is the scope claim worth keeping here — the
  // sweep must not reach other threads. `unresolvedA2UICards` handles the null/empty
  // cases the old `|| []` covered, and those are driven in a2ui-sweep-selection.
  assert.match(dismiss, /for \(const rec of unresolvedA2UICards\(thread\?\.msgs\)\)/);
  // The selection itself moved to `lib/a2ui-sweep.js` and is DRIVEN in
  // a2ui-sweep-selection.test.mjs — a2ui-only, unresolved-only, `resolved === true`
  // rather than truthy, and the empty/null-hole cases. What is worth pinning HERE is
  // only that the handler still delegates to that vetted selection rather than
  // re-deriving one inline, which is how the two would drift apart.
  assert.match(dismiss, /unresolvedA2UICards\(thread\?\.msgs\)/);
  assert.match(dismiss, /rec\.resolved = true/);
  assert.match(dismiss, /historyStore\.touchMessage\(rec\)/);
  assert.match(dismiss, /persistThreads\(\)/);
  assert.match(dismiss, /el\.dataset\?\.messageId === rec\.id/);
  assert.match(dismiss, /setChatSurfaceForCards\(\)/);
  assert.match(dismiss, /card_ids: \[\.\.\.new Set\(/);
});

test("#2183 the no-card_id sweep REPORTS itself, because it clears more than one card", () => {
  // The fallback resolves EVERY unresolved card in the displayed thread — it
  // cannot tell which one a dismissal with no card_id meant. Folding that into
  // `dismissed` alone would let a caller who named one card read "dismissed: 3"
  // with nothing saying why, so the sweep is reported on its own key.
  const at = panelSrc.indexOf("recovered_without_card_id");
  assert.ok(at > -1, "the sweep must report itself separately from `dismissed`");
  // Only when it actually ran: a normal dismissal must not grow a new key.
  const spread = panelSrc.lastIndexOf("...(fallbackDismissed", at);
  assert.ok(spread > -1 && at - spread < 400, "the key must be conditional on the sweep firing");
  assert.ok(panelSrc.includes("clears every unresolved card in the thread on screen"));
});
