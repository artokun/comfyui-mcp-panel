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
//     graph queues, and panel_run still reports ran_to_node (#556). A minified
//     queuePrompt signature can't be sniffed reliably, so the guarantee is
//     enforced at the one place every build must pass through: the POST /prompt
//     request body.
//
// RUN IDENTITY (codex gate r3/r4). Content alone cannot always tell our dispatch
// from a stranger's: an identical-node-set foreign post is indistinguishable
// from ours, and a user's full run of the same graph looks exactly like our
// scope-dropped dispatch. So each run MARKS its own work end to end:
//
//  - QUEUE POSITION MARK: each scoped run queues with its OWN unique number
//    (newScopedQueueMark). Every frontend build's api.queuePrompt copies a
//    nonzero `number` into the POST body verbatim (`body.number = number` —
//    present since at least the 1.28-era frontend), and the server treats it
//    as a priority that near 2^30 always sorts to the END of the pending
//    queue — the same append position today's number=0 produces. The mark is
//    UNIQUE PER RUN (r4): a fixed mark would let one run's leftover guard
//    attribute a LATER run's posts to itself — refusing/capturing traffic that
//    was never its own. A body WITHOUT this run's mark is FOREIGN: passed
//    through untouched, never captured, never refused, never counted as our
//    observation — even with an identical node set and identical targets. A
//    body WITH this run's mark is this run: content-hash + targets exact ⇒
//    observed; anything else (scope missing/wrong/extra, or CONTENT DRIFT —
//    the graph changed under a deferred item) ⇒ OUR corrupted dispatch,
//    refused before it leaves (batch-bounded).
//
//  - QUEUE ITEM TAG: the targets array carries a non-enumerable per-run Symbol
//    tag. Frontend builds store the array by reference in queueItems (either
//    directly or inside the options object), so on timeout the still-pending
//    item can be found and REMOVED with exact ownership (tag AND this run's
//    mark both checked) — an identical-scope item from another run is never
//    touched. When the item can't be found (hard-private #queueItems builds,
//    or a build that copied the array), the surgical guard stays installed
//    for the PAGE LIFETIME as a sentinel — NO expiry timer (r4: an expiring
//    sentinel re-opens the hole, because the uncancellable item can post its
//    scope-dropped full graph whenever the stalled processor resumes). A
//    permanent install is safe BY CONSTRUCTION: the guard only ever acts on
//    its own run's unique mark, which no future run (or user, or UI) will
//    ever carry, so foreign traffic passes through untouched forever. Multiple
//    sentinels simply CHAIN through whatever wrap is current — each restores
//    only inside its own synchronous dispatch, and an old sentinel has no
//    cleanup that could clobber a newer run's guard.
//
// OTHER DISPATCH REALITIES (gate rounds 1–2):
//
//  - app.queuePrompt is NOT synchronous with the POST: a busy processor makes
//    it return early and post LATER. The guard therefore stays installed until
//    our dispatch is OBSERVED or a bounded timeout — and the timeout path
//    decides cancel-vs-sentinel BEFORE the finally restores fetchApi.
//
//  - The prompt CONTENT HASH (r7) must be computable BEFORE dispatch: a
//    stable hash of the full queued prompt — node ids, class types, links,
//    every input/widget value — excluding ONLY the inputs that self-mutate at
//    queue time (beforeQueued hooks: seed widgets re-rolled by their linked
//    control_after_generate, and the hook widgets themselves), which change
//    between any two serializations of the SAME graph by design (#572: the
//    exclusion must reach the hook's serialized TARGET, not just the
//    unserialized control the hook hangs on). A topology-only fingerprint is
//    insufficient: a busy queue defers serialization to post time, and a user
//    edit in between (a changed widget value, a rewired link) leaves node
//    ids/types untouched while rendering a DIFFERENT workflow — the guard
//    refuses that drifted post and the run ends with a truthful "the graph
//    changed" error. If the hash can't be computed at all (graphToPrompt
//    failed), the run FAILS CLOSED: it refuses upfront and never calls
//    queuePrompt.
//
// Extracted as a pure module so the SAME orchestration graph_run runs is
// drivable from `node --test` (the live app.queuePrompt path can't be).

let queueMarkCounter = 0;

