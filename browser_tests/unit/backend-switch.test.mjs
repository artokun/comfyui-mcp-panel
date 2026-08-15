// #1184 — a backend switch must not commit anything until the switch is legal.
//
// `connectBackend()` committed the new backend to memory, to localStorage and to the UI and
// only then checked whether the old provider's session could be durably invalidated. When
// that check failed it returned, leaving the panel claiming a backend it never connected to
// — and `STORAGE_KEY_BACKEND` outlives the tab, so a reload adopted the aborted choice for
// good.
//
// THESE TESTS ASSERT ORDER, NOT JUST OUTCOME. That distinction is the whole point: the
// buggy version reached the same final state on every successful switch, so any test that
// only checks the end state passes against it. What it got wrong was WHEN each write
// happened relative to the guard.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BACKEND_SWITCH, planBackendHandover, runBackendSwitch } from "../../web/js/lib/backend-switch.js";

const PANEL_SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);

/**
 * Effects that record the ORDER they were called in.
 *
 * Every commit the panel performs is represented, because each is a distinct piece of
 * leaked state and asserting on a sampled subset is how five of six leaks stay invisible.
 */
function recorder({
  live = "claude",
  picked = "claude",
  invalidate = async () => true,
  replay = "prior chat",
  // mcp#884 — what the STORE says the incoming backend already has. Defaults to
  // false ("no conversation yet"), which is the pre-mcp#884 world every test
  // below was written against, so their meaning is unchanged.
  incomingHasConversation = false,
} = {}) {
  const log = [];
  // Recorded OFF the ordered log on purpose. These two are queries, not commits;
  // logging them would shift every positional assertion in this file and make a
  // behavioural change look like an ordering regression.
  const invalidateOpts = [];
  const askedAbout = [];
  let liveBackend = live;
  const effects = {
    liveBackend: () => liveBackend,
    pickedBackend: () => picked,
    incomingHasConversation: (b) => {
      askedAbout.push(b);
      return incomingHasConversation;
    },
    invalidate: async (opts) => {
      invalidateOpts.push(opts);
      log.push("invalidate");
      return invalidate();
    },
    // ARGUMENTS RECORDED, not just names. A recorder that logs only the effect name lets
    // the module hand the WRONG backend id to every commit while the whole suite passes —
    // it would prove the order and nothing about what was ordered.
    seedPrefs: (b) => log.push(`seedPrefs:${b}`),
    commitSelection: (b) => log.push(`commitSelection:${b}`),
    endTurn: () => log.push("endTurn"),
    buildReplay: () => {
      log.push("buildReplay");
      return replay;
    },
    // The ARGUMENT matters now: `armContext(null)` is the CLEAR (mcp#884), and a
    // recorder that logged both as "armContext" would let arming the outgoing
    // transcript into the incoming conversation pass as a clear.
    armContext: (ctx) => log.push(ctx == null ? "clearContext" : "armContext"),
    teardownAndConnect: () => log.push("teardownAndConnect"),
    disclose: (reason) => log.push(`disclose:${reason}`),
  };
  return { log, effects, invalidateOpts, askedAbout, setLive: (b) => { liveBackend = b; } };
}

/**
 * Every effect that COMMITS to the NEW backend. None may run before the switch is legal.
 *
 * `endTurn` is deliberately NOT here. It is not a commit to the new backend — it retires a
 * turn on the OLD one, and it has to run on the abort paths too, because
 * `invalidateDurableAgentSession` destroys the session pointer BEFORE it reports whether it
 * succeeded. A turn whose session id is already gone cannot resume, so leaving MID_TASK_KEY
 * armed would make the mid-task nudge fire into a fresh empty session claiming full context.
 */
const COMMITS = ["seedPrefs", "commitSelection", "buildReplay", "armContext", "teardownAndConnect"];
/** Effects are logged as `name` or `name:arg`; match on the name half. */
const at = (log, name) => log.findIndex((e) => e === name || e.startsWith(`${name}:`));
const ran = (log, name) => at(log, name) !== -1;

