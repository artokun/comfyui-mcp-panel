/**
 * comfyui-mcp#1871 — a run-to-node (`panel_run to_node_id`) refused because of a node
 * on a DIFFERENT output branch.
 *
 * The reporter asked for node 43 (a ByteDance output). ComfyUI answered
 *
 *   Node '…' not found. The custom node may not be installed.  (Node ID '#56')
 *
 * naming Topaz nodes 56/57, which are not upstream of 43 and would never have executed.
 * The documented contract of run-to-node is that ONLY the selected output and its
 * upstream dependencies run — so a branch the caller excluded had a veto over a branch
 * they asked for, and the whole feature is unusable on any workflow that carries one
 * unavailable pack anywhere.
 *
 * ## Where the veto comes from (read out of ComfyUI 0.33.2, the reporter's version)
 *
 * `server.py` passes `partial_execution_targets` to exactly one place:
 *
 *     valid = await execution.validate_prompt(prompt_id, prompt, partial_execution_targets)
 *
 * and `execution.validate_prompt` opens with a loop over EVERY entry of the posted
 * prompt:
 *
 *     for x in prompt:
 *         if 'class_type' not in prompt[x]:            -> return (False, missing_node_type…)
 *         class_ = nodes.NODE_CLASS_MAPPINGS.get(prompt[x]['class_type'], None)
 *         if class_ is None:                           -> return (False, missing_node_type…)
 *         if OUTPUT_NODE and (partial_execution_list is None or x in partial_execution_list):
 *             outputs.add(x)
 *
 * The partial list is consulted only on that last line — three lines AFTER the two
 * early returns. So the scope narrows which outputs become execution roots, and narrows
 * nothing at all about which nodes must resolve to an installed class. Every other use
 * of the prompt downstream (`outputs_to_execute`, the executor's own walk) is already
 * scoped correctly; this one pre-loop is the entire defect.
 *
 * That is upstream behaviour and this panel cannot change it. What it CAN do is stop
 * posting nodes the caller excluded: a prompt pruned to the backward closure of the
 * requested targets executes EXACTLY the same nodes (the roots are the targets, and the
 * executor reaches only their dependencies), while the pre-loop no longer sees the other
 * branch at all.
 *
 * ## Why this is a RETRY and not the default
 *
 * Pruning every scoped run would be simpler, and it was the first design. It has a real
 * cost, measured in the same file:
 *
 *     for cache in self.caches.all:
 *         await cache.set_prompt(dynamic_prompt, prompt.keys(), is_changed_cache)
 *         cache.clean_unused()
 *
 * The default (classic `HierarchicalCache`) drops every cached output whose key is not
 * in the prompt it was just handed. A prompt pruned to one branch therefore EVICTS the
 * other branch's cached results, so a scoped preview would quietly make the user's next
 * full run recompute a branch it had already rendered — on the workflows where run-to-node
 * is most useful, that is minutes of GPU time nobody asked to spend.
 *
 * So the prune is spent only where the alternative is a total refusal: the run posts the
 * prompt the frontend built, exactly as before, and only a rejection that names an
 * out-of-scope node buys a second, pruned post. A run that ComfyUI accepts is byte-for-byte
 * unchanged by this module.
 *
 * ## What licenses a second post
 *
 * Re-posting is only safe if the first post queued NOTHING, and that is established from
 * structured fields, never from message text (a message is a description, not a receipt):
 *
 *   - a non-2xx status, and
 *   - a body carrying a top-level `error` object, and
 *   - NO `prompt_id` in that body.
 *
 * `server.py` mints a prompt id and calls `prompt_queue.put(...)` only inside the
 * `if valid[0]:` branch; the rejection branch returns `{"error": …, "node_errors": …}`
 * with status 400 having queued nothing. A body that carries an id is an accepted prompt
 * and is never retried here.
 *
 * The rejection must ALSO name a node — `error.extra_info.node_id`, the field ComfyUI
 * populates for exactly the two early returns above — and that node must be OUTSIDE the
 * closure we compute ourselves from the posted body. Both halves matter: the id is what
 * makes the decision structured, and the closure check is what makes it relevant. A
 * missing node INSIDE the requested branch is not fixable by pruning, so it is reported
 * as-is rather than retried; `prompt_outputs_failed_validation` and `prompt_no_outputs`
 * carry `extra_info: {}` and so never reach a retry either.
 */

