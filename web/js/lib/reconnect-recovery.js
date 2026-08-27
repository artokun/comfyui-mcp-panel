// #663 / #646 — post-reconnect recovery: the proactive settle watch and the
// graph-mutation gate that rides on it.
//
// The panel's post-reconnect machinery used to be entirely PASSIVE on the canvas
// side: the `reconnected` handler bumped the epoch and armed the 30s possibly-
// stale window, but nothing ever RE-PROVED that the restored canvas is bound to
// the active workflow. Two defects shared that root:
//
//   #663 — the window (and with it the mid-population refusals) ran its full
//     30s even when the tab had finished restoring in two seconds, and a restore
//     that never settled hard-refused every graph command until a manual
//     panel_open_workflow / panel reload. Nothing proactive ever ran the binding
//     evidence bar.
//
//   #646 — nothing gated graph MUTATIONS on the post-restart state at all: a
//     mutation dispatched while ComfyUI's backend socket is down, or before the
//     restored canvas binding was re-proven, could land on a canvas the restore
//     was about to rebuild (a fabricated success) or die mid-command with the
//     socket (OUTCOME UNKNOWN).
//
// The shared invariant, implemented ONCE here: a graph mutation may only run
// when the post-reconnect binding has been re-proven — by the watch below, or
// by an explicit workflow_open/new, whose own receipts are stronger proof. The
// watch performs only SAFE heals (the ones a graph command performs lazily on
// every call): getGraphCtx's verified canvas rebind for a provably content-free
// ghost, and the binding guard's uuid-rebind / proven-binding seal. It
// deliberately NEVER repaints the canvas from serialized state — a live root
// whose content differs from the workflow's state can be holding user work
// (#604), and "could not determine whose canvas this is" must stay a refusal,
// not an automatic overwrite. A restore that never settles therefore still
// refuses after the window, with the remedy the refusal message names; what the
// watch buys is that the healthy case stops refusing as soon as the binding is
// observably settled instead of at the 30s wall.

/** Poll cadence for the settle watch (ms). */
export const RECONNECT_SETTLE_POLL_MS = 1000;
/** First poll delay (ms) — the restore needs a beat before it can pass. */
export const RECONNECT_SETTLE_FIRST_POLL_MS = 500;

/**
 * The post-reconnect settle watch. Polls until the caller's binding proof
 * passes, then stamps the proof via `markProven`. Stops early when the window
 * closed without it (an explicit open/new re-proved the tab, or the window
 * expired) and when a newer reconnect superseded it.
 *
 * Every dependency is injected, so the loop is unit-testable with fakes; the
 * panel wires the module-scope epoch state and the real evidence bar.
 *
 * @param {{
 *   isCurrent: () => boolean,    // false once a NEWER reconnect supersedes this watch
 *   windowOpen: () => boolean,   // the #433/#618 possibly-stale window, live
 *   proveBinding: () => boolean, // true when the binding clears the full read bar
 *   markProven: () => void,      // stamp the binding proof for this epoch
 *   sleep?: (ms: number) => Promise<void>,
 *   firstDelayMs?: number,
 *   pollMs?: number,
 *   maxPolls?: number,           // hard cap so the loop is bounded even if the
 *                                // window predicate never closes (fail-safe)
 * }} o
 * @returns {Promise<"proven"|"closed"|"superseded"|"exhausted">}
 */
export async function watchPostReconnectSettle({
  isCurrent,
  windowOpen,
  proveBinding,
  markProven,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  firstDelayMs = RECONNECT_SETTLE_FIRST_POLL_MS,
  pollMs = RECONNECT_SETTLE_POLL_MS,
  maxPolls = 45,
} = {}) {
  await sleep(firstDelayMs);
  for (let poll = 0; poll < maxPolls; poll += 1) {
    if (!isCurrent()) return "superseded";
    if (!windowOpen()) return "closed";
    let proven = false;
    try {
      proven = proveBinding() === true;
    } catch {
      // The proof is itself an operation that can fail — a throwing probe is
      // "not yet", never "proven".
      proven = false;
    }
    if (proven) {
      // Re-check currency BEFORE stamping: a reconnect that landed while the
      // proof ran must not let this older watch close the NEW window.
      if (!isCurrent()) return "superseded";
      markProven();
      return "proven";
    }
    await sleep(pollMs);
  }
  return "exhausted";
}