test("#1184 a failed invalidate commits NOTHING — asserted on every effect, not a sample", async () => {
  const { log, effects } = recorder({ live: "claude", invalidate: async () => false });
  const result = await runBackendSwitch("codex", effects);

  assert.deepEqual(result, { switched: false, reason: BACKEND_SWITCH.INVALIDATE_FAILED });
  // The exact sequence: ask, then say so. Nothing else.
  // endTurn between them, and that is the point: the invalidate already destroyed the
  // session pointer, so the turn is unresumable whatever the boolean said.
  assert.deepEqual(log, ["invalidate", "endTurn", `disclose:${BACKEND_SWITCH.INVALIDATE_FAILED}`]);
  // …and stated per effect, so a failure names the leak rather than a diff of two arrays.
  for (const effect of COMMITS) {
    assert.ok(!ran(log, effect), `${effect} ran despite the switch being illegal`);
  }
});

test("#1184 the invalidate happens BEFORE every commit, not after them", async () => {
  // The regression test proper. The old order produced this same final state, so only the
  // relative positions distinguish the fix from the bug.
  const { log, effects } = recorder({ live: "claude" });
  const result = await runBackendSwitch("codex", effects);

  assert.deepEqual(result, { switched: true, reason: BACKEND_SWITCH.SWITCHED });
  assert.equal(log[0], "invalidate", "the legality check must come first");
  for (const effect of COMMITS) {
    const i = at(log, effect);
    assert.ok(i > 0, `${effect} must run on a successful switch`);
    assert.ok(i > log.indexOf("invalidate"), `${effect} committed BEFORE the invalidate — this is the defect`);
  }
  // …and every commit must be told the backend the CALLER asked for. Order without
  // identity is half a proof: the module could commit a different id in the right order.
  assert.ok(log.includes("commitSelection:codex"), `the selection committed was not codex: ${log}`);
  assert.ok(log.includes("seedPrefs:codex"), `prefs were seeded for the wrong backend: ${log}`);
  assert.equal(log[log.length - 1], "teardownAndConnect", "the connect must be last");
});

test("#1184 a NON-switch never consults the history store", async () => {
  // A first connect and a re-pick of the live backend are not switches, and gating them on
  // the history store would make an unrelated IndexedDB hiccup block connecting at all.
  for (const [label, live] of [["first connect", null], ["re-pick of the live backend", "codex"]]) {
    const { log, effects } = recorder({ live, invalidate: async () => false });
    const result = await runBackendSwitch("codex", effects);

    assert.equal(result.switched, false, `${label}: not a switch`);
    assert.equal(result.reason, BACKEND_SWITCH.CONNECTED, `${label}: but it DID connect`);
    assert.ok(!ran(log, "invalidate"), `${label}: must not invalidate`);
    assert.ok(ran(log, "commitSelection"), `${label}: must still commit the selection`);
    assert.ok(ran(log, "teardownAndConnect"), `${label}: must still connect`);
    // Session-scoped work belongs to a switch only.
    assert.ok(!ran(log, "endTurn"), `${label}: no turn to end`);
    assert.ok(!ran(log, "armContext"), `${label}: nothing to replay`);
  }
});

test("#1184 a handshake landing during the invalidate does NOT discard the user's pick", async () => {
  // The first version of this guard ABORTED here, and that was worse than the race it
  // guarded. By this point the invalidate has run, so the session is already destroyed —
  // aborting left the user with a dead session, no connect, and their explicit click
  // silently dropped. A handshake that merely happened to land during the await must not
  // beat an explicit pick.
  const rec = recorder({ live: "claude" });
  rec.effects.invalidate = async () => {
    rec.log.push("invalidate");
    rec.setLive("gemini"); // an unrelated handshake completes mid-await
    return true;
  };
  const result = await runBackendSwitch("codex", rec.effects);

  assert.deepEqual(result, { switched: true, reason: BACKEND_SWITCH.SWITCHED });
  assert.ok(ran(rec.log, "commitSelection:codex"), "the pick the user made must still be committed");
  assert.ok(ran(rec.log, "teardownAndConnect"), "…and it must actually connect, not strand the panel");
  assert.ok(ran(rec.log, "endTurn"), "the destroyed session leaves no resumable turn");
});

