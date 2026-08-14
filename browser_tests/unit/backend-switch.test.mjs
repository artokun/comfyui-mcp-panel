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

import { BACKEND_SWITCH, runBackendSwitch } from "../../web/js/lib/backend-switch.js";

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
function recorder({ live = "claude", picked = "claude", invalidate = async () => true, replay = "prior chat" } = {}) {
  const log = [];
  let liveBackend = live;
  const effects = {
    liveBackend: () => liveBackend,
    pickedBackend: () => picked,
    invalidate: async () => {
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
    armContext: () => log.push("armContext"),
    teardownAndConnect: () => log.push("teardownAndConnect"),
    disclose: (reason) => log.push(`disclose:${reason}`),
  };
  return { log, effects, setLive: (b) => { liveBackend = b; } };
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
  assert.match(body, /invalidate: \(\) => invalidateDurableAgentSession\(\)/, "the guard must be injected too");
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
