import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  activeWorkflowFenceApplies,
  commandIsCanvasIndependent,
  commandIsCanvasTargetless,
  commandWorkflowMismatch,
  commandTargetsActiveWorkflow,
  hasEmbeddedUuidSuccessionEvidence,
  selectorSearchIncludesListed,
  selectorTargetsNonActiveWorkflow,
  isThreadInScope,
  isNewWorkflowLoad,
  normalizedWorkflowPath,
  rawWorkflowObject,
  resolveUnsavedInstanceUuid,
  sameWorkflowObject,
  shouldCarryIdentityAcrossSaveSwap,
  shouldForkEmbeddedUuidForLiveOwner,
  shouldForkEmbeddedWorkflowUuid,
  shouldForkInPlaceReload,
  workflowAliasForPath
} from '../../web/js/lib/workflow-chat-identity.js'

// #570 P0c — the exemption is decided by the RESOLVED TARGET, not raw path presence.
test('#570 selectorTargetsNonActiveWorkflow: exempt ONLY when the selector resolves to a NON-active open workflow', () => {
  const active = { path: 'workflows/foo.json' }
  const other = { path: 'workflows/bar.json' }
  // Resolves to a DIFFERENT open workflow → non-active → exempt (true).
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: other, active }), true)
  // Resolves to the ACTIVE workflow (incl. after an in-place replacement at the same path: the
  // active object is what the selector lands on) → NOT exempt (false) → will be fenced.
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: active, active }), false)
  // Resolves to NOTHING → can't prove non-active → NOT exempt (false) → fenced (fail-closed).
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: null, active }), false)
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: undefined, active }), false)
})

test('#570 P1: the fence/executor selector scope includes CLOSED-but-listed workflows for rename, open-only for close', () => {
  // The shared resolver keys the search collection on this, so the fence resolves over EXACTLY
  // what the executor searches — rename over [...openWorkflows, ...workflows], close over open only.
  assert.equal(selectorSearchIncludesListed('workflow_rename'), true)
  assert.equal(selectorSearchIncludesListed('workflow_close'), false)
})

test('#570 P1: a CLOSED-but-listed rename target (resolved via the executor collection) is exempt (not over-fenced)', () => {
  // workflow_rename resolves over [...openWorkflows, ...workflows], so a target present only in
  // `workflows` (closed but listed) DOES resolve to a genuine non-active workflow — the executor
  // would rename it — so the fence must exempt it. Models the resolved record the shared helper
  // returns for that selector (a real record distinct from the active object).
  const active = { path: 'workflows/foo.json' } // active canvas
  const closedButListed = { path: 'workflows/archived.json' } // only in s.workflows, not openWorkflows
  assert.equal(selectorTargetsNonActiveWorkflow({ resolved: closedButListed, active }), true)
})

// #570 P0c — the panel fence must cover ALL four active-workflow mutators, not just graph_*,
// so a panel advertising enforces_workflow_stamp honestly fences everything the server admits.
test('#570 fence applies to every graph_* op and all four workflow mutators (active-workflow ops)', () => {
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_add_node' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_get_state' }), true) // reads harmlessly fenced too
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_save' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_save_as' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_rename' }), true) // path-less ⇒ active
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_close' }), true)
  // A rename/close whose selector RESOLVED to the active workflow is fenced (the P0: an explicit
  // path that, after in-place replacement, names the active workflow).
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_close', targetsNonActive: false }), true)
})

test('#570 fence ALSO applies to PINNED commands (the pin guard authorizes by path, not uuid)', () => {
  // A pinned command (workflow_path present) is NOT exempt: after an in-place replacement at the
  // SAME saved path the pin still matches but the uuid does not, and only the uuid fence catches
  // it. activeWorkflowFenceApplies no longer takes a pin — the fence fires for pinned ops too.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_add_node' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_save' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_set_widget' }), true)
})

test('#570 fence does NOT apply to navigation / resolved-non-active workflow ops', () => {
  // Navigation / creation.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_open' }), false)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_new' }), false)
  // Selector RESOLVED to a genuinely non-active open workflow → deterministic target → runs.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_close', targetsNonActive: true }), false)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_rename', targetsNonActive: true }), false)
})

// #932/#607/#688 — the wedge was PERMANENT because the repair probe was fenced.
// The orchestrator refreshes a stale stamp exactly one way: rebindWorkflowFence()
// asks the panel for `workflow_list` and re-derives the fence from the record it
// reports active. Fencing that probe made the repair require the fence to be
// already-correct, so a stale stamp refused the only command that could clear it.
test('#932 workflow_list — the recovery probe — is NOT fenced', () => {
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_list' }), false)
})

test('#932 a STALE stamp must not refuse the probe that would refresh it', () => {
  // The exact wedge: the session is fenced to a workflow the user has navigated
  // away from, so every stamp it sends names the wrong canvas.
  const stale = { commandUuid: 'uuid-the-session-still-believes', activeUuid: 'uuid-actually-on-screen' }
  // Graph work is correctly refused — that is the fence doing its job, and this
  // assertion is what keeps the exemption from being read as "the fence relaxed".
  assert.equal(commandTargetsActiveWorkflow({ cmd: 'graph_add_node', ...stale }), false)
  assert.equal(commandTargetsActiveWorkflow({ cmd: 'graph_get_state', ...stale }), false)
  // …but the probe that learns the right answer must get through, or nothing can.
  assert.equal(commandTargetsActiveWorkflow({ cmd: 'workflow_list', ...stale }), true)
})