test("#1184 a handshake that landed on the TARGET stops it being a switch", async () => {
  // The case the re-read actually exists for. If the handshake landed on the very backend
  // being asked for, the new provider already holds the conversation — arming the
  // "continued in a fresh AI session" preamble against it would replay the whole transcript
  // to the session that is already carrying it, which is the #1184 leak by another route.
  const rec = recorder({ live: "claude", replay: "User: hi" });
  rec.effects.invalidate = async () => {
    rec.log.push("invalidate");
    rec.setLive("codex"); // the handshake landed on the target
    return true;
  };
  const result = await runBackendSwitch("codex", rec.effects);

  assert.equal(result.switched, false, "already on codex — this is no longer a switch");
  assert.equal(result.reason, BACKEND_SWITCH.CONNECTED);
  assert.ok(!ran(rec.log, "armContext"), "the target already has the conversation");
  assert.ok(ran(rec.log, "commitSelection:codex"), "the pick is still recorded");
  assert.ok(ran(rec.log, "teardownAndConnect"), "and the connect still runs");
});

test("#1184 the reseed predicate is preserved: reseed iff the target differs", async () => {
  // Seeding from the new backend's group is what stops the post-handshake push carrying the
  // previous backend's model/effort. A re-pick must NOT reseed — that would clobber a
  // user's in-session model choice.
  // `prevBackend` is `startedOn || pickedBackend()`, so BOTH halves need a case. Running
  // every case with `live: null` leaves the `startedOn` half unexercised — deleting it
  // would not fail anything, and it is the half that decides a real switch.
  const differs = recorder({ live: null, picked: "claude" });
  await runBackendSwitch("codex", differs.effects);
  assert.ok(ran(differs.log, "seedPrefs"), "no live backend: the PICK differs, so reseed");

  const same = recorder({ live: null, picked: "codex" });
  await runBackendSwitch("codex", same.effects);
  assert.ok(!ran(same.log, "seedPrefs"), "no live backend: the pick already matches, so do not reseed");

  // The `startedOn` half: a LIVE backend wins over the pick when deciding what prefs
  // currently reflect, because the handshake is authoritative and the pick may be stale.
  const liveDiffers = recorder({ live: "claude", picked: "codex" });
  await runBackendSwitch("codex", liveDiffers.effects);
  assert.ok(
    ran(liveDiffers.log, "seedPrefs"),
    "live claude vs target codex is a real switch — prefs hold claude's model/effort and must be reseeded, " +
      "even though the stale pick already said codex",
  );
});

test("#1184 the replay is built AFTER the turn ends, and only armed when non-empty", async () => {
  const withReplay = recorder({ live: "claude", replay: "User: hi" });
  await runBackendSwitch("codex", withReplay.effects);
  assert.ok(
    at(withReplay.log, "buildReplay") > at(withReplay.log, "endTurn"),
    "the transcript is captured after the turn is closed out",
  );
  assert.ok(ran(withReplay.log, "armContext"));

  const empty = recorder({ live: "claude", replay: "" });
  await runBackendSwitch("codex", empty.effects);
  assert.ok(ran(empty.log, "buildReplay"), "it still asks");
  assert.ok(!ran(empty.log, "armContext"), "…but arming an empty preamble would send a header with no chat");
});

// ---------------------------------------------------------------------------
// mcp#884 — THE HANDOVER. Both consequences of one question.
// ---------------------------------------------------------------------------

test("mcp#884 the OUTGOING backend's thread keeps its session across a switch", async () => {
  // The defect: `invalidate` cleared the outgoing THREAD's sessionId, so switching
  // back later sent `new_session` instead of resuming — the per-backend persistence
  // this branch adds, defeated by its own switch path. The tab pointer still goes;
  // only the thread's own claim is preserved.
  const rec = recorder({ live: "claude" });
  await runBackendSwitch("codex", rec.effects);

  assert.equal(rec.invalidateOpts.length, 1, "the invalidate still runs exactly once");
  assert.equal(
    rec.invalidateOpts[0]?.preserveThreadSession,
    true,
    "a backend SWITCH must not destroy the outgoing conversation's session id",
  );
});

