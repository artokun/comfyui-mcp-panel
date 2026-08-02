// #556 — panel_run's to_node_id ("run to node") must NEVER silently fall through
// to a FULL-graph execution. A scoped run can fail open on two channels:
//
//  1. SCOPE RESOLUTION — the id is stale/unknown, names a non-output node, or
//     lives in a subgraph the live root can't reach. graph_run resolves strictly
//     via resolveRunToNodeTarget and REFUSES before dispatch (queued:false,
//     naming what couldn't be resolved). Covered by subgraph-scope.test.mjs.
//
//  2. SCOPE DELIVERY — a VALID target must survive the trip through
//     app.queuePrompt into the POST /prompt body as partial_execution_targets.
//     The queuePrompt 3rd-argument SHAPE differs across frontend builds:
//     a positional NodeExecutionId[] on some, a QueuePromptOptions
//     { queueNodeIds } object on others (options builds carry an Array.isArray
//     compat shim for the legacy array). A build that accepts only ONE shape
//     silently IGNORES the other — the scope never reaches the request, the FULL
//     graph queues, and panel_run still reports ran_to_node (#556: an unrelated
//     SaveImage branch rendered and wrote a file nobody asked for). A minified
//     queuePrompt signature can't be sniffed reliably, so the guarantee is
//     enforced at the one place every build must pass through: the POST /prompt
//     request body.
//
// Three dispatch realities shape the design (codex gate, rounds 1–2):
//
//  - app.queuePrompt is NOT synchronous with the POST. When its processor is
//    already busy it pushes the item and RETURNS EARLY — the prompt is
//    serialized and posted LATER by the in-flight processor. A guard restored
//    when queuePrompt returns never sees that deferred dispatch. So the scoped
//    guard stays installed until our dispatch is actually OBSERVED (a POST
//    carrying exactly our targets, attributed to our prompt, has passed
//    through) or a bounded timeout — and a run whose dispatch never surfaces
//    reports a truthful "could not verify", never queued:true.
//
//  - While installed, the guard sees EVERY POST /prompt in the tab (a user
//    queue, another processor's item). Attribution is by PROMPT SIGNATURE
//    FIRST (the sorted node-id|class_type set of the graphToPrompt output we
//    queued — widget values excluded so beforeQueued seed randomization can't
//    blur it), targets second:
//      · signature matches, targets exactly ours → OUR scoped dispatch:
//        observed, passed through, response captured.
//      · signature matches, targets MISSING/WRONG/EXTRA/PARTIAL → OUR dispatch
//        CORRUPTED (the frontend dropped/mangled the scope argument): refused
//        before it leaves, bounded by this batch's post count. A body with
//        ["14","9"] is NOT "someone else's" — it's our scope with an unwanted
//        branch attached, and letting it out would run that work.
//      · signature does NOT match → FOREIGN: passed through untouched, never
//        captured, never refused, and NEVER counts as our observation — even
//        if it carries the same targets (a foreign same-targets post must not
//        satisfy `observed` and let our own deferred corrupted post escape).
//    Known limit: a concurrent full run of the byte-identical node set inside
//    the window is indistinguishable from our own corrupted dispatch and is
//    treated as ours (bounded by batch).
//
//  - On timeout the deferred queue item may STILL be live in the frontend's
//    pending list; restoring the guard then would let a scope-dropped dispatch
//    escape later. graph_run therefore tries to REMOVE the pending item
//    (cancelPendingScopedQueueItem — the frontend keeps its queueItems array
//    runtime-accessible on TS-`private` builds; older builds hard-privatize it
//    as #queueItems, and a scope-dropped item may carry no attributable
//    targets). When removal is impossible the guard stays installed as a
//    sentinel — still surgical, still batch-bounded — until a much longer
//    bound expires, so the corrupted dispatch is refused whenever it posts.
//
// Extracted as a pure module so the SAME guard graph_run installs is drivable
// from `node --test` (the live app.queuePrompt path can't be).

