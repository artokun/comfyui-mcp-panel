/**
 * #2218 — an interactive `panel_ask` card must survive a replacement WebSocket when the
 * replacement proves the same bridge URL + server-issued session epoch. The old socket id
 * fence disabled the card and dropped the user's pick even though the orchestrator process
 * was still the same.
 *
 * The negative side remains load-bearing: an unknown, different URL, or different session
 * epoch must retire the card and abandon its command. A retry must never paint a second card
 * merely because the original socket disappeared.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The SHIPPED translator, not a stub. No catalog is loaded in this process, which is
// exactly the state `tr` is designed to survive: every call returns its English fallback
// with `{holes}` filled. So the wording assertions below still read the English the panel
// renders, and they still fail if that English changes.
import { tr } from "../../web/js/lib/i18n.js";
import { sameBridgeSession } from "../../web/js/lib/command-liveness.js";

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
  return new Function("document", "tr", `${fn}; return retireInteractiveCard;`)(document, tr);
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

test("#2218 source guard: cards use a proven bridge session, not a socket", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /sameBridgeSession\(/, "the session identity helper is the retirement gate");
  assert.match(src, /function bindInteractiveCardsToHandshake\(/, "pre-handshake cards are bound at handshake");
  assert.match(src, /function retireInteractiveCardsFromPreviousSessions\(/);
  assert.match(src, /onStatus\(state, socketId, bridgeScope\)/);
  assert.match(src, /url: sock\?\.__cmcpBridgeUrl \?\? null/);
  assert.match(src, /epoch: sock\?\.__cmcpBridgeEpoch/);
  assert.ok(!/let liveSocketId/.test(src), "a socket-only live identity must not return");
  const sweep = namedFunctionSource(src, "retireInteractiveCardsFromPreviousSessions");
  assert.match(sweep, /sameBridgeSession\(/, "retirement compares URL + epoch");
  assert.ok(!/resolveFn|resolve\(/.test(sweep), "the sweep must not answer anything");
  const retireSrc = namedFunctionSource(src, "retireInteractiveCard");
  assert.ok(!/resolveFn|resolve\(/.test(retireSrc), "nor may the retirement itself");
});

test("#2218: a question card registers its bridge scope and unregisters when answered", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const paint = namedFunctionSource(src, "paintQuestion");
  assert.match(
    paint,
    /const cardScope = normalizeInteractiveCardScope\(paintedOnScope\);/,
    "the command's scope is normalized at paint",
  );
  assert.match(paint, /paintedOnSocketId: cardScope\.socketId/);
  assert.match(paint, /paintedOnScope: cardScope/);
  assert.match(paint, /alreadyAnswered: \(\) => done,/, "so an answered card is skipped");
  assert.match(paint, /handedToCaller\.then\(unregister, unregister\)/, "and dropped once the caller-facing wait settles, either way");
});

test("#2218: a SECRET card carries the same session scope and remains secret-safe", () => {
  // It matters more here than for a question: a live password field whose reply has
  // nowhere to go can still display "Token saved", telling a user their token was stored
  // when nothing received it.
  const src = readFileSync(PANEL_JS, "utf8");
  const paint = namedFunctionSource(src, "paintSecret");
  assert.match(
    paint,
    /const cardScope = normalizeInteractiveCardScope\(paintedOnScope\);/,
    "the command's scope is normalized at paint",
  );
  assert.match(paint, /paintedOnSocketId: cardScope\.socketId/);
  assert.match(paint, /paintedOnScope: cardScope/);
  // Either the bare literal or the translated form — but if it is translated, the KEY is
  // pinned too, not just the English. A wildcard key would let `tr("panel.question",
  // "secret request")` pass while every non-English locale renders the secret card with the
  // question card's noun: the assertion stays green in the one language the author reads,
  // and the "secret-safe wording" this test exists for is gone everywhere else.
  assert.match(paint, /what: (?:tr\("panel\.secret_request",\s*)?"secret request"/);
  assert.match(paint, /Nothing was sent and nothing was stored/, "no false 'saved' impression survives");
  assert.match(paint, /do not paste the value into the chat/, "never redirect a secret into the transcript");
  assert.match(paint, /promise\.then\(unregisterSecret, unregisterSecret\)/);
  // The question card's advice would be actively wrong here.
  assert.ok(!/answer the newer card/.test(paint), "a secret card must not reuse the question wording");
});

test("#952 (codex) the retirement note takes the caller's detail, and defaults for a question", () => {
  const card = fakeCard();
  retire(card, {
    alreadyAnswered: () => false,
    what: "secret request",
    detail: "Nothing was sent and nothing was stored. Wait for the agent to ask again.",
  });
  assert.match(card._children[0].textContent, /connection that asked this secret request dropped/);
  assert.match(card._children[0].textContent, /Nothing was sent and nothing was stored/);
  assert.doesNotMatch(card._children[0].textContent, /answer the newer card/);

  const q = fakeCard();
  retire(q, { alreadyAnswered: () => false });
  assert.match(q._children[0].textContent, /If it asked again, answer the newer card\./, "the default stands");
});

function cardRegistryHarness(src) {
  return new Function(
    "sameBridgeSession",
    `const liveInteractiveCards = new Set();
     ${namedFunctionSource(src, "registerInteractiveCard")}
     ${namedFunctionSource(src, "bindInteractiveCardsToHandshake")}
     ${namedFunctionSource(src, "retireInteractiveCardsFromPreviousSessions")}
     function onStatus(state, socketId, bridgeScope) {
       if (state === "connected") {
         bindInteractiveCardsToHandshake(socketId, bridgeScope);
         retireInteractiveCardsFromPreviousSessions(bridgeScope);
       }
     }
     return { registerInteractiveCard, onStatus, size: () => liveInteractiveCards.size };`,
  )(sameBridgeSession);
}

test("#2218: same-session reconnect keeps the live approval exactly once", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const make = cardRegistryHarness(src);
  make.onStatus("connected", 1, { url: "ws://agent", epoch: "session-1" });
  const retired = [];
  make.registerInteractiveCard({
    paintedOnSocketId: 1,
    paintedOnScope: { url: "ws://agent", epoch: "session-1" },
    retire: () => retired.push("retire"),
    abandon: () => retired.push("abandon"),
  });
  make.onStatus("connected", 2, { url: "ws://agent", epoch: "session-1" });
  assert.deepEqual(retired, [], "a new socket in the same session does not withdraw the pick");
  assert.equal(make.size(), 1, "the reconnect does not create a duplicate card");
});

test("#2218: epoch/URL mismatch withdraws, while a pre-handshake card binds to its own session", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const make = cardRegistryHarness(src);
  make.onStatus("connected", 1, { url: "ws://agent", epoch: "session-1" });
  const retired = [];
  make.registerInteractiveCard({
    paintedOnSocketId: 1,
    paintedOnScope: { url: "ws://agent", epoch: "session-1" },
    retire: () => retired.push("old-retire"),
    abandon: () => retired.push("old-abandon"),
  });
  make.registerInteractiveCard({
    paintedOnSocketId: 2,
    paintedOnScope: { url: "ws://agent", epoch: undefined },
    retire: () => retired.push("new-retire"),
    abandon: () => retired.push("new-abandon"),
  });
  make.onStatus("connected", 2, { url: "ws://agent", epoch: "session-2" });
  assert.deepEqual(retired, ["old-retire", "old-abandon"], "the epoch mismatch withdraws the old card");
  assert.equal(make.size(), 1, "the card painted before the new handshake remains once");

  const urlRetired = [];
  make.registerInteractiveCard({
    paintedOnSocketId: 2,
    paintedOnScope: { url: "ws://agent", epoch: "session-2" },
    retire: () => urlRetired.push("retire"),
    abandon: () => urlRetired.push("abandon"),
  });
  make.onStatus("connected", 3, { url: "ws://other-agent", epoch: "session-2" });
  assert.deepEqual(urlRetired, ["retire", "abandon"], "the URL mismatch also withdraws");
});

test("#2218: repeated handshakes in one bridge session retire nothing", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const make = cardRegistryHarness(src);
  make.onStatus("connected", 7, { url: "ws://agent", epoch: "session-1" });
  const retired = [];
  make.registerInteractiveCard({
    paintedOnSocketId: 7,
    paintedOnScope: { url: "ws://agent", epoch: "session-1" },
    retire: () => retired.push("x"),
  });
  // Every models frame re-emits "connected"; a workflow change can re-hello the live socket.
  make.onStatus("connected", 7, { url: "ws://agent", epoch: "session-1" });
  make.onStatus("connected", 7, { url: "ws://agent", epoch: "session-1" });
  assert.deepEqual(retired, [], "a live card survives any number of re-handshakes");
});

test("#2218 source guard: session scope is stamped before replay and handed to the panel", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /if \(state === "connected"\) \{\r?\n\s*bindInteractiveCardsToHandshake\(socketId, connectedScope\);\r?\n\s*retireInteractiveCardsFromPreviousSessions\(connectedScope\);/,
    "bind and sweep only after a connected handshake",
  );
  assert.match(src, /thisSock\.__cmcpSocketId = \+\+socketSeq;/);
  assert.match(src, /onStatus\(s, sock\?\.__cmcpSocketId \?\? null, \{[\s\S]*?url: sock\?\.__cmcpBridgeUrl/);
  assert.match(src, /epoch: sock\?\.__cmcpBridgeEpoch/);
});

test("#2218: the card records the command's URL+epoch scope, not the UI's belief", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  for (const cmd of ["onAsk", "onSecret"]) {
    const at = src.indexOf(`result = await ${cmd === "onAsk" ? "onAsk" : "onSecret"}(msg, {`);
    assert.ok(at > 0, `${cmd} carries a bridge scope`);
    const frame = src.slice(at, at + 260);
    assert.match(frame, /socketId: thisSock\.__cmcpSocketId/);
    assert.match(frame, /url: thisSock\.__cmcpBridgeUrl \?\? socketUrl/);
    assert.match(frame, /epoch: thisSock\.__cmcpBridgeEpoch/);
  }
  assert.match(src, /onAsk\(msg, cardScope\) \{/);
  assert.match(src, /onSecret\(msg, cardScope\) \{/);
  assert.match(src, /const p = paintQuestion\(msg, cardScope\);/);
  assert.match(src, /const p = paintSecret\(msg, cardScope\);/);
  assert.match(src, /function paintQuestion\(msg, paintedOnScope = null\) \{/);
  assert.match(src, /function paintSecret\(msg, paintedOnScope = null\) \{/);
  assert.equal(
    (src.match(/cardScope == null \? \(\) => \{\} : registerInteractiveCard\(\{/g) ?? []).length,
    2,
    "both interactive card types register only when a command painted them",
  );
});

test("#952 (codex r3) a SETTINGS token card is never registered — it is agent-free", () => {
  // `paintSecret` also serves the Settings "Set … token" buttons, which have no command
  // behind them. That card can still send its set_secret on whatever socket is current
  // after a reconnect, so retiring it would disable a working control and tell the user to
  // wait for a request that is never coming.
  const src = readFileSync(PANEL_JS, "utf8");
  const settingsCall = src.slice(src.indexOf("    paintSecret({"), src.indexOf("    paintSecret({") + 400);
  assert.ok(settingsCall.length > 0, "the Settings call site exists");
  assert.ok(!/socketId/.test(settingsCall), "it passes no socket id");
  // …and with none passed, the painter does not register it at all.
  const make = new Function(
    `const liveInteractiveCards = new Set();
     ${namedFunctionSource(src, "registerInteractiveCard")}
     return { registerInteractiveCard, size: () => liveInteractiveCards.size };`,
  )();
  // The painter's own gate is what skips registration; this asserts the registry keeps no
  // belief-based fallback that would put a socket on an entry that never named one.
  const off = make.registerInteractiveCard({ retire: () => {} });
  assert.equal(make.size(), 1);
  off();
  assert.match(
    namedFunctionSource(src, "registerInteractiveCard"),
    /const record = \{ paintedOnSocketId: null, paintedOnScope: null, \.\.\.entry \};/,
    "no live socket fallback — an entry names its own bridge scope or none",
  );
});
