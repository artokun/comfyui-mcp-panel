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

// The SHIPPED translator, not a stub. No catalog is loaded in this process, which is
// exactly the state `tr` is designed to survive: every call returns its English fallback
// with `{holes}` filled. So the wording assertions below still read the English the panel
// renders, and they still fail if that English changes.
import { tr } from "../../web/js/lib/i18n.js";

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

test("#952 (codex) source guard: a DIFFERENT SOCKET retires cards, and nothing resolves their promise", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // `"connected"` re-fires on every re-handshake — each `models` frame calls markConnected,
  // and a workflow change re-hellos the LIVE socket — so keying on the status string would
  // retire cards that are still perfectly answerable. The socket's identity can tell them
  // apart; the string cannot.
  assert.match(src, /socketId != null && socketId !== liveSocketId/, "a DIFFERENT socket");
  assert.match(src, /retireInteractiveCardsFromPreviousSockets\(\);/);
  assert.ok(!/bridgeConnectSeq/.test(src), "the status-counting trigger must not come back");
  assert.match(src, /thisSock\.__cmcpSocketId = \+\+socketSeq;/, "minted once per WebSocket");
  assert.match(src, /onStatus\(s, sock\?\.__cmcpSocketId \?\? null\)/, "and handed to the UI");
  const sweep = namedFunctionSource(src, "retireInteractiveCardsFromPreviousSockets");
  assert.match(sweep, /if \(record\.paintedOnSocket === liveSocketId\) continue;/, "only cards from another socket");
  // Resolving would send an answer to a socket that is gone, and the panel's own rule is
  // that a reply of this kind does not cross a reconnect.
  assert.ok(!/resolveFn|resolve\(/.test(sweep), "the sweep must not answer anything");
  const retireSrc = namedFunctionSource(src, "retireInteractiveCard");
  assert.ok(!/resolveFn|resolve\(/.test(retireSrc), "nor may the retirement itself");
});

test("#952 source guard: a question card registers itself and unregisters when answered", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const paint = namedFunctionSource(src, "paintQuestion");
  assert.match(
    paint,
    /const unregister = paintedOnSocket == null \? \(\) => \{\} : registerInteractiveCard\(\{/,
    "registered at paint, and ONLY when a command painted it",
  );
  assert.match(paint, /alreadyAnswered: \(\) => done,/, "so an answered card is skipped");
  assert.match(paint, /promise\.then\(unregister, unregister\)/, "and dropped once it settles, either way");
});

test("#952 (codex) a SECRET card is retired too, with secret-safe wording", () => {
  // It matters more here than for a question: a live password field whose reply has
  // nowhere to go can still display "Token saved", telling a user their token was stored
  // when nothing received it.
  const src = readFileSync(PANEL_JS, "utf8");
  const paint = namedFunctionSource(src, "paintSecret");
  assert.match(
    paint,
    /const unregisterSecret = paintedOnSocket == null \? \(\) => \{\} : registerInteractiveCard\(\{/,
    "registered at paint, and ONLY when a command painted it",
  );
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

test("#952 (codex r2) a card painted BEFORE its socket handshakes is not retired by that handshake", () => {
  // A command frame is accepted before the handshake, so an interactive card can be painted
  // on socket B while the UI still believes A is live. Retiring on B's `connected` would
  // then kill a card that is perfectly answerable — worse than the duplicate this fixes.
  // The sandbox runs the SHIPPED registry functions with the shipped handler's two lines,
  // which the source guard below pins.
  const src = readFileSync(PANEL_JS, "utf8");
  const register = namedFunctionSource(src, "registerInteractiveCard");
  const sweep = namedFunctionSource(src, "retireInteractiveCardsFromPreviousSockets");
  const make = new Function(
    `let liveSocketId = null;
     const liveInteractiveCards = new Set();
     ${register}
     ${sweep}
     function onStatus(state, socketId) {
       if (socketId != null && socketId !== liveSocketId) liveSocketId = socketId;
       if (state === "connected") retireInteractiveCardsFromPreviousSockets();
     }
     return { registerInteractiveCard, onStatus, liveCount: () => liveInteractiveCards.size };`,
  );
  const s = make();

  // Socket A connects; a card is painted and answered normally.
  s.onStatus("connected", 1);
  const retiredA = [];
  s.registerInteractiveCard({ paintedOnSocket: 1, retire: () => retiredA.push("A") });

  // A drops, B opens ("connecting" carries B's id) and receives ask_user BEFORE its models
  // frame — the window this test exists for.
  s.onStatus("connecting", 2);
  const retiredB = [];
  s.registerInteractiveCard({ paintedOnSocket: 2, retire: () => retiredB.push("B") });

  // B handshakes.
  s.onStatus("connected", 2);
  assert.deepEqual(retiredA, ["A"], "the card from the previous socket IS retired");
  assert.deepEqual(retiredB, [], "the card painted on B, before B handshaked, is NOT");
  assert.equal(s.liveCount(), 1, "and B's card is still tracked");
});

test("#952 (codex r2) a RE-HANDSHAKE on the same socket retires nothing", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const make = new Function(
    `let liveSocketId = null;
     const liveInteractiveCards = new Set();
     ${namedFunctionSource(src, "registerInteractiveCard")}
     ${namedFunctionSource(src, "retireInteractiveCardsFromPreviousSockets")}
     function onStatus(state, socketId) {
       if (socketId != null && socketId !== liveSocketId) liveSocketId = socketId;
       if (state === "connected") retireInteractiveCardsFromPreviousSockets();
     }
     return { registerInteractiveCard, onStatus };`,
  )();
  make.onStatus("connected", 7);
  const retired = [];
  make.registerInteractiveCard({ paintedOnSocket: 7, retire: () => retired.push("x") });
  // Every models frame re-emits "connected" on the SAME socket; a workflow change re-hellos it.
  make.onStatus("connected", 7);
  make.onStatus("connected", 7);
  assert.deepEqual(retired, [], "a live card survives any number of re-handshakes");
});

test("#952 (codex r2) source guard: adoption is unconditional, retirement waits for the handshake", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /if \(socketId != null && socketId !== liveSocketId\) liveSocketId = socketId;\r?\n\s*if \(state === "connected"\) retireInteractiveCardsFromPreviousSockets\(\);/,
    "adopt on any status carrying a new id; sweep only on connected",
  );
  // The open path must actually emit a status carrying the new socket's id, or a card
  // painted pre-handshake would still record the previous one.
  assert.match(src, /thisSock\.__cmcpSocketId = \+\+socketSeq;/);
  assert.match(src, /onStatus\(s, sock\?\.__cmcpSocketId \?\? null\)/);
});

test("#952 (codex r2) the card records the socket that ASKED, not the UI's belief", () => {
  // The open status that would tell the UI about a new socket is suppressed once the
  // patience window has been given up on (`if (!gaveUp) emitStatus("connecting")`), so a
  // UI-side belief can be stale exactly when a pre-handshake command arrives. Taking the
  // id from the command's own socket removes the dependency entirely.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /result = await onAsk\(msg, thisSock\.__cmcpSocketId \?\? null\);/, "ask carries its socket");
  assert.match(src, /result = await onSecret\(msg, thisSock\.__cmcpSocketId \?\? null\);/, "so does the secret request");
  assert.match(src, /onAsk\(msg, socketId\) \{/, "the UI takes it");
  assert.match(src, /onSecret\(msg, socketId\) \{/);
  assert.match(src, /const p = paintQuestion\(msg, socketId\);/, "and threads it to the painter");
  assert.match(src, /const p = paintSecret\(msg, socketId\);/);
  assert.match(src, /function paintQuestion\(msg, paintedOnSocket = null\) \{/);
  assert.match(src, /function paintSecret\(msg, paintedOnSocket = null\) \{/);
  // The registry entry prefers the painter's own id and falls back to the UI's belief.
  // BOTH painters, COUNTED. Matching once passed while one of the two had lost it — a
  // guard that cannot tell "both do this" from "at least one does" is not guarding much.
  assert.equal(
    (src.match(/paintedOnSocket == null \? \(\) => \{\} : registerInteractiveCard\(\{/g) ?? []).length,
    2,
    "the question card AND the secret card each register only when a command painted them",
  );
});

test("#952 (codex r2) a card painted on a socket the UI never adopted is still tied to it", () => {
  // The behavioural half: with the id coming from the COMMAND, a card painted while
  // `liveSocketId` is stale still records the socket that asked, so that socket
  // handshaking does not retire it — and the older one still does. This matters because
  // the open status carrying a new socket's id is suppressed once the patience window has
  // been given up on, so the UI's belief can be stale exactly when it counts.
  const src = readFileSync(PANEL_JS, "utf8");
  const make = new Function(
    `let liveSocketId = null;
     const liveInteractiveCards = new Set();
     ${namedFunctionSource(src, "registerInteractiveCard")}
     ${namedFunctionSource(src, "retireInteractiveCardsFromPreviousSockets")}
     function onStatus(state, socketId) {
       if (socketId != null && socketId !== liveSocketId) liveSocketId = socketId;
       if (state === "connected") retireInteractiveCardsFromPreviousSockets();
     }
     return { registerInteractiveCard, onStatus };`,
  )();
  make.onStatus("connected", 1); // socket A is live
  const retiredA = [];
  make.registerInteractiveCard({ paintedOnSocket: 1, retire: () => retiredA.push("A") });
  // Socket B opens with NO status reaching the UI, and an ask_user arrives on it: the
  // painter names B explicitly.
  const retiredB = [];
  make.registerInteractiveCard({ paintedOnSocket: 2, retire: () => retiredB.push("B") });
  make.onStatus("connected", 2); // B finally handshakes
  assert.deepEqual(retiredA, ["A"], "the card from A is retired");
  assert.deepEqual(retiredB, [], "the card that named B survives B handshaking");
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
    `let liveSocketId = 9;
     const liveInteractiveCards = new Set();
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
    /const record = \{ paintedOnSocket: null, \.\.\.entry \};/,
    "no liveSocketId fallback — an entry names its own socket or none",
  );
});
