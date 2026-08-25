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
// #1145 — the shipped onTurn("working") body scopes the mid-task nudge's outage
// evidence to the turn it starts, so the lifecycle harness below has to supply the
// real tracker along with the rest of onTurn's closure.
import { createBridgeOutageTracker } from "../../web/js/lib/session-rebind.js";

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
  // Owner and screen are both null — there is no other conversation for such a
  // turn to leak into.
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: true, turnThreadId: null, shownThreadId: null }),
    { paint: true, reason: null },
  );
});

test("an owner-less turn paints into the conversation IT minted", () => {
  // Gate round 2: the turn began on a blank view (owner null), then its own
  // progress `say` ran record(), which minted the conversation now on screen.
  // That conversation IS this turn's. Refusing it was a real false refusal.
  assert.deepEqual(
    classifyInteractiveCard({
      agentWorking: true,
      turnThreadId: null,
      shownThreadId: "t-new",
      mintedThreadId: "t-new",
    }),
    { paint: true, reason: null },
  );
});

test("an owner-less turn does NOT paint into a conversation it merely FOUND on screen", () => {
  // The hole the other direction would open: loadThread()'s cross-workflow
  // BLOCKED branch calls detachInvalidCurrentThread({rebind:true}) and returns
  // WITHOUT endTurnLocally(), so a conversation this turn never created can land
  // on screen under a thread-less live turn.
  assert.deepEqual(
    classifyInteractiveCard({
      agentWorking: true,
      turnThreadId: null,
      shownThreadId: "t-other",
      mintedThreadId: null,
    }),
    { paint: false, reason: "other_conversation" },
  );
});

test("gate round 3: a NEWER conversation from another tab is still not this turn's", () => {
  // Age is not provenance. Tab B creates a conversation AFTER this turn began; it
  // syncs into this tab's history and detachInvalidCurrentThread() rebinds it onto
  // the screen. A "created after the turn started" rule would have painted a
  // secure input into the other tab's conversation. Provenance does not.
  assert.deepEqual(
    classifyInteractiveCard({
      agentWorking: true,
      turnThreadId: null,
      shownThreadId: "t-from-other-tab",
      mintedThreadId: null, // this tab minted nothing during this turn
    }),
    { paint: false, reason: "other_conversation" },
  );
  // And even when this turn HAS minted one, only that exact one qualifies.
  assert.deepEqual(
    classifyInteractiveCard({
      agentWorking: true,
      turnThreadId: null,
      shownThreadId: "t-from-other-tab",
      mintedThreadId: "t-mine",
    }),
    { paint: false, reason: "other_conversation" },
  );
});

test("an owner-less turn fails CLOSED when there is no mint to point at", () => {
  const base = { agentWorking: true, turnThreadId: null, shownThreadId: "t-x" };
  for (const extra of [{}, { mintedThreadId: null }, { mintedThreadId: undefined }, { mintedThreadId: "t-y" }]) {
    assert.deepEqual(
      classifyInteractiveCard({ ...base, ...extra }),
      { paint: false, reason: "other_conversation" },
      `must fail closed for ${JSON.stringify(extra)}`,
    );
  }
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

test("live turn owned by a conversation, screen has none → refused", () => {
  // detachInvalidCurrentThread() with no replacement: another tab deleted the
  // conversation this turn belongs to.
  assert.deepEqual(
    classifyInteractiveCard({ agentWorking: true, turnThreadId: "t-A", shownThreadId: null }),
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
    "an absent owner against a real conversation, with no timestamps, must not paint",
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
        /ask again after the user's next message/i.test(text),
        "gives a next step that actually works",
      );
      assert.ok(
        /do not retry this in a loop/i.test(text),
        "tells the agent not to spin on an immediate retry",
      );
      assert.ok(!/\bok\b|succe/i.test(text.split(":")[0]), "the opening clause never reads as success");
    });
  }
}

test("the no-live-turn refusal states an OBSERVATION, never an unobserved cause", () => {
  // Gate round 1: the wording used to assert the turn "has already ended", which
  // is the usual cause but not the only one — a turn start the panel has not
  // registered yet produces the identical observation. command-liveness.js's rule
  // is "reports what we OBSERVED, never a guess"; this must follow it.
  const text = refusedInteractiveCardError("request_secret", "no_live_turn");
  assert.ok(/has no turn in flight/.test(text), "states what was observed");
  assert.ok(/not a diagnosis/i.test(text), "explicitly disclaims the cause");
  assert.ok(
    !/\bhas already ended\b/.test(text),
    "must not assert a cause the panel did not observe",
  );
});

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
  // #952 threaded the painting socket id through these callbacks, so they take a second
  // parameter now. Matched on the NAME and an open paren, so a later parameter cannot
  // break a guard that is about the fence rather than the signature.
  const re = new RegExp(`\\n {4}${name}\\(msg[^)]*\\) \\{[\\s\\S]*?\\n {4}\\},`);
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

