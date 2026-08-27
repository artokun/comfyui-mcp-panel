// Unit tests for the bridge-command rid dedupe ledger (web/js/lib/command-dedupe.js).
//
// Regression coverage for #517: a graph mutation that timed out bridge-side can
// still apply panel-side, and re-delivering the SAME command frame (a replay
// after reconnect, or a retry that reuses the request id) must NOT execute the
// mutation a second time — the timed-out apply plus the retry is what produced
// duplicate / orphaned nodes. The ledger makes every rid-correlated command
// idempotent at the point of application: the first delivery executes, any
// later delivery of the same rid is answered with the ORIGINAL reply.
//
// The dedupe identity is rid + payload fingerprint: the bridge's re-dispatch of
// the SAME logical command dedupes, but a rid reused for DIFFERENT work must
// execute fresh (never answered from the ledger) and is logged once.
//
// #694: the orchestrator never REUSES a rid (#683/#687) — a timed-out command is
// retried under a FRESH rid plus `retry_of` naming the original. `retry_of` is
// excluded from the fingerprint, so the retry dedupes against the ORIGINAL's
// ledger entry (settled or still in flight) and is answered with the rid
// rewritten to the retry's — never a second execution. An unknown retry_of
// misses and executes fresh (fail-open), and a genuinely fresh command with
// identical args (no retry_of) executes again as it should.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { commandFingerprint, createCommandDedupeLedger } from "../../web/js/lib/command-dedupe.js";

// Minimal stand-in for the panel's bridge message handler: the same
// get → (replay | begin → execute → settle) flow the real dispatch runs.
function makeDispatch(ledger, executor) {
  return async function deliver(msg) {
    const prior = ledger.get(msg.rid, commandFingerprint(msg));
    if (prior !== undefined) return { reply: await prior, executed: false };
    const settle = ledger.begin(msg.rid, commandFingerprint(msg));
    let reply;
    try {
      reply = { rid: msg.rid, ok: true, result: await executor(msg) };
    } catch (err) {
      reply = { rid: msg.rid, ok: false, error: String(err?.message ?? err) };
    }
    settle(reply);
    return { reply, executed: true };
  };
}

// #694 — the SAME stand-in EXTENDED with the panel's retry path: a retry carries
// a FRESH rid plus `retry_of` naming the original (the orchestrator never reuses
// rids, #683/#687). A miss on the retry's own rid falls back to the original's
// ledger entry; a hit there is answered with the rid REWRITTEN to the retry's
// (the orchestrator's pending map waits on the fresh rid). An unknown retry_of
// misses too and falls through to begin + execute fresh — the ledger fails open.
function makeRetryDispatch(ledger, executor, getScope = () => undefined) {
  return async function deliver(msg) {
    const fingerprint = commandFingerprint(msg);
    const scope = getScope();
    let prior = ledger.get(msg.rid, fingerprint, scope);
    let retryOfHit = false;
    if (typeof msg.retry_of === "string") {
      const retryLookup = ledger.lookupRetry(msg.retry_of, fingerprint, scope);
      if (retryLookup.status === "mismatch") {
        return {
          reply: {
            rid: msg.rid,
            ok: false,
            error: "Retry rejected: retry_of refers to a different command or workflow.",
          },
          executed: false,
        };
      }
      if (prior === undefined && retryLookup.status === "match") {
        prior = retryLookup.reply;
        retryOfHit = true;
      }
    }
    if (prior !== undefined) {
      const reply = await prior;
      return { reply: retryOfHit ? { ...reply, rid: msg.rid } : reply, executed: false };
    }
    const settle = ledger.begin(msg.rid, fingerprint, scope);
    let reply;
    try {
      reply = { rid: msg.rid, ok: true, result: await executor(msg) };
    } catch (err) {
      reply = { rid: msg.rid, ok: false, error: String(err?.message ?? err) };
    }
    settle(reply);
    return { reply, executed: true };
  };
}