/**
 * The ordered list of 3rd-argument shapes to try for app.queuePrompt when a
 * run-to-node scope is requested. The positional array comes first (native on
 * positional builds, normalized by the Array.isArray shim on options builds);
 * the QueuePromptOptions object is the fallback for builds that dropped the
 * shim. `[undefined]` when no scope was requested — a plain full run, exactly
 * the historical call shape.
 *
 * @param {string[]|undefined} partialTargets
 * @returns {(string[]|{queueNodeIds:string[]}|undefined)[]}
 */
export function queuePromptScopeArgs(partialTargets) {
  if (!Array.isArray(partialTargets) || !partialTargets.length) return [undefined];
  return [partialTargets, { queueNodeIds: partialTargets }];
}

/**
 * The prompt signature used to attribute a POST /prompt body to THIS run: the
 * sorted node-id|class_type pairs of a graphToPrompt output (the API workflow).
 * Widget values are EXCLUDED — queuePrompt randomizes seeds via beforeQueued
 * between serialization calls, so a value-level fingerprint would miss our own
 * dispatch. Two runs of the same unedited graph share a signature; the batch
 * bound in the guard limits what that ambiguity can mis-attribute.
 */
export function promptSignature(output) {
  if (!output || typeof output !== "object") return null;
  const keys = Object.keys(output);
  if (!keys.length) return null;
  return keys
    .sort()
    .map((k) => `${k}${output[k]?.class_type ?? ""}`)
    .join("|");
}

/** Signature of a raw POST /prompt body, or null when unparseable/odd. */
export function promptSignatureFromBody(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  return promptSignature(body?.prompt);
}

/** The body's partial_execution_targets as strings, or null when absent/empty/unparseable. */
function targetsFromBody(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const t = body?.partial_execution_targets;
  if (!Array.isArray(t) || !t.length) return null;
  return t.map(String);
}

function sameSet(a, b) {
  return a.length === b.length && b.every((x) => a.includes(x));
}

/**
 * Verify a POST /prompt request body carries EXACTLY the requested
 * partial-execution scope. Compared as string sets (server exec ids are strings;
 * a colon path like "76:34" for a subgraph-nested output must survive verbatim).
 * Any deviation — missing key, empty list, wrong/extra targets, an unparseable
 * body — is a refusal: an unverifiable scope is treated as a dropped scope.
 *
 * @param {string|undefined} bodyText        Raw request body (JSON string).
 * @param {string[]|null} expectedExecIds    The scope graph_run resolved, or null.
 * @returns {{ok:true}|{ok:false, reason:"scope_missing"|"scope_mismatch", expected:string[], got:string[]|null}}
 */
export function verifyScopedPromptBody(bodyText, expectedExecIds) {
  const expected = (expectedExecIds ?? []).map(String);
  if (!expected.length) return { ok: true }; // no scope requested — nothing to verify
  const got = targetsFromBody(bodyText);
  if (!got) return { ok: false, reason: "scope_missing", expected, got: null };
  if (!sameSet(got, expected)) return { ok: false, reason: "scope_mismatch", expected, got };
  return { ok: true };
}

/**
 * The truthful refusal message when our own dispatch surfaced WITHOUT the
 * scope. Names the node that couldn't be scoped and states plainly that
 * NOTHING was queued — never a false `queued:true`/`ran_to_node` for what
 * would have been a full-graph run.
 */
export function scopeDroppedError({ toNodeId, verdict }) {
  const detail =
    verdict?.reason === "scope_mismatch"
      ? `the POST /prompt body carried partial_execution_targets ` +
        `${JSON.stringify(verdict.got)} instead of ${JSON.stringify(verdict.expected)}`
      : `the POST /prompt body carried no partial_execution_targets — this ` +
        `frontend build ignored the run-to-node argument`;
  return (
    `run-to-node scope for node ${toNodeId} was NOT applied: ${detail}. ` +
    `Nothing was queued — refusing to fall through to a full-graph execution (#556).`
  );
}

/**
 * The truthful UNVERIFIED outcome when no scoped dispatch surfaced within the
 * observation window (a busy queuePrompt deferred the post past its return, or
 * the prompt build failed silently).
 *  - cancelled:  the still-pending frontend queue item was located and REMOVED
 *    — "nothing was queued" is then literally true.
 *  - lingering:  removal was impossible, so the surgical guard stays installed
 *    for lingerMs as a sentinel — a late scope-dropped dispatch is still
 *    refused whenever it posts. Only "nothing CONFIRMED queued" is claimed.
 */
