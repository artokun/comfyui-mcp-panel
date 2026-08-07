// Regression coverage for the interactive-card fence (found by the independent
// gate on PR #680, re-verified on origin/main).
//
// `onAsk` (a question card) and `onSecret` (a masked token input) painted
// UNCONDITIONALLY, while the handler sitting between them in the same object
// (`onThinking`) is fenced on `agentWorking` precisely so a late frame from an
// abandoned turn cannot act on a screen it no longer owns. The consequence for
// these two is not a stray indicator but a stray VALUE: a superseded turn could
// paint a secure input into whatever conversation the tab was showing, and the
// token typed there came back as the result of a turn belonging to a DIFFERENT
// conversation.
//
// Two layers of coverage:
//   1. the pure decision + refusal wording (web/js/lib/interactive-card-fence.js);
//   2. the REAL `fenceInteractiveCard` / `onAsk` / `onSecret` bodies extracted
//      from the shipped panel source and driven against stubs — the established
//      "real panel source" convention (see context-ring-scope.test.mjs), so the
//      test fails if the fence is removed from the handlers rather than only if
//      the library changes.
//
// NOTE ON SECRETS: nothing here embeds a token-shaped value. The refusal path is
// asserted to run BEFORE any input exists, and the one "normal path" case resolves
// with the literal string "typed-answer" so no test artifact can look like a
// credential.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INTERACTIVE_CARD_CMDS,
  classifyInteractiveCard,
  refusedInteractiveCardError,
} from "../../web/js/lib/interactive-card-fence.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// 1. the pure decision
// ---------------------------------------------------------------------------

test("both collecting cards are covered — the same pair command-liveness redacts", () => {
  assert.ok(INTERACTIVE_CARD_CMDS.has("request_secret"));
  assert.ok(INTERACTIVE_CARD_CMDS.has("ask_user"));
  assert.equal(INTERACTIVE_CARD_CMDS.size, 2);
});

test("the normal path paints: a live turn in the conversation on screen", () => {
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: true, turnThreadId: "t-A", shownThreadId: "t-A" }),
    { paint: true, reason: null },
  );
});

test("a turn in flight before any conversation exists paints against the empty view", () => {
  // Owner and screen are both null — the same equality, not a special case. There
  // is no other conversation for such a turn to leak into.
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: true, turnThreadId: null, shownThreadId: null }),
    { paint: true, reason: null },
  );
});

test("no live turn → refused (the abandoned/superseded turn, the reported shape)", () => {
  // Every abandon path (new chat, opening an older conversation, workflow switch,
  // backend switch, Disconnect, Esc) routes through endTurnLocally(), which clears
  // agentWorking — so this single check covers all of them.
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: false, turnThreadId: "t-A", shownThreadId: "t-A" }),
    { paint: false, reason: "no_live_turn" },
  );
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: false, turnThreadId: null, shownThreadId: "t-B" }),
    { paint: false, reason: "no_live_turn" },
  );
});

test("live turn, but the conversation on screen is a different one → refused", () => {
  // Reachable without endTurnLocally() via detachInvalidCurrentThread(): another
  // tab deleted the active conversation and this tab rebound to a replacement
  // mid-turn.
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: true, turnThreadId: "t-A", shownThreadId: "t-B" }),
    { paint: false, reason: "other_conversation" },
  );
});

test("live turn owned by a conversation, screen has none (and vice versa) → refused", () => {
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: true, turnThreadId: "t-A", shownThreadId: null }),
    { paint: false, reason: "other_conversation" },
  );
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: true, turnThreadId: null, shownThreadId: "t-B" }),
    { paint: false, reason: "other_conversation" },
  );
});