test("the fence reads every input from live panel state", () => {
  const src = fenceMatch[0];
  assert.ok(/agentWorking,/.test(src), "reads the live-turn flag");
  assert.ok(/turnThreadId: liveTurnThreadId/.test(src), "reads the live turn's owner");
  assert.ok(/shownThreadId: thread\?\.id \?\? null/.test(src), "reads the conversation on screen");
  assert.ok(/mintedThreadId: lastMintedThreadId/.test(src), "reads what this turn minted");
});

/** The body of a top-level `function <name>(` in the panel, to its closing brace. */
function panelFunctionBody(name) {
  const start = panelSrc.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `could not locate function ${name}`);
  const end = panelSrc.indexOf("\n  }\n", start);
  assert.ok(end > start, `could not find the end of ${name}`);
  return panelSrc.slice(start, end);
}

test("the owner-less rule is PROVENANCE: record()'s mint is lastMintedThreadId's only writer", () => {
  // The whole rule rests on lastMintedThreadId meaning "record() created this
  // conversation during the turn now running". Two things make that true, and both
  // are pinned here so a future edit fails loudly instead of quietly turning the
  // check into a rubber stamp:
  //   1. every assignment to it is either record()'s mint or onTurn's reset;
  //   2. the mint assignment really is inside record(), in the branch that creates
  //      the thread.
  // Match ANY assignment form, not just `=` — a later `lastMintedThreadId ||=
  // replacement.id` in a rebind path would otherwise slip past this enumeration
  // and let a conversation nobody minted vouch for itself. `(?!=)` keeps `==`,
  // `===` and `!==` comparisons out.
  const writes = [...panelSrc.matchAll(/lastMintedThreadId\s*(?:\|\||\?\?|&&|[+\-*/%])?=(?!=)([^;]*);/g)]
    .map((m) => m[1].trim());
  assert.deepEqual(
    writes.sort(),
    ["null", "null", "thread.id"],
    "exactly one mint write plus the declaration and the turn-start reset — in any assignment form",
  );

  const record = panelFunctionBody("record");
  // Sanity-check the slice really spans record(), so the assertions below are not
  // quietly passing against a truncated body.
  assert.ok(record.includes("if (!thread) {"), "slice covers record()'s mint branch");
  assert.ok(record.includes('if (entry.role === "user") {'), "slice reaches past the mint branch");
  // Bound the mint branch to ITS OWN block (from `if (!thread) {` to that block's
  // own 4-space closing brace) rather than letting a lazy `[\s\S]*?` wander past
  // it — an assignment moved into a SIBLING branch must fail this, not slip
  // through because the regex spanned the brace.
  const branchStart = record.indexOf("    if (!thread) {");
  assert.notEqual(branchStart, -1, "record()'s mint branch starts at a 4-space `if (!thread) {`");
  const branchEnd = record.indexOf("\n    }\n", branchStart);
  assert.ok(branchEnd > branchStart, "the mint branch closes at its own 4-space brace");
  const mintBranch = record.slice(branchStart, branchEnd);
  assert.ok(
    mintBranch.includes("lastMintedThreadId = thread.id;"),
    "the mint write lives inside record()'s thread-creation branch, not a sibling one",
  );
  // …and nowhere else in record(), so a later branch can't claim a conversation
  // record() merely rebound.
  assert.equal(
    (record.match(/lastMintedThreadId = /g) || []).length,
    1,
    "record() assigns lastMintedThreadId exactly once",
  );

  // Scope the reset pin to the INSIDE of the "working" branch — a reset hoisted
  // above the branch would also fire on `done`, which is a different (and weaker)
  // meaning for the marker than "since this turn began".
  const workingOpen = onTurnSrc.indexOf('if (state === "working") {');
  const workingClose = onTurnSrc.indexOf('} else if (state === "done")');
  assert.ok(workingOpen > -1 && workingClose > workingOpen, "onTurn's working branch is where expected");
  const workingBranch = onTurnSrc.slice(workingOpen, workingClose);
  assert.ok(
    /lastMintedThreadId = null;/.test(workingBranch),
    "onTurn('working') resets it INSIDE its own branch, so it always describes the turn now running",
  );
  // record() must NOT retroactively adopt the minted thread as the turn OWNER —
  // if it did, #381's liveTurnThreadId semantics would change under it and this
  // rule would be dead code pretending to guard.
  //
  // Matched as an ASSIGNMENT rather than a mention (mcp#884). Reading the turn
  // owner inside record() is legitimate and now happens: the abandoned-turn
  // output fence consults it to drop a straggler that belongs to a conversation
  // no longer on screen. A bare substring test also failed on the COMMENT that
  // explains that fence, which is the prose-predicate trap — it would have been
  // "fixed" by renaming a comment, leaving the real rule unguarded. The forms
  // enumerated here are the same ones the write-enumeration above accepts, so a
  // `liveTurnThreadId ||= thread.id` smuggled into record() still fails.
  const ownerWrites = [
    ...record.matchAll(/liveTurnThreadId\s*(?:\|\||\?\?|&&|[+\-*/%])?=(?!=)([^;]*);/g),
  ].map((m) => m[1].trim());
  assert.deepEqual(ownerWrites, [], "record() does not write the turn owner");
});

