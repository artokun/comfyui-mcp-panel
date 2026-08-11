/**
 * #952 — a `panel_ask` whose tab disconnects mid-command returns an unknown outcome, and
 * the orchestrator's own message (comfyui-mcp 0.50.88) has to warn:
 *
 *   "Expect the stale card to remain on screen: retry suppression is keyed to the socket
 *    that dropped, so this counts as a new command and the user may see two. Tell them
 *    which one to answer."
 *
 * The panel is the side that can just say it. A card painted on a connection that has since
 * been replaced cannot deliver an answer to anyone — the panel deliberately does not replay
 * a reply of this kind across a reconnect — yet it looks exactly as clickable as the newer
 * card beside it.
 *
 * DELIBERATELY NOT TOUCHED, because they are design questions this issue records and leaves
 * to its owner: whether interactive cards should dedupe on a scope that survives a
 * reconnect, and what a retry should return while the original is unanswered. Retiring a
 * dead card needs neither — no new scope, no retry semantics, no ledger change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

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

/** A DOM stub with exactly the surface `retireInteractiveCard` touches. */
function fakeCard({ connected = true, controls = 2 } = {}) {
  const children = [];
  const els = Array.from({ length: controls }, () => ({ disabled: false, style: {} }));
  return {
    isConnected: connected,
    style: {},
    querySelectorAll: () => els,
    appendChild: (n) => children.push(n),
    _children: children,
    _controls: els,
  };
}

/** The shipped retire function, with a document stub for the note element. */
function loadRetire() {
  const src = readFileSync(PANEL_JS, "utf8");
  const fn = namedFunctionSource(src, "retireInteractiveCard");
  assert.ok(fn, "retireInteractiveCard not found");
  const document = {
    createElement: () => ({ className: "", style: { cssText: "" }, textContent: "" }),
  };
  return new Function("document", `${fn}; return retireInteractiveCard;`)(document);
}

const retire = loadRetire();

test("#952 a retired card loses every control and says why", () => {
  const card = fakeCard({ controls: 3 });
  retire(card, { alreadyAnswered: () => false, what: "question" });
  assert.ok(card._controls.every((c) => c.disabled === true), "nothing stays clickable");
  assert.ok(card._controls.every((c) => c.style.cursor === "not-allowed"));
  assert.equal(card._children.length, 1, "one explanatory line is added");
  assert.match(card._children[0].textContent, /connection that asked this question dropped/);
  assert.match(card._children[0].textContent, /answer here can no longer reach the agent/);
  assert.match(card._children[0].textContent, /If it asked again, answer the newer card\./, "and what to do");
});

test("#952 an ANSWERED card is left completely alone", () => {
  // It is already collapsed into a static result, and its answer DID reach the agent.
  // Adding a note about a dropped connection there would be false.
  const card = fakeCard();
  retire(card, { alreadyAnswered: () => true, what: "question" });
  assert.equal(card._children.length, 0);
  assert.ok(card._controls.every((c) => c.disabled === false));
});

test("#952 a card already removed from the log is not touched", () => {
  const card = fakeCard({ connected: false });
  retire(card, { alreadyAnswered: () => false });
  assert.equal(card._children.length, 0);
});

test("#952 retirement is presentation only — a hostile card cannot break a reconnect", () => {
  const hostile = {
    isConnected: true,
    style: {},
    querySelectorAll() {
      throw new Error("boom");
    },
    appendChild() {},
  };
  assert.doesNotThrow(() => retire(hostile, { alreadyAnswered: () => false }));
  assert.doesNotThrow(() => retire(null, {}));
  assert.doesNotThrow(() => retire(fakeCard(), { alreadyAnswered: () => { throw new Error("boom"); } }));
});

test("#952 source guard: a CONNECT retires earlier cards, and nothing resolves their promise", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // The trigger is a positive fact — a new connection exists — not a "connecting" blip.
  assert.match(src, /if \(state === "connected"\) \{\r?\n\s*bridgeConnectSeq \+= 1;/, "counted on connect");
  assert.match(src, /retireInteractiveCardsFromPreviousConnections\(\);/);
  const sweep = namedFunctionSource(src, "retireInteractiveCardsFromPreviousConnections");
  assert.match(sweep, /if \(record\.paintedOnConnect >= bridgeConnectSeq\) continue;/, "only EARLIER cards");
  // Resolving would send an answer to a socket that is gone, and the panel's own rule is
  // that a reply of this kind does not cross a reconnect.
  assert.ok(!/resolveFn|resolve\(/.test(sweep), "the sweep must not answer anything");
  const retireSrc = namedFunctionSource(src, "retireInteractiveCard");
  assert.ok(!/resolveFn|resolve\(/.test(retireSrc), "nor may the retirement itself");
});

test("#952 source guard: a question card registers itself and unregisters when answered", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const paint = namedFunctionSource(src, "paintQuestion");
  assert.match(paint, /const unregister = registerInteractiveCard\(\{/, "registered at paint");
  assert.match(paint, /alreadyAnswered: \(\) => done,/, "so an answered card is skipped");
  assert.match(paint, /promise\.then\(unregister, unregister\)/, "and dropped once it settles, either way");
});
