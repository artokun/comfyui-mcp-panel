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
//     queuePrompt signature can't be sniffed reliably, so this module enforces
//     the guarantee at the one place every build must pass through: the POST
//     /prompt request body. When a scope was requested, any /prompt body that
//     doesn't carry EXACTLY that scope is REFUSED BEFORE origFetchApi runs —
//     nothing is dispatched unscoped — and the caller retries the OTHER
//     argument shape once, then refuses truthfully if neither shape delivers.
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
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  const targets = Array.isArray(body?.partial_execution_targets)
    ? body.partial_execution_targets.map(String)
    : null;
  if (!targets || !targets.length) {
    return { ok: false, reason: "scope_missing", expected, got: targets };
  }
  const same =
    targets.length === expected.length && expected.every((e) => targets.includes(e));
  if (!same) return { ok: false, reason: "scope_mismatch", expected, got: targets };
  return { ok: true };
}

/**
 * The truthful refusal message when the scope didn't reach the request. Names
 * the node that couldn't be scoped and states plainly that NOTHING was queued —
 * never a false `queued:true`/`ran_to_node` for what would have been a
 * full-graph run.
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
 * The api.fetchApi replacement graph_run installs for the duration of ONE queue
 * attempt. Two jobs:
 *
 *  - SCOPE GUARD (#556, above): for a scoped run, inspect every POST /prompt
 *    body BEFORE it leaves and refuse any that dropped the scope — the blocked
 *    call NEVER reaches origFetchApi, so no unscoped prompt is dispatched. The
 *    refusal is shaped like a server 400 so the frontend walks its normal
 *    rejection path (the same dialog a real refused prompt shows), while the
 *    onScopeDropped callback hands graph_run the truthful error to return.
 *
 *  - RESPONSE CAPTURE (#358/#370, moved verbatim from graph_run): app.queuePrompt
 *    SWALLOWS a synchronous top-level rejection (dialog, then discarded — it
 *    never lands on lastNodeErrors), so the raw non-200 /prompt body is the only
 *    place that error exists; and EVERY accepted prompt_id must be captured for
 *    the recovery ledger. onPromptId receives the id NORMALIZED TO A STRING at
 *    capture (0 and "0" are the same run).
 *
 * @param {object}   args
 * @param {Function} args.origFetchApi      The real api.fetchApi (bound).
 * @param {string[]|null} [args.partialTargets]  Resolved scope, or null for a full run.
 * @param {*}        [args.toNodeId]        The requested to_node_id (for the refusal message).
 * @param {Function} [args.onRejection]     ({error, node_errors}) for a non-200 /prompt.
 * @param {Function} [args.onPromptId]      (promptId:string) for each accepted prompt.
 * @param {Function} [args.onScopeDropped]  (message:string) when the guard refuses.
 */
export function createRunFetchInterceptor({
  origFetchApi,
  partialTargets = null,
  toNodeId = null,
  onRejection = null,
  onPromptId = null,
  onScopeDropped = null,
} = {}) {
  const scoped = Array.isArray(partialTargets) && partialTargets.length > 0;
  return async function runFetchInterceptor(route, options) {
    const method = String(options?.method || "GET").toUpperCase();
    const path = typeof route === "string" ? route.split("?")[0] : "";
    const isPromptPost = method === "POST" && path.endsWith("/prompt");
    if (isPromptPost && scoped) {
      const verdict = verifyScopedPromptBody(options?.body, partialTargets);
      if (!verdict.ok) {
        onScopeDropped?.(scopeDroppedError({ toNodeId, verdict }));
        // Refuse WITHOUT touching origFetchApi — the unscoped prompt must never
        // leave the tab. 400 mirrors a server-side rejection so app.queuePrompt
        // handles it through its existing refused-prompt path.
        return new Response(
          JSON.stringify({
            error: {
              type: "partial_execution_scope_dropped",
              message: "run-to-node scope was not applied; nothing was queued",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    const res = await origFetchApi(route, options);
    if (isPromptPost && res) {
      try {
        const body = await res.clone().json();
        if (res.status !== 200) {
          if (body && (body.error || body.node_errors)) {
            onRejection?.({
              error: body.error ?? null,
              node_errors: body.node_errors ?? null,
            });
          }
        } else if (body && body.prompt_id != null) {
          onPromptId?.(String(body.prompt_id));
        }
      } catch {
        // non-JSON body / clone unsupported — the caller falls back to lastNodeErrors.
      }
    }
    return res;
  };
}
