/**
 * #1898 — coordinate the open until the requested workflow is stable AND its
 * bound graph can be read. A store-level identity switch can settle before
 * graph normalization finishes, so give that normalization one retry when the
 * first outline probe is not readable. Callers must still verify graph content
 * before treating a readable result as proven.
 */

function readableGraphOutline(value) {
  return (
    value != null &&
    typeof value === "object" &&
    Number.isInteger(value.node_count) &&
    value.node_count >= 0 &&
    typeof value.outline === "string" &&
    value.detail_level !== "refused"
  );
}

/**
 * @returns {Promise<{
 *   status: "settled-readable"|"different"|"superseded"|"unknown",
 *   active?: unknown,
 *   outline?: unknown,
 *   retried?: boolean,
 *   reason?: string
 * }>}
 */
export async function settleOpenedWorkflowReadable({
  settleActive,
  readGraphOutline,
  retryNormalization,
} = {}) {
  if (typeof settleActive !== "function" || typeof readGraphOutline !== "function") {
    return { status: "unknown", reason: "workflow identity or graph outline probe was unavailable" };
  }

  const settle = async () => {
    try {
      return await settleActive();
    } catch {
      return { status: "unknown", reason: "workflow identity probe failed" };
    }
  };
  const read = async () => {
    try {
      const outline = await readGraphOutline();
      return readableGraphOutline(outline) ? { readable: true, outline } : { readable: false };
    } catch {
      return { readable: false };
    }
  };

  let active = await settle();
  if (active?.status !== "settled") return active ?? { status: "unknown" };

  let probe = await read();
  let retried = false;
  if (!probe.readable) {
    // Confirm the target still owns the canvas before retrying a load. A failed
    // outline must not authorize normalization on a workflow that moved away.
    active = await settle();
    if (active?.status !== "settled") return active ?? { status: "unknown" };
    if (typeof retryNormalization !== "function") {
      return { status: "unknown", reason: "bound graph outline remained unreadable" };
    }
    try {
      retried = (await retryNormalization()) === true;
    } catch {
      retried = false;
    }
    if (!retried) return { status: "unknown", reason: "workflow normalization retry was not completed" };
    active = await settle();
    if (active?.status !== "settled") return active ?? { status: "unknown" };
    probe = await read();
    if (!probe.readable) return { status: "unknown", reason: "bound graph outline remained unreadable after one retry" };
  }

  // The graph read itself is an await boundary in real frontends. Re-probe the
  // identity after it so a late tab switch cannot turn a readable old graph into
  // a success for the requested workflow.
  active = await settle();
  if (active?.status !== "settled") return active ?? { status: "unknown" };
  return {
    status: "settled-readable",
    active: active.active,
    outline: probe.outline,
    retried,
  };
}
