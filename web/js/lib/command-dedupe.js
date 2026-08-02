// Rid dedupe ledger for inbound agent commands (#517).
//
// The bridge correlates every command frame by `rid`. A mutation that times out
// bridge-side may STILL apply here, and when the apparently-failed command is
// retried under the SAME request id (a replayed frame after a reconnect, or an
// orchestrator that reuses the rid on re-dispatch) the panel must not execute it
// a second time — a re-applied graph_add_node / graph_remove_node is how a
// timed-out mutation plus its retry lands twice (duplicate / orphan nodes).
//
// This ledger makes every rid-correlated command IDEMPOTENT at the point of
// application: the FIRST delivery of a rid executes and its reply is recorded;
// any later delivery of the same rid is answered with that ORIGINAL reply —
// awaited first if the first execution is still in flight — and never runs the
// executor again (so no second mutation and no duplicate activity card).
//
// Bounded (oldest-first eviction) so a long session can't grow it without
// limit. Eviction fails OPEN: a replay older than the cap re-executes, which is
// exactly today's pre-ledger behaviour — never a new failure mode.
//
// Dependency-free (no LiteGraph, no DOM). Unit-testable with plain fixtures.

/**
 * @param {number} cap  max remembered rids (oldest evicted first)
 * @returns {{
 *   get(rid: string): object | Promise<object> | undefined,
 *   begin(rid: string): (reply: object) => void,
 * }} get() returns undefined for a fresh rid, the settled reply object once the
 *    command completed, or a promise of it while the first execution is still
 *    in flight. begin() records a fresh rid as in-flight and returns its
 *    settle(reply) function.
 */
export function createCommandDedupeLedger(cap = 200) {
  // rid → settled reply object | in-flight promise of the reply. Map preserves
  // insertion order, so the oldest rid is always the first key.
  const entries = new Map();

  return {
    get(rid) {
      if (!entries.has(rid)) return undefined;
      const value = entries.get(rid);
      // LRU touch: a replayed rid is by definition still relevant — keep it
      // from ageing out while the bridge may still re-deliver it.
      entries.delete(rid);
      entries.set(rid, value);
      return value;
    },
    begin(rid) {
      let settle;
      entries.set(rid, new Promise((resolve) => { settle = resolve; }));
      while (entries.size > cap) entries.delete(entries.keys().next().value);
      let settled = false;
      return (reply) => {
        if (settled) return; // settle exactly once — later calls can't rewrite history
        settled = true;
        settle(reply);
        // Collapse the in-flight promise to the settled reply itself so later
        // replays read it synchronously (and `await` on either form is the same).
        if (entries.get(rid) !== undefined) entries.set(rid, reply);
      };
    },
  };
}