test("loadThread's BLOCKED cross-workflow branch is why the owner-less rule needs provenance", () => {
  // It calls detachInvalidCurrentThread({rebind:true}) and RETURNS without
  // endTurnLocally(), so a conversation this turn never created can appear under a
  // thread-less live turn. Pin the shape — if this branch ever starts ending the
  // turn, the mint rule becomes belt-and-braces rather than load-bearing, and
  // whoever relaxes it should see this test.
  const start = panelSrc.indexOf("function loadThread(t) {");
  const blocked = panelSrc.slice(start, panelSrc.indexOf("endTurnLocally();", start));
  assert.ok(
    blocked.includes("detachInvalidCurrentThread({ scopeKey, rebind: true });"),
    "the blocked branch rebinds the visible conversation",
  );
  assert.ok(blocked.includes("return false;"), "and returns before endTurnLocally()");
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
    let lastMintedThreadId = null;
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
        lastMintedThreadId = s.mintedThreadId ?? null;
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

// ---------------------------------------------------------------------------
// 4. the REAL lifecycle → the REAL fence
//
// Gate round 1 (MINOR) was right that section 3 injects idealised state and so
// proves the predicate rather than shipped lifecycle behaviour. This section
// wires the ACTUAL `onTurn` and `endTurnLocally` bodies to the ACTUAL fence and
// handlers, so the chain that decides `agentWorking` / `liveTurnThreadId` is the
// shipped one — including the straggler guard, whose two edges are pinned below
// as KNOWN, documented outcomes rather than accidents.
// ---------------------------------------------------------------------------

const endTurnLocallyMatch = panelSrc.match(/\n {2}function endTurnLocally\(\) \{[\s\S]*?\n {2}\}/);
assert.ok(endTurnLocallyMatch, "could not locate endTurnLocally in the panel source");
const onTurnSrc = (() => {
  const m = panelSrc.match(/\n {4}onTurn\(state\) \{[\s\S]*?\n {4}\},/);
  assert.ok(m, "could not locate onTurn in the panel source");
  return m[0];
})();
const guardMs = Number(panelSrc.match(/const STALE_WORKING_GUARD_MS = (\d+);/)?.[1]);
assert.ok(Number.isFinite(guardMs) && guardMs > 0, "could not read STALE_WORKING_GUARD_MS");

/** The real endTurnLocally + onTurn + fence + handlers over one shared closure. */
function buildLifecycle() {
  const painted = [];
  const factory = new Function(
    "deps",
    `
    const { classifyInteractiveCard, refusedInteractiveCardError, paintQuestion, paintSecret,
            bumpThinking, noteActivity, lsSet, SECRET_SET_AT_PREFIX, console,
            showThinking, hideThinking, ssSet, MID_TASK_KEY, getGraphCtx, workflowStableUuid,
            STALE_WORKING_GUARD_MS, now, bridgeOutage } = deps;
    let agentWorking = false;
    let liveTurnThreadId = null;
    let lastMintedThreadId = null;
    let thread = null;
    let localEndAt = 0;
    let pendingSecretRequest = null;
    let lastAgentGraph = null, lastAgentGraphKey = null, lastAgentGraphEpoch = null, sessionEpoch = 0;
    const completeDedicatedWorkflowSessionSwap = () => {};
    const settlePendingDedicatedWorkflowSwapAfterCancellation = () => {};
    const Date = { now };
    ${endTurnLocallyMatch[0]}
    ${fenceMatch[0]}
    const host = {
      ${onTurnSrc}
      ${onAskSrc}
      ${onSecretSrc}
    };
    return {
      host,
      endTurnLocally,
      // A conversation that merely APPEARS on screen: paintThread() /
      // detachInvalidCurrentThread()'s rebind / the restore path. record() was
      // never involved, so the mint marker is untouched.
      showConversation(id) { thread = id ? { id } : null; },
      // What record()'s mint branch does: create the conversation AND stamp it as
      // the one minted here.
      mintConversation(id) { thread = { id }; lastMintedThreadId = id; },
      state: () => ({ agentWorking, liveTurnThreadId, shown: thread?.id ?? null }),
    };
  `,
  );
  let clock = 100000;
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
    bumpThinking: () => {},
    noteActivity: () => {},
    lsSet: () => {},
    SECRET_SET_AT_PREFIX: "cmcp.secretSetAt.",
    console: { warn: () => {} },
    showThinking: () => {},
    hideThinking: () => {},
    ssSet: () => {},
    MID_TASK_KEY: "cmcp.midTask",
    getGraphCtx: () => ({ rootGraph: { serialize: () => ({}) } }),
    workflowStableUuid: () => "wf-1",
    STALE_WORKING_GUARD_MS: guardMs,
    now: () => clock,
    // #1145 — onTurn("working") scopes the mid-task nudge's outage evidence to the turn
    // it is starting. The REAL tracker, on this harness's clock, so the injected surface
    // stays the shipped one rather than a stub that would keep passing if the call
    // changed shape (this section exists to run the shipped lifecycle, not a copy of it).
    bridgeOutage: createBridgeOutageTracker({ now: () => clock }),
  });
  return { ...built, painted, tick: (ms) => { clock += ms; }, at: () => clock };
}