test("a replayed rid is answered with the ORIGINAL reply and never re-executes (#517)", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  const deliver = makeDispatch(ledger, async () => ({ added: { id: ++applied } }));

  const first = await deliver({ rid: "r1", cmd: "graph_add_node" });
  assert.equal(first.executed, true);
  assert.equal(applied, 1, "first delivery applies the mutation once");

  const replay = await deliver({ rid: "r1", cmd: "graph_add_node" });
  assert.equal(replay.executed, false, "second delivery of the same rid is a no-op");
  assert.equal(applied, 1, "the mutation is still applied exactly once — no duplicate node");
  assert.equal(replay.reply, first.reply, "the replay gets the ORIGINAL reply verbatim");
});

test("an in-flight duplicate waits for the first execution and shares its reply", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deliver = makeDispatch(ledger, async () => {
    await gate; // still applying when the replay arrives (the #517 slow-tab window)
    return { added: { id: ++applied } };
  });

  const p1 = deliver({ rid: "r1", cmd: "graph_add_node" });
  const p2 = deliver({ rid: "r1", cmd: "graph_add_node" });
  release();
  const [first, replay] = await Promise.all([p1, p2]);
  assert.equal(applied, 1, "one execution even when the replay lands mid-apply");
  assert.equal(replay.executed, false);
  assert.equal(replay.reply, first.reply, "both deliveries resolve to the same reply");
});

test("a failed command's replay re-sends the same error reply without re-executing", async () => {
  const ledger = createCommandDedupeLedger();
  let attempts = 0;
  const deliver = makeDispatch(ledger, async () => {
    attempts += 1;
    throw new Error("workflow instance mismatch");
  });

  const first = await deliver({ rid: "r1", cmd: "graph_remove_node" });
  assert.equal(first.reply.ok, false);
  const replay = await deliver({ rid: "r1", cmd: "graph_remove_node" });
  assert.equal(replay.executed, false);
  assert.equal(attempts, 1);
  assert.equal(replay.reply, first.reply);
});

test("distinct rids execute independently", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  const deliver = makeDispatch(ledger, async () => ({ added: { id: ++applied } }));
  const a = await deliver({ rid: "r1", cmd: "graph_add_node" });
  const b = await deliver({ rid: "r2", cmd: "graph_add_node" });
  assert.equal(a.executed, true);
  assert.equal(b.executed, true);
  assert.equal(applied, 2);
  assert.notEqual(a.reply, b.reply);
});

test("the ledger forgets rids beyond its cap (bounded, fail-open)", async () => {
  const ledger = createCommandDedupeLedger(3);
  const fp = commandFingerprint({ cmd: "graph_add_node" });
  const deliver = makeDispatch(ledger, async () => ({ ok: true }));
  for (const rid of ["r1", "r2", "r3", "r4"]) await deliver({ rid, cmd: "graph_add_node" });
  assert.equal(ledger.get("r1", fp), undefined, "oldest rid is evicted once over cap");
  assert.notEqual(ledger.get("r4", fp), undefined, "recent rids are still remembered");
  // Fail-open: an evicted replay would simply re-execute — the pre-ledger
  // behaviour, never a new failure mode.
});

test("settle is idempotent — a second settle cannot rewrite the recorded reply", async () => {
  const ledger = createCommandDedupeLedger();
  const settle = ledger.begin("r1", "fp");
  const reply = { rid: "r1", ok: true, result: { added: { id: 1 } } };
  settle(reply);
  settle({ rid: "r1", ok: false, error: "bogus" });
  assert.equal(await ledger.get("r1", "fp"), reply);
});

test("an in-flight entry is NEVER evicted past cap — its replay is still deduped (#517 re-gate)", async () => {
  const ledger = createCommandDedupeLedger(200);
  let applied = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deliver = makeDispatch(ledger, async (msg) => {
    if (msg.rid === "r-first") await gate; // the first command stays in flight
    return { added: { id: ++applied } };
  });

  const first = deliver({ rid: "r-first", cmd: "graph_add_node" }); // in-flight
  // 200 more commands complete while the first is still applying → 201 entries,
  // over cap. Eviction must skip the in-flight first entry, not drop it.
  for (let i = 1; i <= 200; i += 1) {
    await deliver({ rid: `r${i}`, cmd: "graph_add_node" });
  }
  const replayP = deliver({ rid: "r-first", cmd: "graph_add_node" });
  release();
  const [orig, replay] = await Promise.all([first, replayP]);
  assert.equal(replay.executed, false, "the 201st command did not evict the in-flight first");
  assert.equal(applied, 201, "the replay added nothing — executor count stays at one per rid");
  assert.equal(replay.reply, orig.reply);
});

