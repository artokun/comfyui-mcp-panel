// Rid dedupe ledger for inbound agent commands (#517).
//
// The bridge correlates every command frame by `rid`. A mutation that times out
// bridge-side may STILL apply here, and when the apparently-failed command is
// retried under the SAME request id (a replayed frame after a reconnect, or the
// orchestrator deliberately re-dispatching the SAME logical command under its
// original rid after a timeout) the panel must not execute it a second time —
// a re-applied graph_add_node / graph_remove_node is how a timed-out mutation
// plus its retry lands twice (duplicate / orphan nodes).
//
// This ledger makes every rid-correlated command IDEMPOTENT at the point of
// application: the FIRST delivery of a rid executes and its reply is recorded;
// any later delivery of the same rid is answered with that ORIGINAL reply —
// awaited first if the first execution is still in flight — and never runs the
// executor again (so no second mutation and no duplicate activity card).
//
// The dedupe identity is rid + PAYLOAD FINGERPRINT (commandFingerprint below:
// the frame minus `rid`, canonical-stringified). The bridge's re-dispatch of
// the SAME logical command reproduces the frame exactly, so it dedupes — but a
// rid arriving with a MISMATCHED fingerprint is NOT the same command (a
// genuinely new command that happens to reuse a prior rid: re-targeted or
// replaced socket, different workflow). It is never answered from the ledger:
// it executes fresh, and the reuse is logged once via onRidReuse (the bridge
// should only ever re-dispatch the SAME command under a reused rid).
//
// Bounded: oldest-first eviction of SETTLED entries — swept on every begin AND
// every settle (a past-cap burst of concurrent in-flight commands has nothing
// evictable at begin; only a settle-time sweep re-applies the bound as those
// entries complete) — keeps a long session from growing it without limit. An
// IN-FLIGHT entry is NEVER evicted — dropping an unsettled command would let
// its replay re-execute and double-apply a mutation — so past `cap` CONCURRENT
// in-flight commands the ledger simply grows (bounded by real concurrency,
// which is tiny); the settled cap still applies. Settled eviction fails OPEN: a
// replay older than the cap re-executes, which is exactly the pre-ledger
// behaviour — never a new failure mode.
//
// Dependency-free (no LiteGraph, no DOM). Unit-testable with plain fixtures.

/** Recursively key-sorted JSON so equality is independent of key insertion order. */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Fingerprint of a command frame's IDENTITY: every field except the transport
 * `rid` (cmd + all args + the bridge-stamped workflow_uuid), canonicalized so
 * key insertion order doesn't matter. The bridge's re-dispatch of the SAME
 * logical command yields an identical fingerprint; any genuinely different
 * command — even one differing only in workflow_uuid — differs here too.
 */
export function commandFingerprint(msg) {
  const identity = { ...msg };
  delete identity.rid; // transport correlation only — NOT part of command identity
  return stableStringify(identity);
}

/**
 * @param {number} cap  max remembered SETTLED entries (oldest evicted first;
 *    swept on begin and on settle)
 * @param {(message: string) => void} [onRidReuse]  called once when a rid
 *    arrives under a DIFFERENT fingerprint than a remembered entry — i.e. the
 *    bridge reused a request id for different work (anomalous; worth a log).
 * @returns {{
 *   get(rid: string, fingerprint: string): object | Promise<object> | undefined,
 *   begin(rid: string, fingerprint: string): (reply: object) => void,
 * }} get() returns undefined for a fresh rid+fingerprint, the settled reply
 *    object once the command completed, or a promise of it while the first
 *    execution is still in flight. begin() records a fresh rid+fingerprint as
 *    in-flight and returns its settle(reply) function.
 */
export function createCommandDedupeLedger(cap = 200, onRidReuse) {
  // `${rid}\n${fingerprint}` → { rid, inflight: true, promise } in-flight |
  // { rid, inflight: false, reply } settled. Map preserves insertion order, so
  // the oldest entry is always the first key. (The \n separator is safe: rids
  // are UUIDs and canonical JSON never contains a raw newline.)
  const entries = new Map();

  // Evict oldest-first while over cap, but NEVER an in-flight entry (see
  // header): with every entry in flight this grows the ledger past cap
  // instead of evicting, which is the safe direction. Called on begin AND on
  // settle — a burst of >cap concurrent in-flight commands is only trimmable
  // once its entries start settling.
  const evictSettled = () => {
    for (const [k, entry] of entries) {
      if (entries.size <= cap) break;
      if (entry.inflight) continue;
      entries.delete(k);
    }
  };

  return {
    get(rid, fingerprint) {
      const key = `${rid}\n${fingerprint}`;
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      // LRU touch: a replayed entry is by definition still relevant — keep it
      // from ageing out while the bridge may still re-deliver it.
      entries.delete(key);
      entries.set(key, entry);
      return entry.inflight ? entry.promise : entry.reply;
    },
    begin(rid, fingerprint) {
      // begin() only runs after get() missed, so any same-rid entry exists
      // under a DIFFERENT fingerprint — the bridge reused a request id for
      // different work. Warn ONCE: this new entry dedupes its own replays, so
      // a retry of THIS command can't re-fire the warning.
      for (const e of entries.values()) {
        if (e.rid === rid) {
          onRidReuse?.(
            `[comfyui-mcp-panel] bridge rid "${rid}" reused for a DIFFERENT command payload — ` +
              `treating it as a new command (the original reply stays bound to its own payload)`,
          );
          break;
        }
      }
      const key = `${rid}\n${fingerprint}`;
      let settle;
      entries.set(key, { rid, inflight: true, promise: new Promise((resolve) => { settle = resolve; }) });
      evictSettled();
      let settled = false;
      return (reply) => {
        if (settled) return; // settle exactly once — later calls can't rewrite history
        settled = true;
        settle(reply);
        // Collapse to the settled reply itself so later replays read it
        // synchronously (and `await` on either form is the same). The entry is
        // provably still present — in-flight entries are never evicted.
        const entry = entries.get(key);
        if (entry !== undefined) {
          entry.inflight = false;
          entry.reply = reply;
          delete entry.promise;
        }
        // A past-cap burst of concurrent in-flight commands grows the ledger
        // (nothing evictable at begin) — re-apply the bound as entries settle.
        evictSettled();
      };
    },
  };
}