/**
 * #1641 — wait for the post-restart handshake before `workflow_open` compares
 * content.
 *
 * After a ComfyUI restart the tab can answer `workflow_open` (and even
 * `workflow_list`) before the backend socket, the node-def refresh kicked on
 * `reconnected`, and the restored canvas binding have finished one synchronized
 * handshake. The first open of the already-active workflow then reports
 * CONTENT_UNVERIFIED — "the graph on it does not match the state that was
 * loaded" — and publishes no `workflow_uuid`, so the orchestrator answers
 * `FENCE: NOT cleared (active identity UNCONFIRMED after reconnect handshake)`.
 * A retry a moment later succeeds without changing the workflow.
 *
 * This wait is NOT a binding proof and does not repaint. It only buys a
 * settled canvas for the common case so the first open is the one that
 * succeeds. Callers decide what a `"timeout"` means:
 *
 *   - `workflow_list` refuses (#1785): a read must not publish a pre-reconnect
 *     active pointer as targeting success.
 *   - `workflow_open` refuses (#1914): proceeding into freeze/load after a
 *     miss is the timeout-after-delivered-open — the command was already
 *     handed to the tab, no receipt is written, and the orchestrator reports
 *     undetermined. After the settle window closes, `needsWait` is false, this
 *     waiter returns `"ready"`, and the open proceeds as the #646 recovery
 *     for a restore that never settles.
 *
 * Cadence matches the orchestrator's post-open handshake ([400, 900, 1600] ms)
 * so a caller that already waited there is not waiting a second, longer budget
 * here; a caller that hits the panel first pays the same ~2.9s once.
 */
export const OPEN_RECONNECT_HANDSHAKE_STEPS_MS = Object.freeze([400, 900, 1600]);

/**
 * @param {{
 *   needsWait?: () => boolean,  // true while the handshake is still in flight
 *   isReady?: () => boolean,    // true when the open may compare content
 *   sleep?: (ms: number) => Promise<void>,
 *   stepsMs?: readonly number[],
 * }} o
 * @returns {Promise<"ready"|"timeout">}
 */
export async function waitForReconnectHandshakeBeforeOpen({
  needsWait,
  isReady,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  stepsMs = OPEN_RECONNECT_HANDSHAKE_STEPS_MS,
} = {}) {
  const pending = () => {
    try {
      return typeof needsWait === "function" && needsWait() === true;
    } catch {
      // An unreadable probe is not a reason to stall the open — the open itself
      // is the recovery (#646). Same direction as a throwing settle-watch proof.
      return false;
    }
  };
  const ready = () => {
    try {
      return typeof isReady === "function" && isReady() === true;
    } catch {
      return false;
    }
  };
  if (!pending()) return "ready";
  if (ready()) return "ready";
  const steps = Array.isArray(stepsMs) && stepsMs.length ? stepsMs : OPEN_RECONNECT_HANDSHAKE_STEPS_MS;
  for (const waitMs of steps) {
    const ms = Number(waitMs);
    if (Number.isFinite(ms) && ms > 0) await sleep(ms);
    if (ready() || !pending()) return "ready";
  }
  return ready() ? "ready" : "timeout";
}

/**
 * #1914 — typed readiness refusal for `workflow_open` after a reconnect
 * handshake miss.
 *
 * Distinct from `workflow_list`'s pre-probe refusal (#1785): this is a mutator,
 * but it has not yet frozen, switched, or loaded anything, so `applied: false`
 * is a claim this throw is entitled to make. That is the load-bearing part —
 * it converts "command was already delivered; outcome undetermined" into
 * "nothing happened, retry".
 *
 * Authority lives in a WeakSet of the Error objects this function minted, the
 * same unforgeable shape as the graph-mutation gate. A property on the Error
 * would be inherited and settable; membership here is not.
 */
const OPEN_READINESS_REFUSALS = new WeakSet();

export function workflowOpenReadinessRefusalError(reason) {
  const detail =
    typeof reason === "string" && reason.trim()
      ? reason.trim()
      : "the reconnect handshake is still settling";
  const error = new Error(
    "workflow_open did not start because " +
      detail +
      " within the bounded readiness window. Nothing was opened, reloaded, or rebound — " +
      "the canvas is unchanged — so this is safe to retry in a moment.",
  );
  OPEN_READINESS_REFUSALS.add(error);
  return error;
}

/**
 * @returns {{code: "reconnect-not-ready", ready: false, applied: false,
 *   stage: "pre-open", retryable: true}|null}
 */