test("settled entries still evict oldest-first while an in-flight one is kept", async () => {
  const ledger = createCommandDedupeLedger(3);
  const fp = commandFingerprint({ cmd: "graph_add_node" });
  const deliver = makeDispatch(ledger, async () => ({ ok: true }));
  const settleLive = ledger.begin("r-live", "fp-live"); // stays in flight
  for (const rid of ["r1", "r2", "r3"]) await deliver({ rid, cmd: "graph_add_node" });
  // 4 entries > cap 3 → the oldest SETTLED (r1) evicts; in-flight r-live survives.
  assert.notEqual(ledger.get("r-live", "fp-live"), undefined, "in-flight entry is kept past cap");
  assert.equal(ledger.get("r1", fp), undefined, "oldest settled entry still evicts — memory stays bounded");
  assert.notEqual(ledger.get("r3", fp), undefined, "newer settled entries are still remembered");
  settleLive({ rid: "r-live", ok: true, result: {} });
});

test("same rid + DIFFERENT payload is NOT answered from the ledger — it executes fresh (#517 re-gate)", async () => {
  const warnings = [];
  const ledger = createCommandDedupeLedger(200, (m) => warnings.push(m));
  let applied = 0;
  const deliver = makeDispatch(ledger, async (msg) => ({ added: { id: ++applied, pos: msg.pos } }));

  const a = await deliver({ rid: "r1", cmd: "graph_add_node", pos: [0, 0] });
  const b = await deliver({ rid: "r1", cmd: "graph_add_node", pos: [9, 9] });
  assert.equal(a.executed, true);
  assert.equal(b.executed, true, "a reused rid with a different payload must execute, not replay the old reply");
  assert.equal(applied, 2, "the new command was NOT lost to the ledger");
  assert.notEqual(b.reply, a.reply, "each command gets its OWN truthful reply");
  assert.equal(warnings.length, 1, "rid reuse for different work logs a warning");

  // …and each payload still dedupes its OWN replays against its own reply.
  const aReplay = await deliver({ rid: "r1", cmd: "graph_add_node", pos: [0, 0] });
  const bReplay = await deliver({ rid: "r1", cmd: "graph_add_node", pos: [9, 9] });
  assert.equal(aReplay.executed, false);
  assert.equal(bReplay.executed, false);
  assert.equal(applied, 2, "neither payload's replay re-executes");
  assert.equal(aReplay.reply, a.reply);
  assert.equal(bReplay.reply, b.reply);
});

test("fingerprint mismatch logs ONCE — the new payload's own replays dedupe silently", async () => {
  const warnings = [];
  const ledger = createCommandDedupeLedger(200, (m) => warnings.push(m));
  const deliver = makeDispatch(ledger, async () => ({ ok: true }));

  await deliver({ rid: "r1", cmd: "graph_add_node" });
  const fresh = await deliver({ rid: "r1", cmd: "graph_remove_node", node_id: 7 }); // mismatch → warn
  const replay = await deliver({ rid: "r1", cmd: "graph_remove_node", node_id: 7 }); // replay of new → dedupe
  assert.equal(fresh.executed, true);
  assert.equal(replay.executed, false);
  assert.equal(warnings.length, 1, "one warning per rid-reuse event, not per retry");
});

test("fingerprint is key-order independent — the same payload re-serialized still dedupes", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  const deliver = makeDispatch(ledger, async () => ({ added: { id: ++applied } }));

  const first = await deliver({ rid: "r1", cmd: "graph_add_node", class_type: "LoraLoaderModelOnly", pos: [1, 2] });
  // Same logical command, fields in a different insertion order (a re-serialized
  // re-dispatch): identical fingerprint, so it dedupes.
  const replay = await deliver({ pos: [1, 2], class_type: "LoraLoaderModelOnly", cmd: "graph_add_node", rid: "r1" });
  assert.equal(replay.executed, false);
  assert.equal(applied, 1);
  assert.equal(replay.reply, first.reply);
});