test("LIFECYCLE: a real turn start in the shown conversation lets the real handlers paint", async () => {
  const h = buildLifecycle();
  h.showConversation("t-A");
  h.host.onTurn("working");
  assert.deepEqual(h.state(), { agentWorking: true, liveTurnThreadId: "t-A", shown: "t-A" });

  assert.equal(await h.host.onSecret({ label: "Paste your API token" }), "typed-answer");
  assert.equal(await h.host.onAsk({ question: "Which sampler?" }), "typed-answer");
  assert.deepEqual(h.painted.map((p) => p.card), ["secret", "question"]);
});

test("LIFECYCLE: the real interrupt path (endTurnLocally) makes the real handlers refuse", async () => {
  // The reported defect, end to end through shipped code: turn starts in A, the
  // user interrupts (Esc / Disconnect / cancel all route here), the user opens
  // conversation B, and A's superseded request_secret lands.
  const h = buildLifecycle();
  h.showConversation("t-A");
  h.host.onTurn("working");
  h.endTurnLocally();
  h.showConversation("t-B");

  const reply = await dispatch(() => h.host.onSecret({ label: "Paste your API token" }));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /request_secret/);
  assert.deepEqual(h.painted, [], "the secure input never reached conversation B");
});

test("LIFECYCLE: a turn that starts blank and MINTS its conversation still paints", async () => {
  // Gate round 2's false refusal, through the shipped onTurn + fence: the turn
  // begins on an empty view, its own output mints the conversation, then it asks.
  const h = buildLifecycle();
  h.showConversation(null);
  h.host.onTurn("working");
  h.tick(40);
  h.mintConversation("t-new"); // what record() does on the turn's first output
  assert.deepEqual(h.state(), { agentWorking: true, liveTurnThreadId: null, shown: "t-new" });

  assert.equal(await h.host.onSecret({ label: "Paste your API token" }), "typed-answer");
  assert.deepEqual(h.painted.map((p) => p.card), ["secret"]);
});

test("LIFECYCLE: a blank-start turn is refused against a conversation it did not mint", async () => {
  // loadThread()'s blocked cross-workflow branch: detach rebinds a conversation
  // onto the screen without ending the turn. Gate round 3: this covers the
  // cross-tab case too — that conversation may be NEWER than the turn and is
  // still not the turn's, because record() never ran for it here.
  const h = buildLifecycle();
  h.showConversation(null);
  h.host.onTurn("working");
  h.tick(50);
  h.showConversation("t-from-elsewhere"); // appeared; not minted here

  const reply = await dispatch(() => h.host.onSecret({ label: "Paste your API token" }));
  assert.equal(reply.ok, false);
  assert.match(reply.error, /different conversation/i);
  assert.deepEqual(h.painted, []);
});