/** True when `key` is an own key of the prompt map. */
const has = (map, key) => Object.prototype.hasOwnProperty.call(map, key);

/**
 * The prompt node id one input value depends on, or null.
 *
 * The predicate is ComfyUI's, not an approximation of it. Both consumers of a posted
 * prompt read a dependency from the input value ITSELF — never from anything nested
 * inside it:
 *
 *   comfy_execution/graph_utils.py  is_link(obj): a list, length 2, obj[0] a str,
 *                                   obj[1] an int/float. Used by the executor's
 *                                   get_input_data and by the cache-key walk.
 *   execution.py validate_inputs    `if isinstance(val, list)` -> length 2 -> `o_id =
 *                                   val[0]` -> `prompt[o_id]['class_type']`, an
 *                                   UNGUARDED lookup that raises when the id is absent.
 *
 * The second is the broader of the two and is the one the closure must satisfy: a node
 * referenced by a top-level two-element list has to survive the prune, or the retry dies
 * as an exception_during_validation. Hence `String(value[0])` plus a membership test
 * rather than is_link's stricter typing — that keeps a superset of what the executor
 * walks, which is the safe side. The length-2 requirement is NOT loosened for the same
 * reason in reverse: validate_inputs never looks up a longer list, so treating one as a
 * dependency would be an over-keep (see below).
 *
 * NOTHING is scanned recursively (codex gate r1, P1). A widget value can be an arbitrary
 * object, and `{config:{coordinates:["56", 0]}}` on a node in the branch would have
 * pulled node 56 into the closure. That is not a harmless over-keep:
 * `prunedRetryForRejection` declines to retry when the node ComfyUI named is INSIDE the
 * closure, so an unrelated coordinate pair would silently reinstate the very refusal
 * this module exists to remove. Neither ComfyUI consumer looks inside a value, so
 * neither does this.
 */
function linkedId(value, promptMap) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const raw = value[0];
  if (raw == null || typeof raw === "object") return null;
  const key = String(raw);
  return has(promptMap, key) ? key : null;
}

/**
 * The BACKWARD CLOSURE of `rootIds` in a posted prompt: the roots plus every node
 * reachable by walking input links upstream. Returns null when the prompt is not a usable
 * map or when ANY root is absent from it — an unresolvable root means the closure would be
 * a guess, and the caller must then leave the body alone.
 *
 * Cycle-safe (a visited set) and order-independent. Ids are compared as STRINGS: a
 * subgraph-nested target is a colon path ("10:15:359"), which is a prompt key like any
 * other.
 */
export function upstreamClosure(promptMap, rootIds) {
  if (!promptMap || typeof promptMap !== "object" || Array.isArray(promptMap)) return null;
  const roots = (Array.isArray(rootIds) ? rootIds : []).map(String);
  if (!roots.length) return null;
  for (const r of roots) if (!has(promptMap, r)) return null;
  const keep = new Set();
  const stack = [...roots];
  while (stack.length) {
    const id = stack.pop();
    if (keep.has(id)) continue;
    keep.add(id);
    const entry = promptMap[id];
    const inputs = entry && typeof entry === "object" ? entry.inputs : null;
    if (!inputs || typeof inputs !== "object") continue;
    try {
      for (const value of Object.values(inputs)) {
        const dep = linkedId(value, promptMap);
        if (dep != null && !keep.has(dep)) stack.push(dep);
      }
    } catch {
      // A hostile/exotic inputs object (a throwing getter) must not take down the run.
      // An input that could not be read contributes no dependency, and the verification
      // in prunedScopedPromptBody is what stops a half-read closure from being posted.
      continue;
    }
  }
  return keep;
}

