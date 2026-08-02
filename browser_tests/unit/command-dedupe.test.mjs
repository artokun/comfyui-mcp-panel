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
import test from "node:test";
import assert from "node:assert/strict";

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