test("a different bridge-stamped workflow_uuid is a DIFFERENT command even with identical args", async () => {
  const warnings = [];
  const ledger = createCommandDedupeLedger(200, (m) => warnings.push(m));
  let ran = 0;
  const deliver = makeDispatch(ledger, async () => ++ran);

  const a = await deliver({ rid: "r1", cmd: "graph_add_node", class_type: "X", workflow_uuid: "wfA" });
  const b = await deliver({ rid: "r1", cmd: "graph_add_node", class_type: "X", workflow_uuid: "wfB" });
  assert.equal(a.executed, true);
  assert.equal(b.executed, true, "same rid+args on another workflow must execute, not replay");
  assert.equal(ran, 2);
  assert.equal(warnings.length, 1);
});

test("a past-cap in-flight burst is swept back to the cap as entries settle (#517 re-gate)", async () => {
  const ledger = createCommandDedupeLedger(200);
  // 202 commands concurrently in flight — nothing is evictable at begin time,
  // so the ledger grows past cap (safe direction).
  const settles = [];
  for (let i = 0; i <= 200; i += 1) settles.push(ledger.begin(`r${i}`, `fp${i}`));
  const settleLive = ledger.begin("r-live", "fp-live"); // pinned in flight

  // All 201 settle: the settle-time sweep must re-apply the bound, dropping the
  // oldest SETTLED entries while the in-flight one is never touched.
  settles.forEach((s, i) => s({ rid: `r${i}`, ok: true, result: {} }));

  assert.equal(ledger.get("r0", "fp0"), undefined, "oldest settled entry swept on settle");
  assert.equal(ledger.get("r1", "fp1"), undefined, "swept down to the cap, not one past it");
  assert.notEqual(ledger.get("r2", "fp2"), undefined, "settled entries within the cap are kept");
  assert.notEqual(ledger.get("r200", "fp200"), undefined, "newest settled entry is kept");
  assert.notEqual(ledger.get("r-live", "fp-live"), undefined, "the in-flight entry is never evicted");
  settleLive({ rid: "r-live", ok: true, result: {} });
});

// --- #694: retry under a FRESH rid + retry_of (the orchestrator never reuses rids) ---

test("the fingerprint excludes retry_of — a retry fingerprints identically to its original (#694)", () => {
  const original = { rid: "r1", cmd: "graph_add_node", class_type: "X", pos: [1, 2], workflow_uuid: "wfA" };
  const retry = { rid: "r2", retry_of: "r1", cmd: "graph_add_node", class_type: "X", pos: [1, 2], workflow_uuid: "wfA" };
  assert.equal(commandFingerprint(retry), commandFingerprint(original));
  // …and a fresh command with identical args but NO retry_of shares that fingerprint
  // (it is still distinguished by its rid — see the executes-again test below).
  const fresh = { rid: "r3", cmd: "graph_add_node", class_type: "X", pos: [1, 2], workflow_uuid: "wfA" };
  assert.equal(commandFingerprint(fresh), commandFingerprint(original));
});

test("a retry of a SETTLED command gets the ORIGINAL reply with the rid REWRITTEN — the executor never re-runs (#694)", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  const deliver = makeRetryDispatch(ledger, async () => ({ added: { id: ++applied } }));

  const first = await deliver({ rid: "r1", cmd: "graph_add_node", workflow_uuid: "wfA" });
  assert.equal(first.executed, true);
  assert.equal(applied, 1);

  const retry = await deliver({ rid: "r2", retry_of: "r1", cmd: "graph_add_node", workflow_uuid: "wfA" });
  assert.equal(retry.executed, false, "the retry is answered from the ledger, not executed again");
  assert.equal(applied, 1, "the mutation is still applied exactly once — no duplicate node");
  assert.equal(retry.reply.rid, "r2", "the reply is correlated to the RETRY's rid, not the original's");
  assert.deepEqual(
    { ...retry.reply, rid: "r1" },
    first.reply,
    "…and is otherwise the ORIGINAL reply verbatim",
  );
});