test("mcp#884 the incoming backend's OWN conversation is never handed the outgoing transcript", async () => {
  // The other half. `loadThread` will resume the incoming backend's conversation and
  // arm its own replay if it needs one; the outgoing transcript riding in as one-shot
  // context would inject a different provider's chat into it.
  const rec = recorder({ live: "claude", incomingHasConversation: true, replay: "User: hi" });
  const result = await runBackendSwitch("codex", rec.effects);

  assert.equal(result.switched, true, "it is still a switch");
  assert.deepEqual(rec.askedAbout, ["codex"], "the STORE is asked about the INCOMING backend");
  assert.ok(!ran(rec.log, "buildReplay"), "the outgoing transcript is not even built");
  assert.ok(!ran(rec.log, "armContext"), "and nothing is armed against the incoming conversation");
  assert.ok(
    ran(rec.log, "clearContext"),
    "a context armed earlier must be CLEARED, not merely skipped — it would ride the next message",
  );
});

test("mcp#884 a backend with NO conversation still gets the fresh-chat replay", async () => {
  // The long-standing, disclosed behaviour, deliberately preserved: switching to a
  // provider you have never used starts a fresh chat carrying the prior transcript as
  // one-shot context. Only the case where the incoming backend HAS a conversation changed.
  const rec = recorder({ live: "claude", incomingHasConversation: false, replay: "User: hi" });
  await runBackendSwitch("codex", rec.effects);

  assert.deepEqual(rec.askedAbout, ["codex"]);
  assert.ok(ran(rec.log, "buildReplay"), "the transcript is built");
  assert.ok(ran(rec.log, "armContext"), "and armed into the fresh conversation");
  assert.ok(!ran(rec.log, "clearContext"), "nothing is cleared on the fresh path");
});

test("mcp#884 planBackendHandover is ONE decision, so the two halves cannot drift", () => {
  // Stated on the pure function as well as through the run, because the whole point of
  // extracting it is that session preservation and replay disposal are consequences of a
  // single question rather than two independent guards someone can fix by halves.
  assert.deepEqual(
    planBackendHandover({ switching: true, incomingHasConversation: true }),
    { preserveOutgoingSession: true, replay: "clear" },
  );
  assert.deepEqual(
    planBackendHandover({ switching: true, incomingHasConversation: false }),
    { preserveOutgoingSession: true, replay: "arm" },
  );
  // A non-switch decides nothing: no session to hand over, no replay to dispose of.
  for (const incoming of [true, false]) {
    assert.deepEqual(
      planBackendHandover({ switching: false, incomingHasConversation: incoming }),
      { preserveOutgoingSession: false, replay: "leave" },
    );
  }
  assert.deepEqual(
    planBackendHandover(),
    { preserveOutgoingSession: false, replay: "leave" },
    "called with nothing it must decide nothing, not throw",
  );
});

test("mcp#884 a NON-switch never asks the store about the incoming backend", async () => {
  // Same rule as the invalidate: a first connect and a re-pick must stay fully
  // synchronous and must not be gated on history-store state.
  const firstConnect = recorder({ live: null, picked: "claude" });
  await runBackendSwitch("codex", firstConnect.effects);
  assert.deepEqual(firstConnect.askedAbout, [], "a first connect asks nothing");
  assert.deepEqual(firstConnect.invalidateOpts, [], "and invalidates nothing");

  const rePick = recorder({ live: "codex", picked: "codex" });
  await runBackendSwitch("codex", rePick.effects);
  assert.deepEqual(rePick.askedAbout, [], "a re-pick of the live backend asks nothing");
});

// ---------------------------------------------------------------------------
// mcp#884 — the panel side of the handover, RUN rather than inspected.
//
// The tests above prove `runBackendSwitch` PASSES `preserveThreadSession`. That is
// only half a proof: an `invalidateDurableAgentSession` that ignores the option
// destroys the outgoing session exactly as before while every assertion above stays
// green. (Verified by mutation — it survived the whole suite.) So drive the shipped
// body over stubs, the same "real panel source" convention used elsewhere.
// ---------------------------------------------------------------------------