/**
 * A UNIQUE queue-position number for one scoped run (module header). Copied
 * into the POST body as `number` by every frontend build's api.queuePrompt,
 * making THIS run's posts identifiable among every /prompt in the tab. Near
 * 2^30 so the server's priority queue (lower number = earlier) always sorts
 * it to the END — the append behavior of the historical number=0 — and
 * decremented per run so no two runs in the page session share a mark (a
 * leftover sentinel can then never attribute a later run's traffic). Safe
 * integer, nonzero, copied verbatim by the frontend.
 */
export function newScopedQueueMark() {
  queueMarkCounter++;
  return 2 ** 30 - 1 - queueMarkCounter;
}

/** Property key for the per-run ownership tag on the targets array (non-enumerable). */
export const QUEUE_ITEM_TAG = Symbol("cmcp-scoped-run-tag");

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

// Two-seed 32-bit FNV-1a, concatenated — change-detection hashing only (no
// security requirement): stable across key order (canonicalized before
// hashing) and cheap enough to run once at queue time + once per observed post.
function fnv1a32(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const fnv1aHex = (s) =>
  fnv1a32(s, 0x811c9dc5).toString(16).padStart(8, "0") +
  fnv1a32(s, 0x9e3779b9).toString(16).padStart(8, "0");

/**
 * The CONTENT fingerprint attributing a POST /prompt body to THIS run (r7):
 * a stable hash of the full queued prompt — node ids, class types, links, and
 * every input/widget value — canonicalized (sorted keys) so serialization
 * order can't blur it. A topology-only fingerprint (node-id|class_type) is
 * NOT enough: a busy queue defers serialization to post time, and a user edit
 * in between (a changed widget value, a rewired link) leaves the topology
 * untouched while rendering a DIFFERENT workflow.
 *
 * The ONLY values excluded are inputs that self-mutate at queue time (a
 * `beforeQueued` hook — stock seed widgets re-rolled by their linked
 * control_after_generate, third-party hook widgets, etc.): those change
 * between any two serializations of the SAME graph by design, so hashing them
 * would refuse our own dispatch. Exclusions are PER-NODE pairs (prompt node id
 * + input name, r8): an edit to a NON-hook node's same-named input is still
 * detected as drift, and a prompt node that can't be resolved to a live node
 * carrying the hook gets NO exclusions (fail toward detecting drift). #572:
 * the stock hook rides on the unserialized control widget and mutates its
 * LINKED target, so the exclusion follows the linkedWidgets convention to the
 * serialized target (see collectVolatileInputs).
 */
export function promptContentHash(output, volatileInputs = null) {
  if (!output || typeof output !== "object") return null;
  const keys = Object.keys(output).sort();
  if (!keys.length) return null;
  const canon = keys.map((k) => {
    const node = output[k] ?? {};
    const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs : {};
    const names = Object.keys(inputs)
      .filter((n) => !volatileInputs?.has(`${k} ${n}`))
      .sort();
    return [k, node.class_type ?? null, names.map((n) => [n, inputs[n]])];
  });
  return fnv1aHex(JSON.stringify(canon));
}

/** Content hash of a raw POST /prompt body, or null when unparseable/odd. */
export function promptContentHashFromBody(bodyText, volatileInputs = null) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  return promptContentHash(body?.prompt, volatileInputs);
}