test("a retry of an IN-FLIGHT command awaits the first execution and shares its result (#694)", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const deliver = makeRetryDispatch(ledger, async () => {
    await gate; // still applying when the retry arrives (the timed-out-then-retried window)
    return { added: { id: ++applied } };
  });

  const p1 = deliver({ rid: "r1", cmd: "graph_add_node" });
  const p2 = deliver({ rid: "r2", retry_of: "r1", cmd: "graph_add_node" });
  release();
  const [first, retry] = await Promise.all([p1, p2]);
  assert.equal(applied, 1, "one execution even when the retry lands mid-apply");
  assert.equal(retry.executed, false);
  assert.equal(retry.reply.rid, "r2", "the awaited reply is rewritten to the retry's rid");
  assert.deepEqual({ ...retry.reply, rid: "r1" }, first.reply, "both resolve to the same outcome");
});

test("a retry naming an UNKNOWN retry_of executes fresh — the ledger fails open (#694)", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  const deliver = makeRetryDispatch(ledger, async () => ({ added: { id: ++applied } }));

  const retry = await deliver({ rid: "r2", retry_of: "r-unknown", cmd: "graph_add_node" });
  assert.equal(retry.executed, true, "an unknown/evicted retry token can never SUPPRESS execution");
  assert.equal(retry.reply.rid, "r2");
  assert.equal(applied, 1);
});

test("a retained predecessor-epoch retry token is unknown and executes fresh (#713)", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  let epoch = "epoch-before-restart";
  const deliver = makeRetryDispatch(
    ledger,
    async (msg) => ({ applied: ++applied, workflow: msg.workflow_uuid }),
    () => epoch,
  );

  await deliver({ rid: "original-rid", cmd: "graph_set_title", title: "old", workflow_uuid: "wf-old" });
  epoch = "epoch-after-restart";

  // The later process can legitimately retry with the old correlation token.
  // Its retained predecessor entry must be UNKNOWN, never a replay hit.
  const retry = await deliver({
    rid: "retry-rid",
    retry_of: "original-rid",
    cmd: "graph_set_title",
    title: "old",
    workflow_uuid: "wf-old",
  });

  assert.equal(retry.executed, true, "a prior session's token must fail open in the new epoch");
  assert.equal(applied, 2, "the new process receives its own fresh execution");
  assert.equal(retry.reply.result.workflow, "wf-old");
});

test("a same-rid predecessor-epoch replay also executes fresh (#713)", async () => {
  const ledger = createCommandDedupeLedger();
  let epoch = "epoch-before-restart";
  let applied = 0;
  const deliver = makeRetryDispatch(ledger, async () => ({ applied: ++applied }), () => epoch);

  await deliver({ rid: "same-rid", cmd: "graph_add_node", workflow_uuid: "wf" });
  epoch = "epoch-after-restart";
  const current = await deliver({ rid: "same-rid", cmd: "graph_add_node", workflow_uuid: "wf" });

  assert.equal(current.executed, true, "the old process's exact rid is not an own-rid replay now");
  assert.equal(applied, 2);
});

test("a predecessor-epoch retry token cannot reject different current work (#713)", async () => {
  const ledger = createCommandDedupeLedger();
  let epoch = "epoch-before-restart";
  const executed = [];
  const deliver = makeRetryDispatch(
    ledger,
    async (msg) => {
      executed.push(msg.workflow_uuid);
      return { workflow: msg.workflow_uuid };
    },
    () => epoch,
  );

  await deliver({ rid: "original-rid", cmd: "graph_set_title", title: "old", workflow_uuid: "wf-old" });
  epoch = "epoch-after-restart";
  const retry = await deliver({
    rid: "retry-rid",
    retry_of: "original-rid",
    cmd: "graph_set_title",
    title: "current",
    workflow_uuid: "wf-current",
  });

  assert.equal(retry.executed, true, "old-session mismatch state must not reject current work");
  assert.deepEqual(executed, ["wf-old", "wf-current"]);
});