// Normalised: this checkout is CRLF and the anchor spans lines.
const PANEL_LF = PANEL_SRC.replace(/\r\n/g, "\n");
const invalidateSrc = (() => {
  const re = /\n {2}async function invalidateDurableAgentSession\([\s\S]*?\n {2}\}/g;
  const all = [...PANEL_LF.matchAll(re)];
  assert.equal(all.length, 1, `expected exactly 1 invalidateDurableAgentSession, got ${all.length}`);
  return all[0][0];
})();

test("mcp#884 the extracted invalidate really is the shipped body", () => {
  assert.match(invalidateSrc, /ssSet\(SESSION_KEY, null\)/, "slice covers the tab-pointer clear");
  assert.match(invalidateSrc, /historyStore\.flush\(\)/, "slice reaches the durability check");
});

/** The REAL invalidateDurableAgentSession over one conversation and stub effects. */
function buildInvalidate({ threadSessionId = "sess-claude-1" } = {}) {
  const thread = { id: "t-outgoing", provider: "claude", sessionId: threadSessionId, msgs: [] };
  const session = new Map([["comfyui-mcp.panel.sessionId", threadSessionId]]);
  let persists = 0;
  const factory = new Function(
    "deps",
    `
    const { ssSet, SESSION_KEY, thread, historyStore, persistThreads } = deps;
    ${invalidateSrc}
    return invalidateDurableAgentSession;
    `,
  );
  const invalidate = factory({
    ssSet: (key, value) => { session.set(key, value); },
    SESSION_KEY: "comfyui-mcp.panel.sessionId",
    thread,
    // Only the two methods the body reaches. `reviseThread` deletes a field when the
    // value is null, which is exactly what the real store does for a cleared session.
    historyStore: {
      reviseThread: (t, values) => {
        for (const [k, v] of Object.entries(values)) {
          if (v == null) delete t[k];
          else t[k] = v;
        }
        return t;
      },
      flush: async () => true,
    },
    persistThreads: () => { persists += 1; },
  });
  return { invalidate, thread, session, persists: () => persists };
}

test("mcp#884 a SWITCH preserves the outgoing conversation's session id", async () => {
  const h = buildInvalidate();
  assert.equal(await h.invalidate({ preserveThreadSession: true }), true);

  assert.equal(
    h.thread.sessionId,
    "sess-claude-1",
    "the outgoing backend's session outlives the switch — switching back must RESUME, not new_session",
  );
  // …while the backend-agnostic TAB pointer still goes, or the incoming backend would
  // adopt a session id belonging to the previous one.
  assert.equal(h.session.get("comfyui-mcp.panel.sessionId"), null, "the tab pointer is still cleared");
  assert.ok(h.persists() > 0, "and the change is persisted");
});

test("mcp#884 a RESTART/disconnect still destroys the session id", async () => {
  // The opposite case, and why this is an option rather than a removal: that session is
  // genuinely gone, so a preserved pointer would make the next resume name a session the
  // orchestrator no longer has.
  const h = buildInvalidate();
  assert.equal(await h.invalidate(), true);
  assert.equal(h.thread.sessionId, undefined, "the default is still to destroy it");
  assert.equal(h.session.get("comfyui-mcp.panel.sessionId"), null);
});

test("mcp#884 preserveThreadSession:false is explicitly the destroying case", async () => {
  const h = buildInvalidate();
  await h.invalidate({ preserveThreadSession: false });
  assert.equal(h.thread.sessionId, undefined);
});