test('#932 the probe survives an ABSENT stamp too, which is how #718 wedges', () => {
  // #718's half: an unstamped frame is refused HARDER than a mismatched one
  // (an advertised fence must not fail open). That made the unstamped case the
  // unrecoverable one, so the probe has to clear it as well — an exemption that
  // only covered a mismatched uuid would leave exactly that wedge in place.
  for (const commandUuid of [undefined, null, '', '   ']) {
    assert.equal(commandWorkflowMismatch({ commandUuid, activeUuid: 'live' }), true, 'still a mismatch')
    assert.equal(
      commandTargetsActiveWorkflow({ cmd: 'workflow_list', commandUuid, activeUuid: 'live' }),
      true,
      'but the probe still runs',
    )
  }
})

test('#932 an UNRESOLVABLE active uuid still lets the probe through', () => {
  // The panel fails closed when it cannot resolve its own active uuid (#186), which
  // is precisely the moment the caller most needs the listing to find out what IS
  // active. Fencing here would wedge the recovery at its most useful instant.
  for (const activeUuid of [undefined, null, '']) {
    assert.equal(commandTargetsActiveWorkflow({ cmd: 'workflow_list', commandUuid: 'x', activeUuid }), true)
    assert.equal(commandTargetsActiveWorkflow({ cmd: 'graph_add_node', commandUuid: 'x', activeUuid }), false)
  }
})

test('#932 the shared predicate covers BOTH guards, and is strictly wider', () => {
  // Everything canvas-independent stays targetless…
  for (const cmd of ['nodes_search', 'nodes_list', 'nodes_install', 'nodes_queue_status',
                     'graph_update_node', 'comfy_reboot', 'free_vram']) {
    assert.equal(commandIsCanvasTargetless(cmd), true, `${cmd} targets no canvas`)
  }
  // …plus exactly one more.
  assert.equal(commandIsCanvasTargetless('workflow_list'), true)
  assert.equal(commandIsCanvasIndependent('workflow_list'), false, 'wider, not the same set')
  // And nothing else leaks in — a canvas write or a content read must still be
  // refusable by the pin guard, which is the guard this predicate now also feeds.
  for (const cmd of ['graph_add_node', 'graph_outline', 'graph_get_state', 'workflow_save',
                     'workflow_close', 'workflow_open', 'refresh_nodes', 'some_future_command']) {
    assert.equal(commandIsCanvasTargetless(cmd), false, `${cmd} still answers to target guards`)
  }
  assert.equal(commandIsCanvasTargetless(undefined), false)
})

test('#932 workflow_list is exempt WITHOUT being called canvas-independent', () => {
  // It does observe the canvas — it reports which tab is active — so folding it into
  // CANVAS_INDEPENDENT_COMMANDS ("never reads or mutates a canvas") would make that
  // set's own contract false. The two ideas stay distinct: not canvas-independent,
  // but not canvas-TARGETING either, which is what the fence actually guards.
  assert.equal(commandIsCanvasIndependent('workflow_list'), false)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_list' }), false)
})

test('#932 the exemption is workflow_list ALONE — sibling reads stay fenced', () => {
  // Guards against the fix being widened into "reads are safe". These all return
  // graph CONTENT, so a stale-stamped caller would read the wrong canvas and
  // believe it read the right one.
  for (const cmd of ['graph_get_state', 'graph_outline', 'graph_query', 'graph_view_selected']) {
    assert.equal(activeWorkflowFenceApplies({ cmd }), true, `${cmd} returns canvas content — stays fenced`)
  }
  // Nor does it leak to look-alike command names.
  for (const cmd of ['workflow_list_nodes', 'workflow_lis', 'workflow_listx', 'WORKFLOW_LIST']) {
    assert.equal(activeWorkflowFenceApplies({ cmd }), true, `${cmd} is not the probe`)
  }
})

// #602 — a command whose execution AND reply never reference the active canvas
// (Manager registry/server ops, ComfyUI server controls) must not be fenced to the
// active workflow's uuid: a tab switch after issue manufactured a false refusal for
// panel_search_nodes before it ever reached the registry search.
test('#602 fence does NOT apply to canvas-independent Manager/server commands', () => {
  for (const cmd of [
    'nodes_search',
    'nodes_list',
    'nodes_install',
    'nodes_queue_status',
    'graph_update_node', // a Manager PACK update misnamed with a graph_ prefix
    'comfy_reboot',
    'free_vram',
  ]) {
    assert.equal(activeWorkflowFenceApplies({ cmd }), false, `${cmd} never touches a canvas`)
    assert.equal(commandIsCanvasIndependent(cmd), true, `${cmd} is canvas-independent`)
  }
  // codex gate round 5 — refresh_nodes is NOT canvas-independent: its executor
  // re-applies fresh defs to LIVE node objects and renames UNKNOWN widget
  // placeholders on the active canvas, so a stale-stamped call must stay fenced.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'refresh_nodes' }), true)
  assert.equal(commandIsCanvasIndependent('refresh_nodes'), false)
})