/**
 * The "execId inputName" pairs whose owning widgets SELF-MUTATE at queue time
 * (a `beforeQueued` hook), collected from the live root graph and every nested
 * subgraph. execId is the flattened prompt id: String(node.id) at root, the
 * colon-joined subgraph-instance path for nested nodes ("10:15:359") — the
 * same path buildNodeExecutionId produces, so pairs line up with the keys of
 * the API prompt. These are the ONLY values the content hash excludes —
 * everything a user can edit, on any other node, is covered.
 *
 * #572 — the stock control_after_generate hook is NOT on the serialized
 * widget: the frontend hangs `beforeQueued` on the control combo (serialize:
 * false — it never even reaches the prompt) and the hook mutates the LINKED
 * TARGET (the seed / noise_seed / cycled combo), which IS serialized
 * (ComfyUI_frontend widgets.ts: `targetWidget.linkedWidgets = [controlWidget]`;
 * the queue processor fires the hook before serializing the post body).
 * Excluding only the carrier's own name therefore covered nothing, and any
 * frontend/mode where the mutation lands between our pre-dispatch hash and the
 * deferred serialization (WidgetControlMode "before"; pre-#8774 frontends on a
 * partial execution; third-party hooks following the same linkedWidgets
 * convention) false-refused EVERY scoped run as "graph CHANGED" — nothing
 * queued, no concurrent edit. So for each carrier `w` we ALSO exclude every
 * sibling target `t` with `t.linkedWidgets` containing `w`. A carrier whose
 * value is the string "fixed" never mutates anything, so the fixed-ness check
 * GATES the exclusion (codex r2): a fixed carrier excludes NOTHING — not its
 * own input, not its target's — and a mid-window user edit to either still
 * refuses as drift.
 *
 * ACCEPTED RESIDUAL (codex gate, documented deliberately): the exclusion is
 * narrowed to exactly the input(s) the hook mutates — each linked target's own
 * serialized input — but a USER edit to one of THOSE SAME inputs inside the
 * deferred window (e.g. seed 111 → 777 while the post is pending) is
 * inherently indistinguishable from the hook's own reroll and is therefore
 * TOLERATED, not refused. This is the narrowest possible gap: an edit to ANY
 * OTHER input of the same node (or any input anywhere else) still mismatches
 * the hash and refuses the dispatch. The gap is never silent: dispatchScopedRun
 * returns these pairs as `volatileInputs`, and graph_run surfaces them in the
 * run result's `drift_coverage` note so the caller knows which inputs were not
 * drift-covered for that run.
 */
export function collectVolatileInputs(rootGraph) {
  const pairs = new Set();
  const seen = new Set();
  const addPair = (execId, name) => {
    if (name != null) pairs.add(`${execId} ${String(name)}`);
  };
  const walk = (graph, prefix) => {
    if (!graph || seen.has(graph)) return;
    seen.add(graph);
    for (const node of graph._nodes ?? []) {
      if (!node || node.id == null) continue;
      const execId = prefix ? `${prefix}:${node.id}` : String(node.id);
      const widgets = node.widgets ?? [];
      for (const w of widgets) {
        if (typeof w?.beforeQueued !== "function") continue;
        // A "fixed" value-control no-ops at queue time: NEITHER its own input
        // NOR its linked target is volatile. The fixed-ness check must GATE the
        // exclusion, not follow it — excluding anything for a fixed carrier
        // would mask a genuine mid-window user edit as drift-blind (codex r2).
        if (w.value === "fixed") continue;
        // The carrier's own input (third-party hooks that mutate their own
        // serialized value; a no-op for the serialize:false stock control).
        addPair(execId, w.name);
        // #572 — the serialized TARGET(s) of a linked value-control hook.
        for (const t of widgets) {
          if (Array.isArray(t?.linkedWidgets) && t.linkedWidgets.includes(w)) {
            addPair(execId, t.name);
          }
        }
      }
      if (node.subgraph) walk(node.subgraph, execId);
    }
  };
  walk(rootGraph, "");
  return pairs;
}