test("#1184 WIRING: the panel delegates, and keeps no commit above the guard", () => {
  // Without this the module can be correct and dead. The panel is 1.7MB of IIFE, so this is
  // a source assertion by necessity — but it is the specific one that matters: no write to
  // the committed state may remain textually inside connectBackend.
  const at = PANEL_SRC.indexOf("async function connectBackend(id) {");
  assert.ok(at > 0, "connectBackend must be findable");
  const body = PANEL_SRC.slice(at, PANEL_SRC.indexOf("\n  }", at));

  assert.match(body, /runBackendSwitch\(id, \{/, "connectBackend must delegate the ordering to the module");

  // THE REGION THAT MATTERS: everything BEFORE the delegation. Asserting only that the
  // module is called proved nothing — the #1184 leak could be reinstated verbatim above the
  // call (write `selectedBackend`, persist STORAGE_KEY_BACKEND, then delegate) and all ten
  // tests stayed green. Verified by doing exactly that.
  // CODE ONLY. The comment above the delegation NAMES these calls while explaining what the
  // old order got wrong, so a raw text scan matched the prose and failed on correct code —
  // the same trap that has bitten several assertions in this repo.
  const preamble = body
    .slice(0, body.indexOf("runBackendSwitch(id, {"))
    .split(String.fromCharCode(10))
    .filter((l) => !l.trim().startsWith("//"))
    .join(String.fromCharCode(10));
  const LEAKS = [
    [/selectedBackend\s*=/, "the in-memory pick"],
    [/localStorage\.setItem/, "the persisted pick — this one outlives the tab"],
    [/renderBackendChips\(/, "the chip paint"],
    [/endTurnLocally\(/, "the working indicator and MID_TASK_KEY"],
    [/armContext\(/, "the one-shot replay, which client.stop() does NOT disarm"],
    [/seedPrefsForBackendSwitch\(/, "the prefs reseed"],
  ];
  for (const [re, what] of LEAKS) {
    assert.doesNotMatch(
      preamble,
      re,
      `${what} is committed BEFORE the switch is known to be legal — that is #1184, reinstated`,
    );
  }
  // The commits may only appear as INJECTED effects, i.e. inside a callback the module
  // calls after the guard — never as statements the function runs on its own.
  assert.match(body, /commitSelection: \(next\) => \{/, "the selection writes must be an injected effect");
  // mcp#884 gave the guard an argument (`preserveThreadSession`), so match the injection
  // rather than the exact old arity — and assert the options really are FORWARDED, because
  // an `(opts) => invalidateDurableAgentSession()` that drops them silently reinstates the
  // destroyed-outgoing-session defect while still looking injected.
  assert.match(
    body,
    /invalidate: \(opts\) => invalidateDurableAgentSession\(opts\)/,
    "the guard must be injected too, and must forward the handover options",
  );
  // The old shape, stated exactly so a revert is caught by name.
  assert.doesNotMatch(
    body,
    /if \(!await invalidateDurableAgentSession\(\)\) return;/,
    "the bare guarded return is the #1184 defect — the module decides the order now",
  );
});

test("#1184 the disclosure is honest only because nothing was committed", () => {
  // #1171 briefly added this same line at the old call site and it was withdrawn, correctly:
  // saying "reconnect is paused" while the panel had already half-switched was a lie. The
  // ordering fix is what makes the existing key true, which is why no new catalog string is
  // minted here — the English catalog is frozen (#1135) and one new key means a pass over
  // eleven locale files.
  const at = PANEL_SRC.indexOf("async function connectBackend(id) {");
  const body = PANEL_SRC.slice(at, PANEL_SRC.indexOf("\n  }", at));
  assert.match(body, /panel\.the_old_session_could_not_be_invalidated/, "the abort must be disclosed, not silent");
});

test("#1184 the two aborts are disclosed differently — one message cannot be true for both", () => {
  // A shared message would be false for one of them. INVALIDATE_FAILED means nothing
  // committed and the switch did not happen, which is what hardRestart's line says.
  // SUPERSEDED means a handshake landed mid-await, so the panel IS connected and coherent —
  // `onModels` has already written connectedBackend, localStorage and repainted the chips.
  // Printing "reconnect is paused" there would be flatly wrong: the session WAS invalidated
  // and nothing is paused.
  //
  // Caught by reading rather than by a test, which is why it is pinned now: the module
  // passes a reason and the first wiring ignored it.
  const at = PANEL_SRC.indexOf("async function connectBackend(id) {");
  const body = PANEL_SRC.slice(at, PANEL_SRC.indexOf("\n  }", at));
  assert.match(
    body,
    /disclose: \(reason\) => \{[\s\S]{0,200}?if \(reason !== BACKEND_SWITCH\.INVALIDATE_FAILED\) return;/,
    "the disclosure must branch on the reason, not print the invalidate line for every abort",
  );
});