test('#602 the exemption stays EXPLICIT — canvas ops, workflow mutators, and unknown commands stay fenced (fail closed)', () => {
  // Canvas mutators and reads.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_add_node' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_get_state' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_run' }), true)
  // Active-workflow mutators.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_save' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_close' }), true)
  // workflow_list observes the canvas (it reports which tab is active), so it is
  // genuinely NOT canvas-independent and that half of this test still holds. What
  // changed in #932 is the other half: being canvas-OBSERVING does not make it
  // canvas-TARGETING, and it is the sole probe the fence repair runs through, so it
  // is exempt from the fence while staying out of CANVAS_INDEPENDENT_COMMANDS.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'workflow_list' }), false)
  assert.equal(commandIsCanvasIndependent('workflow_list'), false)
  // An unknown/new command fails closed: coverage is lost only by an explicit opt-out.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_future_command' }), true)
  assert.equal(commandIsCanvasIndependent('graph_future_command'), false)
})

test('#602 wiring: dispatch skips the graph-binding assert for canvas-independent graph_ commands, and the fence message is clean UTF-8', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(HERE, '../../web/js/comfyui-mcp-panel.js'), 'utf8')
  // graph_update_node is canvas-independent but named graph_*: the dispatch-time
  // binding assert (which requires a canvas binding proof) must not gate it.
  assert.match(
    src,
    /msg\.cmd\.startsWith\("graph_"\)\s*&&\s*!commandIsCanvasIndependent\(msg\.cmd\)/,
    'the dispatch binding assert must skip commands that never touch a canvas',
  )
  // Same for the PIN guard (codex gate round 2): a pin exists to stop a CANVAS
  // write landing on the wrong workflow — canvas-independent commands must not
  // be refused by it either. #932 widened this to commandIsCanvasTargetless so the
  // recovery probe clears BOTH guards: exempting it from the uuid fence alone would
  // have left a pinned session wedged in exactly the same way, one guard over, with
  // the pin refusal advertising the very re-target that runs through workflow_list.
  assert.match(
    src,
    /pinnedPath\.trim\(\)\s*&&\s*!commandIsCanvasTargetless\(msg\.cmd\)/,
    'the pinned-target guard must skip commands that target no canvas',
  )
  // …and it must be the WIDER predicate, not the narrow one, at that call site.
  assert.ok(
    !/pinnedPath\.trim\(\)\s*&&\s*!commandIsCanvasIndependent\(msg\.cmd\)/.test(src),
    'the pin guard must not fall back to the narrow canvas-independent test',
  )
  // The workflow-instance-mismatch refusal renders for real users; it once shipped
  // with a mojibake em dash ("â€”"). Pin the clean form. #750 rewrote the sentence
  // that used to carry the dash (it asserted a cause the panel never observed), so
  // the guard now pins the em dash in its replacement.
  assert.ok(
    src.includes('That is the comparison, not the cause — the panel observed only that the two'),
    'fence message keeps its em dash',
  )
  assert.ok(!src.includes('â€'), 'no mojibake anywhere in the panel source')
  // …and the refusal is built in exactly ONE place now, so the two dispatch sites
  // cannot drift apart the way they did while each carried its own copy.
  assert.equal(
    (src.match(/workflow instance mismatch: /g) || []).length,
    1,
    'the refusal text must have a single spelling',
  )
})

// #750 — the refusal must report the COMPARISON it made, not a cause it did not
// observe. The old text committed to "the workflow was switched or replaced after it
// was issued"; in the report behind #750 no tab was connected at all, and in the wedge
// behind artokun/comfyui-mcp#932 nothing had been switched — the fence simply could
// never be rebound. Both diagnoses were sent down the wrong path by this sentence.
function loadMismatchMessage() {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(HERE, '../../web/js/comfyui-mcp-panel.js'), 'utf8')
  const start = src.indexOf('function workflowInstanceMismatchMessage(')
  assert.notEqual(start, -1, 'the shared refusal builder must exist in the shipped source')
  const end = src.indexOf('\n}', start)
  assert.notEqual(end, -1)
  const body = src.slice(start, end + 2)
  return new Function(`${body}\nreturn workflowInstanceMismatchMessage;`)()
}

test('#750 the refusal states the two identities it compared', () => {
  const msg = loadMismatchMessage()({ commandUuid: 'uuid-issued-for', activeUuid: 'uuid-on-screen' })
  assert.match(msg, /uuid-issued-for/, 'names the instance the command was issued for')
  assert.match(msg, /uuid-on-screen/, 'and what the canvas actually reports')
  assert.match(msg, /Nothing was applied/, 'and that it did not partially run')
})

test('#750 it does NOT assert a cause it never observed', () => {
  const msg = loadMismatchMessage()({ commandUuid: 'a', activeUuid: 'b' })
  // The old sentence, as a bare claim, must be gone.
  assert.doesNotMatch(
    msg,
    /the workflow was switched or replaced after it was issued\./,
    'the single-cause assertion must not return',
  )
  // The switch is still OFFERED as one possibility among several — removing it
  // entirely would be the opposite error, hiding the most common cause.
  assert.match(msg, /can mean the workflow was switched or replaced/)
  assert.match(msg, /never established or could not\s+be refreshed/, 'the #932 cause is listed')
  assert.match(msg, /identity could not be read/, 'and the unreadable case')
  assert.match(msg, /comparison, not the cause/, 'and it says which of the two this is')
})