/** The body's queue-position `number` as a Number, or null when absent/unparseable. */
function bodyQueueMark(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const n = Number(body?.number);
  return Number.isFinite(n) ? n : null;
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
    verdict?.reason === "graph_changed"
      ? `the workflow graph CHANGED after the run was queued — the deferred ` +
        `dispatch would render a modified workflow, not the one that was scoped. ` +
        `Retrying is safe (nothing was queued); if this recurs without any edit in ` +
        `between, a queue-time widget hook is mutating values between serialization ` +
        `and dispatch (e.g. a control_after_generate widget with WidgetControlMode ` +
        `"before" — switch it to "after" or fix the target widget's value)`
      : verdict?.reason === "scope_mismatch"
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
 * The truthful UPFRONT refusal when the prompt can't be fingerprinted
 * (graphToPrompt failed before dispatch). Without a signature our dispatch
 * can't be told apart from a stranger's, so a scoped run must NOT dispatch at
 * all — fail closed, nothing queued.
 */
export function scopeUnattributableError({ toNodeId }) {
  return (
    `run-to-node scope for node ${toNodeId} cannot be dispatched safely: the ` +
    `prompt could not be fingerprinted (graphToPrompt failed), so the panel ` +
    `cannot distinguish its own dispatch from unrelated queue traffic. ` +
    `Nothing was queued rather than risk a full-graph execution (#556).`
  );
}

/**
 * The truthful UNVERIFIED outcome when no scoped dispatch surfaced within the
 * observation window (a busy queuePrompt deferred the post past its return, or
 * the prompt build failed silently).
 *  - cancelled:  the still-pending frontend queue item was located by its
 *    ownership tag and REMOVED — "nothing was queued" is then literally true.
 *  - sentinel:   removal was impossible, so the surgical guard stays installed
 *    for the REST OF THE PAGE SESSION (no expiry — an expiring sentinel would
 *    re-open the hole) — a late scope-dropped dispatch of THIS run is still
 *    refused whenever it posts. Only "nothing CONFIRMED queued" is claimed.
 *  - verified/batch (r5): a partially-verified batch names its count — the
 *    verified prompts DID queue (scoped); only the unverified remainder is
 *    in doubt.
 */
export function scopeUnverifiedError({ toNodeId, timeoutMs, cancelled = false, verified = 0, batch = 1 }) {
  const count =
    verified > 0
      ? ` (${verified} of ${batch} batch prompts WERE verified and are queued with the scope)`
      : "";
  const base =
    `run-to-node scope for node ${toNodeId} could not be verified: no scoped ` +
    `dispatch was observed within ${Math.round(timeoutMs / 1000)}s of queueing ` +
    `(the frontend deferred or silently dropped the request)${count}. `;
  if (cancelled) {
    return (
      base +
      `The still-pending queue item was located and REMOVED, so nothing ` +
      `${verified > 0 ? "more " : ""}was queued and no scope-dropped full-graph dispatch can execute — retry the run (#556).`
    );
  }
  return (
    base +
    `The pending queue item could not be removed on this frontend, so the scope ` +
    `guard stays installed for the rest of this page session as a sentinel — ` +
    `any late dispatch of THIS run WITHOUT the scope will still be refused (it ` +
    `cannot touch any other run's traffic). ` +
    `Nothing is CONFIRMED queued beyond the verified count — check the ComfyUI queue before retrying (#556).`
  );
}

/**
 * The truthful PARTIAL-BATCH outcome (r5): the argument shape demonstrably
 * works (at least one post verified), then a LATER post in the same batch lost
 * its scope and was refused — the frontend's batch loop breaks on that first
 * refusal, so the attempt is terminal: `verified` prompts are queued (scoped),
 * one was refused, and the rest never posted. Never reported as dispatched.
 */
export function scopePartialBatchError({ toNodeId, verified, refused, batch, graphChanged = false }) {
  const unposted = Math.max(0, batch - verified - refused);
  const cause = graphChanged
    ? `was refused after the graph changed mid-batch`
    : `was refused after its scope was lost mid-batch`;
  return (
    `run-to-node scope for node ${toNodeId}: batch incomplete — ${verified} of ` +
    `${batch} prompts were verified and are queued WITH the scope, ${refused} ` +
    `${cause} (it did NOT execute, and no ` +
    `full-graph dispatch left the tab)` +
    (unposted ? `, and ${unposted} never posted` : "") +
    `. Re-run for the remaining prompts (#556).`
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

/**
 * The truthful DISPATCH-FAILURE outcome (r6): an ATTRIBUTED /prompt post (our
 * mark, our signature, our exact targets) whose fetch threw or whose response
 * was malformed (no parseable prompt_id, no rejection body). That post is NOT
 * verified and NOT a server rejection — the run must never report queued:true
 * for it. Names what failed and how much of the batch was confirmed first.
 */
export function scopeDispatchError({ toNodeId, detail, verified, batch }) {
  return (
    `run-to-node scope for node ${toNodeId}: a verified-scoped /prompt request ` +
    `FAILED to complete — ${detail}. ${verified} of ${batch} batch prompts were ` +
    `confirmed queued before the failure. The run is NOT reported as queued: ` +
    `this prompt did not reach ComfyUI, and no full-graph dispatch occurred (#556).`
  );
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

// Classify the response to an ATTRIBUTED scoped post (r6): "accepted" ONLY
// when it is a real 200 with a parseable prompt_id (captured); "rejected" when
// it is a genuine server rejection (non-200 with an error / node_errors body —
// captured through the established #358 channel); "malformed" for anything
// else (2xx without a prompt_id, non-200 without a rejection body, unparseable
// body, missing response). Only "accepted" may ever count as verified.
async function classifyRunResponse(res, { onRejection, onPromptId }) {
  if (!res) return "malformed";
  try {
    const body = await res.clone().json();
    if (res.status === 200) {
      if (body && body.prompt_id != null) {
        onPromptId?.(String(body.prompt_id));
        return "accepted";
      }
      return "malformed";
    }
    if (body && (body.error || body.node_errors)) {
      onRejection?.({ error: body.error ?? null, node_errors: body.node_errors ?? null });
      return "rejected";
    }
    return "malformed";
  } catch {
    return "malformed";
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
 * The api.fetchApi replacement dispatchScopedRun installs for a SCOPED run —
 * see the module header for the run-identity model. Per POST /prompt body:
 *  - NO queue mark                → FOREIGN: passed through untouched, never
 *                                   captured, never refused, never observed —
 *                                   even with our node set and our targets.
 *  - mark + content hash + exact targets → OUR scoped dispatch: passed
 *                                   through, counted OBSERVED once its fetch
 *                                   completes (r6), response captured.
 *  - mark + anything else         → OUR corrupted dispatch: scope missing or
 *                                   wrong/extra/partial targets, or the
 *                                   CONTENT HASH mismatched (r7: the graph
 *                                   changed under a deferred item — a user
 *                                   edit, or the deferred serialization
 *                                   picking up a modified graph): refused
 *                                   before it leaves, batch-bounded.
 * state = { observed, rejected, refused, dropped, droppedReason, failed } is
 * live; waitForVerdict(ms) resolves true at any terminal state, false on
 * timeout.
 */
export function createScopedRunGuard({
  origFetchApi,
  execIds,
  contentHash,
  volatileInputs = null,
  batch = 1,
  toNodeId = null,
  queueMark,
  onRejection = null,
  onPromptId = null,
  onScopeDropped = null,
} = {}) {
  const expected = (execIds ?? []).map(String);
  const maxBatch = Math.max(1, Math.floor(Number(batch)) || 1);
  const state = { observed: 0, rejected: 0, refused: 0, dropped: null, droppedReason: null, failed: null };
  const waiters = new Set();
  const notify = () => {
    for (const fire of [...waiters]) fire();
  };

  const guard = async (route, options) => {
    if (!isPromptPost(route, options)) return origFetchApi(route, options);
    // RUN IDENTITY FIRST: no mark ⇒ not ours ⇒ never touch it. This is what
    // keeps a user's full run of the SAME graph, or another scoped run with
    // the SAME targets, safe from our refusals and our capture.
    if (bodyQueueMark(options?.body) !== queueMark) {
      return origFetchApi(route, options);
    }
    const targets = targetsFromBody(options?.body);
    const contentOk =
      contentHash && promptContentHashFromBody(options?.body, volatileInputs) === contentHash;
    if (contentOk && targets && sameSet(targets, expected)) {
      // OUR scoped dispatch. It counts as VERIFIED only when the fetch itself
      // completes with a real 200 + prompt_id (r6) — a thrown fetch or a
      // malformed response is a terminal dispatch FAILURE, never a success;
      // a genuine server rejection flows through the established #358 channel.
      let res;
      try {
        res = await origFetchApi(route, options);
      } catch (err) {
        if (state.failed == null) {
          state.failed = scopeDispatchError({
            toNodeId,
            detail: `the /prompt request itself threw (${String(err?.message ?? err)})`,
            verified: state.observed,
            batch: maxBatch,
          });
        }
        notify();
        throw err; // the frontend sees exactly the failure it would have seen
      }
      const verdict = await classifyRunResponse(res, { onRejection, onPromptId });
      if (verdict === "accepted") {
        state.observed++;
      } else if (verdict === "rejected") {
        state.rejected++;
      } else if (state.failed == null) {
        state.failed = scopeDispatchError({
          toNodeId,
          detail: `the /prompt response was malformed (HTTP ${res?.status ?? "?"}, no prompt_id and no rejection body)`,
          verified: state.observed,
          batch: maxBatch,
        });
      }
      notify();
      return res;
    }
    // OUR dispatch CORRUPTED. Content drift (r7) takes naming precedence: a
    // changed graph would render the wrong workflow even with the scope
    // intact. Then the scope itself: missing, or wrong/extra/partial targets.
    if (state.refused < maxBatch) {
      state.refused++;
      if (state.dropped == null) {
        const verdict = !contentOk
          ? { ok: false, reason: "graph_changed" }
          : targets
            ? { ok: false, reason: "scope_mismatch", expected, got: targets }
            : { ok: false, reason: "scope_missing", expected, got: null };
        state.droppedReason = verdict.reason;
        state.dropped = scopeDroppedError({ toNodeId, verdict });
        onScopeDropped?.(state.dropped);
      }
      notify();
      return SCOPE_DROPPED_RESPONSE();
    }
    // Refusal budget for this batch is exhausted (paranoia bound; normally the
    // frontend's batch loop breaks on the first refusal).
    return origFetchApi(route, options);
  };
  guard.state = state;
  // Verdict = the run reached a TERMINAL state: the whole batch verified, a
  // genuine server rejection arrived, a dispatch failure occurred (r6), or a
  // corrupted post ended the attempt (the frontend's batch loop breaks on the
  // first refusal — the caller distinguishes shape-drop (0 verified ⇒ retry
  // shape) from mid-batch corruption (some verified ⇒ terminal partial, r5)).
  const verdictReached = () =>
    state.failed != null ||
    state.rejected > 0 ||
    state.observed >= maxBatch ||
    state.dropped != null;
  guard.verdictReached = verdictReached;
  guard.waitForVerdict = (ms) =>
    new Promise((resolve) => {
      if (verdictReached()) return resolve(true);
      const fire = () => {
        clearTimeout(timer);
        waiters.delete(fire);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(fire);
        resolve(false);
      }, ms);
      if (typeof timer.unref === "function") timer.unref();
      waiters.add(fire);
    });
  return guard;
}

/**
 * Best-effort removal of THIS run's still-pending item(s) from the frontend's
 * in-memory queueItems (the not-yet-posted deferred dispatch — the server-side
 * /queue never saw it, so server queue control can't help). Ownership requires
 * BOTH: the non-enumerable QUEUE_ITEM_TAG dispatchScopedRun stamped on the
 * targets array (frontend builds store the array by reference, either directly
 * or inside the options object) AND the item's queue-position number equal to
 * THIS run's unique mark — an identical-scope item from ANOTHER run is never
 * removed. The array is runtime-accessible as app.queueItems on TS-`private`
 * builds; older builds hard-privatize it (#queueItems), and a build that
 * COPIED the array loses the tag — then this reports 0 removed and the caller
 * keeps the guard installed as a sentinel instead (module header).
 *
 * @returns {{accessible: boolean, removed: number}}
 */
export function cancelPendingScopedQueueItem(app, { runTag, queueMark } = {}) {
  const items = app?.queueItems;
  if (!Array.isArray(items)) return { accessible: false, removed: 0 };
  let removed = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const raw = items[i]?.queueNodeIds;
    const arr = Array.isArray(raw) ? raw : raw && Array.isArray(raw.queueNodeIds) ? raw.queueNodeIds : null;
    if (arr && arr[QUEUE_ITEM_TAG] === runTag && Number(items[i]?.number) === queueMark) {
      items.splice(i, 1);
      removed++;
    }
  }
  return { accessible: true, removed };
}

/**
 * The scoped-dispatch orchestration graph_run runs — extracted whole so the
 * REAL control flow (guard install, queuePrompt, observation wait, cancel/
 * sentinel decision, and the finally-restore) is what the unit tests drive.
 *
 * Returns a discriminated result (never throws for queue outcomes), always
 * carrying the run's unique `queueMark` and — once the prompt was fingerprinted
 * — `volatileInputs`: the sorted "execId inputName" pairs this run did NOT
 * drift-cover (queue-time hook inputs; see collectVolatileInputs' ACCEPTED
 * RESIDUAL note), so the caller can state the coverage gap honestly:
 *  - { outcome: "dispatched",   queueMark }  our scoped dispatch was OBSERVED
 *    (prompt_ids / a server rejection captured via the callbacks);
 *  - { outcome: "refused",      queueMark, error }  every argument shape
 *    produced OUR corrupted dispatch, all blocked — nothing was queued;
 *  - { outcome: "unverified",   queueMark, error }  no scoped dispatch
 *    surfaced in time; our pending item was cancelled, or a sentinel guard
 *    remains installed for the page session (the error says which);
 *  - { outcome: "unverifiable", queueMark?, error }  no attribution possible
 *    (no fetchApi to observe through, or no prompt signature) — refused
 *    BEFORE dispatch, nothing queued.
 */
export async function dispatchScopedRun({
  app,
  apiTarget,
  execIds,
  batch = 1,
  toNodeId = null,
  verifyTimeoutMs = 5000,
  queueMark = null,
  onRejection = null,
  onPromptId = null,
} = {}) {
  const mark = queueMark ?? newScopedQueueMark();
  const prevFetchApi = typeof apiTarget?.fetchApi === "function" ? apiTarget.fetchApi : null;
  const origFetchApi = prevFetchApi ? prevFetchApi.bind(apiTarget) : null;
  if (!origFetchApi) {
    return {
      outcome: "unverifiable",
      queueMark: mark,
      error:
        `run-to-node scope for node ${toNodeId} cannot be verified — api.fetchApi is ` +
        `unavailable on this frontend, so there is no way to confirm the scope reaches the ` +
        `prompt. Nothing was queued rather than risk a full-graph execution (#556).`,
    };
  }
  // The CONTENT HASH that (with the queue mark) attributes a POST /prompt
  // body to THIS run: the full prompt we are about to queue — ids, class
  // types, links, widget values — minus only the self-mutating (beforeQueued)
  // inputs that change between any two serializations by design. No hash ⇒
  // no attribution ⇒ fail closed BEFORE dispatch.
  let contentHash = null;
  let volatileInputs = null;
  try {
    if (typeof app.graphToPrompt === "function") {
      // This panel's live root is app.graph (r8) — app.rootGraph only as a
      // fallback for frontends that expose it instead.
      volatileInputs = collectVolatileInputs(app?.graph ?? app?.rootGraph ?? null);
      contentHash = promptContentHash((await app.graphToPrompt())?.output, volatileInputs);
    }
  } catch {
    contentHash = null;
  }
  if (!contentHash) {
    return { outcome: "unverifiable", queueMark: mark, error: scopeUnattributableError({ toNodeId }) };
  }
  // #572 — the inputs this run does NOT drift-cover (queue-time hook inputs:
  // hook carriers plus their linked, serialized targets). Surfaced on every
  // post-hash outcome so the caller can report the coverage gap truthfully
  // instead of implying full-graph drift proof (see collectVolatileInputs'
  // ACCEPTED RESIDUAL note).
  const volatileList = volatileInputs ? [...volatileInputs].sort() : [];
  // Ownership tag for the timeout cancellation (see QUEUE_ITEM_TAG).
  const runTag = Symbol("cmcp-scoped-run");
  try {
    Object.defineProperty(execIds, QUEUE_ITEM_TAG, { value: runTag, enumerable: false, configurable: true });
  } catch {
    // non-extensible array — cancellation will report 0 and the sentinel covers it.
  }
  let dropped = null;
  for (const scopeArg of queuePromptScopeArgs(execIds)) {
    dropped = null;
    let keepGuardInstalled = false;
    const guard = createScopedRunGuard({
      origFetchApi,
      execIds,
      contentHash,
      volatileInputs,
      batch,
      toNodeId,
      queueMark: mark,
      onRejection,
      onPromptId,
    });
    apiTarget.fetchApi = guard;
    try {
      await app.queuePrompt(mark, batch, scopeArg);
      if (!guard.verdictReached()) {
        // queuePrompt returned without our dispatch surfacing — the
        // frontend's processor was busy and will serialize/post the item
        // LATER. Keep the guard installed and wait for the WHOLE batch to be
        // accounted (r5: never dispatched on a partial count), or the timeout.
        await guard.waitForVerdict(verifyTimeoutMs);
      }
      if (!guard.verdictReached()) {
        // GIVE-UP — decided HERE, inside the try, so the finally below honors
        // keepGuardInstalled. The deferred item may still be live in the
        // frontend's pending queue: try to REMOVE it (ownership tag AND this
        // run's mark both checked), and only when that's impossible keep the
        // surgical guard installed for the PAGE SESSION as a sentinel — NO
        // expiry timer (r4): the uncancellable item can post whenever the
        // stalled processor resumes, so the refusal must not go away. Safe by
        // construction: the sentinel only ever acts on THIS run's unique mark.
        const verified = guard.state.observed;
        const cancel = cancelPendingScopedQueueItem(app, { runTag, queueMark: mark });
        if (cancel.removed > 0) {
          return {
            outcome: "unverified",
            queueMark: mark,
            verified,
            volatileInputs: volatileList,
            error: scopeUnverifiedError({ toNodeId, timeoutMs: verifyTimeoutMs, cancelled: true, verified, batch }),
          };
        }
        keepGuardInstalled = true;
        return {
          outcome: "unverified",
          queueMark: mark,
          verified,
          volatileInputs: volatileList,
          error: scopeUnverifiedError({ toNodeId, timeoutMs: verifyTimeoutMs, cancelled: false, verified, batch }),
        };
      }
      // r6: a dispatch FAILURE with the batch not fully accounted — the
      // frontend CONTINUES its queue loop on generic submission failures, so
      // later posts of this batch can still come. Keep the guard installed as
      // a page-session sentinel so a later CORRUPTED post is still refused
      // (decided HERE so the finally below honors it).
      if (
        guard.state.failed != null &&
        guard.state.observed + guard.state.rejected + guard.state.refused < batch
      ) {
        keepGuardInstalled = true;
      }
    } finally {
      if (!keepGuardInstalled) apiTarget.fetchApi = prevFetchApi;
    }
    // r6: the dispatch itself failed (fetch threw / malformed response) —
    // terminal, truthful, NEVER queued:true.
    if (guard.state.failed != null) {
      return {
        outcome: "failed",
        queueMark: mark,
        verified: guard.state.observed,
        volatileInputs: volatileList,
        error: guard.state.failed +
          (keepGuardInstalled
            ? " The scope guard stays installed as a sentinel for the rest of this page session."
            : ""),
      };
    }
    // A genuine SERVER rejection (#358) is terminal and flows through the
    // established rejection channel — the run "dispatched" and ComfyUI said
    // no; graph_run's summarizePromptRejection surfaces it, never queued:true.
    if (guard.state.rejected > 0) {
      return { outcome: "dispatched", queueMark: mark, verified: guard.state.observed, volatileInputs: volatileList };
    }
    // The FULL batch verified — genuinely dispatched (r5: never on a partial).
    if (guard.state.observed >= batch) {
      return { outcome: "dispatched", queueMark: mark, verified: guard.state.observed, volatileInputs: volatileList };
    }
    // r7 CONTENT DRIFT with ZERO verified posts is NOT an argument-shape
    // problem — retrying the other shape would produce the same drifted post.
    // Terminal refusal naming that the graph changed under the deferred item.
    if (guard.state.observed === 0 && guard.state.droppedReason === "graph_changed") {
      return { outcome: "refused", queueMark: mark, verified: 0, volatileInputs: volatileList, error: guard.state.dropped };
    }
    // A corrupted post with ZERO verified posts means this argument SHAPE was
    // dropped by the frontend — nothing was queued, so retrying the other
    // shape can never double-queue.
    if (guard.state.observed === 0) {
      dropped = guard.state.dropped;
      continue;
    }
    // r5 TERMINAL PARTIAL: the shape works (≥1 verified), then a later batch
    // post lost its scope (or the graph drifted) and was refused — the
    // frontend's batch loop breaks on that refusal, so no more posts of this
    // attempt will come. Report the truthful counts; never "dispatched"; no
    // shape retry (the shape works).
    return {
      outcome: "refused",
      queueMark: mark,
      verified: guard.state.observed,
      volatileInputs: volatileList,
      error: scopePartialBatchError({
        toNodeId,
        verified: guard.state.observed,
        refused: guard.state.refused,
        batch,
        graphChanged: guard.state.droppedReason === "graph_changed",
      }),
    };
  }
  return { outcome: "refused", queueMark: mark, verified: 0, volatileInputs: volatileList, error: dropped };
}