test("undefined inputs are refused, never treated as a match", () => {
  // Defensive: a caller that forgets an argument must fail CLOSED, and must not
  // make `undefined === undefined` read as "the same conversation" while a turn
  // is supposedly live.
  assert.equal(classifyInteractiveCard().paint, false);
  assert.equal(classifyInteractiveCard({}).paint, false);
  assert.equal(
    classifyInteractiveCard({ agentWorking: true, shownThreadId: "t-B" }).paint,
    false,
    "an absent owner against a real conversation must not paint",
  );
});

// ---------------------------------------------------------------------------
// 2. the refusal the AGENT receives
// ---------------------------------------------------------------------------

for (const cmd of ["request_secret", "ask_user"]) {
  for (const reason of ["no_live_turn", "other_conversation"]) {
    test(`refusal for ${cmd}/${reason} is an honest, actionable failure`, () => {
      const text = refusedInteractiveCardError(cmd, reason);
      assert.ok(text.includes(cmd), "names the command that was refused");
      assert.ok(
        /nothing was shown, nothing was collected and nothing was stored/i.test(text),
        "states plainly that no value was taken — not silence, not a fabricated success",
      );
      assert.ok(
        /ask again after the user sends a message/i.test(text),
        "gives the one next step that actually works",
      );
      assert.ok(
        /retrying right now gets the same refusal/i.test(text),
        "tells the agent not to spin on an immediate retry",
      );
      assert.ok(!/\bok\b|succe/i.test(text.split(":")[0]), "the opening clause never reads as success");
    });
  }
}

test("the secret refusal names the actual harm (a token in a conversation the user did not choose)", () => {
  const text = refusedInteractiveCardError("request_secret", "no_live_turn");
  assert.ok(/secure input/i.test(text));
  assert.ok(/token typed there/i.test(text));
  assert.ok(/conversation the user never chose/i.test(text));
});

test("an unknown reason still produces a refusal, never an empty or partial string", () => {
  const text = refusedInteractiveCardError("request_secret", "something-new");
  assert.ok(text.length > 80);
  assert.ok(text.includes("request_secret"));
});

// ---------------------------------------------------------------------------
// 3. the REAL panel handlers
// ---------------------------------------------------------------------------

/** Pull one 4-space-indented object-literal method out of the panel source. */
function extractMethod(name) {
  const re = new RegExp(`\\n {4}${name}\\(msg\\) \\{[\\s\\S]*?\\n {4}\\},`);
  const m = panelSrc.match(re);
  assert.ok(m, `could not locate ${name} in the panel source`);
  return m[0];
}

const fenceMatch = panelSrc.match(/\n {2}function fenceInteractiveCard\(cmd\) \{[\s\S]*?\n {2}\}/);
assert.ok(fenceMatch, "could not locate fenceInteractiveCard in the panel source");
const onAskSrc = extractMethod("onAsk");
const onSecretSrc = extractMethod("onSecret");