test('#750 an UNSTAMPED command says so, rather than claiming a different workflow', () => {
  // #718 refuses unstamped commands too. "your command carried no stamp" and "your
  // stamp names another workflow" need different fixes; the old text described only
  // the second, for both.
  for (const commandUuid of [undefined, null, '', '   ']) {
    const msg = loadMismatchMessage()({ commandUuid, activeUuid: 'uuid-on-screen' })
    assert.match(msg, /carries no workflow-instance stamp/)
    assert.doesNotMatch(msg, /issued for workflow instance/)
  }
})

test('#750 an UNRESOLVABLE active identity is reported as unresolvable, not as a value', () => {
  for (const activeUuid of [undefined, null, '']) {
    const msg = loadMismatchMessage()({ commandUuid: 'uuid-issued-for', activeUuid })
    assert.match(msg, /reports no resolvable identity/)
    assert.doesNotMatch(msg, /reports undefined|reports null|reports \./)
  }
})

test('#750 the remedy covers the disconnected case the old text stranded', () => {
  // The #750 reporter had NO tab connected; the advertised remedies cannot help
  // there, and it took six tool calls to find that out.
  const msg = loadMismatchMessage()({ commandUuid: 'a', activeUuid: 'b' })
  assert.match(msg, /panel_set_workflow_target/)
  assert.match(msg, /panel_open_workflow/)
  assert.match(msg, /If NO panel tab is\s+connected, neither will help/)
  assert.match(msg, /panel_graph_outline reports connectivity/)
})

test('#570 pinned command after in-place replacement at the same path: uuid mismatch ⇒ REFUSED', () => {
  // A pinned graph write stamped for A (uuid-A) whose workflow_path still matches the active
  // canvas — but the workflow at that path was replaced in place by B (uuid-B). The fence APPLIES
  // (pinned no longer exempt) and the uuid mismatch refuses it, protecting B.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'graph_add_node' }), true)
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: 'uuid-B' }), true)
})

// #570 — WORKFLOW-INSTANCE FENCE. A command stamped for workflow A must not execute against
// a canvas the user has since switched to (B). The generation-bound-command leak: the server
// cannot retract a delivered frame, so the panel declines to apply a stale one.
test('#570 fence: stamped uuid matches the active workflow → execute', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: 'uuid-A' }), false)
})

test('#570 fence: stamped uuid differs from active (post-switch) → REJECT (no cross-apply)', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: 'uuid-B' }), true)
})

test('#570 fence: stamped uuid but active is UNRESOLVABLE → REJECT (fail closed, #186)', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: undefined }), true)
  assert.equal(commandWorkflowMismatch({ commandUuid: 'uuid-A', activeUuid: null }), true)
})

test('#718 fence: missing or blank stamp is a protected-command mismatch (fail closed)', () => {
  assert.equal(commandWorkflowMismatch({ commandUuid: undefined, activeUuid: 'uuid-B' }), true)
  assert.equal(commandWorkflowMismatch({ commandUuid: '', activeUuid: 'uuid-B' }), true)
  assert.equal(commandWorkflowMismatch({ commandUuid: '   ', activeUuid: 'uuid-B' }), true)
  assert.equal(commandWorkflowMismatch({}), true)
})

// #570 — FAIL-CLOSED durability carrier. The embedded graph.extra uuid is only trustworthy
// when the creation-boundary wrapper (the sanitizer that re-mints graph.extra on every copy)
// is provably installed. If it is NOT, a pasted/imported unsaved graph could still carry the
// SOURCE uuid, so it must be ignored and a fresh per-instance uuid minted.
test('#570 unsaved uuid: live-object WeakMap value always wins (copy-safe)', () => {
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: 'live-A', embeddedId: 'copied-src', forkActive: true, mint: () => 'FRESH' }),
    'live-A'
  )
  // Even with the sanitizer off, the live object is authoritative.
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: 'live-A', embeddedId: 'copied-src', forkActive: false, mint: () => 'FRESH' }),
    'live-A'
  )
})

test('#570 unsaved uuid: embedded uuid trusted ONLY when the fork wrapper is installed (durable reload)', () => {
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: undefined, embeddedId: 'wf-uuid', forkActive: true, mint: () => 'FRESH' }),
    'wf-uuid'
  )
})

test('#570 unsaved uuid: fork wrapper NOT installed → embedded uuid ignored, mint fresh (no cross-resume)', () => {
  // The critical regression: loadGraphData unavailable / wrapping threw → a copied graph must
  // NOT adopt its source graph.extra uuid.
  assert.equal(
    resolveUnsavedInstanceUuid({ objectUuid: undefined, embeddedId: 'copied-src-uuid', forkActive: false, mint: () => 'FRESH' }),
    'FRESH'
  )
})

test('#570 unsaved uuid: no live object and no embedded → mint fresh regardless of fork state', () => {
  assert.equal(resolveUnsavedInstanceUuid({ forkActive: true, mint: () => 'FRESH' }), 'FRESH')
  assert.equal(resolveUnsavedInstanceUuid({ forkActive: false, mint: () => 'FRESH' }), 'FRESH')
})

