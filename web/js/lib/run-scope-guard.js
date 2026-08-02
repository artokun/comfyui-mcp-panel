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
// Two dispatch realities shape the design (codex gate on the first cut):
//
//  - app.queuePrompt is NOT synchronous with the POST. When its processor is
//    already busy it pushes the item and RETURNS EARLY — the prompt is
//    serialized and posted LATER by the in-flight processor. A guard restored
//    when queuePrompt returns never sees that deferred dispatch (P0). So the
//    scoped guard stays installed until our dispatch is actually OBSERVED (a
//    POST carrying exactly our targets has passed through) or a bounded
//    timeout — and a run whose dispatch never surfaces reports a truthful
//    "could not verify — nothing confirmed queued", never queued:true.
//
//  - While installed, the guard sees EVERY POST /prompt in the tab, including
//    unrelated ones (a user queue, another processor's item). Refusing any
//    body that merely lacks our targets would 400 a stranger's legitimate full
//    run (P1). So the guard is SURGICAL: it only refuses a targetless body
//    that matches THIS run's prompt signature (the sorted node-id|class_type
//    set of the graphToPrompt output we queued — widget values excluded so
//    beforeQueued seed randomization can't blur it), and only for as many
//    posts as this batch still has unattributed. Everything else — unrelated
//    full runs, other scoped runs, unparseable bodies — passes through
//    untouched and is never captured as ours. Known limit: a concurrent full
//    run of the byte-identical node set inside the window is indistinguishable
//    from our own dropped dispatch and is treated as ours (bounded by batch).
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
    .map((k) => `${k}${output[k]?.class_type ?? ""}`)
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

/** The body body's partial_execution_targets as strings, or null when absent/empty/unparseable. */
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
 * the prompt build failed silently). Deliberately does NOT say "nothing was
 * queued" — a deferred post may still land later, unverifiably — only that
 * nothing is CONFIRMED queued, so the caller must check the ComfyUI queue
 * rather than assume a scoped run happened.
 */
export function scopeUnverifiedError({ toNodeId, timeoutMs }) {
  return (
    `run-to-node scope for node ${toNodeId} could not be verified: no scoped ` +
    `dispatch was observed within ${Math.round(timeoutMs / 1000)}s of queueing ` +
    `(the frontend deferred or silently dropped the request). Nothing is ` +
    `CONFIRMED queued — check the ComfyUI queue, and retry the run; the panel ` +
    `did not report this as a scoped execution (#556).`
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
 * module header for the two dispatch realities this is shaped by.
 *
 * Attribution, per POST /prompt body:
 *  - carries exactly our targets       → OUR scoped dispatch: pass through,
 *    count it OBSERVED, capture its response (rejection / prompt_id).
 *  - carries someone else's targets    → unrelated scoped run: untouched,
 *    never captured.
 *  - carries NO targets, matches our prompt signature, and this batch still
 *    has unattributed posts           → OUR dispatch gone wrong (the frontend
 *    ignored the scope argument): REFUSE before origFetchApi runs — the
 *    unscoped prompt never leaves the tab — and record state.dropped so the
 *    caller can retry the other argument shape.
 *  - anything else (other signature, batch already accounted, unparseable)
 *                                      → unrelated: untouched, never captured.
 *
 * The guard stays installed until the caller has observed a verdict; it does
 * not restore itself. state = { observed, dropped } is live;
 * waitForVerdict(ms) resolves true as soon as either is set, false on timeout.
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
  let oursAccounted = 0; // verified + refused posts attributable to THIS batch
  const state = { observed: 0, dropped: null };
  const waiters = new Set();
  const notify = () => {
    for (const fire of [...waiters]) fire();
  };

  const guard = async (route, options) => {
    if (!isPromptPost(route, options)) return origFetchApi(route, options);
    const targets = targetsFromBody(options?.body);
    if (targets) {
      if (!sameSet(targets, expected)) {
        // A scoped run for SOMEONE ELSE — never touch it.
        return origFetchApi(route, options);
      }
      oursAccounted++;
      state.observed++;
      const res = await origFetchApi(route, options);
      if (res) await captureRunResponse(res, { onRejection, onPromptId });
      notify();
      return res;
    }
    // Targetless body. Ours-gone-wrong only while it matches our signature and
    // we still have unattributed batch posts outstanding.
    if (signature && promptSignatureFromBody(options?.body) === signature && oursAccounted < maxBatch) {
      oursAccounted++;
      state.dropped = scopeDroppedError({
        toNodeId,
        verdict: { ok: false, reason: "scope_missing", expected, got: null },
      });
      onScopeDropped?.(state.dropped);
      notify();
      return SCOPE_DROPPED_RESPONSE();
    }
    // Unrelated full run (or unattributable) — untouched, never captured.
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