export function readWorkflowOpenReadinessRefusal(error) {
  if (!error || typeof error !== "object" || !OPEN_READINESS_REFUSALS.has(error)) return null;
  return {
    code: "reconnect-not-ready",
    ready: false,
    applied: false,
    stage: "pre-open",
    retryable: true,
  };
}

/**
 * The #646 graph-mutation gate: the refusal message for a mutating graph
 * command that arrives while the post-reconnect environment is known-unstable,
 * or null when the command may run. Two independent instability signals:
 *
 *   - backendDown: ComfyUI's own backend socket is between its "reconnecting"
 *     and "reconnected" events. A mutation dispatched in that gap lands on a
 *     canvas the incoming restore is about to rebuild — applied-then-wiped is
 *     the fabricated-success outcome this repo treats as the worst case.
 *   - bindingSettleWindow: a reconnect happened within the possibly-stale
 *     window and the canvas binding has NOT been re-proven for this epoch yet
 *     (the watch / an explicit open/new closes this). Reads stay available on
 *     their own evidence bars; only mutations are gated.
 *
 * Both refusals are retryable and state that nothing was applied — true
 * because the gate runs BEFORE the executor.
 *
 * ## Why this returns STRUCTURE, not a sentence (#1529)
 *
 * That last paragraph is the fact an automatic retry depends on, and until now it
 * existed only in prose. The orchestrator half of #1529 was first written to
 * regex-match this text to decide a retry was safe, and was reverted as a P0:
 * the property being asserted — "the executor did not run" — is not derivable
 * from a string the executor itself could have produced. Acknowledged panel
 * errors travel as arbitrary `msg.error` text, so any sentence written here, a
 * genuine mid-write failure can also contain. Being wrong does not print a bad
 * message; it DOUBLE-APPLIES a graph mutation.
 *
 * So the trusted side states it structurally and the reader keys on that. This
 * is the same shape as the bridge's other provenance channels (`markReplyTimeout`,
 * `tabIncarnation`, the #514 open receipt): a fact the panel KNOWS, published as
 * a field rather than inferred from wording.
 *
 * `applied: false` is a claim this gate is entitled to make and callers are not:
 * it is true precisely because the gate runs before the executor, which is why
 * both call sites must keep invoking it there.
 *
 * @returns {{code: string, message: string, applied: false, stage: "pre-executor",
 *   retryable: true}|null}
 */
/** Record a refusal as gate-produced and return it unchanged. */
function brandGateRefusal(refusal) {
  GATE_REFUSALS.add(refusal);
  return refusal;
}

/** ComfyUI's WebSocket OPEN readyState. Inlined so Node tests need no DOM WebSocket. */
export const WS_OPEN = 1;

/**
 * #1325 — is the backend socket actually down RIGHT NOW?
 *
 * The sticky `comfyBackendSocketDown` flag is necessary: ComfyUI announces a drop
 * as events, and a mutation in that gap is the #646 applied-then-wiped hazard.
 * It is not sufficient. ComfyUI also dispatches `status` with a null payload from
 * `_pollQueue` whenever `GET /prompt` fails, and that poller — once started —
 * runs for the life of the tab. A long GPU-bound render (Wan 2.2 dual-pass)
 * blocks the backend event loop, the poll fails, the flag arms, and `reconnected`
 * never fires again because the websocket never left OPEN. Graph reads keep
 * working (they read the local canvas); mutations stay refused forever.
 *
 * The live readyState is the fact a restore-is-incoming decision can rest on:
 * OPEN means no canvas rebuild is in flight. Flagged-down + OPEN is a stale or
 * busy-poll signal, not a down socket.
 *
 * An omitted/unknown readyState + flaggedDown still refuses — fail closed when
 * we cannot see the socket, which is the #646 direction.
 */
export function backendSocketIsDown({ flaggedDown = false, socketReadyState } = {}) {
  if (flaggedDown !== true) return false;
  if (socketReadyState === WS_OPEN) return false;
  return true;
}

/**
 * #1325 — classify a ComfyUI `status` event for the mutation-guard flag.
 *
 *   - "alive"  — a real queue/status payload; the backend is talking
 *   - "lost"   — null payload AND the socket is not OPEN (the close-handler signal)
 *   - "ignore" — null payload while the socket is still OPEN (busy `/prompt` poll)
 */
export function classifyBackendStatusEvent({ detail, socketReadyState } = {}) {
  if (detail != null && typeof detail === "object") return "alive";
  if (detail == null) {
    return socketReadyState === WS_OPEN ? "ignore" : "lost";
  }
  return "ignore";
}