// #570 P0b — an in-place load into an existing object must FORK when the content identity
// changed; a stale object-cache must never override the newly-loaded graph identity.
test('#570 P0b in-place replace (cached uuid, DIFFERENT incoming) → fork', () => {
  assert.equal(shouldForkInPlaceReload({ cachedUuid: 'uuid-A', incomingUuid: 'uuid-B' }), true)
  // Incoming has no embedded uuid at all → still fork (can't prove same content).
  assert.equal(shouldForkInPlaceReload({ cachedUuid: 'uuid-A', incomingUuid: undefined }), true)
})

test('#570 P0b same content reloaded/undone (cached === incoming) → keep', () => {
  assert.equal(shouldForkInPlaceReload({ cachedUuid: 'uuid-A', incomingUuid: 'uuid-A' }), false)
})

test('#570 P0b a fresh object (no cache) is NOT an in-place replace here → false', () => {
  // A brand-new object (reload-restore/copy) has no cache; creation/embedded handling covers it.
  assert.equal(shouldForkInPlaceReload({ cachedUuid: undefined, incomingUuid: 'uuid-A' }), false)
  assert.equal(shouldForkInPlaceReload({}), false)
})

// #557 — a save replaces the active ComfyWorkflow object. The successor parses the
// same embedded uuid from the just-saved file while the REPLACED object is still the
// registered owner: fork ONLY while that owner is still a live OPEN tab.
test('#557 fork away from an owned embedded uuid ONLY while the owner is still open', () => {
  const owner = { path: 'workflows/x.json' }
  const successor = { path: 'workflows/x.json' }
  // Owner replaced (no longer an open workflow) AND succession proven →
  // successor INHERITS, no fork — minting fresh here desynced the object from
  // the root tag and blocked every graph tool until a frontend reload.
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: 'uuid-A', embeddedOwner: owner, identityObject: successor,
    ownerIsOpenWorkflow: false, successionProven: true
  }), false)
  // Owner still open alongside → a genuine co-open copy → fork (#570).
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: 'uuid-A', embeddedOwner: owner, identityObject: successor, ownerIsOpenWorkflow: true
  }), true)
  // The owner IS this object (rename/Save-As continuity) → never fork.
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: 'uuid-A', embeddedOwner: owner, identityObject: owner, ownerIsOpenWorkflow: true
  }), false)
  // Missing identity/owner data is inconclusive → never fork.
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: null, embeddedOwner: owner, identityObject: successor, ownerIsOpenWorkflow: true
  }), false)
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: 'uuid-A', embeddedOwner: null, identityObject: successor, ownerIsOpenWorkflow: true
  }), false)
  assert.equal(shouldForkEmbeddedUuidForLiveOwner(), false)
})

// #558 r9 P0 — a CLOSED owner is not succession: without positive evidence this
// object continues the owner's FILE, a different-path copy must FORK, never
// inherit (inheriting re-keys the uuid's owner record to the copy and lets
// stale uuid-scoped commands for the old workflow pass the fence against it).
test('#557 r9: closed-owner inheritance requires positive succession evidence', () => {
  const owner = { isPersisted: true, path: 'workflows/x.json' }
  const copy = { isPersisted: true, path: 'workflows/y.json' }
  // Closed owner + NO succession evidence (default fails safe) → FORK.
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: 'uuid-A', embeddedOwner: owner, identityObject: copy, ownerIsOpenWorkflow: false
  }), true)
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: 'uuid-A', embeddedOwner: owner, identityObject: copy,
    ownerIsOpenWorkflow: false, successionProven: false
  }), true)
  // Closed owner + proven succession (same-file successor) → INHERIT.
  assert.equal(shouldForkEmbeddedUuidForLiveOwner({
    embeddedUuid: 'uuid-A', embeddedOwner: owner, identityObject: copy,
    ownerIsOpenWorkflow: false, successionProven: true
  }), false)
})

test('#557 r9/r10: hasEmbeddedUuidSuccessionEvidence — file path record or alias ONLY', () => {
  const owner = { isPersisted: true, path: 'workflows/x.json' }
  // 1. The file's own recorded workflow_path ties the uuid to this object's file.
  assert.equal(hasEmbeddedUuidSuccessionEvidence({
    embeddedUuid: 'uuid-A', embeddedPath: 'workflows/x.json', currentPath: 'workflows/x.json'
  }), true)
  assert.equal(hasEmbeddedUuidSuccessionEvidence({
    embeddedUuid: 'uuid-A', embeddedPath: 'workflows\\x.json', currentPath: 'workflows/x.json'
  }), true, 'separator normalization still ties the same file')
  // 2. The canonical path alias ties this object's path to the uuid.
  assert.equal(hasEmbeddedUuidSuccessionEvidence({
    embeddedUuid: 'uuid-A', currentPath: 'workflows/y.json', pathAlias: 'uuid-A'
  }), true)
  // r10 P0: the owner's file MATCHING this object's path is NOT evidence — a
  // closed→reopened object at the same path is a NEW identity, and its resume
  // heal belongs to the unregistered-embedded path, not registered-owner
  // inheritance.
  assert.equal(hasEmbeddedUuidSuccessionEvidence({
    embeddedUuid: 'uuid-A', embeddedPath: null, currentPath: 'workflows/x.json',
    pathAlias: null, embeddedOwner: owner
  }), false)
  // The r9 hole: different-path copy, file carries ONLY workflow_uuid (no
  // workflow_path), no alias → NO evidence → fork.
  assert.equal(hasEmbeddedUuidSuccessionEvidence({
    embeddedUuid: 'uuid-A', embeddedPath: null, currentPath: 'workflows/y.json',
    pathAlias: null, embeddedOwner: owner
  }), false)
  // An UNSAVED owner has no unique path (#186) — never evidence.
  assert.equal(hasEmbeddedUuidSuccessionEvidence({
    embeddedUuid: 'uuid-A', currentPath: 'workflows/Unsaved Workflow.json',
    embeddedOwner: { isPersisted: false, path: 'workflows/Unsaved Workflow.json' }
  }), false)
  assert.equal(hasEmbeddedUuidSuccessionEvidence(), false)
})