test("a retry naming an EVICTED retry_of also executes fresh (#543)", async () => {
  const ledger = createCommandDedupeLedger(1);
  const executedRids = [];
  const deliver = makeRetryDispatch(ledger, async (msg) => {
    executedRids.push(msg.rid);
    return { appliedTo: msg.workflow_uuid };
  });

  await deliver({ rid: "r1", cmd: "graph_set_title", title: "A", workflow_uuid: "wfA" });
  await deliver({ rid: "r-fill", cmd: "graph_set_title", title: "fill", workflow_uuid: "wfA" });
  const retry = await deliver({ rid: "r2", retry_of: "r1", cmd: "graph_set_title", title: "B", workflow_uuid: "wfB" });

  assert.equal(retry.executed, true, "an evicted retry token retains fail-open behaviour");
  assert.deepEqual(executedRids, ["r1", "r-fill", "r2"]);
});

test("a retained retry_of with another workflow fingerprint is rejected before it executes (#543)", async () => {
  const ledger = createCommandDedupeLedger();
  const executedWorkflows = [];
  const deliver = makeRetryDispatch(ledger, async (msg) => {
    executedWorkflows.push(msg.workflow_uuid);
    return { appliedTo: msg.workflow_uuid };
  });

  // r1 applied to workflow A, but the orchestrator timed out before seeing its
  // reply. It switches to workflow B, then retries r1 under r2. The retained
  // token proves this is not an unknown/evicted fail-open case.
  const first = await deliver({ rid: "r1", cmd: "graph_set_title", title: "A", workflow_uuid: "wfA" });
  assert.equal(first.executed, true);
  const retry = await deliver({ rid: "r2", retry_of: "r1", cmd: "graph_set_title", title: "B", workflow_uuid: "wfB" });

  assert.equal(retry.executed, false, "the cross-workflow retry is stopped before the executor");
  assert.equal(retry.reply.ok, false);
  assert.match(retry.reply.error, /retry_of.*different command or workflow/i);
  assert.deepEqual(executedWorkflows, ["wfA"], "workflow B never receives r2");
});

test("a later-retained original rejects a duplicate retry that first failed open (#543 P1)", async () => {
  const ledger = createCommandDedupeLedger(2);
  const executions = [];
  const deliver = makeRetryDispatch(ledger, async (msg) => {
    executions.push(`${msg.rid}:${msg.workflow_uuid}`);
    return { appliedTo: msg.workflow_uuid };
  });
  const originalA = { rid: "r1", cmd: "graph_set_title", title: "A", workflow_uuid: "wfA" };
  const retryB = { rid: "r2", retry_of: "r1", cmd: "graph_set_title", title: "B", workflow_uuid: "wfB" };

  // Evict r1/A. r2/B can then fail open, as designed, because r1 is absent.
  await deliver(originalA);
  await deliver({ rid: "fill-1", cmd: "graph_set_title", title: "fill", workflow_uuid: "wfA" });
  await deliver({ rid: "fill-2", cmd: "graph_set_title", title: "fill", workflow_uuid: "wfA" });
  const firstRetry = await deliver(retryB);
  assert.equal(firstRetry.executed, true, "the evicted retry token fails open once");

  // A delayed delivery of r1/A is now retained again while r2/B remains in the
  // ledger. The duplicate r2/B must validate retry_of before replaying its own
  // prior reply, otherwise it hides the now-known cross-workflow mismatch.
  await deliver(originalA);
  const beforeDuplicate = [...executions];
  const duplicateRetry = await deliver(retryB);

  assert.equal(duplicateRetry.executed, false);
  assert.equal(duplicateRetry.reply.ok, false);
  assert.match(duplicateRetry.reply.error, /retry_of.*different command or workflow/i);
  assert.deepEqual(executions, beforeDuplicate, "the duplicate r2/B neither replays success nor executes again");
  assert.equal(executions.filter((entry) => entry === "r2:wfB").length, 1, "workflow B ran only during the permitted fail-open delivery");
});

