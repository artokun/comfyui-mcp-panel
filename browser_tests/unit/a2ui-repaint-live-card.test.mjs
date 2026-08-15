// panel#832 — `panel_ui_render` returned a card_id, and an immediate `panel_ui_update`
// in the SAME agent turn failed with:
//
//   no live card "a2ui-mslhgcem-8" (already resolved, dismissed, or from a previous view)
//
// with no click, no dismissal, and no workflow/tab switch in between.
//
// THE MECHANISM. `appendA2UICard` registers a live card in `liveA2uiCards`;
// `resetFeed()` unconditionally does `liveA2uiCards.clear()`; `paintA2UIRecord()` replays
// every persisted record INERT and re-registers nothing; `onUiUpdate` requires
// `liveA2uiCards.get(card_id)`. So any same-thread repaint between two tool calls turns
// an unresolved card inert and drops its handle.
//
// THE HALF THE REPORT COULD NOT SEE. Re-rendering the record live on repaint would NOT
// have been enough: the record never stored its card_id —
//
//   const rec = { role: "card", kind: "a2ui", spec, resolved: false, choice: null };
//
// — and `renderA2UICard` minted a fresh id on every call. A repaint would therefore have
// re-registered the card under a NEW id while the agent still held the old one, so
// panel_ui_update would keep failing, for a new reason instead of the old one. Restoring
// liveness required restoring IDENTITY.
//
// WHY THESE ARE SOURCE-STRUCTURE ASSERTIONS. This suite has no DOM, and the sibling A2UI
// tests (a2ui-validate, secret-card-sizing, interactive-card-fence) are written the same
// way for the same reason: `renderA2UICard` builds real elements. These pin the wiring
// that decides the bug — which render path a record takes, whether the id is persisted,
// and whether the id survives a repaint — each of which is individually mutable and is
// mutation-tested. A DOM-driven render → repaint → update test would be stronger and is
// not possible until this suite grows a DOM harness.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const panelSrc = read("../../web/js/comfyui-mcp-panel.js");
const a2uiSrc = read("../../web/js/cmcp-a2ui.js");