// #558 r2 — openWorkflows holds Vue PROXIES while the owner/uuid WeakMaps can hold
// RAW objects (the workflow-save.test.mjs store double models exactly this), so
// identity across those carriers must be proxy-safe.
test('rawWorkflowObject: unwraps __v_raw, passes raw objects and transparent proxies through', () => {
  const raw = { path: 'workflows/x.json' }
  assert.equal(rawWorkflowObject(raw), raw)
  const proxy = new Proxy(raw, {})
  assert.equal(rawWorkflowObject(proxy), proxy, 'a transparent proxy has no raw back-pointer')
  assert.equal(rawWorkflowObject({ __v_raw: raw }), raw)
  assert.equal(rawWorkflowObject(null), null)
  assert.equal(rawWorkflowObject(undefined), null)
})

test('sameWorkflowObject: a Vue proxy and its raw target are the SAME workflow', () => {
  const raw = { isPersisted: true, path: 'workflows/b.json', changeTracker: { activeState: null } }
  const proxy = new Proxy(raw, {}) // transparent proxy — the repo's store-double idiom
  assert.equal(sameWorkflowObject(raw, proxy), true)
  assert.equal(sameWorkflowObject(proxy, raw), true)
  assert.equal(sameWorkflowObject(proxy, proxy), true)
  // A Vue-style proxy exposing the raw target as __v_raw.
  const vueProxy = { __v_raw: raw }
  assert.equal(sameWorkflowObject(vueProxy, raw), true)
  assert.equal(sameWorkflowObject(raw, vueProxy), true)
})

test('sameWorkflowObject: distinct workflows never match — incl. same-path unsaved tabs (#186)', () => {
  const raw = { isPersisted: true, path: 'workflows/b.json', changeTracker: {} }
  assert.equal(sameWorkflowObject(raw, { isPersisted: true, path: 'workflows/c.json' }), false)
  // Two UNSAVED tabs share the synthetic path; identity falls to the per-instance
  // changeTracker object, which differs.
  const unsavedA = { isPersisted: false, path: 'workflows/Unsaved Workflow.json', changeTracker: {} }
  const unsavedB = { isPersisted: false, path: 'workflows/Unsaved Workflow.json', changeTracker: {} }
  assert.equal(sameWorkflowObject(unsavedA, unsavedB), false)
  assert.equal(sameWorkflowObject(unsavedA, new Proxy(unsavedA, {})), true)
  // Two not-yet-loaded unsaved tabs (no tracker) can never be proven same.
  assert.equal(sameWorkflowObject({ isPersisted: false }, { isPersisted: false }), false)
  assert.equal(sameWorkflowObject(null, raw), false)
  assert.equal(sameWorkflowObject(raw, null), false)
  assert.equal(sameWorkflowObject(null, null), false)
})

// #558 r3 P0 — path equality alone must NOT prove object identity: two distinct
// objects sharing a path are the same identity ONLY across a continuous-lifetime
// replacement (the save-swap, threaded via the replacement event). A
// closed→reopened object at the same path is a NEW workflow.
test('sameWorkflowObject r3: same-path distinct objects are NOT one identity (closed→reopened is new)', () => {
  assert.equal(sameWorkflowObject(
    { isPersisted: true, path: 'workflows/b.json', changeTracker: { activeState: null } },
    { isPersisted: true, path: 'workflows/b.json', changeTracker: { activeState: null } }
  ), false)
  assert.equal(sameWorkflowObject(
    { isPersisted: true, path: 'workflows/b.json', changeTracker: {} },
    { isPersisted: true, path: 'workflows/b.json', changeTracker: null }
  ), false)
  assert.equal(sameWorkflowObject(
    { isPersisted: true, path: 'workflows/b.json' },
    { isPersisted: true, path: 'workflows/b.json' }
  ), false)
})