export function scopeUnverifiedError({ toNodeId, timeoutMs, cancelled = false, lingerMs = 0 }) {
  const base =
    `run-to-node scope for node ${toNodeId} could not be verified: no scoped ` +
    `dispatch was observed within ${Math.round(timeoutMs / 1000)}s of queueing ` +
    `(the frontend deferred or silently dropped the request). `;
  if (cancelled) {
    return (
      base +
      `The still-pending queue item was located and REMOVED, so nothing was ` +
      `queued and no scope-dropped full-graph dispatch can execute — retry the run (#556).`
    );
  }
  return (
    base +
    `The pending queue item could not be removed on this frontend, so the scope ` +
    `guard stays installed for up to ${Math.round(lingerMs / 60000)}min as a sentinel — ` +
    `any late dispatch of this prompt WITHOUT the scope will still be refused. ` +
    `Nothing is CONFIRMED queued — check the ComfyUI queue before retrying (#556).`
  );
}

const SCOPE_DROPPED_RESPONSE = () =>
  new Response(
    JSON.stringify({
      error: {
        type: "partial_execution_scope_dropped",
        message: "run-to-node scope was not applied; nothing was queued",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );

function isPromptPost(route, options) {
  const method = String(options?.method || "GET").toUpperCase();
  const path = typeof route === "string" ? route.split("?")[0] : "";
  return method === "POST" && path.endsWith("/prompt");
}

// Capture the #358 top-level rejection / #370 prompt_id out of a /prompt
// response that is ATTRIBUTED to this run. prompt_id is normalized to a string
// at capture (0 and "0" are the same run).
async function captureRunResponse(res, { onRejection, onPromptId }) {
  try {
    const body = await res.clone().json();
    if (res.status !== 200) {
      if (body && (body.error || body.node_errors)) {
        onRejection?.({ error: body.error ?? null, node_errors: body.node_errors ?? null });
      }
    } else if (body && body.prompt_id != null) {
      onPromptId?.(String(body.prompt_id));
    }
  } catch {
    // non-JSON body / clone unsupported — the caller falls back to lastNodeErrors.
  }
}

/**
 * The api.fetchApi replacement graph_run installs around an UNSCOPED run — the
 * historical #358/#370 capture wrap, byte-identical in behavior: app.queuePrompt
 * SWALLOWS a synchronous top-level rejection (dialog, then discarded — it never
 * lands on lastNodeErrors), so the raw non-200 /prompt body is the only place
 * that error exists; and EVERY accepted prompt_id is captured for the recovery
 * ledger. Installed only for the duration of the queuePrompt call.
 */
export function createRunFetchInterceptor({ origFetchApi, onRejection = null, onPromptId = null } = {}) {
  return async function runFetchInterceptor(route, options) {
    const res = await origFetchApi(route, options);
    if (isPromptPost(route, options) && res) {
      await captureRunResponse(res, { onRejection, onPromptId });
    }
    return res;
  };
}

/**
 * The api.fetchApi replacement graph_run installs for a SCOPED run — see the
 * module header for the attribution rules this enforces. The guard stays
 * installed until the caller restores it (on observation, on a successful
 * pending-item cancellation, or via the long-bound sentinel timer); it does
 * not restore itself. state = { observed, dropped } is live; waitForVerdict(ms)
 * resolves true as soon as either is set, false on timeout.
 *
 * @param {object}   args
 * @param {Function} args.origFetchApi
 * @param {string[]} args.execIds        This run's resolved partial-execution targets.
 * @param {string|null} [args.signature] promptSignature of the graphToPrompt output we queued.
 * @param {number} [args.batch]          Bound on how many corrupted posts are attributable to us.
 * @param {*}        [args.toNodeId]
 */
export function createScopedRunGuard({
  origFetchApi,
  execIds,
  signature = null,
  batch = 1,
  toNodeId = null,
  onRejection = null,
  onPromptId = null,
  onScopeDropped = null,
} = {}) {
  const expected = (execIds ?? []).map(String);
  const maxBatch = Math.max(1, Math.floor(Number(batch)) || 1);
  let refused = 0; // corrupted posts refused so far (batch-bounded)
  const state = { observed: 0, dropped: null };
  const waiters = new Set();
  const notify = () => {
    for (const fire of [...waiters]) fire();
  };

  const guard = async (route, options) => {
    if (!isPromptPost(route, options)) return origFetchApi(route, options);
    const targets = targetsFromBody(options?.body);
    // SIGNATURE FIRST: only a body whose node set is exactly the prompt we
    // queued can be this run — matched or corrupted. Everything else is
    // foreign: passed through untouched, never captured, never observed,
    // never refused (even a foreign post carrying the SAME targets).
    // Degraded mode: with NO signature (graphToPrompt failed at queue time) we
    // can only attribute a post carrying EXACTLY our targets — enough to still
    // verify a delivered scope, never enough to refuse (never blocks strangers).
    const attributable = signature
      ? promptSignatureFromBody(options?.body) === signature
      : targets != null && sameSet(targets, expected);
    if (!attributable) return origFetchApi(route, options);
    if (targets && sameSet(targets, expected)) {
      // OUR scoped dispatch, verifiably delivered.
      state.observed++;
      const res = await origFetchApi(route, options);
      if (res) await captureRunResponse(res, { onRejection, onPromptId });
      notify();
      return res;
    }
    // OUR dispatch CORRUPTED — scope missing, or wrong/extra/partial targets
    // (["14","9"] would run an unwanted branch; "9" would run the wrong one).
    // Only reachable with a signature; the batch bound caps the documented
    // same-node-set ambiguity.
    if (refused < maxBatch) {
      refused++;
      state.dropped = scopeDroppedError({
        toNodeId,
        verdict: targets
          ? { ok: false, reason: "scope_mismatch", expected, got: targets }
          : { ok: false, reason: "scope_missing", expected, got: null },
      });
      onScopeDropped?.(state.dropped);
      notify();
      return SCOPE_DROPPED_RESPONSE();
    }
    // Refusal budget for this batch is exhausted — beyond this point a
    // same-signature body is not ours to judge (documented ambiguity bound).
    return origFetchApi(route, options);
  };
  guard.state = state;
  guard.waitForVerdict = (ms) =>
    new Promise((resolve) => {
      if (state.observed > 0 || state.dropped) return resolve(true);
      const fire = () => {
        clearTimeout(timer);
        waiters.delete(fire);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(fire);
        resolve(false);
      }, ms);
      waiters.add(fire);
    });
  return guard;
}

/**
 * Best-effort removal of THIS run's still-pending item(s) from the frontend's
 * in-memory queueItems (the not-yet-posted deferred dispatch — the server-side
 * /queue never saw it, so server queue control can't help). The frontend keeps
 * the array runtime-accessible as app.queueItems on TS-`private` builds; older
 * builds hard-privatize it (#queueItems) and then this is impossible — the
 * caller keeps the guard installed as a sentinel instead (module header).
 *
 * An item is only removed when its stored targets NORMALIZE to exactly this
 * run's scope (either the raw array or the {queueNodeIds} options shape a
 * positional build stored verbatim) — a user's pending full-run item carries
 * no targets and is never touched, and a scope-dropped item whose build stored
 * no attributable targets can't be identified (left for the sentinel).
 *
 * @returns {{accessible: boolean, removed: number}}
 */
export function cancelPendingScopedQueueItem(app, expectedExecIds) {
  const items = app?.queueItems;
  if (!Array.isArray(items)) return { accessible: false, removed: 0 };
  const expected = (expectedExecIds ?? []).map(String);
  let removed = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const raw = items[i]?.queueNodeIds;
    const ids = Array.isArray(raw) && raw.length
      ? raw.map(String)
      : raw && Array.isArray(raw.queueNodeIds) && raw.queueNodeIds.length
        ? raw.queueNodeIds.map(String)
        : null;
    if (ids && sameSet(ids, expected)) {
      items.splice(i, 1);
      removed++;
    }
  }
  return { accessible: true, removed };
}