/**
 * The node id a /prompt REJECTION names, when it names one in a structured field.
 *
 * `error.extra_info.node_id` is populated by ComfyUI for both early returns of
 * `validate_prompt`'s pre-loop (no class_type; class not in NODE_CLASS_MAPPINGS) — the
 * only rejections a prune can fix. Read as a string; `details` ("Node ID '#56'") and
 * `message` are prose and are never parsed.
 *
 * Deliberately NOT gated on `error.type`. The id is what makes this decision structured,
 * and the caller additionally requires that the named node lies outside the requested
 * branch — a rejection that names a node the caller excluded is one the caller's own
 * request already answers, whatever the server chose to call it. Every OTHER rejection
 * shape ComfyUI produces (`prompt_outputs_failed_validation`, `prompt_no_outputs`,
 * `invalid_prompt_id`) carries `extra_info: {}` and stops here.
 */
export function rejectionNodeId(rejectionBody) {
  const err = rejectionBody?.error;
  if (!err || typeof err !== "object" || Array.isArray(err)) return null;
  const extra = err.extra_info;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) return null;
  const id = extra.node_id;
  if (typeof id === "string" && id.trim() !== "") return id.trim();
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}

/**
 * True when a parsed /prompt response body proves NOTHING was queued: a top-level
 * `error` object and no `prompt_id`. Status is checked by the caller.
 *
 * The absence of an id is the load-bearing half. ComfyUI's partial-validation path
 * (#944) returns an id ALONGSIDE `node_errors` for a prompt it accepted and is already
 * running; re-posting that would double-render it. An id present ⇒ never retried.
 */
export function rejectionQueuedNothing(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.prompt_id != null && String(body.prompt_id).trim() !== "") return false;
  const err = body.error;
  return !!err && typeof err === "object" && !Array.isArray(err) && Object.keys(err).length > 0;
}

/**
 * The same POST /prompt body with every node OUTSIDE the backward closure of
 * `expectedExecIds` removed, or null when that cannot be done safely.
 *
 * Null (leave the body exactly as it was) for: an unreadable body, a prompt that is not a
 * map, a target that is not a key of the prompt, and — importantly — a closure that
 * already covers the whole prompt, because then there is nothing to prune and a second
 * identical post would be pointless traffic.
 *
 * Everything except `prompt` is carried over verbatim: `partial_execution_targets` (so
 * the scope the guard verified still travels), the queue-position `number` that
 * identifies this run, `client_id`, and `extra_data` — which holds the FULL workflow for
 * `extra_pnginfo`, so a saved image still embeds the whole graph the user was looking at,
 * not the pruned one.
 *
 * The prune verifies ITSELF before returning, the way repairScopeInBody does: the
 * rewritten text is re-parsed and the result must carry exactly the closure's node ids and
 * the unchanged targets. Anything short of that returns null and the caller forwards the
 * original — a rewrite that cannot be confirmed is not a rewrite.
 *
 * @returns {{text:string, removed:string[], kept:number}|null}
 */
export function prunedScopedPromptBody(bodyText, expectedExecIds) {
  const expected = (Array.isArray(expectedExecIds) ? expectedExecIds : []).map(String);
  if (!expected.length) return null;
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const promptMap = body.prompt;
  const keep = upstreamClosure(promptMap, expected);
  if (!keep || !keep.size) return null;
  const allIds = Object.keys(promptMap);
  const removed = allIds.filter((id) => !keep.has(id));
  if (!removed.length) return null; // nothing to prune — never re-post an identical body
  const prunedPrompt = {};
  for (const id of allIds) if (keep.has(id)) prunedPrompt[id] = promptMap[id];
  let text;
  try {
    text = JSON.stringify({ ...body, prompt: prunedPrompt });
  } catch {
    return null;
  }
  // Re-read what was produced. The check is on the PARSED result, not on the object we
  // built: JSON.stringify is where a value can vanish, and this is the last point at
  // which that can be caught.
  let check;
  try {
    check = JSON.parse(text);
  } catch {
    return null;
  }
  const outMap = check?.prompt;
  if (!outMap || typeof outMap !== "object" || Array.isArray(outMap)) return null;
  const outIds = Object.keys(outMap);
  if (outIds.length !== keep.size) return null;
  for (const id of outIds) if (!keep.has(id)) return null;
  for (const id of expected) if (!has(outMap, id)) return null;
  const targets = check.partial_execution_targets;
  if (!Array.isArray(targets) || targets.length !== expected.length) return null;
  const got = targets.map(String);
  if (!expected.every((id) => got.includes(id))) return null;
  return { text, removed, kept: outIds.length };
}