test('#557 r3/r4/r8: identity carries across a save object-swap ONLY with save-produced-record continuity', () => {
  const pre = { isPersisted: true, path: 'workflows/x.json', changeTracker: {} }
  const successor = { isPersisted: true, path: 'workflows/x.json', changeTracker: {} }
  // In-place / first save that swapped the object, predecessor GONE from the open
  // tabs, and the post-save active object IS the service's record for the file
  // this save wrote (save-produced-record continuity) → carry.
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: successor, savedAs: false, preWfStillOpen: false, postWfIsSaveProducedRecord: true
  }), true)
  // r8 P0: static tracker/state evidence is NOT continuity — a lagging
  // activeState carrying the pre-save uuid can be a closed/reopened tab's
  // residue. Without the target-record thread, never carry.
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: successor, savedAs: false, preWfStillOpen: false, successorCarriesPreUuid: true
  }), false)
  // r5 P0: tab-slot occupancy is NOT continuity — a closed-then-compacted list
  // can seat a foreign B in A's old slot with zero A lineage.
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: successor, savedAs: false, preWfStillOpen: false, successorInPreSlot: true
  }), false)
  // r7 P0: an established, DIFFERENT identity on the successor vetoes the carry —
  // overwriting it would promote the stamp over the object's own identity and
  // poison the owner map (the r6 stale-lineage bypass via registration).
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: successor, savedAs: false, preWfStillOpen: false,
    postWfIsSaveProducedRecord: true, postWfHasConflictingEstablishedIdentity: true
  }), false)
  // r4 P0: the predecessor is STILL OPEN — a user/reconnect tab switch during the
  // awaited save lands on a DISTINCT workflow; seeding it with A's uuid would
  // bypass the #349 wrong-canvas fence → never carry.
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: successor, savedAs: false, preWfStillOpen: true, postWfIsSaveProducedRecord: true
  }), false)
  // No continuity evidence → never carry (an unknown predecessor state defaults
  // to still-open, fail-safe).
  assert.equal(shouldCarryIdentityAcrossSaveSwap({ preWf: pre, postWf: successor, savedAs: false }), false)
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: successor, savedAs: false, preWfStillOpen: false
  }), false)
  // A Save-As COPY starts a new workflow → never carry (#226/#570).
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: successor, savedAs: true, preWfStillOpen: false, postWfIsSaveProducedRecord: true
  }), false)
  // Same object (no swap) / a proxy form of the same object → nothing to carry.
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: pre, savedAs: false, preWfStillOpen: false, postWfIsSaveProducedRecord: true
  }), false)
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: pre, postWf: { __v_raw: pre }, savedAs: false, preWfStillOpen: false, postWfIsSaveProducedRecord: true
  }), false)
  // Missing sides → no carry.
  assert.equal(shouldCarryIdentityAcrossSaveSwap({
    preWf: null, postWf: successor, savedAs: false, preWfStillOpen: false, postWfIsSaveProducedRecord: true
  }), false)
  assert.equal(shouldCarryIdentityAcrossSaveSwap(), false)
})

// Fakes for the ComfyWorkflow 4th arg: a REUSE passes a ComfyWorkflow OBJECT; a CREATION
// passes null/undefined/string.
class FakeComfyWorkflow { constructor (path) { this.path = path } }

// #570 P0 — fork the per-instance identity at the workflow CREATION boundary.
test('#570 a CREATION (non-object 4th arg) is forked so a copy cannot inherit the source uuid', () => {
  // paste/new-blank pass null; open-file/duplicate/template pass a string filename.
  assert.equal(isNewWorkflowLoad({ workflowArg: null }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: undefined }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: 'workflows/Unsaved Workflow.json' }), true)
})

test('#570 an external import with an openSource is a creation', () => {
  assert.equal(isNewWorkflowLoad({ workflowArg: 'x.json', openSource: 'file_button' }), true)
  // Even if some future path passed an object, an explicit openSource still forks.
  assert.equal(isNewWorkflowLoad({ workflowArg: new FakeComfyWorkflow('a'), openSource: 'file_drop' }), true)
})

test('#570 a REUSE (ComfyWorkflow object 4th arg, no openSource) is NOT forked — durable reload', () => {
  // reload-restore / tab-switch / undo / reroute-migration all pass the workflow OBJECT.
  assert.equal(isNewWorkflowLoad({ workflowArg: new FakeComfyWorkflow('workflows/Unsaved Workflow.json') }), false)
})

test('#570 the panel\'s own same-workflow reload opts out via noFork (snapshot revert)', () => {
  assert.equal(isNewWorkflowLoad({ workflowArg: null, noFork: true }), false)
  assert.equal(isNewWorkflowLoad({ workflowArg: 'x.json', openSource: 'file_button', noFork: true }), false)
})

test('#570 FAIL-SAFE: an unrecognized/mis-shaped object 4th arg is forked (bias to fork)', () => {
  // A real reuse passes a ComfyWorkflow with a string `path`; anything else — an object
  // WITHOUT a path, or an array — is ambiguous and must fork rather than risk inheriting.
  assert.equal(isNewWorkflowLoad({ workflowArg: {} }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: { notAPath: 1 } }), true)
  assert.equal(isNewWorkflowLoad({ workflowArg: { path: 123 } }), true) // path not a string
  assert.equal(isNewWorkflowLoad({ workflowArg: [] }), true)
  // Only a ComfyWorkflow-shaped object (string path) is trusted as a reuse.
  assert.equal(isNewWorkflowLoad({ workflowArg: { path: 'workflows/x.json' } }), false)
})