const BACKEND_SOCKET_DOWN_NOTE =
  "ComfyUI's backend connection is down (a restart or reconnect is in progress). " +
  "The canvas is still readable from local state, but graph mutations are refused " +
  "until the backend reconnects. Wait a few seconds and retry; if it never comes " +
  "back, reload the ComfyUI page or restart ComfyUI.";

/**
 * #1325 — binding-status view of the backend socket.
 *
 * Canvas binding ("bound") is a different question (who owns this graph). A
 * reply that reports only `bound`/`already_current` while mutations are gated
 * is the #1325 misread: the agent retries the wrong recovery. When the socket
 * is down, `graph_binding` is "reconnecting" and `canvas_binding` still names
 * the canvas identity so the two facts stay distinguishable.
 */
export function describeGraphMutationReadiness({
  flaggedDown = false,
  socketReadyState,
  canvasBinding,
} = {}) {
  const down = backendSocketIsDown({ flaggedDown, socketReadyState });
  const canvas =
    canvasBinding === "bound" || canvasBinding === "foreign" || canvasBinding === "unknown"
      ? canvasBinding
      : null;
  if (down) {
    return {
      backend_socket: "reconnecting",
      mutations_ready: false,
      graph_binding: "reconnecting",
      ...(canvas ? { canvas_binding: canvas } : {}),
      backend_socket_note: BACKEND_SOCKET_DOWN_NOTE,
    };
  }
  return {
    backend_socket: "up",
    mutations_ready: true,
    ...(canvas ? { canvas_binding: canvas, graph_binding: canvas } : {}),
  };
}

export function graphMutationReconnectGate({ cmd, backendDown = false, bindingSettleWindow = false } = {}) {
  const name = typeof cmd === "string" && cmd ? `"${cmd}"` : "this graph command";
  /** Every refusal from this gate shares these — see the docblock. */
  const base = { applied: false, stage: "pre-executor", retryable: true };
  if (backendDown) {
    return brandGateRefusal({
      ...base,
      code: "backend-reconnecting",
      message:
        `[backend-reconnecting] ComfyUI's backend connection is down right now (a restart or ` +
        `reconnect is in progress), so ${name} was NOT applied — nothing changed. A graph mutation ` +
        `dispatched in this window can land on a canvas the reconnect is about to rebuild. Retry ` +
        `once the tab has reconnected (usually seconds); if it never reconnects, reload the ComfyUI page.`,
    });
  }
  if (bindingSettleWindow) {
    return brandGateRefusal({
      ...base,
      code: "post-reconnect-settling",
      message:
        `[post-reconnect-settling] ComfyUI reconnected moments ago and the panel has not yet ` +
        `re-proven that the canvas is bound to the active workflow, so ${name} was NOT applied — ` +
        `nothing changed. The panel re-proves the binding automatically (usually within a few ` +
        `seconds); retry in a moment. If this persists past ~30 seconds, re-open the active ` +
        `workflow tab (panel_open_workflow) or reload the panel (panel_reload scope:frontend), then retry.`,
    });
  }
  return null;
}

/** The codes this gate is allowed to publish. An enumerated list, not a shape
 *  test: a reader keys its retry on the code, so an unrecognised one must not
 *  reach it (the #1478 lesson — enumerate, do not pattern-match). */
const REFUSAL_CODES = new Set(["backend-reconnecting", "post-reconnect-settling"]);

/**
 * The errors THIS MODULE minted. A WeakSet, not a marker property:
 *
 *   - a property is inherited. `err?.cmcpRefusal` walks the prototype chain, so
 *     anything that lands `cmcpRefusal` on `Error.prototype` — a polyfill, a
 *     careless extension, a bad merge — makes EVERY error in the page read as a
 *     pre-executor refusal, including one thrown after a node was already added.
 *   - a property is also settable. Membership here is not.
 *
 * The set holds the errors themselves and is unreachable from outside this
 * module, so it answers the only question the reader actually has: did the gate
 * produce this, before the executor ran? Entries are weak, so a caught-and-
 * discarded error is still collectable.
 */
const MINTED_REFUSALS = new WeakSet();

