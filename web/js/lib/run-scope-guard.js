import { tr } from "./i18n.js";
// #1124 — rgthree's Seed node mutates the outgoing prompt WITHOUT a beforeQueued
// hook, so collectVolatileInputs needs a second volatility signal. The measured
// facts about that pack (sentinels, node predicate, mute/bypass early-return, the
// input its handler overwrites) already live in scoped-batch-seed.js; this file
// imports the verdict rather than restating them.
import { rgthreeQueueTimeSeedInput } from "./scoped-batch-seed.js";
// comfyui-mcp#1871 — ComfyUI's prompt validation requires EVERY node in the posted
// prompt to resolve to an installed class before it narrows execution to
// partial_execution_targets, so one unavailable pack on an unrelated branch vetoes a
// run-to-node of a branch that does not touch it. The measured upstream facts, the
// backward-closure walk, and the structured test that licenses a second post live in
// partial-run-prune.js; this file imports the verdict.
import { prunedRetryForRejection } from "./partial-run-prune.js";
// #1273 — the THIRD volatility signal: cg-use-everywhere materialises its
// broadcast links into the prompt inside its own queuePrompt patch, so the
// inputs it will inject are queue-time volatile too. The measured facts about
// the pack (the extra.ue_links record, the io-node ids, the subgraph routing)
// live in use-everywhere-links.js; this file imports the verdict.
import { ueQueueTimeLinkPairs } from "./use-everywhere-links.js";
// #1331 — after reconnect a converted widget's leftover value (clip/vae/model/…)
// can still churn while the live input is already linked. control_after_generate
// can also be present by OPTION SHAPE before its beforeQueued hook is re-hung.
// Both detectors already live in their own modules; this file imports the verdict.
import { controlAfterGenerateEntries } from "./control-after-generate.js";
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
//    every input/widget value — excluding ONLY (a) the inputs that mutate
//    at queue time (beforeQueued hooks: seed widgets re-rolled by their linked
//    control_after_generate, and the hook widgets themselves; plus prompts
//    rewritten by an extension's own api.queuePrompt patch, which carry no hook
//    at all — rgthree's armed Seed node, #1124; plus leftover values of
//    link-driven converted widgets that settle from the widget default to the
//    incoming link after reconnect — MiniMax H3 clip/vae/model, #1331), which change
//    between any two serializations of the SAME graph by design (#572: the
//    exclusion must reach the hook's serialized TARGET, not just the
//    unserialized control the hook hangs on), and (b) inputs whose value the
//    POST body's JSON cannot carry (undefined/function/symbol, or a toJSON
//    that yields one), which the in-memory graphToPrompt output carries but
//    the wire always drops — hashing
//    those refused every scoped run on such a graph as a false "graph
//    CHANGED" (#659). A topology-only fingerprint is
//    insufficient: a busy queue defers serialization to post time, and a user
//    edit in between (a changed widget value, a rewired link) leaves node
//    ids/types untouched while rendering a DIFFERENT workflow — the guard
//    refuses that drifted post and the run ends with a truthful "the graph
//    changed" error NAMING the differing inputs (#659). If the hash can't be
//    computed at all (graphToPrompt
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
 * the QueuePromptOptions object is next for builds that dropped the shim.
 * `[undefined]` when no scope was requested — a plain full run, exactly the
 * historical call shape.
 *
 * #752 — the THIRD shape, `{ partialExecutionTargets }`, exists because the
 * frontend uses TWO DIFFERENT OPTION KEYS at two different layers. Read out of a
 * shipped ComfyUI_frontend 1.47.12 bundle:
 *
 *   store  async queuePrompt(e,t=1,n={}){ let {queueNodeIds:r,intent:i} =
 *            Array.isArray(n) ? {queueNodeIds:n} : n; …
 *            await api.queuePrompt(e, m, {partialExecutionTargets:n, …})
 *
 *   api    async queuePrompt(e,t,n){ … ...n?.partialExecutionTargets &&
 *            {partial_execution_targets: n.partialExecutionTargets} … }
 *
 * So the store speaks `queueNodeIds` and translates it, while the api layer
 * speaks `partialExecutionTargets` and is the one that actually writes the
 * request field. A build whose `app.queuePrompt` IS — or forwards straight to —
 * the api-level function silently ignores both shapes we sent, the scope never
 * reaches the body, and the run falls through to request_body_repair. That is
 * exactly what two field reports show (#752, on frontend 1.45.21).
 *
 * Strictly additive: builds that already answered shape 1 or 2 never reach this
 * one. Destructuring ignores unknown keys, so offering the extra key cannot harm
 * a build that does not read it.
 *
 * @param {string[]|undefined} partialTargets
 * @returns {(string[]|{queueNodeIds:string[]}|undefined)[]}
 */
export function queuePromptScopeArgs(partialTargets) {
  if (!Array.isArray(partialTargets) || !partialTargets.length) return [undefined];
  return [
    partialTargets,
    { queueNodeIds: partialTargets },
    { partialExecutionTargets: partialTargets },
  ];
}

/**
 * The ordered DELIVERY ATTEMPTS for a run-to-node scope. The first two hand the
 * scope to `app.queuePrompt` in each of its two documented third-argument
 * shapes. The LAST one hands over the positional array again but also licenses
 * the guard to write `partial_execution_targets` straight into this run's own
 * /prompt body (repairScopeInBody) if it still has not arrived.
 *
 * The final attempt exists because refusing is the SAFE outcome for #556, not
 * the CORRECT one: the caller asked for a subset and is entitled to get it. The
 * request body is the one interface every frontend build shares, so repairing
 * it there honours the request on builds whose `app.queuePrompt` wrapper drops
 * the argument for any reason — including reasons this panel cannot see. It is
 * ordered LAST so a frontend that delivers the scope natively always wins, and
 * the panel only reaches for the body when the supported routes have failed.
 *
 * @param {string[]|undefined} partialTargets
 * @returns {{arg: string[]|{queueNodeIds:string[]}|undefined, repair: boolean}[]}
 */
export function queuePromptScopeAttempts(partialTargets) {
  if (!Array.isArray(partialTargets) || !partialTargets.length) {
    return [{ arg: undefined, repair: false }];
  }
  return [
    { arg: partialTargets, repair: false },
    { arg: { queueNodeIds: partialTargets }, repair: false },
    { arg: { partialExecutionTargets: partialTargets }, repair: false },
    { arg: partialTargets, repair: true },
  ];
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
 * The CANONICAL FORM of a queued prompt — sorted node entries of
 * [execId, class_type, [[inputName, value], …]] — shared by the content hash
 * and by the drift diff reported on a graph_changed refusal (#659).
 *
 * Two exclusion rules, both required for the SAME unmodified graph to
 * canonicalize identically through the two channels this module compares —
 * the in-memory `graphToPrompt().output` object (pre-dispatch) and the parsed
 * POST /prompt body (post-time serialization after a JSON round-trip):
 *
 *  1. VOLATILE INPUTS — inputs that mutate at queue time, by either mechanism
 *     collectVolatileInputs knows about: a `beforeQueued` hook (stock seed
 *     widgets re-rolled by their linked control_after_generate, third-party hook
 *     widgets), or an extension rewriting the outgoing prompt in its own
 *     `api.queuePrompt` patch (rgthree's armed Seed node, #1124). Those change
 *     between any two serializations of the SAME graph by design, so hashing
 *     them would refuse our own dispatch. Exclusions are PER-NODE pairs
 *     (prompt node id + input name, r8): an edit to a NON-hook node's
 *     same-named input is still detected as drift, and a prompt node that
 *     can't be resolved to a live node carrying the hook gets NO exclusions
 *     (fail toward detecting drift). #572: the stock hook rides on the
 *     unserialized control widget and mutates its LINKED target, so the
 *     exclusion follows the linkedWidgets convention to the serialized
 *     target (see collectVolatileInputs).
 *
 *  2. JSON-INVISIBLE VALUES (#659) — an input whose value JSON.stringify
 *     would DROP from the inputs object: `undefined`, functions, symbols,
 *     and object values whose own `toJSON()` returns one of those. The
 *     in-memory output object CARRIES the key (graphToPrompt assigns
 *     `inputs[name] = widget.value` unconditionally for serialized widgets),
 *     but the key never reaches the POST body, so the parsed body never has
 *     it. Without this filter the pre-dispatch hash and the post-body hash
 *     of an untouched graph differ deterministically and every scoped run is
 *     refused as "graph CHANGED". Live-observed shape: an async-populated
 *     combo whose fetch produced no value (e.g. OllamaConnectivityV2's
 *     `"model": ((), {})` — an empty-options combo with no default, left
 *     `undefined` when the Ollama server is unreachable), and the shim
 *     widgets a multi-spec COMFY_AUTOGROW_V3 group creates with no value at
 *     all.
 *
 *     The check is an exact emulation of the wire, not a type guess: each
 *     input is serialized once in a one-key probe object UNDER ITS REAL NAME
 *     (codex gate r2: `toJSON(key)` receives the property name, so probing
 *     under a fixed key misjudges a key-sensitive `toJSON`), a dropped key
 *     yields exactly `"{}"`, and the probe's PARSED value is what the canon
 *     stores — so `toJSON` fires exactly once per input, with the same key
 *     the POST body would use, and the canon holds the same wire-normalized
 *     value the parsed body will (dates, toJSON results, -0, NaN→null all
 *     land identically on both channels). A value that THROWS on stringify
 *     (BigInt, circular) is KEPT raw — fail toward detecting drift; the hash
 *     itself then fails closed exactly as before.
 *
 *     This is NOT a drift-detection loosening: the guard's invariant is that
 *     the workflow that WOULD EXECUTE is unchanged, and a value JSON cannot
 *     transmit never reaches the server — it cannot be part of what
 *     executes. Any change the wire CAN represent still flips the hash: an
 *     edit from `undefined` to a value makes the key APPEAR in the body
 *     (mismatch ⇒ refused), and an edit from a value to `undefined` makes it
 *     VANISH (mismatch ⇒ refused). Only "absent on both channels" is
 *     tolerated.
 *
 * Returns null for a missing/empty prompt (the caller fails closed).
 */
export function canonicalizePrompt(output, volatileInputs = null) {
  if (!output || typeof output !== "object") return null;
  const keys = Object.keys(output).sort();
  if (!keys.length) return null;
  return keys.map((k) => {
    const node = output[k] ?? {};
    const inputs = node.inputs && typeof node.inputs === "object" ? node.inputs : {};
    // An own `toJSON` FUNCTION on the inputs object hijacks JSON.stringify's
    // hook protocol for the WHOLE object (codex gate r3): on the wire the
    // body carries whatever `inputs.toJSON("inputs")` returns instead of
    // these keys, and the same name would hijack the one-key probe below.
    // The wire form of such a node cannot be predicted faithfully from here,
    // so fail CLOSED — dispatchScopedRun's catch turns this throw into the
    // upfront "cannot fingerprint" refusal, never a false "graph CHANGED".
    if (typeof inputs.toJSON === "function") {
      throw new TypeError(`prompt node ${k} carries an own toJSON function — its wire form is not predictable`);
    }
    const names = [];
    const wireValues = new Map();
    for (const n of Object.keys(inputs)) {
      if (volatileInputs?.has(`${k} ${n}`)) continue;
      let probe;
      try {
        probe = JSON.stringify({ [n]: inputs[n] });
      } catch {
        // Unstringifyable (BigInt/circular): keep the RAW value — the hash
        // then fails closed exactly as before #659, never dropping coverage.
        names.push(n);
        continue;
      }
      // A one-key object renders as exactly "{}" when the key is dropped —
      // that value cannot reach the server, so it cannot drift.
      if (probe === "{}") continue;
      names.push(n);
      // The canon stores the WIRE form of the value (toJSON applied once,
      // under the real key) so both channels compare the same thing.
      wireValues.set(n, JSON.parse(probe)[n]);
    }
    names.sort();
    return [k, node.class_type ?? null, names.map((n) => [n, wireValues.has(n) ? wireValues.get(n) : inputs[n]])];
  });
}

/**
 * The CONTENT fingerprint attributing a POST /prompt body to THIS run (r7):
 * a stable hash of the full queued prompt — node ids, class types, links, and
 * every input/widget value — canonicalized (sorted keys) so serialization
 * order can't blur it. A topology-only fingerprint (node-id|class_type) is
 * NOT enough: a busy queue defers serialization to post time, and a user edit
 * in between (a changed widget value, a rewired link) leaves the topology
 * untouched while rendering a DIFFERENT workflow. See canonicalizePrompt for
 * the two exclusion rules (queue-time-volatile inputs; JSON-invisible values).
 */
export function promptContentHash(output, volatileInputs = null) {
  const canon = canonicalizePrompt(output, volatileInputs);
  if (!canon) return null;
  return fnv1aHex(JSON.stringify(canon));
}

/**
 * WHAT differed between two canonical prompts (#659) — the observation a
 * graph_changed refusal must report instead of asserting a cause it cannot
 * see. One token per difference:
 *  - `"<id> <inputName>"` — that input's value changed, or it exists on only
 *    one side (a mid-window edit: changed widget, added/removed link);
 *  - `"<id> (node only in queued prompt)"` / `"(node only in dispatch
 *    body)"` — a node was removed/added in the deferred window;
 *  - `"<id> (class_type changed)"` — the node was replaced.
 * Input-name tokens name the pair without asserting WHICH side is newer —
 * the guard knows only that the two serializations differ. Returns null when
 * either canon is unusable. Never throws: this runs on the refusal path.
 */
export function diffPromptCanons(canonA, canonB) {
  try {
    if (!Array.isArray(canonA) || !Array.isArray(canonB)) return null;
    const byId = (canon) => {
      const m = new Map();
      for (const entry of canon) {
        if (Array.isArray(entry)) m.set(String(entry[0]), entry);
      }
      return m;
    };
    const A = byId(canonA);
    const B = byId(canonB);
    const tokens = [];
    for (const k of A.keys()) {
      if (!B.has(k)) tokens.push(`${k} (node only in queued prompt)`);
    }
    for (const k of B.keys()) {
      if (!A.has(k)) tokens.push(`${k} (node only in dispatch body)`);
    }
    for (const [k, entryA] of A) {
      const entryB = B.get(k);
      if (!entryB) continue;
      if (entryA[1] !== entryB[1]) {
        tokens.push(`${k} (class_type changed)`);
        continue;
      }
      const insA = Array.isArray(entryA[2]) ? entryA[2] : [];
      const insB = Array.isArray(entryB[2]) ? entryB[2] : [];
      const mapA = new Map(insA.filter(Array.isArray).map(([n, v]) => [String(n), v]));
      const mapB = new Map(insB.filter(Array.isArray).map(([n, v]) => [String(n), v]));
      for (const [n, v] of mapA) {
        if (!mapB.has(n) || JSON.stringify(mapB.get(n)) !== JSON.stringify(v)) {
          tokens.push(`${k} ${n}`);
        }
      }
      for (const n of mapB.keys()) {
        if (!mapA.has(n)) tokens.push(`${k} ${n}`);
      }
    }
    return tokens;
  } catch {
    return null;
  }
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
 * The "execId inputName" pairs whose values MUTATE AT QUEUE TIME — after our
 * pre-dispatch stamp and before the POST body is built — collected from the live
 * root graph and every nested subgraph. FOUR signals, one per mechanism: a
 * widget-level `beforeQueued` hook (#572), an extension that patches
 * `api.queuePrompt` and rewrites the outgoing prompt directly (rgthree's armed
 * Seed node, #1124 — invisible to any widget scan, matched by node identity),
 * an extension that materialises virtual links into the prompt at queue
 * time (cg-use-everywhere, #1273 — matched by the pack's own `extra.ue_links`
 * record, see ueQueueTimeLinkPairs), and a leftover widget value whose
 * SAME-NAMED input is already link-connected (#1331 — after reconnect the
 * serialized form flips from the stale widget default to the incoming link,
 * or the leftover filename itself settles, while the canvas is idle).
 * execId is the flattened prompt id: String(node.id) at root, the
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
/**
 * Widget names on `node` whose SAME-NAMED input is currently link-connected
 * (#1331). The leftover widget value is non-semantic: execution reads the
 * link. A connected input with no matching widget and no convert-to-input
 * marker is a pure socket and is NOT returned — those stay drift-covered.
 * Never throws: this runs on the stamp path.
 */
function linkDrivenWidgetInputNames(node) {
  const names = new Set();
  try {
    const live = new Set();
    for (const w of node?.widgets ?? []) {
      if (w && typeof w.name === "string") live.add(w.name);
    }
    for (const input of node?.inputs ?? []) {
      if (!input || input.link == null) continue;
      const converted = typeof input.widget?.name === "string" ? input.widget.name : null;
      if (converted) names.add(converted);
      else if (typeof input.name === "string" && live.has(input.name)) names.add(input.name);
    }
  } catch {
    /* a malformed node contributes no pairs — fail toward detecting drift */
  }
  return names;
}

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
      // #1124 — THE SECOND VOLATILITY SIGNAL. `beforeQueued` is not the only way
      // an input mutates between our stamp and the POST: a pack can patch
      // `api.queuePrompt` itself and rewrite the serialized prompt on its way out,
      // which happens AFTER graphToPrompt and is invisible to any widget-hook
      // scan. rgthree's Seed node does exactly that — and it SPLICES OUT the
      // control_after_generate widget the stock hook would have ridden on, so the
      // loop above finds nothing on it. Every scoped run on a workflow containing
      // an armed Seed (rgthree) was therefore refused as "the graph CHANGED",
      // naming the seed input, with nothing queued and the retry failing
      // identically (the widget stays armed, so each attempt draws a new number).
      //
      // NARROW BY CONSTRUCTION, and it must stay that way: this excludes exactly
      // ONE input on nodes that self-identify as rgthree seed nodes AND are armed
      // with one of rgthree's sentinels. A fixed seed, a muted or bypassed node,
      // and every other node in the graph keep full drift coverage —
      // rgthreeQueueTimeSeedInput returns null for all of them. #556 still catches
      // a graph that genuinely changed under a stamped run; what it no longer does
      // is call another extension's documented queue-time substitution a user edit.
      const rgthreeSeedInput = rgthreeQueueTimeSeedInput(node);
      if (rgthreeSeedInput != null) addPair(execId, rgthreeSeedInput);
      // #1331 — THE FOURTH VOLATILITY SIGNAL. After a reconnect the frontend
      // re-materialises converted widgets (clip/vae/model/length/…) while their
      // SAME-NAMED input is already linked. graphToPrompt then serializes the
      // leftover widget value on one pass and the incoming link (or a later
      // leftover) on the next — 100+ `clip`/`vae`/`model` diffs on a large
      // MiniMax H3 graph, every one of them link-driven, none of them a user
      // edit. The #1050 single retry still races because serializeValue keeps
      // settling those leftovers. The value that EXECUTES is the link; the
      // leftover is non-semantic. Exclude exactly those widget names.
      //
      // NARROW BY CONSTRUCTION: a connected input with no matching widget and
      // no convert-to-input marker (`input.widget`) is a PURE SOCKET and stays
      // hashed — a rewire of KSampler.model is still drift. A converted widget
      // (`input.widget.name`, or a live widget whose name matches a linked
      // input) is the leftover that races.
      for (const name of linkDrivenWidgetInputNames(node)) addPair(execId, name);
      // #1331 (b) — after reconnect the stock control_after_generate combo
      // can be present by OPTION SHAPE before its beforeQueued hook is
      // re-hung. The hook scan above then finds nothing, and a randomize
      // RandomNoise seed churns between stamp and dispatch the same way
      // #572 already excluded when the hook WAS there. The shipped detector
      // (controlAfterGenerateEntries) is hook-independent; a "fixed" mode
      // still excludes nothing.
      for (const entry of controlAfterGenerateEntries(node)) {
        if (entry.mode === "fixed") continue;
        addPair(execId, entry.widget);
        if (entry.control !== entry.widget) addPair(execId, entry.control);
      }
      if (node.subgraph) walk(node.subgraph, execId);
    }
  };
  walk(rootGraph, "");
  // #1273 — THE THIRD VOLATILITY SIGNAL. cg-use-everywhere's queuePrompt patch
  // converts its broadcasts to REAL links before the post body is serialized
  // and restores them after, so the stamp's graphToPrompt and the dispatch's
  // serialization of an UNTOUCHED graph differ on exactly the pack's own
  // `extra.ue_links` record. Every scoped run on a UE graph was refused as
  // "the graph CHANGED", naming the broadcast targets (model/clip/vae/…), with
  // the retry failing identically — the injection is deterministic, not a
  // race. The pairs are exactly the inputs the injection can materialise
  // (subgraph routing included — see use-everywhere-links.js); everything else
  // keeps full drift coverage, and the set rides along in `volatileInputs`
  // like the hook and rgthree pairs. This is its own walk, not a fold into
  // the loop above: the output-panel routing needs the INSTANCE node a bare
  // graph walk doesn't carry, and a shared subgraph definition must be walked
  // once per instance prefix.
  for (const pair of ueQueueTimeLinkPairs(rootGraph)) pairs.add(pair);
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

/**
 * WHY a POST /prompt body carries no usable scope — the OBSERVATION, kept
 * distinct instead of folded into one verdict.
 *
 * The previous single "scope_missing" verdict covered FOUR different states
 * and its message asserted one specific cause for all of them ("this frontend
 * That assertion is a BUCKET narrated as a CAUSE. Three separate field reports
 * on #556 pasted that asserted cause verbatim into the tracker, which is
 * precisely why the real cause stayed unknown for so long.
 *
 * #752 - this paragraph USED to continue: "every ComfyUI_frontend build from
 * 1.42 through 1.50 demonstrably accepts BOTH third-argument shapes ... and both
 * funnel into api.queuePrompt's options.partialExecutionTargets ->
 * body.partial_execution_targets". It is FALSE on at least one build, and it was
 * the same defect this paragraph is ABOUT: a claim about builds nobody here had
 * run, stated as demonstrated.
 *
 * MEASURED on a live ComfyUI_frontend 1.48.7 - intercepting POST /prompt and
 * BLOCKING it so nothing queued - calling app.queuePrompt(0, 1, third):
 *
 *   positional [id]             -> partial_execution_targets: ["9"]
 *   { queueNodeIds: [id] }      -> partial_execution_targets: {"queueNodeIds":["9"]}
 *   { partialExecutionTargets } -> partial_execution_targets: {"partialExecutionTargets":["9"]}
 *
 * The third argument is copied into the body VERBATIM; nothing unwraps an
 * options object. So on that build only the positional shape yields a usable
 * target list, and either options shape puts an OBJECT where the server expects
 * an array. readScopeFromBody's `not_a_list` state is what catches it - which is
 * why that state must stay: the KEY being present is not evidence the scope
 * landed, and a presence-only check would have accepted a malformed body.
 *
 * Which builds honour which shape is still not something this file can assert.
 * The shapes are tried in order and the emitted request is measured; that is the
 * only claim available from inside one of them.
 *
 * So the states are now reported separately, the message states only what was
 * OBSERVED, and the body's top-level keys ride along as evidence.
 *
 * `body_unreadable` and `body_not_an_object` are deliberately separate (codex
 * gate r2): a JSON scalar, `null`, or an array PARSES fine — saying it "could
 * not be parsed" would report a definite negative about an operation that
 * actually succeeded, which is the same collapse this split exists to remove.
 *
 * REACHABILITY, stated plainly rather than implied: neither of those two states
 * can reach the guard's refusal path today, and that is by construction, not by
 * luck. The guard's FIRST test is run identity — this run's unique queue mark,
 * read from the body's top-level `number`. A body that will not parse, or that
 * parses to a scalar/array, cannot carry that mark, so it is FOREIGN traffic:
 * passed through untouched, never refused, never repaired, never observed. The
 * two states therefore exist for correctness of the classification itself (and
 * for any future caller that reads a body it has already attributed some other
 * way), and the tests pin BOTH the classification and the pass-through.
 *
 * @typedef {"present"|"absent"|"empty"|"not_a_list"|"body_unreadable"|"body_not_an_object"} ScopeReadState
 * @returns {{state: ScopeReadState, targets: string[]|null, bodyKeys: string[]|null, raw: unknown}}
 */
export function readScopeFromBody(bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { state: "body_unreadable", targets: null, bodyKeys: null, raw: undefined };
  }
  // An array parses and has keys, but it is not a prompt request; treat it with
  // the scalars rather than letting Object.keys present indices as body keys.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { state: "body_not_an_object", targets: null, bodyKeys: null, raw: body };
  }
  const bodyKeys = Object.keys(body).sort();
  const t = body.partial_execution_targets;
  // "absent" means the key is genuinely not there. JSON cannot encode
  // `undefined`, so after a parse `undefined` is exactly "no such key". An
  // explicit `null` is a key that IS present carrying an unusable value —
  // reporting that as "no partial_execution_targets key at all" would
  // contradict the body keys printed alongside it, and would be this module's
  // own defect class (an observation collapsed into a definite negative).
  if (t === undefined) return { state: "absent", targets: null, bodyKeys, raw: t };
  if (!Array.isArray(t)) return { state: "not_a_list", targets: null, bodyKeys, raw: t };
  if (!t.length) return { state: "empty", targets: null, bodyKeys, raw: t };
  return { state: "present", targets: t.map(String), bodyKeys, raw: t };
}

/** The body's partial_execution_targets as strings, or null when absent/empty/not-a-list/unparseable. */
function targetsFromBody(bodyText) {
  return readScopeFromBody(bodyText).targets;
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
 * REPAIR the scope into a POST /prompt body we have already ATTRIBUTED to this
 * run (its unique queue mark AND its content hash both match), when the body
 * reached the wire without a usable `partial_execution_targets`.
 *
 * This is what turns #556's outcome from "refuse and explain" into "honour the
 * request". `partial_execution_targets` is a plain top-level key of the /prompt
 * body — the one place every ComfyUI_frontend build must put the scope,
 * whatever shape its `app.queuePrompt` wrapper takes — so writing it here works
 * on any build, present or future, including one whose wrapper drops the
 * argument entirely. The alternative at this point is NOT a full-graph run (the
 * guard blocks that unconditionally); it is a refusal. So repair can only ever
 * improve the outcome, and never widens what executes: the targets written are
 * exactly the ones graph_run resolved.
 *
 * The repair is ITSELF an operation that can fail, so it verifies its own
 * output: the rewritten text is re-parsed and re-checked, and anything short of
 * a clean pass returns null so the caller refuses instead of forwarding an
 * unverified body. `prompt` is untouched, so the content hash still matches.
 *
 * @param {string|undefined} bodyText
 * @param {string[]} expectedExecIds
 * @returns {string|null} the repaired body text, or null when repair is impossible
 */
export function repairScopeInBody(bodyText, expectedExecIds) {
  const expected = (expectedExecIds ?? []).map(String);
  if (!expected.length) return null;
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  let text;
  try {
    text = JSON.stringify({ ...body, partial_execution_targets: expected.slice() });
  } catch {
    return null;
  }
  // Re-read what we just produced: a repair that cannot be verified is not a
  // repair. Never hand on a body we have not confirmed carries the scope.
  if (!verifyScopedPromptBody(text, expected).ok) return null;
  return text;
}

/**
 * Render an arbitrary observed value for a human-readable message WITHOUT ever
 * throwing (codex gate r2, P1).
 *
 * `JSON.stringify` is not a safe formatter for a value that came off the wire:
 * a deeply nested object throws RangeError, a BigInt throws TypeError, a
 * circular structure throws. This function sat between the guard's decision to
 * refuse and the recording of that refusal, so a throw here escaped the guard
 * with the refusal budget already spent — and on the next attributed scopeless
 * post the exhausted-budget path forwarded it UNCHANGED, i.e. a full-graph run.
 * A guard that can throw is not a guard.
 *
 * Bounded in length too: this string goes into an error a caller reads.
 *
 * NOTE on reproducibility (be honest about what is proven): the depth-based
 * trigger codex found is engine- and stack-dependent. `JSON.stringify` DOES
 * throw RangeError on a ~5000-deep value when called from a shallow stack on
 * this Node, but from inside the guard's async call chain it survived 150k
 * levels — V8's stringify is iterative there. So the exploit is real but not
 * deterministically reproducible from the guard's entry point on this engine.
 * The contract enforced by the tests is therefore the one that matters and can
 * be proven: this function NEVER throws, for any input. Exported for that test.
 */
export function describeObserved(value) {
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return String(typeof value); // undefined / function / symbol — stringify returns undefined
  } catch {
    // Unserializable (too deep, circular, BigInt). Say what it was, not what it said.
    try {
      return Array.isArray(value) ? `an unserializable array` : `an unserializable ${typeof value} value`;
    } catch {
      return "an unserializable value";
    }
  }
}

/**
 * What was OBSERVED about the scope in our own dispatch — one clause per
 * distinct state, asserting nothing beyond the observation. See
 * readScopeFromBody for why these are no longer one bucket.
 *
 * Every interpolation goes through describeObserved: this runs on the refusal
 * path, and the refusal path must not be able to fail.
 */
function scopeObservation(verdict) {
  switch (verdict?.reason) {
    case "scope_mismatch":
      return (
        `the POST /prompt body carried partial_execution_targets ` +
        `${describeObserved(verdict.got)} instead of ${describeObserved(verdict.expected)}`
      );
    case "scope_not_a_list":
      return (
        `the POST /prompt body's partial_execution_targets was not a list ` +
        `(${describeObserved(verdict.raw)}) — the requested scope did not survive ` +
        `the trip through app.queuePrompt in a usable shape`
      );
    case "scope_empty":
      return `the POST /prompt body carried an EMPTY partial_execution_targets list`;
    case "body_unreadable":
      return `the POST /prompt body could not be parsed, so the scope could not be read from it`;
    case "body_not_an_object":
      return (
        `the POST /prompt body parsed, but it was not a request object ` +
        `(${describeObserved(verdict.raw)}), so it carries no scope to read`
      );
    default:
      return (
        `the POST /prompt body carried no partial_execution_targets key at all` +
        (verdict?.bodyKeys?.length ? ` (body keys: ${verdict.bodyKeys.join(", ")})` : "")
      );
  }
}

/**
 * The truthful refusal message when our own dispatch surfaced WITHOUT the
 * scope. Names the node that couldn't be scoped and states plainly that
 * NOTHING was queued — never a false `queued:true`/`ran_to_node` for what
 * would have been a full-graph run.
 *
 * It reports the OBSERVATION and, where the cause is not observable from here,
 * enumerates the candidates rather than asserting whichever one it happened to
 * name. It also gives a remedy that works from where the caller is standing:
 * the scope is what could not be delivered, so the run that CAN still be made
 * is the unscoped one — stated as a choice with its cost, never taken silently.
 */
export function scopeDroppedError({ toNodeId, verdict }) {
  if (verdict?.reason === "graph_changed") {
    // #659 — report WHAT differed (the observation), not a guessed cause. The
    // old message named only the control_after_generate hook, which sent the
    // reporter chasing the wrong layer for five runs. When the drift diff is
    // available, the differing "execId inputName" pairs lead; the hook
    // guidance stays as a fallback for when the diff could not be computed.
    //
    // The tokens are normalized defensively (codex gate r1): verdict.drift is
    // module-internal today (diffPromptCanons only ever emits bounded
    // strings), but this function is exported and runs on the refusal path —
    // a malformed caller-supplied drift must degrade to the no-diff message,
    // never throw out of the refusal's description.
    const drift = (() => {
      try {
        if (!Array.isArray(verdict.drift) || !verdict.drift.length) return null;
        const tokens = verdict.drift
          .filter((t) => typeof t === "string" && t.length)
          .map((t) => (t.length > 120 ? `${t.slice(0, 120)}…` : t));
        return tokens.length ? tokens : null;
      } catch {
        return null;
      }
    })();
    const MAX_DRIFT_TOKENS = 12;
    const driftText = drift
      ? `The differing entr${drift.length === 1 ? "y" : "ies"}: ` +
        drift.slice(0, MAX_DRIFT_TOKENS).join("; ") +
        (drift.length > MAX_DRIFT_TOKENS ? `; …and ${drift.length - MAX_DRIFT_TOKENS} more` : "") +
        `. `
      : "";
    // Enumerate CANDIDATES, never assert one (codex gate r1/r2): the guard
    // observed two differing serializations, nothing more — it cannot see
    // WHAT rewrote the value, or even that a "rewrite" happened at all (a
    // nondeterministic widget serializer — a serializeValue emitting a
    // timestamp — produces this same refusal on an untouched graph).
    // #1124 added the FOURTH candidate, and it is the one that had been missing:
    // an extension that patches `api.queuePrompt` and rewrites the serialized
    // prompt on its way out. That happens after graphToPrompt and carries no
    // widget hook, so no scan of the live graph can see it coming. rgthree's Seed
    // node is the measured instance and is now excluded by name
    // (collectVolatileInputs); it stays listed here because the NEXT pack doing
    // the same thing will land on this message, and naming the shape is what lets
    // a reporter recognise it.
    const causeText = drift
      ? `If you did not edit ${drift.length === 1 ? "it" : "these"} between queueing and ` +
        `dispatch, the two serializations differ for a reason the panel cannot identify from ` +
        `here — candidates: a queue-time widget hook (e.g. control_after_generate), an ` +
        `extension that rewrites the prompt inside its own api.queuePrompt patch, a ` +
        `dynamic-input node reshaping its slots, or a nondeterministic widget serializer. ` +
        `Please report this with the differing list above. `
      : `If this recurs without any edit in between, the two serializations differ for a ` +
        `reason the panel cannot identify from here — candidates: a queue-time widget hook ` +
        `mutating values between serialization and dispatch (e.g. a control_after_generate ` +
        `widget with WidgetControlMode "before" — switch it to "after" or fix the target ` +
        `widget's value), an extension that rewrites the prompt inside its own ` +
        `api.queuePrompt patch, or a nondeterministic widget serializer. `;
    return (
      `run-to-node scope for node ${toNodeId} was NOT applied: the workflow graph ` +
      `CHANGED after the run was queued — the deferred dispatch would render a ` +
      `modified workflow, not the one that was scoped. ` +
      driftText +
      `Retrying is safe (nothing was queued). ` +
      causeText +
      `Nothing was queued — refusing to fall through to a full-graph execution (#556).`
    );
  }
  return (
    `run-to-node scope for node ${toNodeId} was NOT applied: ${scopeObservation(verdict)}. ` +
    `Every delivery route was tried — the positional NodeExecutionId[] argument, the ` +
    `QueuePromptOptions { queueNodeIds } argument, and writing partial_execution_targets ` +
    `directly into this run's own /prompt body — and the scope still did not reach the ` +
    `request, so the panel cannot say which layer dropped it from here. ` +
    `Nothing was queued — refusing to fall through to a full-graph execution (#556). ` +
    `To render this branch now, either run it unscoped (panel_run without to_node_id, ` +
    `which executes the WHOLE graph — every other output branch included, at full GPU/API ` +
    `cost) or delete/bypass the output nodes you do not want and run unscoped. ` +
    // #752 — the removed clause said this path is "not reproducible against
    // ComfyUI_frontend 1.42–1.50, where both argument shapes are honoured".
    // Three field reports on 1.45.21 sit INSIDE that range and reproduced it, so
    // the claim was false, and it was expensive: it told each reporter their own
    // evidence could not be happening, and sent them (and me) to audit argument
    // shapes that were fine. A build range is a claim about builds nobody here
    // has run — the panel can measure the request it just made and nothing else.
    `Please report this with the body keys above, and your ComfyUI_frontend version — ` +
    `which builds honour which argument shape is not something the panel can determine ` +
    `from inside one of them.`
  );
}

/**
 * The truthful UPFRONT refusal when the prompt can't be fingerprinted
 * (graphToPrompt failed before dispatch). Without a signature our dispatch
 * can't be told apart from a stranger's, so a scoped run must NOT dispatch at
 * all — fail closed, nothing queued.
 *
 * #1571 — `cause` is the error `graphToPrompt` actually threw, and dropping it was
 * expensive. The reporter's graph had been left unserializable by a subgraph
 * conversion; ComfyUI threw `InvalidLinkError: No link found in parent graph for id
 * [302:192] slot [0] conditioning`, which names the offending node outright. This
 * refusal caught it, discarded it, and said only "graphToPrompt failed" — so the
 * reporter concluded that run-to-node "cannot fingerprint NESTED output targets".
 * Nesting had nothing to do with it. The panel knew the real reason and did not say it.
 *
 * The cause is quoted, never interpreted: this path cannot tell a corrupt graph from a
 * missing pack from an extension throwing inside its own serializer, and guessing
 * between them is how a reporter gets sent to fix the wrong thing. `cause` is optional
 * because the refusal also fires with nothing thrown at all — a frontend with no
 * `graphToPrompt`, or a prompt that canonicalizes to nothing — and inventing a cause
 * for those would be the same defect pointed the other way.
 */
export function scopeUnattributableError({ toNodeId, cause } = {}) {
  const reason = describeFingerprintFailure(cause);
  return (
    `run-to-node scope for node ${toNodeId} cannot be dispatched safely: the ` +
    `prompt could not be fingerprinted (graphToPrompt failed), so the panel ` +
    `cannot distinguish its own dispatch from unrelated queue traffic. ` +
    `${reason}` +
    `Nothing was queued rather than risk a full-graph execution (#556).`
  );
}

/** How many characters of a thrown serializer error are worth quoting verbatim. */
const FINGERPRINT_CAUSE_CAP = 400;

/**
 * The `cause` clause for {@link scopeUnattributableError}: the serializer's own words,
 * bounded, or nothing at all when there were none.
 *
 * Deliberately says WHERE the text came from. An unattributed sentence in the middle of
 * a panel refusal reads as the panel's own diagnosis, and this one is a third party's —
 * ComfyUI's serializer, or whatever extension is patched into it.
 */
export function describeFingerprintFailure(cause) {
  const raw = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return "";
  const quoted = text.length > FINGERPRINT_CAUSE_CAP ? `${text.slice(0, FINGERPRINT_CAUSE_CAP)}…` : text;
  return (
    `ComfyUI's serializer failed with: "${quoted}" — that is the frontend's own error, ` +
    `not the panel's diagnosis of it. A graph left unserializable by an earlier edit ` +
    `(comfyui-mcp#1571: a subgraph conversion that dropped a boundary link) fails here ` +
    `whatever node you scope to, so this is not specific to run-to-node or to nesting. `
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
export function scopeUnverifiedError({ toNodeId, timeoutMs, cancelled = false, verified = 0, batch = 1, inFlight = 0 }) {
  const count =
    verified > 0
      ? ` (${verified} of ${batch} batch prompts WERE verified and are queued with the scope)`
      : "";
  const base =
    `run-to-node scope for node ${toNodeId} could not be verified: no scoped ` +
    `dispatch was observed within ${Math.round(timeoutMs / 1000)}s of queueing ` +
    `(the frontend deferred or silently dropped the request)${count}. `;
  // IN FLIGHT ≠ NEVER SENT (codex gate r9). A correctly-scoped request that has
  // already left the panel but whose response has not come back yet is neither
  // verified nor absent — it may be accepted a moment from now. Saying "nothing
  // was queued" about it is a definite negative we cannot observe, and the
  // caller acting on it re-renders a branch that is already running.
  const inFlightNote =
    inFlight > 0
      ? `${inFlight} correctly-scoped request(s) had ALREADY LEFT the panel and were ` +
        `still awaiting a response when the wait expired — those may yet be accepted by ` +
        `ComfyUI, so this is NOT a report that nothing was queued. Check the ComfyUI ` +
        `queue before retrying. `
      : "";
  if (cancelled) {
    return (
      base +
      inFlightNote +
      `The still-pending queue item was located and REMOVED, so nothing ` +
      `${verified > 0 || inFlight > 0 ? "more " : ""}was queued from the pending item and no ` +
      `scope-dropped full-graph dispatch can execute` +
      (inFlight > 0 ? ` (#556).` : ` — retry the run (#556).`)
    );
  }
  if (inFlightNote) return base + inFlightNote + `The scope guard stays installed as a sentinel (#556).`;
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
        message: tr("run_scope_guard.run_to_node_scope_was_not_applied", "run-to-node scope was not applied; nothing was queued"),
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
 *
 * DISCLOSURE, NOT A DENIAL (codex gate r7, P0-4). This message used to end
 * "this prompt did not reach ComfyUI" — a definite negative the panel cannot
 * observe, and one that now contradicts the module's own handling: a thrown
 * fetch is recorded as INDETERMINATE precisely because the throw can happen
 * AFTER ComfyUI received and queued the prompt (a reset while reading the
 * response is indistinguishable from one before the request left). Telling the
 * caller it did not run makes them do the reasonable thing — resubmit — and
 * pay twice in GPU time or API credits for a render that may already be
 * running. Refuse vs disclose: once the request may have left, the only honest
 * answer is what is known and what is not, plus where to look.
 */
export function scopeDispatchError({ toNodeId, detail, verified, batch }) {
  return (
    `run-to-node scope for node ${toNodeId}: a verified-scoped /prompt request ` +
    `FAILED to complete — ${detail}. ${verified} of ${batch} batch prompts were ` +
    `confirmed queued before the failure. This one is NOT confirmed queued — but ` +
    `it had already left the panel, so whether ComfyUI accepted it CANNOT be ` +
    `determined from here: it may be queued or running right now. Check the ` +
    `ComfyUI queue before resubmitting, or a retry may render the branch twice. ` +
    `What IS certain: the request carried the run-to-node scope, so no full-graph ` +
    `dispatch occurred (#556).`
  );
}

/**
 * #1504 — node_errors on an ACCEPTED (200) reply are dropped outputs, not a refusal.
 *
 * ComfyUI's `validate_prompt` validates each output independently and keeps the ones
 * that pass (`good_outputs`). When at least one survives, server.py takes the
 * `if valid[0]:` branch — it mints a prompt id, calls `prompt_queue.put(...)`, and
 * answers
 *
 *     web.json_response({"prompt_id": …, "number": …, "node_errors": valid[3]})
 *
 * with status **200**. So an accepted, already-executing prompt can carry a populated
 * `node_errors` map naming the outputs it dropped ("Output will be ignored").
 *
 * That map is ALSO what the frontend stores: `app.queuePrompt` calls
 * `recordNodeErrors(res.node_errors)` on the resolved (200) response, so
 * `app.lastNodeErrors` is populated for a run that is on the GPU right now. Reading
 * only that channel is what made graph_run answer "ComfyUI refused to queue the
 * workflow" for six VAEDecode nodes whose branches were bypassed — while the render
 * they belonged to was running, and every following graph read came back QUEUE BUSY.
 *
 * The 200 body is the authoritative, non-stale source for both halves: it says a
 * prompt id was minted AND which outputs were dropped, in one structured receipt.
 * `lastNodeErrors` cannot distinguish those two cases at all.
 */
async function captureRunResponse(res, { onRejection, onPromptId, onAcceptedNodeErrors }) {
  try {
    const body = await res.clone().json();
    if (res.status !== 200) {
      if (body && (body.error || body.node_errors)) {
        onRejection?.({ error: body.error ?? null, node_errors: body.node_errors ?? null });
      }
    } else if (body && body.prompt_id != null) {
      onPromptId?.(String(body.prompt_id));
      reportAcceptedNodeErrors(body, onAcceptedNodeErrors);
    }
  } catch {
    // non-JSON body / clone unsupported — the caller falls back to lastNodeErrors.
  }
}

/** Forward a 200 reply's non-empty `node_errors` (the #1504 partial-validation drops). */
function reportAcceptedNodeErrors(body, onAcceptedNodeErrors) {
  const ne = body?.node_errors;
  if (ne && typeof ne === "object" && !Array.isArray(ne) && Object.keys(ne).length) {
    onAcceptedNodeErrors?.(ne);
  }
}

// Classify the response to an ATTRIBUTED scoped post (r6): "accepted" ONLY
// when it is a real 200 with a parseable prompt_id (captured); "rejected" when
// it is a genuine server rejection (non-200 with an error / node_errors body —
// captured through the established #358 channel); "malformed" for anything
// else (2xx without a prompt_id, non-200 without a rejection body, unparseable
// body, missing response). Only "accepted" may ever count as verified.
async function classifyRunResponse(res, { onRejection, onPromptId, onAcceptedNodeErrors }) {
  if (!res) return "malformed";
  try {
    const body = await res.clone().json();
    if (res.status === 200) {
      if (body && body.prompt_id != null) {
        onPromptId?.(String(body.prompt_id));
        reportAcceptedNodeErrors(body, onAcceptedNodeErrors); // #1504
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
export function createRunFetchInterceptor({
  origFetchApi,
  onRejection = null,
  onPromptId = null,
  onAcceptedNodeErrors = null,
} = {}) {
  return async function runFetchInterceptor(route, options) {
    const res = await origFetchApi(route, options);
    if (isPromptPost(route, options) && res) {
      await captureRunResponse(res, { onRejection, onPromptId, onAcceptedNodeErrors });
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
 *
 * REPAIR (`repairScope`, the final dispatch attempt): when the body is OURS
 * (mark AND content hash both match) and carries no usable scope, the guard
 * WRITES the resolved targets into the body and forwards it, instead of
 * refusing — see repairScopeInBody. This is what lets #556 end in the
 * PREFERRED outcome (the requested subset actually runs) rather than the
 * merely-safe one (a refusal). It is never a widening: a scope MISMATCH — a
 * body carrying targets we did not ask for — is never overwritten, and an
 * unreadable body is never repaired; both still refuse.
 *
 * state = { observed, repaired, rejected, refused, dropped, droppedReason,
 * failed } is live; waitForVerdict(ms) resolves true at any terminal state,
 * false on timeout.
 */
export function createScopedRunGuard({
  origFetchApi,
  execIds,
  contentHash,
  volatileInputs = null,
  contentCanon = null,
  batch = 1,
  toNodeId = null,
  queueMark,
  repairScope = false,
  onRejection = null,
  onPromptId = null,
  onAcceptedNodeErrors = null,
  onScopeDropped = null,
} = {}) {
  const expected = (execIds ?? []).map(String);
  const maxBatch = Math.max(1, Math.floor(Number(batch)) || 1);
  const state = { observed: 0, repaired: 0, rejected: 0, refused: 0, overrun: 0, overrunError: null, inFlight: 0, indeterminate: 0, closed: false, retired: false, dropped: null, droppedReason: null, failed: null, repairedFromKeys: null, prunedRetry: null };
  const waiters = new Set();
  const notify = () => {
    for (const fire of [...waiters]) fire();
  };
  // #659 — WHAT differed between the pre-dispatch canonical prompt and this
  // attributed body's, for the graph_changed refusal to report. Runs only on
  // the refusal path, after the refusal is already decided; a failure to diff
  // (unparseable body, odd canon) degrades to null and never changes the
  // refusal itself.
  const driftTokensForBody = (bodyText) => {
    try {
      if (!contentCanon) return null;
      const body = JSON.parse(bodyText);
      return diffPromptCanons(contentCanon, canonicalizePrompt(body?.prompt, volatileInputs));
    } catch {
      return null;
    }
  };

  const guard = async (route, options) => {
    // RETIRED (codex gate r8): this attempt has handed over to a LATER attempt
    // of the same run, which is now installed above us in the chain and owns
    // this mark. We must not also act on it — two live guards for one mark
    // would double-count a forwarded post, or refuse our own successor's
    // repaired body. Retired means fully transparent, forever.
    if (state.retired) return origFetchApi(route, options);
    if (!isPromptPost(route, options)) return origFetchApi(route, options);
    // RUN IDENTITY FIRST: no mark ⇒ not ours ⇒ never touch it. This is what
    // keeps a user's full run of the SAME graph, or another scoped run with
    // the SAME targets, safe from our refusals and our capture.
    if (bodyQueueMark(options?.body) !== queueMark) {
      return origFetchApi(route, options);
    }
    // BATCH QUOTA (codex gate r3). This run asked for `maxBatch` prompts. An
    // attributed post BEYOND that is work nobody requested — the requested
    // branch executed again, at real GPU/API cost, while graph_run still
    // reports batch_count as what was asked for. The old batch bound was purely
    // OBSERVATIONAL: it stopped the orchestration waiting, but never stopped a
    // post leaving. That was already true for a natively-scoped duplicate, and
    // the repair would have widened it — turning a duplicate that used to be
    // refused (its scope was dropped) into one that dispatches. So the bound is
    // now a FENCE on dispatch, checked before the repair and before any
    // forwarding.
    //
    // Only completed work counts toward the quota: `observed` (queued) and
    // `rejected` (ComfyUI said no — that prompt is spent). A `failed` post never
    // reached ComfyUI, so a later post of the same batch is legitimately still
    // owed and must not be fenced out.
    // CLOSED (codex gate r5): the orchestration has already RETURNED and told
    // the caller what happened. The report is itself a fence — a post that
    // dispatches after it contradicts what the caller was told, and a caller
    // instructed to "re-run only the remaining N" would then get those N twice.
    // So a closed guard refuses every attributed post, whatever the quota says.
    if (state.closed || state.observed + state.rejected + state.indeterminate + state.inFlight >= maxBatch) {
      state.overrun++;
      if (state.overrunError == null) {
        state.overrunError = state.closed
          ? `run-to-node scope for node ${toNodeId}: a /prompt post carrying this run's ` +
            `identity arrived AFTER the run's outcome had already been reported. It was ` +
            `refused rather than dispatched — executing it would contradict the result the ` +
            `caller was given, and could double-render the branch alongside their retry (#556).`
          : `run-to-node scope for node ${toNodeId}: an EXTRA /prompt post carrying this ` +
            `run's identity arrived after all ${maxBatch} requested prompt(s) were already ` +
            `accounted for. It was refused rather than dispatched — queueing it would have ` +
            `executed the requested branch more times than asked, at real GPU/API cost. ` +
            `The requested prompts are queued and unaffected (#556).`;
      }
      notify();
      return SCOPE_DROPPED_RESPONSE();
    }
    const scopeRead = readScopeFromBody(options?.body);
    let targets = scopeRead.targets;
    const contentOk =
      contentHash && promptContentHashFromBody(options?.body, volatileInputs) === contentHash;
    // SCOPE REPAIR — only for a body already attributed to THIS run (mark +
    // content hash), only when no usable scope is present (absent / empty /
    // not-a-list), and only on the attempt that asked for it. A body carrying
    // DIFFERENT targets is a mismatch we do not understand and must not
    // overwrite; an unparseable body cannot be repaired. Both fall through to
    // the refusal below, exactly as before.
    let forwardOptions = options;
    if (
      repairScope &&
      contentOk &&
      !targets &&
      // ONLY a genuinely ABSENT key (codex gate r7, P0-1). Previously `empty`
      // and `not_a_list` were repaired too, which broke this module's own rule
      // that a scope we did not put there is never overwritten. `[]`, `null`,
      // `"14"`, and especially `{ queueNodeIds: [...] }` are PRESENT values in
      // a shape we did not expect — the last looks like another layer's scope
      // convention, not an absence. Absence is ours to fill; a present value we
      // cannot interpret is someone else's data, and rewriting it would be
      // executing our intent over a request that said something different.
      // Those states now fall through to the refusal, which names what it saw.
      scopeRead.state === "absent"
    ) {
      const repairedBody = repairScopeInBody(options?.body, expected);
      if (repairedBody != null) {
        forwardOptions = { ...options, body: repairedBody };
        targets = expected.slice();
        state.repaired++;
        // #752 — WHAT THE BODY ACTUALLY CONTAINED. Three reports have not
        // narrowed this because the note says the scope "did not reach the
        // request" without saying what did. The keys distinguish the cases
        // that matter: a frontend that dropped the field entirely, versus one
        // that renamed it, versus one that put it somewhere else. Recorded
        // from the FIRST repair only — later posts in a batch are the same
        // shape, and a growing list would read as several distinct causes.
        if (state.repairedFromKeys === null) state.repairedFromKeys = scopeRead.bodyKeys;
      }
    }
    if (contentOk && targets && sameSet(targets, expected)) {
      // OUR scoped dispatch. It counts as VERIFIED only when the fetch itself
      // completes with a real 200 + prompt_id (r6) — a thrown fetch or a
      // malformed response is a terminal dispatch FAILURE, never a success;
      // a genuine server rejection flows through the established #358 channel.
      //
      // RESERVE THE QUOTA SLOT BEFORE FORWARDING (codex gate r4). Counting only
      // COMPLETED requests left the fence racy: two same-mark posts issued
      // concurrently both read observed=0, both passed the quota, and both were
      // forwarded — executing the requested branch twice while reporting no
      // overrun. The reservation is taken here, synchronously, before the await,
      // so a second concurrent post sees the slot already taken.
      state.inFlight++;
      let res;
      try {
        res = await origFetchApi(route, forwardOptions);
        // comfyui-mcp#1871 — ComfyUI refuses a prompt whose OTHER branch names a class
        // this server does not have, before it ever looks at partial_execution_targets.
        // That refusal queued nothing (structured proof: non-2xx, a top-level `error`,
        // no prompt_id), and the node it names is one this run's own scope excluded —
        // so the requested branch gets ONE more post, with the excluded nodes left out.
        // Null for every other outcome, including an accepted prompt: a run ComfyUI
        // takes never reaches a second post, and the response below is the first one.
        const retry = await prunedRetryForRejection(res, forwardOptions?.body, expected);
        if (retry) {
          // Record BEFORE the post, so a retry that throws is still disclosed as having
          // been attempted rather than vanishing into the dispatch-failure message.
          state.prunedRetry = { namedNode: retry.namedNode, removed: retry.removed };
          res = await origFetchApi(route, { ...forwardOptions, body: retry.text });
        }
      } catch (err) {
        // INDETERMINATE, not "never arrived" (codex gate r6). A fetch can throw
        // after ComfyUI already received and queued the prompt — a reset while
        // reading the response looks identical to one before the request left.
        // Treating the throw as proof of non-arrival is this cluster's defect
        // class exactly, and acting on it re-dispatches a branch that may
        // already be rendering. So the slot stays CONSUMED and the outcome is
        // recorded as unknown, which is what it is.
        state.inFlight--;
        state.indeterminate++;
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
      const verdict = await classifyRunResponse(res, {
        onRejection,
        onPromptId,
        onAcceptedNodeErrors,
      });
      // The request DID leave, so the reservation is now settled into a
      // definite outcome. A malformed response keeps the slot consumed on
      // purpose: the post reached ComfyUI and MAY have queued, and re-forwarding
      // on that uncertainty is how a branch gets rendered twice. "Could not
      // determine whether it queued" is not "determined it did not".
      state.inFlight--;
      if (verdict === "accepted") {
        state.observed++;
      } else if (verdict === "rejected") {
        state.rejected++;
      } else {
        state.indeterminate++;
        if (state.failed == null) {
          state.failed = scopeDispatchError({
            toNodeId,
            detail: `the /prompt response was malformed (HTTP ${res?.status ?? "?"}, no prompt_id and no rejection body)`,
            verified: state.observed,
            batch: maxBatch,
          });
        }
      }
      notify();
      return res;
    }
    // OUR dispatch CORRUPTED. Content drift (r7) takes naming precedence: a
    // changed graph would render the wrong workflow even with the scope
    // intact. Then the scope itself: missing, or wrong/extra/partial targets.
    //
    // REFUSE FIRST, DESCRIBE AFTER (codex gate r2, P1). The refusal is the
    // thing that makes this post safe; the message is only its description.
    // Recording the message used to sit BETWEEN spending the refusal budget
    // and returning the refusal, so a throw while formatting an observed value
    // escaped the guard with the budget already spent — and the next
    // attributed post then took the exhausted-budget path and was FORWARDED,
    // scopeless, as a full graph. The budget is now spent only alongside a
    // recorded message, and the description is fenced so it cannot throw at
    // all (describeObserved) AND cannot escape if a future edit reintroduces a
    // throw (the catch below).
    if (state.dropped == null) {
      // Report the OBSERVATION, not a bucket: which of the distinct
      // no-usable-scope states actually occurred (readScopeFromBody), with
      // the body's top-level keys as evidence for the next report.
      const verdict = !contentOk
        ? { ok: false, reason: "graph_changed", drift: driftTokensForBody(options?.body) }
        : targets
          ? { ok: false, reason: "scope_mismatch", expected, got: targets }
          : {
              ok: false,
              reason:
                scopeRead.state === "not_a_list"
                  ? "scope_not_a_list"
                  : scopeRead.state === "empty"
                    ? "scope_empty"
                    : scopeRead.state === "body_unreadable"
                      ? "body_unreadable"
                      : scopeRead.state === "body_not_an_object"
                        ? "body_not_an_object"
                        : "scope_missing",
              expected,
              got: null,
              raw: scopeRead.raw,
              bodyKeys: scopeRead.bodyKeys,
            };
      state.droppedReason = verdict.reason;
      try {
        state.dropped = scopeDroppedError({ toNodeId, verdict });
      } catch {
        // The description failed; the REFUSAL must not. Never leave
        // state.dropped null here — a null would re-enter this branch on the
        // next post and could spend the whole batch's budget describing.
        state.dropped =
          `run-to-node scope for node ${toNodeId} was NOT applied and the reason could ` +
          `not be described. Nothing was queued — refusing to fall through to a ` +
          `full-graph execution (#556).`;
      }
      state.refused++;
      try {
        onScopeDropped?.(state.dropped);
      } catch {
        // A caller's notification failure must not turn a refusal into a forward.
      }
      notify();
      return SCOPE_DROPPED_RESPONSE();
    }
    // Already refused once in this batch: still OUR corrupted post, so it is
    // still refused. Only the RECORDING is bounded (one message per attempt) —
    // the budget never licensed dispatching a scopeless full graph, and letting
    // it do so is the #556 harm itself.
    if (state.refused < maxBatch) state.refused++;
    notify();
    return SCOPE_DROPPED_RESPONSE();
  };
  guard.state = state;
  // Called by the orchestration when it RETURNS: from here on this run has an
  // answer, and no further post of it may execute.
  guard.close = () => {
    state.closed = true;
  };
  // Called when a LATER attempt of the SAME run takes over: this guard becomes
  // permanently transparent instead of being unhooked, so the chain below it
  // (which may include ANOTHER run's live sentinel) is never disturbed.
  guard.retire = () => {
    state.retired = true;
  };
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
  onAcceptedNodeErrors = null,
} = {}) {
  const mark = queueMark ?? newScopedQueueMark();
  // CHAIN COMPOSITION (codex gate r8). Both the entry-time capture below and
  // the per-attempt restore used to be WRONG in the presence of a concurrent
  // run:
  //
  //   A installs GA1 over raw fetch and waits for its deferred first attempt.
  //   B starts, captures GA1 as its chain, succeeds, and retains GB as the
  //   current sentinel. A's deferred post arrives scopeless, GA1 refuses it,
  //   and A retries — whereupon A's `finally` restored A's ENTRY-TIME
  //   fetchApi (raw), CLOBBERING GB, and A's next guard also delegated to A's
  //   entry-time raw fetch, bypassing B entirely. A late B post then passed
  //   through as foreign and reached raw fetch scopeless: full graph.
  //
  // Two rules fix it, and both are needed:
  //   1. A guard delegates to whatever was CURRENT when it was installed, not
  //      to what was current when the run began (captured per attempt below).
  //   2. A superseded attempt is RETIRED — made permanently transparent — and
  //      never unhooked. Nothing in this module writes apiTarget.fetchApi back
  //      to an older value any more, so no run can displace another's guard.
  const entryFetchApi = typeof apiTarget?.fetchApi === "function" ? apiTarget.fetchApi : null;
  const origFetchApi = entryFetchApi ? entryFetchApi.bind(apiTarget) : null;
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
  // types, links, widget values — minus only the queue-time-mutating inputs
  // (beforeQueued hooks, and prompts an extension rewrites in its own
  // api.queuePrompt patch — #1124) that change between any two
  // serializations by design, and the
  // JSON-invisible values that cannot survive the POST body at all (#659).
  // No hash ⇒ no attribution ⇒ fail closed BEFORE dispatch. The canonical
  // form is RETAINED (contentCanon) so a graph_changed refusal can say WHAT
  // differed instead of asserting a cause (#659).
  let contentHash = null;
  let contentCanon = null;
  let volatileInputs = null;
  // #1571 — KEEP what was thrown. The refusal below is the only thing the caller sees,
  // and without this the serializer's own message (which names the offending node) was
  // discarded at exactly the moment it was needed.
  let fingerprintCause = null;
  try {
    if (typeof app.graphToPrompt === "function") {
      // This panel's live root is app.graph (r8) — app.rootGraph only as a
      // fallback for frontends that expose it instead.
      volatileInputs = collectVolatileInputs(app?.graph ?? app?.rootGraph ?? null);
      contentCanon = canonicalizePrompt((await app.graphToPrompt())?.output, volatileInputs);
      contentHash = contentCanon ? fnv1aHex(JSON.stringify(contentCanon)) : null;
    }
  } catch (err) {
    contentHash = null;
    contentCanon = null;
    fingerprintCause = err;
  }
  if (!contentHash) {
    return {
      outcome: "unverifiable",
      queueMark: mark,
      error: scopeUnattributableError({ toNodeId, cause: fingerprintCause }),
    };
  }
  // #572/#1124 — the inputs this run does NOT drift-cover (queue-time hook
  // carriers plus their linked, serialized targets; and an armed rgthree Seed
  // node's own seed input). Surfaced on every
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
  const attempts = queuePromptScopeAttempts(execIds);
  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
    const { arg: scopeArg, repair } = attempts[attemptIndex];
    const isLastAttempt = attemptIndex === attempts.length - 1;
    dropped = null;
    // DEFAULT TO KEEPING THE FENCE (codex gate r7, P0-2). This used to start
    // false, so any exit that did not reach the terminal-path logic — most
    // importantly `app.queuePrompt` THROWING partway through, after it had
    // already emitted a scoped post — unwound through the `finally` and
    // RESTORED raw fetchApi. A deferred duplicate carrying this run's mark
    // could then post with no scope and run the full graph.
    //
    // The ordering rule, in its teardown direction: a fence must not be
    // removed before something has decided it is no longer needed. The
    // `finally` always runs; the decision may never. So the decision is now
    // the one that has to fire — `retireGuard` is set explicitly on the only
    // exit where this attempt's guard may stand down (handing over to another
    // attempt of this same run, which installs its own guard on the same mark
    // immediately). Standing down means RETIRING (transparent), never
    // unhooking: see the chain-composition note at the top of this function.
    let retireGuard = false;
    // The chain this guard delegates to is whatever is installed RIGHT NOW —
    // which may be another run's live sentinel, or our own previous attempt.
    // Capturing the run's entry-time fetchApi here instead would bypass a
    // newer run's guard entirely (r8 P0).
    const chainBelow =
      typeof apiTarget.fetchApi === "function" ? apiTarget.fetchApi.bind(apiTarget) : origFetchApi;
    const guard = createScopedRunGuard({
      origFetchApi: chainBelow,
      execIds,
      contentHash,
      volatileInputs,
      contentCanon,
      batch,
      toNodeId,
      queueMark: mark,
      repairScope: repair,
      onRejection,
      onPromptId,
      onAcceptedNodeErrors,
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
        // GIVE-UP. The guard stays (that is now the default — the finally only
        // ever stands it down when handing over to another attempt of this same
        // run, which this is not). The deferred item may still be live in the
        // frontend's pending queue: try to REMOVE it (ownership tag AND this
        // run's mark both checked), and only when that's impossible keep the
        // surgical guard installed for the PAGE SESSION as a sentinel — NO
        // expiry timer (r4): the uncancellable item can post whenever the
        // stalled processor resumes, so the refusal must not go away. Safe by
        // construction: the sentinel only ever acts on THIS run's unique mark.
        //
        // P0-3 (codex gate r7): a successful cancel is NOT grounds to tear the
        // fence down. `removed > 0` proves only that tagged entries STILL IN
        // app.queueItems were spliced. It says nothing about an item the
        // frontend has already copied, popped, or scheduled — and if such a
        // same-mark item exists alongside one that was still removable,
        // restoring raw fetchApi lets that copy post scopeless later. Positive
        // evidence about the items we COULD see is not evidence about the ones
        // we could not. So the sentinel stays either way; the cancel result
        // only changes what we can honestly CLAIM about what was queued.
        const verified = guard.state.observed;
        // STILL IN FLIGHT is its own state (codex gate r9). A busy frontend can
        // fire-and-forget a correctly-scoped POST and return; if the server has
        // not answered by the time the wait expires, that request HAS left the
        // panel and may still be accepted. Reporting the run as "nothing
        // queued" then is a definite negative about something unobserved, and a
        // caller acting on it re-renders a branch that is already running. It is
        // surfaced so graph_run can omit `queued` rather than assert it false.
        const inFlight = guard.state.inFlight;
        const cancel = cancelPendingScopedQueueItem(app, { runTag, queueMark: mark });
        if (cancel.removed > 0) {
          return {
            outcome: "unverified",
            queueMark: mark,
            verified,
            indeterminate: guard.state.indeterminate,
            inFlight,
            volatileInputs: volatileList,
            error: scopeUnverifiedError({ toNodeId, timeoutMs: verifyTimeoutMs, cancelled: true, verified, batch, inFlight }),
          };
        }
        return {
          outcome: "unverified",
          queueMark: mark,
          verified,
          indeterminate: guard.state.indeterminate,
          inFlight,
          volatileInputs: volatileList,
          error: scopeUnverifiedError({ toNodeId, timeoutMs: verifyTimeoutMs, cancelled: false, verified, batch, inFlight }),
        };
      }
      // r6: a dispatch FAILURE with the batch not fully accounted — the
      // frontend CONTINUES its queue loop on generic submission failures, so
      // later posts of this batch can still come. Keep the guard installed as
      // a page-session sentinel so a later CORRUPTED post is still refused
      // (decided HERE so the finally below honors it).
      // SUCCESS IS ALSO A SENTINEL CASE (codex gate r4). Completing the batch
      // used to RESTORE fetchApi — which uninstalled the quota fence, so a LATE
      // same-mark post (a deferred duplicate the processor emits after
      // queuePrompt returned) bypassed the guard entirely. On a build that
      // drops the scope that post goes out UNSCOPED: the full-graph execution
      // this whole module exists to prevent, arriving after we already reported
      // success. Verdict-reached is not the same as no-more-traffic.
      //
      // So a completed scoped run keeps its guard installed for the page
      // session, exactly as the timeout and dispatch-failure paths already do,
      // and on the same by-construction safety argument: the guard only ever
      // acts on THIS run's unique mark, which no future run, user action, or UI
      // will ever carry, so every other post passes through untouched forever.
      //
      // COST, stated rather than hidden: this makes the sentinel the common
      // case rather than the exception, so a long session chains one wrapper
      // per scoped run. Each is a single number comparison before delegating,
      // and chaining is already the documented behaviour for the other terminal
      // paths — a real but small price for the guarantee that no late post of a
      // finished run can run the full graph.
      // EVERY TERMINAL OUTCOME IS A SENTINEL CASE (codex gate r5, P0). Success
      // was not the only path that restored fetchApi and reopened the hole:
      //  - a TERMINAL PARTIAL batch (one post repaired and queued, a later one
      //    refused for drift/mismatch) restored it too;
      //  - so did a graph_changed refusal;
      //  - and so did the LAST attempt's all-refused return, after the loop.
      // In each case a late same-mark scopeless post then bypassed both the
      // quota fence and the repair and reached ComfyUI as a full graph.
      //
      // The only attempt that may safely restore is one that is about to hand
      // over to ANOTHER attempt of this same run (the shape retry), because
      // that attempt immediately installs its own guard on the same mark. So
      // the rule is: restore ONLY when we are continuing. `continuing` is
      // exactly the post-loop `observed === 0 && droppedReason !== "graph_changed"`
      // condition, computed HERE so this finally can honor it.
      //
      // Note this also bounds the chaining: within a run each attempt
      // overwrites the previous attempt's guard, so at most ONE guard per run
      // ever persists.
      const continuing =
        !isLastAttempt &&
        guard.state.failed == null &&
        guard.state.rejected === 0 &&
        guard.state.observed === 0 &&
        guard.state.droppedReason !== "graph_changed";
      // The ONLY place the fence may be torn down. Reached only when
      // app.queuePrompt returned normally AND this attempt is handing over to
      // another attempt of the same run; a throw skips this line entirely and
      // the fence stays up (P0-2).
      retireGuard = continuing;
    } finally {
      // Stand down ONLY by retiring; never by writing apiTarget.fetchApi back
      // to an older value, which would displace a concurrent run's guard (r8).
      if (retireGuard) guard.retire();
      else guard.close();
    }
    // r6: the dispatch itself failed (fetch threw / malformed response) —
    // terminal, truthful, NEVER queued:true.
    // comfyui-mcp#1871 — every terminal return carries `prunedRetry`: when ComfyUI
    // refused the first post over a node on ANOTHER branch and the run only queued
    // because a second post left that branch out, this is the only place the caller
    // can learn it happened. Null on every run that was accepted first time.
    if (guard.state.failed != null) {
      return {
        outcome: "failed",
        queueMark: mark,
        verified: guard.state.observed,
        indeterminate: guard.state.indeterminate,
      volatileInputs: volatileList,
        prunedRetry: guard.state.prunedRetry,
        error: guard.state.failed +
          (!retireGuard
            ? " The scope guard stays installed as a sentinel for the rest of this page session."
            : ""),
      };
    }
    // A genuine SERVER rejection (#358) is terminal and flows through the
    // established rejection channel — the run "dispatched" and ComfyUI said
    // no; graph_run's summarizePromptRejection surfaces it, never queued:true.
    if (guard.state.rejected > 0) {
      return {
        outcome: "dispatched",
        queueMark: mark,
        verified: guard.state.observed,
        repaired: guard.state.repaired,
        scopeAppliedBy: guard.state.repaired > 0 ? "request_body_repair" : "frontend",
        repairedFromKeys: guard.state.repairedFromKeys,
        indeterminate: guard.state.indeterminate,
      volatileInputs: volatileList,
        prunedRetry: guard.state.prunedRetry,
      };
    }
    // The FULL batch verified — genuinely dispatched (r5: never on a partial).
    if (guard.state.observed >= batch) {
      return {
        outcome: "dispatched",
        queueMark: mark,
        verified: guard.state.observed,
        repaired: guard.state.repaired,
        // DISCLOSURE, not a footnote: on this path the scope reached ComfyUI
        // because the panel wrote it into the request body, NOT because the
        // frontend delivered it. The run IS correctly scoped (the guard
        // re-verified the repaired body before it left), but the frontend
        // believed it was queueing a full run — so its queue-time widget hooks
        // ran with isPartialExecution=false. graph_run states this in the
        // result rather than letting the caller infer a native scoped run.
        scopeAppliedBy: guard.state.repaired > 0 ? "request_body_repair" : "frontend",
        repairedFromKeys: guard.state.repairedFromKeys,
        // DISCLOSE a fenced overrun (r3). The requested prompts DID queue, so
        // this is not a failure and must not be reported as one — but an extra
        // identical-identity post was blocked, and the caller should know their
        // frontend produced one rather than be left to wonder at the queue.
        overrunBlocked: guard.state.overrun,
        overrunNote: guard.state.overrunError,
        indeterminate: guard.state.indeterminate,
      volatileInputs: volatileList,
        prunedRetry: guard.state.prunedRetry,
      };
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
      indeterminate: guard.state.indeterminate,
      volatileInputs: volatileList,
      prunedRetry: guard.state.prunedRetry,
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