test("the shipped handlers call the fence, and call it BEFORE painting", () => {
  for (const [name, src] of [["onAsk", onAskSrc], ["onSecret", onSecretSrc]]) {
    const fenceAt = src.indexOf("fenceInteractiveCard(");
    assert.ok(fenceAt > 0, `${name} must call fenceInteractiveCard`);
    const paintAt = src.search(/paint(Question|Secret)\(/);
    assert.ok(paintAt > fenceAt, `${name} must fence before it paints`);
  }
  assert.ok(onAskSrc.includes('fenceInteractiveCard("ask_user")'));
  assert.ok(onSecretSrc.includes('fenceInteractiveCard("request_secret")'));
});

test("the fence reads all three inputs from live panel state", () => {
  const src = fenceMatch[0];
  assert.ok(/agentWorking,/.test(src), "reads the live-turn flag");
  assert.ok(/turnThreadId: liveTurnThreadId/.test(src), "reads the live turn's owner");
  assert.ok(/shownThreadId: thread\?\.id \?\? null/.test(src), "reads the conversation on screen");
});

test("the fence never logs or journals a collected value", () => {
  // It runs before any card exists, so there is nothing to leak — pin that the
  // only things it can print are the command name and the observed reason.
  const src = fenceMatch[0];
  const logged = src.match(/console\.\w+\(([\s\S]*?)\);/);
  assert.ok(logged, "the fence logs its refusal");
  assert.ok(/\$\{cmd\}/.test(logged[1]) && /verdict\.reason/.test(logged[1]));
  assert.ok(!/value|secret|token|input\.value/.test(logged[1]), "no user value in the log line");
});

test("every path that swaps the visible conversation ends the turn locally", () => {
  // The `agentWorking` half of the fence is only load-bearing because these do.
  // If one of them stops calling endTurnLocally(), the fence silently weakens.
  for (const fn of ["function loadThread(t) {", "function newChat({ notifyBackend = true } = {}) {"]) {
    const start = panelSrc.indexOf(fn);
    assert.notEqual(start, -1, `could not locate ${fn}`);
    const body = panelSrc.slice(start, start + 3000);
    assert.ok(body.includes("endTurnLocally();"), `${fn} must call endTurnLocally()`);
  }
  assert.ok(
    /agentWorking = false;\n +localEndAt = Date\.now\(\);/.test(panelSrc),
    "endTurnLocally must clear agentWorking",
  );
});

test("onTurn still captures the live turn's owner and clears it on done", () => {
  assert.ok(
    /agentWorking = true;[\s\S]{0,400}?liveTurnThreadId = thread\?\.id \?\? null;/.test(panelSrc),
    "turn start must capture the owning conversation",
  );
  assert.ok(
    /else if \(state === "done"\) \{[\s\S]*?agentWorking = false;[\s\S]*?liveTurnThreadId = null;/.test(panelSrc),
    "turn end must clear the owner",
  );
});

/**
 * Instantiate the REAL fence + the REAL onAsk/onSecret bodies over mutable
 * closure state, with every collaborator stubbed. Returns the host handlers, a
 * state setter, and the paint log.
 */
function buildHandlers() {
  const painted = [];
  const warnings = [];
  const factory = new Function(
    "deps",
    `
    const { classifyInteractiveCard, refusedInteractiveCardError, paintQuestion, paintSecret,
            bumpThinking, noteActivity, lsSet, SECRET_SET_AT_PREFIX, console } = deps;
    let agentWorking = false;
    let liveTurnThreadId = null;
    let thread = null;
    let pendingSecretRequest = null;
    ${fenceMatch[0]}
    const host = {
      ${onAskSrc}
      ${onSecretSrc}
    };
    return {
      host,
      setState(s) {
        agentWorking = s.agentWorking;
        liveTurnThreadId = s.turnThreadId ?? null;
        thread = s.shownThreadId ? { id: s.shownThreadId } : null;
      },
      armSettingsRequest(req) { pendingSecretRequest = req; },
      pendingSecretRequest: () => pendingSecretRequest,
    };
  `,
  );
  const built = factory({
    classifyInteractiveCard,
    refusedInteractiveCardError,
    paintQuestion: (msg) => {
      painted.push({ card: "question", question: msg.question });
      return Promise.resolve("typed-answer");
    },
    paintSecret: (msg) => {
      painted.push({ card: "secret", label: msg.label });
      return Promise.resolve("typed-answer");
    },
    bumpThinking: () => painted.push({ card: "thinking-bump" }),
    noteActivity: () => painted.push({ card: "activity" }),
    lsSet: () => painted.push({ card: "settings-marker" }),
    SECRET_SET_AT_PREFIX: "cmcp.secretSetAt.",
    console: { warn: (m) => warnings.push(m) },
  });
  return { ...built, painted, warnings };
}

test("NORMAL PATH: a live turn in the conversation on screen still paints and resolves", async () => {
  const h = buildHandlers();
  h.setState({ agentWorking: true, turnThreadId: "t-A", shownThreadId: "t-A" });

  assert.equal(await h.host.onAsk({ question: "Which sampler?" }), "typed-answer");
  assert.equal(await h.host.onSecret({ label: "Paste your API token" }), "typed-answer");

  assert.deepEqual(
    h.painted.map((p) => p.card),
    ["question", "thinking-bump", "activity", "secret", "thinking-bump"],
    "both cards paint and keep the working indicator alive, exactly as before",
  );
  assert.equal(h.warnings.length, 0, "the normal path is silent");
});

test("NORMAL PATH: a turn started before any conversation existed still paints", async () => {
  const h = buildHandlers();
  h.setState({ agentWorking: true, turnThreadId: null, shownThreadId: null });
  assert.equal(await h.host.onSecret({ label: "Paste your API token" }), "typed-answer");
  assert.deepEqual(h.painted.map((p) => p.card), ["secret", "thinking-bump"]);
});

/**
 * Exactly what the bridge's command handler does with these two: `await` the
 * host callback inside a try/catch and turn a throw into the reply the AGENT
 * receives. Using it here means the assertions are about the wire reply, not
 * about whether the fence happens to throw synchronously or asynchronously.
 */
async function dispatch(fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

test("LOAD-BEARING: an abandoned turn's secure input is NOT painted into the visible conversation", async () => {
  // The reported defect. The user interrupted / started a new chat, so
  // endTurnLocally() cleared agentWorking; the superseded turn's request_secret
  // lands a moment later while conversation t-B is on screen.
  const h = buildHandlers();
  h.setState({ agentWorking: false, turnThreadId: "t-A", shownThreadId: "t-B" });

  const reply = await dispatch(() => h.host.onSecret({ label: "Paste your API token" }));
  assert.equal(reply.ok, false, "the agent gets a failure, not silence and not a fabricated success");
  assert.match(reply.error, /request_secret/);
  assert.match(reply.error, /nothing was collected/i);
  assert.deepEqual(h.painted, [], "no card, no indicator bump — nothing reached the screen");
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /no_live_turn/);
});

test("LOAD-BEARING: a live turn's secure input is NOT painted into a conversation it does not own", async () => {
  // detachInvalidCurrentThread(): another tab deleted the active conversation and
  // this tab rebound to a replacement mid-turn, without ending the turn.
  const h = buildHandlers();
  h.setState({ agentWorking: true, turnThreadId: "t-A", shownThreadId: "t-B" });

  const reply = await dispatch(() => h.host.onSecret({ label: "Paste your API token" }));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /different conversation than the one on screen/i);
  assert.deepEqual(h.painted, []);
  assert.match(h.warnings[0], /other_conversation/);
});

test("LOAD-BEARING: the same fence applies to the question card", async () => {
  const h = buildHandlers();
  h.setState({ agentWorking: false, turnThreadId: "t-A", shownThreadId: "t-B" });
  const reply = await dispatch(() => h.host.onAsk({ question: "Which sampler?" }));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /ask_user/);
  assert.deepEqual(h.painted, [], "no question card, and no revived working indicator");
});

test("a refused secret clears the Settings marker instead of arming it for the next one", async () => {
  const h = buildHandlers();
  h.armSettingsRequest({ key: "SOME_PROVIDER_KEY" });
  h.setState({ agentWorking: false, turnThreadId: null, shownThreadId: "t-B" });

  assert.equal((await dispatch(() => h.host.onSecret({ label: "Paste your API token" }))).ok, false);
  assert.equal(h.pendingSecretRequest(), null, "a refused request must not leave the slot armed");

  // The NEXT (legitimate) secret must therefore not be attributed to that button.
  h.setState({ agentWorking: true, turnThreadId: "t-B", shownThreadId: "t-B" });
  await h.host.onSecret({ label: "Paste your API token" });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(
    !h.painted.some((p) => p.card === "settings-marker"),
    "no stale set-at marker is written for an unrelated later secret",
  );
});