test("a genuinely FRESH command with identical args after a settled one EXECUTES again (#694)", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  const deliver = makeRetryDispatch(ledger, async () => ({ added: { id: ++applied } }));

  const first = await deliver({ rid: "r1", cmd: "graph_add_node", pos: [0, 0] });
  const fresh = await deliver({ rid: "r2", cmd: "graph_add_node", pos: [0, 0] }); // same args, NO retry_of
  assert.equal(first.executed, true);
  assert.equal(fresh.executed, true, "identical args without retry_of is a NEW command — it must run");
  assert.equal(applied, 2, "the user really did ask for two identical nodes");
});

test("a same-rid verbatim replay is still answered with the UNREWITTEN original reply (#521 unchanged)", async () => {
  const ledger = createCommandDedupeLedger();
  let applied = 0;
  const deliver = makeRetryDispatch(ledger, async () => ({ added: { id: ++applied } }));

  const first = await deliver({ rid: "r1", cmd: "graph_add_node" });
  const replay = await deliver({ rid: "r1", cmd: "graph_add_node" }); // no retry_of — the #521 replay
  assert.equal(replay.executed, false);
  assert.equal(applied, 1);
  assert.equal(replay.reply, first.reply, "same-rid replay returns the original reply object verbatim");
});

test("#694 wiring: the panel handler falls back to retry_of and REWRITES the rid on a retry hit", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");
  // The dedupe block: a miss on the frame's own rid must consult retry_of BEFORE
  // falling through to begin + execute.
  const fpAt = src.indexOf("const fingerprint = commandFingerprint(msg);");
  assert.notEqual(fpAt, -1, "the command handler must fingerprint the frame");
  // Bounded by the executor's `try {`, which is the structural end of the dedupe region,
  // not by a fixed character count. The count stood in for "the dedupe block" and stopped
  // meaning it the moment the block grew a comment (#1095 added one) — a passing
  // assertion failing for a reason unrelated to what it checks. Third instance of this
  // trap in the suite, after markConnected and #508's codex R3.
  const blockEnd = src.indexOf("\n        try {", fpAt);
  assert.notEqual(blockEnd, -1, "could not locate the end of the dedupe block");
  const block = src.slice(fpAt, blockEnd);
  assert.match(block, /const commandEpoch = thisSock\.__cmcpBridgeEpoch;/, "the command snapshots its socket epoch");
  assert.match(
    block,
    /let priorRidReply = commandRidLedger\.get\(msg\.rid, fingerprint, commandEpoch\);/,
    "the frame's own rid is consulted in its session epoch",
  );
  assert.match(
    block,
    /const retryLookup = commandRidLedger\.lookupRetry\(msg\.retry_of, fingerprint, commandEpoch\);/,
    "a retry distinguishes the original token only in its current session epoch",
  );
  assert.match(block, /if \(retryLookup\.status === "mismatch"\)/, "a retained mismatched retry token is rejected");
  assert.match(block, /error: "Retry rejected: retry_of refers to a different command or workflow\."/, "the mismatch produces a truthful retry error");
  assert.match(
    block,
    /\{ \.\.\.dupReply, rid: msg\.rid \}/,
    "a retry hit is answered with the rid REWRITTEN to the retry's fresh rid",
  );
  // The rewrite must sit on the dedupe-reply path, BEFORE the reply is sent.
  const rewriteAt = block.indexOf("{ ...dupReply, rid: msg.rid }");
  const sendAt = block.indexOf(`thisSock["send"](`, rewriteAt);
  assert.ok(rewriteAt !== -1 && sendAt !== -1 && rewriteAt < sendAt, "the rewrite precedes the reply write");
  // begin() must still key the retry's OWN rid when the token was unknown/evicted (fail-open).
  assert.match(block, /commandRidLedger\.begin\(msg\.rid, fingerprint, commandEpoch\);/);
  const rejectAt = block.indexOf('retryLookup.status === "mismatch"');
  const ownReplyAt = block.indexOf("if (priorRidReply !== undefined)");
  const beginAt = block.indexOf("commandRidLedger.begin(msg.rid, fingerprint, commandEpoch)");
  assert.ok(rejectAt !== -1 && ownReplyAt !== -1 && rejectAt < ownReplyAt, "mismatched retries return before their own-rid reply can replay");
  assert.ok(rejectAt !== -1 && beginAt !== -1 && rejectAt < beginAt, "mismatched retries return before begin + execute");
});