test('normalizes Windows paths for stable identity comparisons', () => {
  assert.equal(
    normalizedWorkflowPath('Workflows\\Portrait.JSON'),
    'workflows/portrait.json'
  )
})

test('forks a copied workflow with an embedded UUID on a clean browser', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    embeddedUuid: 'same-uuid',
    embeddedPath: 'workflows/original.json',
    currentPath: 'workflows/copy.json'
  }), true)
})

test('keeps identity for the same live object during rename or Save As', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    objectUuid: 'same-uuid',
    embeddedUuid: 'same-uuid',
    embeddedPath: 'workflows/original.json',
    currentPath: 'workflows/renamed.json'
  }), false)
})

test('forks repeated aliases even for old workflows without an embedded path', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    embeddedUuid: 'same-uuid',
    currentPath: 'workflows/copy.json',
    aliases: {
      'workflows/original.json': 'same-uuid'
    }
  }), true)
})

test('keeps the canonical path when stale aliases still mention the same UUID', () => {
  assert.equal(shouldForkEmbeddedWorkflowUuid({
    embeddedUuid: 'same-uuid',
    embeddedPath: 'workflows/current.json',
    currentPath: 'workflows/current.json',
    aliases: {
      'workflows/old-name.json': 'same-uuid',
      'workflows/current.json': 'same-uuid'
    }
  }), false)
})

test('reuses the path alias minted for an unsaved fork after a browser restart', () => {
  assert.equal(workflowAliasForPath({
    'workflows/original.json': 'embedded-original',
    'Workflows\\Copy.JSON': 'stable-fork'
  }, 'workflows/copy.json'), 'stable-fork')
})

test('scope guard authorizes only an exact workflow UUID key', () => {
  const thread = { workflowKey: 'workflow:abc-123' }
  assert.equal(isThreadInScope(thread, 'workflow:abc-123'), true)
  assert.equal(isThreadInScope(thread, 'workflow:abc'), false)
  assert.equal(isThreadInScope(thread, 'workflow:abc-123-copy'), false)
  assert.equal(isThreadInScope(thread, ''), false)
})

// #607 — server/Manager-scoped commands never read or mutate app.graph, so the
// per-instance workflow stamp says nothing about whether they may run. Fencing them
// wedged panel_restart_comfyui itself behind "workflow instance mismatch" — the very
// command the mismatch error's situation calls for — leaving no in-band recovery.
test('#607 non-canvas commands are exempt from the workflow-instance fence', () => {
  // The exemption set is #624's CANVAS_INDEPENDENT_COMMANDS (adopted in the merge
  // integration — same #607 deadlock it fixes, with a sharper membership
  // criterion: the command neither touches a canvas NOR answers for the active one).
  for (const cmd of [
    'comfy_reboot',
    'free_vram',
    'nodes_search',
    'nodes_list',
    'nodes_install',
    'nodes_queue_status',
    // graph_update_node: a Manager PACK update misnamed with a graph_ prefix (#624).
    'graph_update_node'
  ]) {
    assert.equal(activeWorkflowFenceApplies({ cmd }), false, `${cmd} must not be fenced`)
  }
})

test('#607 canvas and workflow commands stay fenced; unknown commands fail closed', () => {
  for (const cmd of [
    'graph_add_node',
    'graph_outline',
    'graph_run',
    'graph_set_widget',
    // refresh_nodes re-applies defs to LIVE node instances and rewrites combo
    // lists on the active graph (refreshComfyNodeDefs → reapplyDefsToLiveNodes) —
    // a canvas mutation, so the stamp must be proven before it runs (codex gate).
    'refresh_nodes',
    // workflow_list USED to be fenced here, on the reading that its reply
    // "describes the active workflow, so a stale-stamped call would answer for the
    // wrong tab". #932/#607/#688 showed that premise does not hold and the cost of
    // acting on it was a permanent wedge:
    //   • the reply is computed from liveWorkflowListActive() at EXECUTION time, so
    //     it always describes the genuinely-active tab — the stamp never enters the
    //     answer, and there is no "wrong tab" for it to answer for;
    //   • unlike a graph read, the reply CARRIES ITS OWN IDENTITY (routing_key per
    //     record plus an `active` flag), so a caller holding a stale expectation can
    //     see the difference rather than misattribute the result. graph_outline
    //     returns node content with nothing to check it against — which is exactly
    //     why it stays in this list;
    //   • the orchestrator corroborates the active record against the open list
    //     (corroborateActiveForFence) before adopting a uuid from it, so the panel
    //     fence was not the thing preventing a bad adoption.
    // And fencing it made the ONE repair probe depend on the fence being already
    // correct, which is what left the documented recovery a no-op. Exemption and
    // reasoning: see the '#932 …' tests above.
    'workflow_save',
    'workflow_save_as',
    'workflow_rename',
    'workflow_close'
  ]) {
    assert.equal(activeWorkflowFenceApplies({ cmd }), true, `${cmd} must stay fenced`)
  }
  // Fail closed: a command nobody classified is treated as canvas-bound.
  assert.equal(activeWorkflowFenceApplies({ cmd: 'some_future_command' }), true)
  assert.equal(activeWorkflowFenceApplies({ cmd: undefined }), true)
  assert.equal(activeWorkflowFenceApplies({}), true)
})
