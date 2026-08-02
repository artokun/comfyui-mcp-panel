// Unit tests for the bridge-command rid dedupe ledger (web/js/lib/command-dedupe.js).
//
// Regression coverage for #517: a graph mutation that timed out bridge-side can
// still apply panel-side, and re-delivering the SAME command frame (a replay
// after reconnect, or a retry that reuses the request id) must NOT execute the
// mutation a second time — the timed-out apply plus the retry is what produced
// duplicate / orphaned nodes. The ledger makes every rid-correlated command
// idempotent at the point of application: the first delivery executes, any
// later delivery of the same rid is answered with the ORIGINAL reply.
import test from "node:test";
import assert from "node:assert/strict";

import { createCommandDedupeLedger } from "../../web/js/lib/command-dedupe.js";

// Minimal stand-in for the panel's bridge message handler: the same
// get → (replay | begin → execute → settle) flow the real dispatch runs.
function makeDispatch(ledger, executor) {
  return async function deliver(msg) {
    const prior = ledger.get(msg.rid);
    if (prior !== undefined) return { reply: await prior, executed: false };
    const settle = ledger.begin(msg.rid);
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
  const deliver = makeDispatch(ledger, async () => ({ ok: true }));
  for (const rid of ["r1", "r2", "r3", "r4"]) await deliver({ rid, cmd: "graph_add_node" });
  assert.equal(ledger.get("r1"), undefined, "oldest rid is evicted once over cap");
  assert.notEqual(ledger.get("r4"), undefined, "recent rids are still remembered");
  // Fail-open: an evicted replay would simply re-execute — the pre-ledger
  // behaviour, never a new failure mode.
});

test("settle is idempotent — a second settle cannot rewrite the recorded reply", async () => {
  const ledger = createCommandDedupeLedger();
  const settle = ledger.begin("r1");
  const reply = { rid: "r1", ok: true, result: { added: { id: 1 } } };
  settle(reply);
  settle({ rid: "r1", ok: false, error: "bogus" });
  assert.equal(await ledger.get("r1"), reply);
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
  const deliver = makeDispatch(ledger, async () => ({ ok: true }));
  const settleLive = ledger.begin("r-live"); // stays in flight
  for (const rid of ["r1", "r2", "r3"]) await deliver({ rid, cmd: "graph_add_node" });
  // 4 entries > cap 3 → the oldest SETTLED (r1) evicts; in-flight r-live survives.
  assert.notEqual(ledger.get("r-live"), undefined, "in-flight entry is kept past cap");
  assert.equal(ledger.get("r1"), undefined, "oldest settled entry still evicts — memory stays bounded");
  assert.notEqual(ledger.get("r3"), undefined, "newer settled entries are still remembered");
  settleLive({ rid: "r-live", ok: true, result: {} });
});