/**
 * The whole decision, in one place: given the body we posted, the response ComfyUI
 * returned, and the scope the caller asked for — is there a pruned body worth posting
 * once more?
 *
 * All four conditions must hold, and each is checked against a structured field:
 *   1. the response is non-2xx (it is a rejection at all);
 *   2. its body proves nothing was queued (a top-level `error`, no `prompt_id`);
 *   3. it names a node in `error.extra_info.node_id`;
 *   4. that node is OUTSIDE the backward closure of the requested targets — i.e. it is a
 *      node the caller's own request already excluded from execution.
 *
 * Returns null on anything else, including every kind of read failure: this sits on the
 * path of a run that is already failing, and it must be able to add nothing rather than
 * add a new failure mode.
 *
 * @returns {{text:string, removed:string[], namedNode:string}|null}
 */
export async function prunedRetryForRejection(res, bodyText, expectedExecIds) {
  try {
    const status = Number(res?.status);
    if (!Number.isFinite(status) || (status >= 200 && status < 300)) return null;
    if (typeof res?.clone !== "function") return null;
    const parsed = await res.clone().json();
    if (!rejectionQueuedNothing(parsed)) return null;
    const namedNode = rejectionNodeId(parsed);
    if (namedNode == null) return null;
    const expected = (Array.isArray(expectedExecIds) ? expectedExecIds : []).map(String);
    let requestBody;
    try {
      requestBody = JSON.parse(bodyText);
    } catch {
      return null;
    }
    const keep = upstreamClosure(requestBody?.prompt, expected);
    if (!keep) return null;
    // The named node must be one the caller EXCLUDED. A node inside the requested branch
    // is a real blocker for the run they asked for, and hiding it behind a second post
    // that fails the same way would replace a clear answer with a slower one.
    if (keep.has(namedNode)) return null;
    if (!has(requestBody.prompt, namedNode)) return null; // named a node we never sent
    const pruned = prunedScopedPromptBody(bodyText, expected);
    if (!pruned) return null;
    return { text: pruned.text, removed: pruned.removed, namedNode };
  } catch {
    return null;
  }
}

/**
 * The disclosure sentence for a run that only queued because unrelated nodes were left
 * out of the second post. Stated as what was OBSERVED — ComfyUI refused, naming a node
 * outside the branch; the panel re-posted without the excluded nodes — because the panel
 * cannot see why that node is unavailable on this server, only that it refused.
 */
export function prunedRetryNote({ toNodeId, namedNode, removed }) {
  const list = (Array.isArray(removed) ? removed : []).map(String);
  const shown = list.slice(0, 12);
  const more = list.length > shown.length ? `, and ${list.length - shown.length} more` : "";
  return (
    `ComfyUI first REFUSED this run over node ${namedNode}, which is not upstream of ` +
    `node ${toNodeId} and would not have executed: its prompt validation checks that every ` +
    `node in the posted prompt resolves to an installed class BEFORE it narrows execution ` +
    `to the requested branch (comfyui-mcp#1871). Nothing was queued by that refusal. The ` +
    `panel then re-posted the SAME run with the ${list.length} node(s) outside the requested ` +
    `branch omitted — ${shown.join(", ")}${more} — and that is the prompt ComfyUI accepted. ` +
    `The first post is NOT pre-pruned, on purpose: ComfyUI drops every cached output whose `
      + `node is absent from the prompt it was handed, so pruning every scoped run would evict `
      + `the other branch's cached results and make your next FULL run recompute a branch it `
      + `had already rendered. The prune is spent only where the alternative is this refusal. ` +
    `The nodes that executed are exactly node ${toNodeId} and its upstream dependencies, ` +
    `which is what run-to-node asks for; the omitted nodes are untouched on your canvas and ` +
    `a FULL run will still fail on them until the pack behind node ${namedNode} is installed.`
  );
}