test("LIFECYCLE: the mint marker does not survive into the NEXT turn", async () => {
  // onTurn('working') resets it, so a conversation minted by an earlier turn
  // cannot vouch for a later owner-less one that merely finds it on screen.
  const h = buildLifecycle();
  h.showConversation(null);
  h.host.onTurn("working");
  h.mintConversation("t-1");
  h.host.onTurn("done");

  // A later turn starts while nothing is shown, then t-1 is rebound onto screen.
  h.showConversation(null);
  h.host.onTurn("working");
  h.showConversation("t-1");
  assert.equal((await dispatch(() => h.host.onSecret({ label: "Paste your API token" }))).ok, false);
  assert.deepEqual(h.painted, []);
});

test("LIFECYCLE: an interrupted turn cannot resurrect a secure input in its OWN conversation", async () => {
  // The purest statement of the `agentWorking` half, and the same class onThinking
  // already guards: the user dismissed this turn, so its trailing card must not
  // come back — even though the conversation on screen never changed.
  const h = buildLifecycle();
  h.showConversation("t-A");
  h.host.onTurn("working");
  h.endTurnLocally();

  const reply = await dispatch(() => h.host.onSecret({ label: "Paste your API token" }));
  assert.equal(reply.ok, false);
  assert.deepEqual(h.painted, []);
});

test("LIFECYCLE: a real turn:done makes the real handlers refuse a trailing card", async () => {
  const h = buildLifecycle();
  h.showConversation("t-A");
  h.host.onTurn("working");
  h.host.onTurn("done");
  assert.deepEqual(h.state(), { agentWorking: false, liveTurnThreadId: null, shown: "t-A" });

  assert.equal((await dispatch(() => h.host.onAsk({ question: "Which sampler?" }))).ok, false);
  assert.deepEqual(h.painted, []);
});

test("LIFECYCLE: a fresh turn AFTER the straggler-guard window paints normally", async () => {
  // The common interrupt-then-send-again shape: past the guard, onTurn accepts
  // the new turn and the fence follows it.
  const h = buildLifecycle();
  h.showConversation("t-A");
  h.host.onTurn("working");
  h.endTurnLocally();
  h.tick(guardMs + 1);
  h.host.onTurn("working");
  assert.equal(await h.host.onSecret({ label: "Paste your API token" }), "typed-answer");
  assert.deepEqual(h.painted.map((p) => p.card), ["secret"]);
});

test("KNOWN RESIDUAL: a turn start swallowed by the straggler guard is refused, not misrouted", async () => {
  // Gate round 1 (IMPORTANT). onTurn discards ANY turn:working inside
  // STALE_WORKING_GUARD_MS of a local end — including a genuinely fresh turn the
  // orchestrator released from the queue right after an interrupt. `agentWorking`
  // therefore stays false and the card is refused.
  //
  // This is pinned, not fixed: closing it needs a turn id on the wire (see the
  // header of interactive-card-fence.js). What IS asserted is the direction of
  // the failure — an explicit, honest error, never a card painted into the wrong
  // conversation, and never a fabricated success.
  const h = buildLifecycle();
  h.showConversation("t-A");
  h.host.onTurn("working");
  h.endTurnLocally();
  h.tick(Math.max(1, guardMs - 1));
  h.host.onTurn("working"); // the queued turn's real start — swallowed by the guard
  assert.equal(h.state().agentWorking, false, "shipped onTurn drops it; the fence only reads the result");

  const reply = await dispatch(() => h.host.onSecret({ label: "Paste your API token" }));
  assert.equal(reply.ok, false, "fails closed");
  assert.match(reply.error, /nothing was collected/i, "and says so honestly");
  assert.ok(
    !/has already ended/.test(reply.error),
    "and does NOT claim a cause that is wrong in exactly this case",
  );
  assert.deepEqual(h.painted, []);
});

test("KNOWN RESIDUAL: a straggler turn:working past the guard re-authorizes the shown conversation", async () => {
  // Gate round 1 (SEVERE). The mirror image, pinned for the same reason: the
  // `turn` frame carries no turn identity, so a late working frame from an ENDED
  // turn is indistinguishable from a fresh one and onTurn adopts the conversation
  // then on screen. The fence cannot see behind that.
  //
  // Recorded so the residual is visible and so a future turn-id on the wire has a
  // test to flip. Note the pre-fix behaviour was strictly worse: on origin/main
  // the card painted with NO precondition at all.
  const h = buildLifecycle();
  h.showConversation("t-A");
  h.host.onTurn("working");
  h.endTurnLocally();
  h.showConversation("t-B");
  h.tick(guardMs + 1);
  h.host.onTurn("working"); // indistinguishable from a fresh turn in B
  assert.equal(h.state().liveTurnThreadId, "t-B");
  assert.equal(await h.host.onSecret({ label: "Paste your API token" }), "typed-answer");
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
