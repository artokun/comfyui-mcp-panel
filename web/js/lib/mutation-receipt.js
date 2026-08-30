// #2116 — persist graph_set_widget acknowledgements by request id.
//
// A timed-out mutation can still apply after the caller has given up. The
// command rid is the transaction identity: retry_of must replay that receipt
// instead of executing a second write, and panel_list_workflows advertises
// the same rid-correlated list the save path uses for late_save_receipts.

export const LATE_MUTATION_RECEIPT_TTL_MS = 10 * 60 * 1000;
export const MAX_LATE_MUTATION_RECEIPTS = 32;

function appliedWidgetResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  if (result.applied === true) return true;
  const set = result.set;
  return !!(set && typeof set === "object" && Object.prototype.hasOwnProperty.call(set, "value"));
}

/**
 * Bounded rid-keyed store for applied widget-write receipts.
 *
 * @param {{
 *   ttlMs?: number,
 *   maxEntries?: number,
 *   now?: () => number,
 * }} [opts]
 */
export function createMutationReceiptStore({
  ttlMs = LATE_MUTATION_RECEIPT_TTL_MS,
  maxEntries = MAX_LATE_MUTATION_RECEIPTS,
  now = () => Date.now(),
} = {}) {
  const receipts = new Map();

  const prune = () => {
    const t = typeof now === "function" ? now() : Date.now();
    const stamp = Number.isFinite(t) ? t : Date.now();
    for (const [rid, receipt] of receipts) {
      if (stamp - receipt.completed_at > ttlMs) receipts.delete(rid);
    }
    while (receipts.size > maxEntries) {
      const oldest = receipts.keys().next();
      if (oldest.done) break;
      receipts.delete(oldest.value);
    }
  };

  return {
    remember(rid, result, { cmd = "graph_set_widget", fingerprint } = {}) {
      if (typeof rid !== "string" || !rid) return;
      if (!appliedWidgetResult(result)) return;
      prune();
      receipts.set(rid, {
        rid,
        cmd: typeof cmd === "string" && cmd ? cmd : "graph_set_widget",
        fingerprint: typeof fingerprint === "string" && fingerprint ? fingerprint : undefined,
        completed_at: typeof now === "function" ? now() : Date.now(),
        result: { ...result },
      });
    },
    lookup(rid, fingerprint) {
      prune();
      if (typeof rid !== "string" || !rid) return undefined;
      const receipt = receipts.get(rid);
      if (!receipt) return undefined;
      if (
        receipt.fingerprint &&
        typeof fingerprint === "string" &&
        fingerprint &&
        receipt.fingerprint !== fingerprint
      ) {
        return undefined;
      }
      return receipt;
    },
    list() {
      prune();
      return Array.from(receipts.values()).map((receipt) => ({
        rid: receipt.rid,
        cmd: receipt.cmd,
        completed_at: receipt.completed_at,
        result: { ...receipt.result },
      }));
    },
  };
}

/**
 * Replay a stored applied receipt for this frame's rid / retry_of.
 *
 * A fingerprint mismatch is a miss: the token named different work, so the
 * caller must not receive this receipt and must not treat it as authorization
 * to skip execution.
 *
 * @param {{ lookup: (rid: string, fingerprint?: string) => object | undefined }} store
 * @param {{ rid?: string, retry_of?: string }} msg
 * @param {string} [fingerprint]
 * @returns {{ reply: { rid: string, ok: true, result: object }, retryOfHit: boolean } | undefined}
 */
export function resolveLateMutationReply(store, msg, fingerprint) {
  if (!store || typeof store.lookup !== "function" || !msg || typeof msg !== "object") {
    return undefined;
  }
  const retryOf = typeof msg.retry_of === "string" ? msg.retry_of : "";
  const rid = typeof msg.rid === "string" ? msg.rid : "";
  const receipt =
    (retryOf && store.lookup(retryOf, fingerprint)) ||
    (rid && store.lookup(rid, fingerprint)) ||
    undefined;
  if (!receipt) return undefined;
  const replyRid = rid || receipt.rid;
  return {
    reply: { rid: replyRid, ok: true, result: receipt.result },
    retryOfHit: !!(retryOf && receipt.rid === retryOf),
  };
}