const fn = (src, name) => {
  const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`));
  assert.ok(m, `could not locate ${name}`);
  return m[0];
};

// ---------------------------------------------------------------------------
// 1. Identity — the half that was missing.
// ---------------------------------------------------------------------------

test("#832 renderA2UICard can be given an id instead of always minting one", () => {
  assert.match(
    a2uiSrc,
    /export function renderA2UICard\(spec, \{ onAction, onDismiss, cardId: reuseId \} = \{\}\)/,
    "the renderer accepts a caller-supplied id",
  );
  // Minting remains the DEFAULT, so every ordinary render is unchanged — and it now
  // carries a random nonce. `_cardSeq` restarts at 0 on module load and a REUSED id does
  // not advance it, so Date.now()+counter alone could mint an id equal to one a repaint
  // had already registered, silently overwriting that map entry (codex review finding).
  assert.match(a2uiSrc, /a2ui-\$\{Date\.now\(\)\.toString\(36\)\}-\$\{\+\+_cardSeq\}-\$\{Math\.random\(\)/);
  assert.match(
    a2uiSrc,
    /typeof reuseId === "string" && reuseId\s*\?\s*reuseId/,
    "a supplied id wins; an empty or non-string one falls back to minting",
  );
});

test("#832 the record persists the card_id the agent was handed", () => {
  // Without this the id lives only on the transient handle, and a repaint cannot
  // reconstruct the identity the agent is holding.
  assert.match(fn(panelSrc, "mountLiveA2UICard"), /rec\.cardId = handle\.cardId;/);
});

// ---------------------------------------------------------------------------
// 2. Liveness — an unresolved record comes back live, a resolved one does not.
// ---------------------------------------------------------------------------

test("#832 an UNRESOLVED record is repainted LIVE, under its original id", () => {
  const paint = fn(panelSrc, "paintA2UIRecord");
  assert.match(paint, /m\.resolved !== true/, "the branch turns on resolved-ness");
  assert.match(
    paint,
    /mountLiveA2UICard\(m, typeof m\.cardId === "string" \? m\.cardId : undefined\)/,
    "it re-mounts live and hands back the ORIGINAL id",
  );
});

test("#832 a RESOLVED record stays inert — an answered question is not re-offered", () => {
  const paint = fn(panelSrc, "paintA2UIRecord");
  assert.match(paint, /renderA2UIInert\(m\.spec, m\.choice\)/);
  // The inert path must remain reachable: it is the whole non-regression here.
  assert.ok(
    paint.indexOf("renderA2UIInert") > paint.indexOf("m.resolved !== true"),
    "inert is the fall-through for a resolved record, not dead code",
  );
});

test("#832 dismissal still retires the card — resurrection must not undo it", () => {
  // onDismiss sets resolved = true, which is exactly what routes a dismissed card down
  // the inert path above. If dismissal stopped marking the record, a repaint would bring
  // a dismissed card back to life.
  const mount = fn(panelSrc, "mountLiveA2UICard");
  assert.match(mount, /onDismiss\(\) \{\s*rec\.resolved = true;/);
  assert.match(mount, /onAction\(text\) \{\s*rec\.resolved = true;/);
});

// ---------------------------------------------------------------------------
// 3. The handlers are shared, so the two paths cannot drift apart.
// ---------------------------------------------------------------------------

test("#832 first paint and repaint mount through the SAME function", () => {
  // Two copies of the resolve/dismiss handlers would be two chances for a repainted
  // card to behave differently from a freshly rendered one — the class of bug this
  // issue already is.
  assert.match(fn(panelSrc, "appendA2UICard"), /mountLiveA2UICard\(rec\)/);
  assert.match(fn(panelSrc, "paintA2UIRecord"), /mountLiveA2UICard\(m, /);
  assert.equal(
    (panelSrc.match(/renderA2UICard\(/g) || []).length,
    1,
    "exactly one live-render call site in the panel",
  );
});

test("#832 the live registry is written on both paths, via that shared function", () => {
  assert.match(fn(panelSrc, "mountLiveA2UICard"), /liveA2uiCards\.set\(handle\.cardId, \{ handle, rec \}\)/);
});

test("#832 the card is RECORDED before it is mounted — record() can repaint", () => {
  // record() can reach detachInvalidCurrentThread(), which calls resetFeed() (clearing
  // liveA2uiCards) and repaints. Mounting first would place the card into a feed that
  // the very next statement can wipe, and the card is not yet in any thread, so the
  // repaint would not bring it back. This is the ordering the pre-refactor code had.
  const append = fn(panelSrc, "appendA2UICard");
  assert.ok(
    append.indexOf("record(rec)") < append.indexOf("mountLiveA2UICard(rec)"),
    "record(rec) must precede the mount",
  );
});

test("#832 (codex): the PRE-HYDRATION restore paint replays cards inert", () => {
  // The synchronous restore pass declares itself "paint-only": settings are not hydrated,
  // so the thread it paints comes from a tab pointer and may not be the authoritative one.
  // Mounting a card LIVE there would register one belonging to a thread about to be
  // replaced, and an update could land on it — a correctness bug traded for a convenience
  // one. Liveness waits until the real thread is chosen.
  assert.match(panelSrc, /let a2uiPaintProvisional = false;/);
  assert.match(
    fn(panelSrc, "paintA2UIRecord"),
    /m\.resolved !== true && !a2uiPaintProvisional/,
    "the live branch is suppressed during the provisional paint",
  );
  const restore = panelSrc.match(/\(function restoreLastThread\(\) \{[\s\S]*?\n  \}\)\(\);/)[0];
  assert.match(restore, /a2uiPaintProvisional = true;/);
  assert.match(restore, /finally \{\s*a2uiPaintProvisional = false;/, "reset even if paint throws");
});