/**
 * The refusal objects `graphMutationReconnectGate` itself produced.
 *
 * Re-review, P0: minting used to accept any object of the right shape, which
 * made `reconnectRefusalError` an unrestricted authority — a call site added
 * AFTER a graph write could hand it a hand-built literal and publish
 * "applied:false, safe to retry" about a write that had already landed. The
 * retry then duplicates the node, which is the exact outcome this whole channel
 * exists to prevent.
 *
 * So the mint's input must come from the gate, and the gate only returns non-null
 * when it has actually refused. That does not by itself prove the executor had
 * not run — a caller could still invoke the gate late — but it removes the
 * forgery path, and the remaining question ("is this call site pre-executor?") is
 * answered where it must be, at the two call sites, and pinned by a test that
 * fails if a third appears.
 */
const GATE_REFUSALS = new WeakSet();

/**
 * Throwable form: an Error whose message is unchanged from before, carrying the
 * structured refusal on a named property so the reply builder can publish it.
 *
 * A dedicated property rather than spreading fields onto the Error: `code` and
 * `message` on an Error are conventional and already mean other things to other
 * readers, and a refusal that quietly changed what `err.code` means for every
 * catch in the file is the kind of collision that surfaces months later.
 */
export function reconnectRefusalError(refusal) {
  // The mint takes only what the GATE produced. A hand-built literal of the
  // right shape is rejected loudly rather than minted, so a call site added
  // after a write cannot manufacture "applied:false, safe to retry" about a
  // write that already landed (re-review, P0). Throwing rather than returning
  // null because every caller here is `throw reconnectRefusalError(gate)` — a
  // null would become a TypeError one line later with no explanation, and a
  // silent Error would publish no refusal at all while looking fine.
  if (!refusal || typeof refusal !== "object" || !GATE_REFUSALS.has(refusal)) {
    throw new TypeError(
      "reconnectRefusalError: refusals may only be minted from graphMutationReconnectGate's own return value",
    );
  }
  const err = new Error(refusal.message);
  // defineProperty, not assignment. `err.cmcpRefusal = …` is an assignment, and
  // an assignment to a property that exists on the PROTOTYPE as non-writable
  // THROWS in strict mode — which ES modules are. So a polluted Error.prototype
  // would not merely confuse the reader: it would make this function throw a
  // TypeError from inside the gate's call site, replacing a clear refusal with
  // an unrelated crash. (Found by the pollution test below, which was written
  // for the reader and caught this instead.) defineProperty creates the OWN
  // property regardless of what the prototype says.
  Object.defineProperty(err, "cmcpRefusal", {
    value: {
      code: refusal.code,
      applied: refusal.applied,
      stage: refusal.stage,
      retryable: refusal.retryable,
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  MINTED_REFUSALS.add(err);
  return err;
}

/**
 * The reader's side: the refusal to publish for a caught error, or null.
 *
 * Every caller must go through this rather than reading `err.cmcpRefusal`
 * directly, because the property alone answers a WEAKER question than the one a
 * retry depends on. The field says "something set this"; the retry needs "the
 * gate set this, before the executor ran". Those differ exactly in the case that
 * costs a graph: an error thrown AFTER a write, carrying the property by
 * inheritance or by an unrelated assignment, would be published as
 * applied:false and retried into a duplicate node (review, P0).
 *
 * Three independent conditions, all required:
 *
 *   1. this module minted the error (unforgeable, and immune to a polluted
 *      prototype);
 *   2. the payload is an OWN property — not one inherited after minting;
 *   3. every field still holds the exact value the gate is entitled to claim.
 *
 * (3) matters because the payload is a mutable object on a mutable error: being
 * minted at throw time does not prove it was unmodified at catch time. The
 * literals are re-asserted rather than copied, and the returned object is built
 * FRESH — so nothing that was attached to the caught payload rides along onto
 * the wire.
 *
 * @returns {{code: string, applied: false, stage: "pre-executor", retryable: true}|null}
 */
export function readReconnectRefusal(err) {
  if (!err || typeof err !== "object") return null;
  if (!MINTED_REFUSALS.has(err)) return null;
  if (!Object.prototype.hasOwnProperty.call(err, "cmcpRefusal")) return null;
  const payload = err.cmcpRefusal;
  if (!payload || typeof payload !== "object") return null;
  if (!REFUSAL_CODES.has(payload.code)) return null;
  // The three claims, re-checked. Anything else is not this gate's refusal, and
  // "unrecognised" must read as no refusal at all — the direction that merely
  // loses an automatic retry, rather than the one that double-applies a write.
  if (payload.applied !== false) return null;
  if (payload.stage !== "pre-executor") return null;
  if (payload.retryable !== true) return null;
  return { code: payload.code, applied: false, stage: "pre-executor", retryable: true };
}
