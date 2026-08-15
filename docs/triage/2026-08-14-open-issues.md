<!--
Generated 2026-08-14 by a 12-agent parallel triage pass (one agent per unclaimed open
issue, plus a synthesis pass). Each diagnosis was originally grounded in file:line
evidence at b84cb37c. READ THE BASIS COLUMN: only #813 was reproduced; #1172 and #817 were
verified by git ancestry plus a passing suite; the rest is code reading and is labelled as
such per section. Treat the low- and medium-confidence sections as leads, not conclusions.

RE-VERIFIED 2026-08-14 against main at d7c7497c (v0.14.40). What that pass changed:
  * #813 SHIPPED in the meantime (c5293380 / PR #1239, released v0.14.40) and the issue is
    CLOSED. Its section is rewritten as already-fixed; the diagnosis was confirmed correct
    by the fix that landed, but the one-line patch it proposed was NOT what shipped.
  * #817's "verify and close" recommendation is WITHDRAWN — the thread carries three
    recurrences on panel 0.14.24, long after the 0.11.51 fix this doc cites.
  * ~174 file:line references were re-pointed at the current tree (main moved
    comfyui-mcp-panel.js by +230 lines). A handful were wrong when written, not merely
    stale, and are corrected against the real symbol: see the #584 section.
  * Every remaining diagnosis's cited code is byte-identical at d7c7497c to what was read
    at b84cb37c, so those mechanisms are unchanged. Issue state was re-checked on GitHub.
-->

# Triage: 12 issue diagnoses

Twelve independent diagnoses, collated. Each section carries the root cause, the `file:line` evidence, the fix hint, and the guard(s) the fix touches. **Read the "Basis" column before you trust a section**: only #813 was reproduced against a harness; #1172 and #817 were verified by git ancestry plus a passing suite; every other diagnosis is code reading and is labelled as such in its own section.

**Freshness.** Line numbers and verdicts below are current as of main `d7c7497c` (v0.14.40). This repo ships several releases a day, so re-check `git log` before acting on a section: one of these twelve (#813) was fixed and closed between this doc being written and being reviewed.

---

## Work order

Sorted so the top row is the best next thing to pick up: high confidence, small effort, panel-side and fixable here. Orchestrator-side and diagnosis-rests-on-reading-only sink to the bottom. **Status** is the 2026-08-14 re-verification verdict; where it disagrees with the original row, the Status column wins.

| Issue | Verdict | Status @ d7c7497c | Conf. | Effort | Basis | One-line root cause |
|---|---|---|---|---|---|---|
| [#1172](https://github.com/artokun/comfyui-mcp-panel/issues/1172) refresh_nodes reports refreshed, combo stays empty | already-fixed | **still accurate** — open, needs closing | high | small | git ancestry + 99/99 unit tests at HEAD | `reapplyDefsToLiveNodes` never touched `options.values` and `refreshed:true` asserted only that API calls resolved; both fixed in 67e05b53 (v0.14.34), reporter was on 0.14.15 |
| [#757](https://github.com/artokun/comfyui-mcp-panel/issues/757) cannot create rgthree `lora_N` slots | panel-side | **still accurate** | high | medium | code read + maintainer's live probe in the thread | `resolveWidgetWrite` throws on a missing widget and nothing in `GRAPH_TOOL_EXECUTORS` can mint one; only `node.addNewLoraWidget()` creates a row, and only this repo holds that object |
| [#1124](https://github.com/artokun/comfyui-mcp-panel/issues/1124) run-to-node permanently refused on armed rgthree Seed | panel-side | **still accurate** | high | medium | code read, on top of previously **measured** rgthree behaviour recorded in-repo | The #556 drift guard's only volatility signal is `typeof w.beforeQueued === "function"`; rgthree splices that widget out and substitutes the seed inside its own `api.queuePrompt` patch, so the hash always mismatches on `47 seed` |
| [#1215](https://github.com/artokun/comfyui-mcp-panel/issues/1215) reads silently serve the PREVIOUS tab's graph | panel-side | **still accurate** | high | medium | code read (reporter's build predates all mitigations; residual is asserted-open by an existing test) | The open's own `checkState()` capture serializes the still-mounted tab-A canvas into tab B's tracker, then faithfully repaints it — all four proof parts are true statements about a poisoned source |
| [#976](https://github.com/artokun/comfyui-mcp-panel/issues/976) set_widget reports exception after a successful write | panel-side | **still accurate** | medium | small | code read; **the throwing callback could not be read on this machine** | The TypeError is not the panel's, but `describeThrown` renders `String(err.message)` only and the Error never reaches the console — the panel destroys the one piece of evidence that would close the ticket |
| [#654](https://github.com/artokun/comfyui-mcp-panel/issues/654) panel does not reconnect after `panel_restart_comfyui` | panel-side | **still accurate** (fresh duplicate on 0.14.34) | medium | small | code read; the bridge-stays-up shape is **untested** in the existing e2e | With the orchestrator out-of-band the bridge socket never drops, so nothing sends a `hello`; the tab sits on a live socket it never re-announced and every graph tool answers "Connected: none" |
| [#1098](https://github.com/artokun/comfyui-mcp-panel/issues/1098) save → UUID mismatch → unresponsive `workflow_open` | panel-side | **still accurate** | medium | medium | code read; **cannot prove which await hung** without knowing whether the tab was hidden | `workflow_open` has no end-to-end deadline and the Save-As steers it onto a bare `requestAnimationFrame` await; a hung executor never replies and never journals a receipt, and `pending > 0` freezes the 30 s guard ceiling |
| [#584](https://github.com/artokun/comfyui-mcp-panel/issues/584) frontend reload keeps stale panel JS | panel-side | **mechanism accurate, LINE REFS CORRECTED** | medium | medium | code read (recurrence report is consistent, not reproduced) | The stale-bundle healer is wired to page load only; the event that actually changes the bundle is a pack update + restart, which the `reconnected` listener sees but never re-probes for |
| [#1181](https://github.com/artokun/comfyui-mcp-panel/issues/1181) PrimitiveNode values lost across subgraph inputs | panel-side | **still accurate** (one symbol name corrected) | medium | medium | code read; the loss itself is upstream and **unverified against a captured prompt** | The value loss is ComfyUI's `graphToPrompt`; the *panel's* defect is `linkDrivenWidgets` asserting "the stored value is stale, the link overrides it", which is exactly backwards for a virtual origin |
| [#701](https://github.com/artokun/comfyui-mcp-panel/issues/701) `panel_reload` drops the socket; open cannot recover | orchestrator-side | **still accurate** | medium | small | code read; both panel-side halves already fixed here | Residual is upstream: `scope:'orchestrator'` is dispatched over the tab socket and `/comfyui_mcp_panel/reload` is a by-design 503; the truncated `wf:workf` string is composed in ui-bridge |
| [#817](https://github.com/artokun/comfyui-mcp-panel/issues/817) graph_outline rejects active workflow after tab switch | already-fixed *for the original report* | **CORRECTED — do NOT close** | high→low | — | git ancestry + 23/23 unit tests at HEAD | A *wrong* root tag was stickier than *no* tag; fixed by 4964486f (v0.11.51), reporter was on 0.11.45. **But the thread carries three recurrences on 0.14.24 reporting `workflow instance mismatch`** — a different guard from the one that was fixed. See the section. |
| [#813](https://github.com/artokun/comfyui-mcp-panel/issues/813) move_group refuses on collapsed nodes | panel-side | **ALREADY FIXED & CLOSED** — shipped v0.14.40 | high | small | **reproduced** (extracted executor + harness; patch verified, 135/135 existing tests green) | `nodeAreaIsLive` demands all four rect components match the panel's *collapsed-pill* extent model, which the engine's own `updateArea()` overwrites. Diagnosis confirmed by the landed fix (c5293380); nothing left to pick up. |

---

## Shared root causes

### Cluster A — one ComfyUI restart, two things the live tab never redoes: #654 + #584

**These two share a cause and should be worked in one sitting.** Both are the same structural fact: `externalOrchestratorMode()` is hardcoded `true` (`web/js/comfyui-mcp-panel.js:4146-4153`), so the orchestrator survives a ComfyUI restart, the bridge socket never closes, and the only code path that repairs tab state — a fresh socket / page load — never runs. Both fixes land in or beside the same `reconnected` listener at `web/js/comfyui-mcp-panel.js:1511-1530`, which already does exactly this kind of "the backend restarted, my cached state is wrong" invalidation for the Manager dialect cache and node defs, and stops there.

Be precise about what this buys you: **one fix does not close both tickets.** #654 needs a re-advertise (`hello`); #584 needs a version re-probe. But they are the same trigger, the same handler, the same "is this a real restart or a blip" gating question, and the same one-shot discipline — so doing them separately means solving that gating question twice.

#701's remaining half sits in the same reload/reconnect cluster and shares `web/js/lib/reload-blocked.js:81-96` with #584's second defect, but its residual is upstream; see "Not actionable yet".

### Cluster B — tab-switch graph identity: #817 and #1215 are the same guard failing in opposite directions

Group them for context, **not** for a shared fix. #817 is the guard refusing a graph it should have admitted (fixed in v0.11.51). #1215 is the inverse — the guard admitting, and every proof part honestly passing, over a poisoned source. A change that relaxes the guard to close #1215 would re-open the #349 wrong-canvas refusal that #817's fix was carefully built not to disturb. #1233 (re-reported on 0.14.2, i.e. after both fixes) is the third member of this cluster and is a genuinely different residual.

Two other pairings that look shared and are **not**: #1124 and #757 are both rgthree but have unrelated causes (drift-guard exclusion vs. widget creation); #1098's mismatch half is already disclosed under #978, so its live defect (the unbounded await) is its own.

---

## #813 — `panel_move_group` mutates the graph, then refuses on collapsed nodes

**ALREADY FIXED AND CLOSED · shipped v0.14.40 · nothing to pick up**

> **Superseded 2026-08-14.** This section was written while #813 was open and recommended it as the first pick. It shipped hours later: `c5293380` ("fix(813): a COLLAPSED group member is not a node that refused to move", PR #1239), released as `d7c7497c` / **v0.14.40** (PR #1240). GitHub issue #813 is CLOSED as completed.
>
> **The diagnosis below was confirmed correct** — the landed fix names the same mechanism (the collapsed-PILL model vs. the engine's own `updateArea()` extents) and lands at the same line. Keep it as the explanation of what was wrong.
>
> **But the one-line patch it proposes is NOT what shipped, and applying it would be a regression.** Review found two things the naive form gets wrong, both now written into the code at `web/js/lib/group-geometry.js:532-575`:
> 1. **It must be GATED to collapsed nodes.** The proposed `if (!nodeAreaIsLive(n) && !syncNodeArea(n)) landedExactly = false;` is ungated. An EXPANDED node's `updateArea()` may authoritatively compute visible bounds that legitimately differ from the generic `[x, y-30, size0, size1+30]` model; forcing the generic footprint there overwrites the engine's own answer and then reports success, and rect-first membership is wrong afterwards.
> 2. **`syncNodeArea`'s own return value must not be trusted.** `boundingRect` can be an accessor whose getter returns a fresh array per read; `syncNodeArea` would then mutate and verify a throwaway copy and return true while the real rect never changed. The shipped code re-reads the verdict through `nodeAreaIsLive`, which fetches the property again.
>
> The rest of this section — root cause, evidence, risk — is retained as the record of the analysis. Its `group-geometry.js:531-532` citations describe the code **before** the fix; line 532 is now the fix's own comment block.

### Root cause *(as diagnosed pre-fix; the cited line 532 no longer contains this code)*
The "would not accept a new position" verdict for a group member is not the position write — it is a cached-rect equality test the panel loses against the frontend for COLLAPSED nodes only. In `moveGroupMembers` the pos write is verified by `writePoint`, but then `web/js/lib/group-geometry.js:531-532` overrode the verdict with `if (!nodeAreaIsLive(n)) landedExactly = false;`, and `nodeAreaIsLive` (351-361) demands the cached `boundingRect` equal all four components of the panel's OWN footprint model, `wantedNodeArea` (331-341). For an EXPANDED node that model is `[x, y-30, size0, size1+30]` — exactly what a LiteGraph `updateArea()` recompute produces — so the two agree. For a COLLAPSED node the panel substitutes its pill (`w = _collapsed_width || 80`, `h = 0`), which the engine's own rect will not match; and `refreshNodeArea` (54-93) calls `node.updateArea?.()` and, at line 73, returns "trusted" as soon as the engine moved the rect origin, without ever reconciling w/h. So the pre-flight `syncGraphNodeAreas` normalises the collapsed rect to the pill, the engine's `updateArea()` inside the move puts its own extents straight back, `nodeAreaIsLive` sees a width mismatch, and every collapsed member is classified stuck — after its position was already written, forcing the mutation-phase rollback at `web/js/comfyui-mcp-panel.js:16256-16275`. The reporter's `size:[225,0]` nodes are exactly this shape.

The second half of the complaint ("PARTIALLY moved … could NOT be put back") already landed as commit `fa93556a` — see the `panel#813` note at `web/js/lib/group-geometry.js:605-628`; the repro now reports "NOTHING was moved" with positions correctly restored. ~~The collapsed-node refusal itself is still live.~~ **The collapsed-node refusal is fixed as of `c5293380` / v0.14.40.**

### Evidence
*(line numbers are `b84cb37c`, i.e. pre-fix, except where noted; `group-geometry.js` was rewritten in this region by `c5293380`)*
- `web/js/lib/group-geometry.js:531` — `refreshNodeArea(n, [px, py])` — return value discarded (**still line 531 at HEAD**)
- `web/js/lib/group-geometry.js:532` (pre-fix) — `if (!nodeAreaIsLive(n)) landedExactly = false;` — the only stuck verdict that is not the pos write. **At HEAD line 532 begins the fix's comment block; the shipped replacement is the collapsed-gated correction at `:576-590`.**
- `web/js/lib/group-geometry.js:351-361` — `nodeAreaIsLive` requires `want.every((v, i) => br[i] === v)`: all four components, extents included
- `web/js/lib/group-geometry.js:331-341` — `wantedNodeArea`: collapsed ⇒ `w = finiteExtent(_collapsed_width, 80)`, `h = 0`; expanded ⇒ `size[0]`, `size[1]` — the collapsed branch is the divergence
- `web/js/lib/group-geometry.js:66` — `node.updateArea?.()` hands the rect back to the engine mid-move
- `web/js/lib/group-geometry.js:73` — trusts the engine's recompute on origin movement, never reconciles `br[2]`/`br[3]`
- `web/js/comfyui-mcp-panel.js:16265-16275` — stuck ⇒ `refuse('would not accept a new position')` AFTER members have been written
- `web/js/comfyui-mcp-panel.js:16256-16264` — `refuse()` runs the rollback and emits the "PARTIALLY moved … Press Ctrl+Z" text
- `web/js/lib/group-geometry.js:605-628` — the already-landed half of #813
- `browser_tests/unit/group-geometry.test.mjs:645-660` — the repo's own #813 fixture *is* the reporter's node: pos `[100,100]`, size `[225,0]`, `flags.collapsed`, rect `[100,70,225,30]`
- `browser_tests/unit/move-group.test.mjs:941-963` — what the #408 guard at line 532 exists for: a rect that cannot be made to track the node must still refuse. **Note:** `c5293380` added tests to this file, so the test now at `:941` is "#408: a member whose rect is already correct is NOT reported as unrestorable" — related, but no longer the frozen-rect case this bullet was pointing at
- `browser_tests/unit/group-geometry.test.mjs:229-243` — the repo's model of an engine `updateArea()`: `[pos0, pos1-30, size0, size1+30]`

### Fix — SHIPPED, do not re-apply
The direction proposed here was right and is what landed: stop letting the panel's collapsed-pill *extent* model decide whether a position write landed, without dropping the #408 requirement that the rect must describe where the node now is.

The patch this section originally proposed was:

```js
// PROPOSED — NOT what shipped. Ungated, and trusts syncNodeArea's own verdict.
if (!nodeAreaIsLive(n) && !syncNodeArea(n)) landedExactly = false;
```

What actually shipped in `c5293380` (`web/js/lib/group-geometry.js:588-590`) gates on collapsed-ness and re-reads the verdict through a fresh property fetch:

```js
if (!nodeAreaIsLive(n) && !(isCollapsed && syncNodeArea(n) && nodeAreaIsLive(n))) {
  landedExactly = false;
}
```

Both differences are load-bearing; see the superseded note at the top of this section for why. The alternative sketched here — having `refreshNodeArea` finish with a `syncNodeArea` reconcile at line 73 — was **not** taken, and would still be ungated with respect to expanded nodes.

Verified: the shipped `graph_move_group` was extracted with the same `new Function` harness `move-group.test.mjs` uses and run against the reporter's node (collapsed, size `[225,0]`, rect `[x, y-30, 225, 30]`) on a build whose `updateArea()` recomputes the rect the way `group-geometry.test.mjs:237` models it. Unpatched it throws the reporter's exact string — "1 enclosed item(s) would not accept a new position (node 24) …" — while an otherwise identical EXPANDED node moves fine; a build whose collapsed width is `_collapsed_width + 1` fails the same way. Patched, all four cases move and report `{nodes:1}`. Untouched `move-group.test.mjs` + `group-geometry.test.mjs` against the patched lib: 135/135 pass.

Add regression tests for (a) a collapsed member whose engine `updateArea()` restores non-pill extents still moves, and (b) the frozen-rect node of `move-group.test.mjs:941` still refuses. Optional follow-ups from the report: the refusal text still says "Press Ctrl+Z", which the agent caller cannot do, and points at `panel_edit_node` when `panel_move_node` is what the reporter used to repair the nodes.

### Risk
Line 532 is a #408 guard: a rect that cannot be made to track the node makes membership (which is rect-first) report the node in a group it has left, so the move is refused rather than reported done. This fix does not relax that — it gives the rect one more chance to be corrected before the verdict, using `syncNodeArea`, the identical writer the move's own pre-flight (`syncGraphNodeAreas`, line 443) already ran over every node moments earlier. A genuinely uncorrectable rect (frozen, hostile accessor) still returns false and still refuses; `move-group.test.mjs:941` stays green, as do the #416 area-overstatement tests (the forced write is the pill, never the full box). One residual: on builds where `pos`/`size` alias `boundingRect` (the Float64Array-subarray shape at `group-geometry.js:729-731`), writing `br[2]`/`br[3]` could touch the node's size — but that write already happens on every move and every bounds-query pre-flight, so this adds no new class of write. Worth a fixture. Not a duplicate: #813 is the only open issue touching group moves or collapsed nodes, though it shares the mutate-then-refuse family with #408/#631.

---

## #1172 — `panel_refresh_nodes` reports refreshed but new `CheckpointLoaderSimple` keeps an empty ckpt list

**already-fixed · confidence high · effort small · verified by git ancestry + tests**

### Root cause
The report is panel-side (the reporter's "upstream-only: yes" was wrong) and the mechanism has since been fixed here. Two distinct defects produced it.

1. **Rebuild.** `registerComfyNodeDefs` calls `reapplyDefsToLiveNodes(rootGraph, defs)` (`comfyui-mcp-panel.js:1282`) on every refresh path, but that sweep only stamped `ctor.nodeData` and reconciled UNKNOWN widget names — it never touched `options.values`, even though `refreshComboOptionsFromDefs` sat thirty lines above in the same module, reachable only from the set_widget path. Repopulating combos was delegated entirely to `app.refreshComboInNodes()`, whose per-node effect the panel never observed, so a just-added `CheckpointLoaderSimple` kept an empty `ckpt_name` list.
2. **Disclose.** Every input `describeNodeDefRefresh` consumes is STRUCTURAL (app present, defs obtained, register ran, combo API present, combo resolved), so `refreshed: true` asserted that API calls RESOLVED, not that the definitions were usable — the panel held `ckpt_name: [[], {…}]` at both register and reapply and discarded it, and the agent learned about it at queue time from ComfyUI's own `Value not in list (… not in [])`.

Commit `67e05b53` / PR #1218 (v0.14.34) fixed both; HEAD is v0.14.40 and `git merge-base --is-ancestor 67e05b53 HEAD` passes (re-checked at `d7c7497c`).

### Evidence
- `web/js/lib/asset-staleness.js:901-916` — the #1172 rebuild: `reapplyDefsToLiveNodes` now calls `refreshComboOptionsFromDefs` per live node, with a comment naming this exact report
- `web/js/lib/asset-staleness.js:764-795` — `refreshComboOptionsFromDefs` copies the authoritative array into `w.options.values` (788), skips a dynamic function source (786)
- `web/js/lib/asset-staleness.js:831-852` — `emptyComboListsOnGraph`, computed from the `/object_info` payload already in hand, scoped to types on the graph, walking subgraphs via `collectAllGraphs`
- `web/js/lib/asset-staleness.js:870-884` — `emptyComboNote`: states the observation, names no cause, predicts no other command's result
- `web/js/comfyui-mcp-panel.js:1414-1435` — verdict now carries `empty_combo_lists` / `empty_combo_lists_note`; `refreshed` deliberately stays true per #507/#1133
- `web/js/comfyui-mcp-panel.js:1279-1283` — the reapply sweep runs on every `registerComfyNodeDefs` path, including `refresh_nodes`' `force:true`
- `web/js/comfyui-mcp-panel.js:9356-9367` — executor forwards the disclosure through the `refreshed: true` object literal (the #981 hole)
- `web/js/lib/refresh-coalesce.js:37,68,85` — the coalescer returns `runRegister`'s result unmodified, so the enriched verdict reaches the executor on the forced/trailing path too
- `web/js/lib/set-widget.js:638-651` — #507/#1133: an authoritatively empty list is "not knowable", so the write is PERFORMED and reports `empty_option_list: true`
- `browser_tests/unit/asset-staleness.test.mjs:1218-1330` — eight #1172 tests; all 99 in the file pass at HEAD
- `browser_tests/unit/stale-placeholders.test.mjs:262-271` — the #981 source guard pins both the spread and `empty_combo_lists_note`

### Fix
No code change for the reported defect. Verify and close: reporter was on 0.14.15, fix shipped in 0.14.34. Re-running their steps on >= 0.14.34 should yield a repopulated `ckpt_name` combo, or — if the backend genuinely publishes `[]` — a reply of `{ ok: true, refreshed: true, empty_combo_lists: [{type:"CheckpointLoaderSimple", widget:"ckpt_name"}], empty_combo_lists_note: "…" }`. Note ComfyUI's `Value not in list (… not in [])` is a BACKEND `validate_inputs` message; with an empty list the server's own `folder_paths` returned nothing, which the panel now discloses rather than causes.

One optional follow-up, **not** the reported defect: `graph_add_node` routes through `refresh: (defs) => refreshComfyNodeDefs(defs)` (`comfyui-mcp-panel.js:10817`) and discards the verdict, so an add whose combo is empty says nothing at add time — the reporter's very first observation. Forwarding `empty_combo_lists` into the add_node reply would close that, and would need the #981 source guard at `stale-placeholders.test.mjs:265-271` extended to name it.

### Risk
The landed fix relaxes no guard — `refreshed` deliberately stays TRUE (`asset-staleness.js:806-815`, `comfyui-mcp-panel.js:1423-1426`) because #507/#1133 established that an authoritatively empty list is legitimate and `set-widget.js:638-651` still performs the write. Two live interactions to watch:

- **Perf.** `refreshComboOptionsFromDefs` now runs for every live node on every refresh. The merged input map is hoisted per TYPE (`asset-staleness.js:797-803`), but the comment at 890-894 states plainly this is not free against #1193's measured 3.97 s register/reapply phase. **#1193 (open) is the issue that will feel it.**
- **Clobber.** The rebuild overwrites any ARRAY-valued `options.values`, protected only by the function-source skip at `asset-staleness.js:786` — a node that populates an array client-side would be reset to the backend list on each refresh. That is the neighbourhood of open #1126 (absolute path on a dynamic file combo) and #757 (rgthree dynamic `lora_N` slots); both use dynamic sources today, so neither is currently broken by it.

---

## #817 — `panel_graph_outline` rejects active workflow after tab switch

**original report already-fixed · BUT LIVE RECURRENCES ON 0.14.24 · do NOT close · see Cluster B**

> **Corrected 2026-08-14.** This section originally read "already-fixed · confidence high" and recommended "verify and close as fixed by `4964486f`". **That recommendation is withdrawn.** Re-reading the thread before acting on it — which this section did not do — turns up three recurrence comments, all *after* the fix it cites and all on panel **0.14.24**:
>
> | Comment | Panel | Reported symptom |
> |---|---|---|
> | 2026-08-13 00:21 | not captured | "workflow-instance mismatch" after a tab switch / reconnect; `panel_set_workflow_target({mode:"current"})` restored the read |
> | 2026-08-13 08:24 | 0.14.24 | same, after a sidebar session tab switch/reopen |
> | 2026-08-14 02:34 | 0.14.24 | same, immediately after `ACTIVE WORKFLOW CHANGED`; stale instance `f894606c…` vs active `09fe6c01…` |
>
> The issue is in **REOPENED** state on GitHub for exactly this reason.
>
> **What is and is not established.** The recurrences report `workflow instance mismatch` — a *command-instance* vs. active-canvas comparison. The original report, and the fix analysed below, are about `root-workflow-uuid-mismatch` — a *root tag* comparison. These are different guards, so the analysis below is very likely still a correct account of the ORIGINAL defect, and `4964486f` very likely did fix it. What is **not** established is the thing the section originally concluded: that there is nothing left here. Closing #817 on the strength of the ancestry check below would close a ticket with three live reproductions on a current build.
>
> **Recommended next step:** treat the recurrence as its own diagnosis job against `workflow instance mismatch` (the instance guard), not as a re-run of the ancestry check. It is transient and self-heals after `panel_set_workflow_target({mode:"current"})` in all three reports, which is a different signature from the original sticky-tag refusal. #1233 and #1215 remain the other members of this cluster.

### Root cause
Panel-side, exactly as the reporter observed: ComfyUI reuses one `app.graph` across workflow tabs and its clear/configure did not reset `graph.extra` on that build, so switching A→B left A's `extra.comfyui_mcp.workflow_uuid` on a canvas now holding B's graph, and `graphRootWorkflowUuidMismatches` refused every graph tool (`web/js/comfyui-mcp-panel.js:6816`). The sharp part was an asymmetry, not the tag: `sealProvenRootBinding` bails out early on any root that already carries a tag (`web/js/lib/graph-binding.js:2033-2035`), so a byte-identical canvas with NO tag self-healed via the content proof while the same canvas wearing a WRONG tag was refused until the user re-opened the already-active workflow — a wrong tag was stickier than no tag.

Fixed 2026-08-09 by `4964486f` (PR #843): the seal's content bar was lifted into `rootContentProvesActiveWorkflow` (`graph-binding.js:1919-1934`) and fed to `resolveGraphRootUuidRebind` as a third rebind clause (`graph-binding.js:1810`), with the caller computing the exclusivity proof above the rebind and re-stamping the root (`comfyui-mcp-panel.js:6851-6872`). Reporter ran 0.11.45; fix shipped in 0.11.51 (`CHANGELOG.md:2323-2348`); HEAD is 0.14.38. The issue is still open on GitHub, not still broken in code.

### Evidence
- `web/js/comfyui-mcp-panel.js:6816` — `graphRootWorkflowUuidMismatches` raises the reported refusal
- `web/js/comfyui-mcp-panel.js:6847-6872` — the fix at the call site: `rootContentProvesActiveWorkflow(...)` feeds `resolveGraphRootUuidRebind`; a "rebind" verdict calls `stampGraphRootWorkflowUuid` and clears `rootUuidMismatch`
- `web/js/lib/graph-binding.js:1810-1812` — `contentProvesActiveWorkflow`, the third clause returning "rebind" instead of "conflict"
- `web/js/lib/graph-binding.js:1919-1934` — root scope, clean tab, equality against the workflow's CURRENT state, exclusive among open tabs
- `web/js/lib/graph-binding.js:2033-2035` — the already-tagged bail-out: the asymmetry that made a stale tag unrecoverable
- `web/js/lib/graph-binding.js:1764-1777` — the clause documents the tab-switch mechanism (reused `app.graph`, extra not reset) verbatim
- `web/js/lib/graph-binding.js:1830-1840` — `graph_outline` is in `READ_ONLY_GRAPH_COMMANDS`, so it takes the lower read bar
- `browser_tests/unit/stale-tag-after-tab-switch.test.mjs:11-23` (narrative), `:73-82` (rebind asserted), `:98-120` (what must still refuse)
- `CHANGELOG.md:2323-2348` — shipped in 0.11.51
- `web/js/comfyui-mcp-panel.js:6896-6916` — the later #995 extension: a read-only call on a DIRTY tab clears the mismatch for that call only, writing nothing

### Fix
No code change **for the original report**, which was fixed by `4964486f` (PR #843) and extended by `40099573` (#995 / PR #1016) for the modified-tab case. `node --test browser_tests/unit/stale-tag-after-tab-switch.test.mjs browser_tests/unit/stale-tag-dirty-tab.test.mjs` passes 23/23 on HEAD, and `git merge-base --is-ancestor 4964486f HEAD` passes.

**Do NOT close the ticket on that basis** — see the correction at the top of this section. The three 0.14.24 recurrences report a different guard (`workflow instance mismatch`, not `root-workflow-uuid-mismatch`) and need their own diagnosis. The ancestry evidence here retires the original mechanism only.

If the intent is to spend effort on the surviving tab-switch symptom rather than on this ticket, work **#1233** (same title/mechanism but re-reported on 0.14.2, i.e. after both fixes — a genuinely different residual) and **#1215** below. Note the reporter's requested framing — "rebind on the tab-switch EVENT before graph tools are admitted" — was deliberately NOT how this was fixed: the panel rebinds lazily at guard time on CONTENT proof, so no event ordering can be relied on.

### Risk
The main risk is re-opening this and "fixing" it again by relaxing the guard. `sealProvenRootBinding`'s refusal to overwrite an existing tag must stay (`graph-binding.js:2033-2035`) — it keeps the #349 wrong-canvas refusal intact and is pinned by `stale-tag-after-tab-switch.test.mjs:167-177`. The rebind's admitting clauses must each keep their guards: #349 foreign-canvas, #545 dirty-tracker (a lagging tracker is not evidence), identical-twin ambiguity, #565/#833 both-empty (an empty canvas can never identify itself). The #995 path must stay a read-only, write-nothing bypass (`comfyui-mcp-panel.js:6873-6916`) and stay opt-in via `graphCommandBindingBar`; `READ_ONLY_GRAPH_COMMANDS` grows one verified command at a time, never by pattern (#1478).

---

## #757 — `panel_set_widget` cannot create dynamic widget slots (rgthree Power Lora Loader `lora_N`)

**panel-side · confidence high · effort medium · code read + the maintainer's live probe in the thread**

This one carries a verdict reversal: it was previously parked as orchestrator-owned, and that verdict was too broad.

### Root cause
`panel_set_widget` resolves a widget by name against the live LiteGraph node and throws when it misses — `resolveWidgetWrite` at `web/js/lib/widget-write.js:923-931` — and nothing in `GRAPH_TOOL_EXECUTORS` can make a widget appear. rgthree's Power Lora Loader mints `lora_N` rows only from `node.addNewLoraWidget()` (the maintainer's own live probe in the thread: `callback`, `onMouseClick` and `mouseClickCallback` all accept the call and create nothing, so any fix written against the generic widget contract silently no-ops). Only this repo runs in the browser and holds that node object, so the creation step can only be implemented here.

The prior triage parked it as orchestrator-owned (`web/js/lib/pressable-widget.js:17-21`, plus the closing comment citing `scripts/check-tool-vocabulary.mjs`), but that constraint binds only the *new-tool* design: a new `cmd` must be sent by the orchestrator because bridge dispatch rejects anything not in `GRAPH_TOOL_EXECUTORS` (`comfyui-mcp-panel.js:18756-18757`). It does not bind a narrow route inside the existing `panel_set_widget`, and this repo already drives pack-private entry points exactly that way, keyed strictly to node type.

Second, one of the two blockers recorded in the thread is now stale: composite `lora_N` object writes ARE supported (`RGTHREE_LORA_SLOT_SCHEMA` at `widget-write.js:186-191`, merge path at 491-542, dotted sub-fields at 893-922). Remaining scope is **creation only**.

### Evidence
- `web/js/lib/widget-write.js:923-931` — the refusal that produces the reported error; `resolveWidgetWrite` throws `WidgetWriteError` with the availability list plus `pressableWidgetHint`, and has no creation branch
- `web/js/comfyui-mcp-panel.js:16986-16991` — the second missing-widget refusal (`graph_promote_widget`) carrying the same #757 disclosure
- `web/js/lib/pressable-widget.js:17-21` — records that only the disclosure half shipped: "Pressing the button would be a new capability … parked behind the stabilization pass"
- `web/js/lib/pressable-widget.js:46-53` — `isPressableWidget` detects a click handler, not `type === "button"` (rgthree's `RgthreeBetterButtonWidget` is `type: "custom"`); exported, and the primitive a creator route builds on
- `web/js/comfyui-mcp-panel.js:18756-18757` — `const executor = GRAPH_TOOL_EXECUTORS[msg.cmd]; if (!executor) throw …` — the whole basis of the prior orchestrator-side verdict
- `scripts/check-tool-vocabulary.mjs:5-19` — "the panel depends on TWO vocabularies it does not own"; `vendor/tool-vocabulary.json` is generated in comfyui-mcp
- `vendor/tool-vocabulary.json` — contains `panel_remove_widget` but no press/add-slot tool, so the mirror-image capability was already granted new tool surface once
- `web/js/lib/remove-widget.js:1-8` — `panel_remove_widget` shipped for comfyui-mcp#938 for THIS exact class; removal is solved, addition is the missing half
- `web/js/lib/remove-widget.js:19-25` — rgthree's `loraWidgetsCounter` is monotonic and `configure()` re-mints `lora_1..N` from serialized ORDER; names are not positional
- `web/js/lib/remove-widget.js:216-227` — the post-verify discipline for a pack-overridable mutation: call the node's own method, then assert the widget list actually changed and throw if not
- `web/js/comfyui-mcp-panel.js:11874-11921` — `graph_remove_widget` executor: `/object_info` read, workflow fence, then `runRemoveWidget` with beforeChange/afterChange/setDirty — the shape a create route would mirror
- `web/js/lib/ltx-director.js:22-26` — precedent for calling a pack-private entry point, keyed strictly to `node.type` and feature-detected; `:260-262` — loud refusal when the private method is absent
- `web/js/comfyui-mcp-panel.js:11578-11624` — `graph_set_widget` already carries three node-type-keyed routes (#314 LTXDirector, #506 PromptRelay, #983 rgthree Fast Groups) before the generic path
- `web/js/lib/widget-write.js:186-191`, `:491-542`, `:893-922` — composite row writes and dotted sub-fields already work
- `web/js/lib/api-workflow-load.js:23-27` — a graph load rebuilds the rows through the node's own class, which is why the loaded-workflow workaround works
- `web/js/lib/node-resolve.js:61-62` — Power Lora Loader is NOT frontend-only, so the #458 fresh-backend authorization already passes

### Fix
Add a node-type-keyed creation route to `graph_set_widget`, modelled on `ltx-director.js`, shipped as a lib beside `remove-widget.js` (e.g. `web/js/lib/rgthree-lora-row.js`) with unit tests in `browser_tests/unit/`.

Classifier fires ONLY when all of: `node.type`/`comfyClass` is `"Power Lora Loader (rgthree)"`; the requested name matches `/^lora_\d+$/`; the name is absent from `node.widgets`; `typeof node.addNewLoraWidget === "function"` (feature-detected, loud refusal otherwise, exactly as `ltx-director.js:260-262`); and the incoming value parses to a lora-slot object accepted by the existing `isLoraSlotObject` (`widget-write.js:194-210`).

Then: `graph.beforeChange()` → snapshot the widget-name list → `node.addNewLoraWidget()` → re-read the list. Because `loraWidgetsCounter` is monotonic (`remove-widget.js:19-25`) the appended row may NOT be named as requested — if the newly appended widget's name differs from `widget`, remove it again via `node.removeWidget(created)` and refuse, naming the real next name, so nothing is left behind. If nothing was appended at all, throw (the callback probe's silent no-op is exactly the trap post-verify catches — `remove-widget.js:222-227`). On success fall straight through to the existing `applyWidgetWrite`, which already handles the composite merge and the #240 verify, and close the single `afterChange()` so create+write are ONE Ctrl+Z. Report the created row name in the result.

If a general capability is preferred instead, the alternative is a symmetric new "add widget" tool, mirroring `panel_remove_widget` — but that needs comfyui-mcp to define the name+schema and `vendor/tool-vocabulary.json` re-exported, exactly as `panel_remove_widget` was for comfyui-mcp#938. The narrow route needs no upstream surface and can ship now. (Deliberately not writing the hypothetical `panel_*` name here: `scripts/check-tool-vocabulary.mjs` scans every `panel_*` identifier in the tree, docs included, and fails on one that no tool answers to.)

### Risk
Nothing is relaxed. The guard being worked around is the deliberate refusal to auto-press a pressable control (`pressable-widget.js:61-69` and the maintainer's closing comment): a generic "node has exactly one pressable widget, press it" rule would mutate the graph on an ordinary typo, which is the overwhelmingly common reason a widget name misses. The narrow route requires the node TYPE, the `lora_N` name shape, AND a lora-slot-shaped value, so a typo cannot reach it, and `pressableWidgetHint` must stay the answer for every other node and every other missing name (`browser_tests/unit/pressable-widget.test.mjs` pins that an ordinary typo gets nothing added).

Interactions to re-check: the #983 rgthree Fast Groups refusal (`web/js/lib/rgthree-fast-groups.js`) must still run first and stay untouched — both are rgthree, and a broadened classifier could swallow it; the #458 authorization order in `set-widget.js` (creation must happen AFTER `awaitObjectInfoHistorySeed` and after the resolved-target registry gate, never before); the #570/#718 `workflow_uuid` fence must bracket the mutation as `graph_remove_widget` does at `comfyui-mcp-panel.js:11913-11916`; and the #976 `write_warning_source` attribution path, since `addNewLoraWidget` is a second pack callback the panel invokes that can throw. Residual: `addNewLoraWidget` is pack-private and version-dependent — feature detection plus post-verify means a rename degrades to a loud refusal rather than a silent no-op.

---

## #1124 — run-to-node permanently refused when Seed (rgthree) changes during graph stamping

**panel-side · confidence high · effort medium · code read, standing on rgthree behaviour previously measured and recorded in-repo**

### Root cause
The refusal is produced entirely by this repo's #556 drift guard. `dispatchScopedRun` fingerprints the prompt from its OWN `app.graphToPrompt()` before dispatch (`run-scope-guard.js:1442-1444`), then re-hashes the outgoing `POST /prompt` body and refuses as `graph_changed` when the two differ (`:1124-1125`, `:1243-1244`). The only values excluded from that hash come from `collectVolatileInputs`, which detects a queue-time mutation ONLY by `typeof w?.beforeQueued === "function"` on a live widget, plus that carrier's `linkedWidgets` targets (`:441-455`).

An armed `Seed (rgthree)` node has no such widget: rgthree splices the built-in `control_after_generate` widget out entirely and substitutes the seed inside its own `api.queuePrompt` patch — `outputInputs[this.seedWidget.name || "seed"] = seedToUse` in the `comfy-api-queue-prompt-before` handler — both facts already measured and quoted in this repo at `scoped-batch-seed.js:166-190` and `:279-291`, with the `api.queuePrompt` shadowing re-confirmed on a live 1.48.7 at `queue-prompt-chain.js:15`. So the panel hashes node 47's `seed` as the sentinel `-1`, rgthree rewrites it below `api.queuePrompt` and above `api.fetchApi` (where the guard sits), the hashes mismatch on that one input, and the guard emits the drift token `"47 seed"`.

It is PERMANENT because the widget stays armed at `-1` after every call (measured, `scoped-batch-seed.js:177-179`): every retry re-rolls, and `graph_changed` with zero verified posts is terminal by design — no shape retry (`run-scope-guard.js:1688-1689`).

### Evidence
- `web/js/lib/run-scope-guard.js:441` — the ONLY volatility signal: `if (typeof w?.beforeQueued !== "function") continue;`
- `web/js/lib/run-scope-guard.js:446` — the `w.value === "fixed"` gate: the precedent for gating an exclusion on armed-ness (#572 codex r2)
- `web/js/lib/run-scope-guard.js:450-455` — the exclusion only follows `linkedWidgets`, a shape rgthree's Seed node does not have
- `web/js/lib/run-scope-guard.js:1442-1444` — pre-dispatch canon/hash from the panel's own `app.graphToPrompt()`, which sees `seed = -1`
- `web/js/lib/run-scope-guard.js:1124-1125` — `contentOk` compares that hash against the POST body's, which carries rgthree's substituted seed
- `web/js/lib/run-scope-guard.js:1243-1244` — `{ ok:false, reason:"graph_changed", drift: driftTokensForBody(...) }` — the exact reported error
- `web/js/lib/run-scope-guard.js:1688-1689` — `graph_changed` with 0 verified is terminal
- `web/js/lib/scoped-batch-seed.js:167-170` — quoted rgthree source: it splices the built-in `control_after_generate` widget out, so no `beforeQueued` carrier exists
- `web/js/lib/scoped-batch-seed.js:181-183` — measured: substitution happens in rgthree's `api.queuePrompt` patch, not in queue-time widget hooks
- `web/js/lib/scoped-batch-seed.js:177-179` — measured: three consecutive posts carried three different seeds and the widget stayed `-1`
- `web/js/lib/scoped-batch-seed.js:286-290` — quoted handler: `outputInputs[this.seedWidget.name || "seed"] = seedToUse;`
- `web/js/lib/scoped-batch-seed.js:192-197` — `RGTHREE_SPECIAL_SEEDS`: `-1` randomize, `-2` increment, `-3` decrement
- `web/js/lib/scoped-batch-seed.js:200-203` — existing `isRgthreeSeedNode` predicate (currently module-private)
- `web/js/lib/queue-prompt-chain.js:15` — measured on live 1.48.7: rgthree shadows `api.queuePrompt` with an own property
- `web/js/comfyui-mcp-panel.js:12912-12920` — `graph_run`'s only scoped path is `dispatchScopedRun`
- `web/js/comfyui-mcp-panel.js:12877-12886` — `findRgthreeSeedNodes` is already called on the run path, but only when `batch > 1`, purely for the #1339 note
- `web/js/comfyui-mcp-panel.js:13053-13063` — the `drift_coverage.uncovered_inputs` disclosure channel that already publishes every excluded input
- `browser_tests/unit/run-scope-guard.test.mjs:283-346` — tests pin the `beforeQueued`/`linkedWidgets`-only detection, including the fixed-carrier gate

### Fix
Teach `collectVolatileInputs` (`run-scope-guard.js:427-462`) a second volatility source alongside `beforeQueued`: an ARMED rgthree seed node. Inside the existing walk, for each node where `isRgthreeSeedNode(node)` and the seed widget's numeric value is one of `-1/-2/-3`, add the pair `${execId} ${seedWidget.name || "seed"}` — using the widget's real name, per the quoted handler — and use the same flattened colon `execId` the walk already builds so nested-subgraph pairs line up with prompt keys.

Export `isRgthreeSeedNode` + the sentinel map from `scoped-batch-seed.js` (or lift both into a shared module) rather than re-deriving the predicate; `scoped-batch-seed.js:192-203` is already the repo's single source of truth. Armed-ness must GATE the exclusion exactly as `w.value === "fixed"` does at `:446`: a concrete (unarmed) rgthree seed is submitted verbatim, never drifts, and must stay drift-covered so a real mid-window edit still refuses. Also skip muted/bypassed nodes (`node.mode === 2 || 4`), which rgthree's own handler returns early for (`scoped-batch-seed.js:270-275`).

Then update the ACCEPTED RESIDUAL note (`run-scope-guard.js:415-425`), the module header's exclusion-rule text (`:66-87`, `:214-220`), and the `drift_coverage.note` at `comfyui-mcp-panel.js:13058-13062`, which today says "queue-time hook inputs (beforeQueued…)" and would silently under-describe the new source. Add tests mirroring `run-scope-guard.test.mjs:296-346`: armed seed ⇒ pair excluded; fixed/concrete seed ⇒ NOT excluded and a mid-window edit still refuses; nested subgraph colon path; and a hash-level test that an edit to any OTHER input of the same rgthree node still refuses as drift.

Do NOT pursue the reporter's "capture the post-queue-hook graph once and dispatch that serialization" — rgthree's substitution happens per `api.queuePrompt` call and is non-idempotent (new random each post, widget unchanged), so no single capture matches what actually posts. A "serialize twice and diff" heuristic would not catch it either, since both pre-dispatch `graphToPrompt()` calls return `-1`.

### Risk
This relaxes the #556/#659 content-drift guard, whose exclusion mechanism was built for #572. Named justification: the excluded value is one rgthree OVERWRITES on every post, so the panel can never predict it — hashing it can only produce false refusals, never catch a real edit, and a user edit to an armed seed widget is overwritten before dispatch and therefore is not part of what executes (the same argument `run-scope-guard.js:249-256` already makes for JSON-invisible values). The relaxation is per-node + per-input and is disclosed through the existing `drift_coverage.uncovered_inputs` channel.

Residuals: (1) `isRgthreeSeedNode` matches `/rgthree/i && /seed/i` on `node.type`, so a coincidentally-named third-party node whose seed is NOT rewritten would lose drift coverage on that one input — the sentinel gate narrows this but does not eliminate it; (2) keying on *armed* rather than *varies* is deliberate — the #1339 degenerate-range case (`scoped-batch-seed.js:213-249`) is about whether values REPEAT, which is irrelevant to drift and must not be conflated; (3) if rgthree also emits a `last_seed` input on some builds, that input would still drift and refuse — the field report's drift list was `"47 seed"` only, so this is unproven either way and should not be pre-excluded without measurement; (4) with the seed excluded, a scoped `batch > 1` on an armed rgthree node will now dispatch where it previously refused — intended, and already disclosed by the #1339/#988 notes. No other OPEN issue shares this cause; #572 and #659 (both closed) are the two earlier false-positive classes of this same guard, making this the third instance. Open #757 is rgthree-related but unconnected.

---

## #1215 — after a tab switch, graph reads silently serve the PREVIOUS tab's graph under the NEW workflow's stamp

**panel-side · confidence high · effort medium · code read** · see Cluster B

This is the dangerous one in the batch: it is a silent wrong answer, not a refusal.

### Root cause
The panel's own `workflow_open` repaint poisons the target tab's in-memory state and then faithfully reproduces it. After `await s.openWorkflow(target)` moves the pointer to B (`comfyui-mcp-panel.js:14210`) but before anything repaints, the executor calls `target.changeTracker.checkState()` (`:14361`) — ComfyUI's `captureCanvasState()`, which serializes the MOUNTED root (still A's canvas, complete with node-written values like rolled seeds) into the now-ACTIVE tracker, i.e. into B's `activeState`. The repaint then reads that same state (`const st = target.changeTracker?.activeState`, `:14372`) and `loadGraphData`s it (`:14472`), so all four proof parts — instance/marker/identity/content (`:14498-14508`) — are true statements about a poisoned source, and the open returns PROVEN, publishing B's `workflow_uuid` while A's graph sits on the canvas under B's stamp. `graph_outline` (`:9629-9633`) then reads `getGraphCtx()` and passes `assertGraphBoundToActiveWorkflow` honestly, because the root really does carry B's identity — the silent inverse the reporter describes.

This is #968/#1089 verbatim; the code narrates it at `:14280-14309`. The reporter's build (0.13.7) predates every mitigation: `cc5bffae` (#1001 `geometry_rewritten`, which their receipt carries) IS in 0.13.7, but `4213878c` (#968 capture guard, 0.14.5), `b53616cd`/`5994f983` (#1089 `foreign_source_state`, 0.14.15/16) and `c30a5d1c` (#1111) are NOT — which is exactly why their receipt had `geometry_rewritten` and no foreign-source warning.

On current main the reported path is closed **only when `app.graph` carries a panel tag**: `describeLiveCanvasBinding` (`:5501-5516`) returns "unknown" for an UNTAGGED root, so the capture still runs, and the resulting poisoned state is also untagged, so `describeRepaintSourceBinding` (`lib/graph-binding.js:1363-1364`) returns "unknown" and no disclosure is emitted. That residual is written down at `:14118-14122` and asserted as still-open by `open-rebind-proof.test.mjs:898`.

### Evidence
- `web/js/comfyui-mcp-panel.js:14210`, `:14280`, `:14284`, `:14348`, `:14353`, `:14361`, `:14372`, `:14472`, `:14498`
- `web/js/comfyui-mcp-panel.js:5501`, `:5508` — `describeLiveCanvasBinding` returns "unknown" for an untagged root
- `web/js/comfyui-mcp-panel.js:9629`, `:6549`, `:14939`, `:14340`
- `web/js/lib/graph-binding.js:1281`, `:1363`
- `browser_tests/unit/open-rebind-proof.test.mjs:775`, `:898` — the residual is asserted as still open

### Fix
Close the untagged-root residual at the capture gate, using evidence the function already has but never gathers: the pre-switch active workflow.

1. Snapshot `const activeBefore = activeWorkflowRef()` next to `const wasDirty = !!target.isModified` (`comfyui-mcp-panel.js:14159`) — before `await s.openWorkflow(target)` at `:14210`.
2. Change the gate at `:14354` from `if (captureBinding !== "foreign")` to require the capture's own precondition when the tag is silent: capture when `captureBinding === "bound"`, or when `captureBinding !== "foreign" && sameWorkflowObject(activeBefore, target)`; skip otherwise. `sameWorkflowObject` is already the proxy-safe comparator used at `:14421`/`:14488`. This leaves #874's population untouched — `:14315` states the capture exists for "the already-current case", which is exactly `activeBefore === target` — and removes the capture only in the configuration that produced #968/#1089/#1215.
3. Extend the disclosure to cover what remains: today `foreign_source_state` (`:14939`) requires `sourceForeign`, which needs a TAG on the source state, so the untagged case warns nobody. Add an untagged-source arm — pointer moved during this open AND the repaint source carried no resolvable identity — emitting the same "VERIFY THE GRAPH BEFORE EDITING" disclosure with weaker wording.

**Disclosure only, never a refusal**: `graph-binding.js:1288-1300` and `:1329-1334` record that refusing here strands the pointer on the target with the other workflow's uuid on `app.graph` and wedges every `graph_*` command, including the recommended `panel_load_workflow`.

Also tell the reporter to update — 0.13.7 has none of #968/#1089/#1111.

### Risk
**The gate change contradicts a recorded codex conclusion.** `comfyui-mcp-panel.js:14322-14324` says the guard "never guesses from 'did the pointer move' — that says nothing about who owns the canvas, and an earlier draft of this fix got both directions wrong with it." That objection is sound in the direction it was written (pointer-moved does not PROVE the canvas is foreign, so it must not drive a refusal) but is being used here the other way — as a REQUIREMENT for a write whose own precondition is "the mounted canvas is the target's". **Any patch must rewrite that paragraph rather than silently invert it, or the next reviewer restores the hole.**

The guard being tightened protects #874 (ChangeTracker captures on user input only, so node-written values — populated wildcards, rolled seeds — would otherwise be reverted by the repaint). Tightening costs a #874 revert in exactly one configuration: target's canvas mounted while the pointer sat on another tab (the #604/#708 divergence). In the normal pointer-moved case target's node-written values are not on the mounted canvas at all, so the capture cannot preserve them — it can only import the other tab's graph — which is why the trade is safe.

Do NOT reach for the dirty flag as a substitute signal: `open-rebind-proof.test.mjs:850-896` asserts both that `describeRepaintSourceBinding` ignores cleanliness and that the panel source does not re-introduce `wasDirty`/`isModified` at that site; it is wrong in both directions (#874 spuriously-false, cold-open spuriously-true). `canvas_file_divergence` (#968) cannot backstop this: it fires only on DISJOINT node ids and ComfyUI numbers nodes from 1, so the reporter's ids 1-13 would overlap krea2's — `:14110-14116` records that dead end. Same root cause as CLOSED #968/#1089/#1111; no OPEN issue duplicates it — open #817 and #1233 are the inverse (a wrong refusal), not this silent serve.

---

## #976 — `panel_set_widget` reports an exception after a successful MiniMaxH3Director duration write

**panel-side (observability only) · confidence medium · effort small · code read; the throwing callback could not be read on this machine**

### Root cause
The panel assigns `w.value = coerced` and then programmatically invokes the widget's OWN callback via `reflectApply(widgetCallback, w, [coerced, canvas, targetNode, targetNode.pos, undefined])` (`widget-write.js:1272-1278`); a throw there is captured (`:1279-1292`), the write is verified by read-back, deliberately NOT rolled back (#639, `:1300-1309`), and disclosed as `write_warning` + `write_warning_source: "widget_callback"` (`:1460-1479`, `:1714-1724`). That behaviour is correct and the attribution already shipped in 0.11.88 — the reporter's recurrence comment confirms it is being emitted.

The TypeError itself is **not** the panel's: every `.options` read in the panel and its libs is guarded (`asset-staleness.js:787`, `input-asset.js:285`, `node-widget-materialization.js:839`, `widget-write.js:1779`), the monolith contains no unguarded `X.options`, the panel never wraps or installs a widget callback (no `.callback =` anywhere in `web/js`), and it passes a real `canvas: app.canvas` (`comfyui-mcp-panel.js:11757`), so arg 2 is not the undefined being dereferenced.

What is still owned here is that **the panel destroys the only evidence that could close the ticket**: `describeThrown` renders `String(err.message ?? err)` and nothing else (`widget-write.js:29-38`), the Error is caught inside the lib so it never reaches the browser console, and no stack/frame is put in the result envelope — which is why the maintainer has asked the reporter twice for a stack the panel makes unobtainable, and why the same issue has now been re-filed against 0.13.7 with no more information than the first time.

### Evidence
- `web/js/lib/widget-write.js:1272-1278` — callback looked up, then invoked via `reflectApply` with `[value, canvas, node, node.pos, undefined]`
- `web/js/lib/widget-write.js:1279-1292` — catch captures `err` into `threw`; nothing logged, nothing rethrown
- `web/js/lib/widget-write.js:29-38` — `describeThrown` returns only `String(err.message ?? err)`; `err.stack` is never read
- `web/js/lib/widget-write.js:1460-1479` — composes the exact `write_warning` text quoted in the issue; message only, no frame
- `web/js/lib/widget-write.js:1714-1724` — result envelope: `write_warning` + `write_warning_source`; no stack/frame field exists
- `web/js/lib/widget-write.js:1300-1309` — the #639 note asserting MiniMaxH3Director's callback "throws on `options` of undefined on ANY programmatic invocation" — **an unmeasured claim**; the only repro was a synthetic CLIPTextEncode probe
- `web/js/lib/widget-write.js:1779`; `web/js/lib/asset-staleness.js:787`; `web/js/lib/input-asset.js:285`; `web/js/lib/node-widget-materialization.js:839` — every `.options` access in the libs is guarded
- `web/js/comfyui-mcp-panel.js:11757` — `canvas: app.canvas`, a real LGraphCanvas is arg 2
- `web/js/comfyui-mcp-panel.js:20888-20889` — the summary renders the attribution from `write_warning_source` as data, not prose-matching
- `web/js/lib/set-widget.js:368-377` — the single `applyWidgetWrite` call site; canvas/beforeChange/afterChange/setDirty are injected hooks (the lib has zero console usage by design)
- `browser_tests/unit/widget-write.test.mjs:2458-2464` — pins `/reading 'options'/` and the `^the write itself SUCCEEDED` lede; any change must keep both
- `…/custom_nodes/WhatDreamsCost-ComfyUI/js/ltx_director.js:16-21` — the shared editor's only unguarded-looking `.options` read is fenced by `if (!w) return`; `:11356-11357` attaches it to `"LTXDirector"` only
- `…/custom_nodes/WhatDreamsCost-ComfyUI/minimax_h3_director.py:83-127` — **the installed MiniMaxH3Director schema has no `duration` widget at all**; the reporter is on a different pack version, which is why the throwing callback cannot be read from this machine

### Fix
Make the throw attributable to a FILE, in `web/js/lib/widget-write.js`.

1. Extend the never-throwing describer at `:29-38` with a sibling `describeThrownFrame(err)` that reads `err.stack` inside the same try/catch totality contract and returns the first frame not inside `widget-write.js`/`set-widget.js` (browser stacks give `http://host:8188/extensions/<pack>/<file>.js:LINE:COL`).
2. Emit it as DATA in the envelope at `:1714-1724` alongside `write_warning_source`, e.g. `write_warning_frame` (single top non-panel frame) and optionally a truncated `write_warning_stack` — a stack is an observation, not an attribution claim, so unlike `write_warning_source` it can be emitted for the unattributed branch too.
3. Do NOT alter the existing `write_warning` prose (`widget-write.test.mjs:2458-2464` pins it).
4. Optionally add an injected `onWriteException(err)` hook to `applyWidgetWrite`'s options bag (same pattern as canvas/beforeChange/setDirty at `set-widget.js:368-377`) that the monolith wires to a one-shot `console.warn(err)`, so the raw Error with its clickable stack reaches the console — the libs must stay console-free.
5. Separately, soften the unmeasured assertion at `:1300-1309`. It was never measured, and this repo's own convention is that a comment like that gets quoted back later as a measurement.

### Risk
Low, and it relaxes nothing: the non-rollback decision (#639), the fail-closed rail/promotion checks (#366/#477) and the "claim only what is establishable" attribution boundary (fenced by `widget-write.test.mjs:2496-2604`) are untouched. Three real hazards:

- `err.stack` can itself be a throwing accessor on a hostile thrown value, so the frame reader must live inside the same total try/catch discipline as `describeThrown`, or the reporting path that exists to report a throw will throw.
- Stacks carry the user's host/port and local extension paths, and this text is pasted into public issues (the reporter's own body is marked "scrubbed") — emit only the URL path from `/extensions/` onward, not the full origin, and cap the length.
- The panel summary at `comfyui-mcp-panel.js:20888-20889` is i18n-checked (`scripts/i18n-check.mjs`, `i18n-prose-audit.mjs`), so rendering the frame into the chat line needs a locale key, not inline English. (`write_warning_source` is not in `vendor/tool-vocabulary.json`, so a new sibling field needs no vocabulary registration.)

Residual: if the captured frame lands inside the DaSiWa/WhatDreamsCost pack, this closes as upstream-to-the-pack (**not** the orchestrator, which the reporter's "upstream-only: yes" wrongly names — the orchestrator only relays the panel's structured result). If it lands in the ComfyUI frontend, the follow-up is whether the panel's synchronous, event-less invocation is the trigger — same family as open #757 (callbacks written for a click, invoked programmatically), not the same root cause.

---

## #654 — panel does not reconnect after `panel_restart_comfyui`

**panel-side · confidence medium · effort small · code read; the bridge-stays-up shape is untested** · see Cluster A

### Root cause
The panel only ever re-registers its bridge route by sending a `hello`, and on the ComfyUI-restart path nothing sends one unless the bridge SOCKET itself dies. `externalOrchestratorMode()` is now hardcoded `true` (`comfyui-mcp-panel.js:4146-4153`), so the orchestrator survives a ComfyUI restart and the bridge socket never closes. `onComfyReconnected` is then a no-op: its only bridge action is `connectAgent()`, gated by `shouldResumeAfterComfyReconnect`, whose first line is `if (bridgeConnected) return false` (`session-rebind.js:28`), and `isConnected()` is plain socket-OPEN (`comfyui-mcp-panel.js:19765-19767`). Even if that gate passed, `connect()` early-returns on an already-OPEN socket (`:18340-18347`), so `connectAgent()` could not produce a hello either.

The panel already owns exactly this repair — `shouldRehelloAfterCommand` re-advertises the tab after `free_vram` because a ComfyUI connection bounce "drops the orchestrator's tab mapping (the next graph tool then failed with 'Connected: none')" — but it covers only `free_vram` and justifies the omission with "exactly as the restart path re-establishes it on reconnect" (`:28193-28203`), an assumption that holds only when the bridge drops. So after a restart the tab sits on a live socket it never re-announced; `panel_set_workflow_target({mode:"current"})` and `panel_graph_outline` answer "Connected: none", and only a browser refresh recovers it (`:18395-18423` plus the mount-time REBOOT_KEY resume at `:32820-32827`).

### Evidence
- `web/js/comfyui-mcp-panel.js:4146-4153` — `externalOrchestratorMode()` hardcoded true
- `web/js/lib/session-rebind.js:20-30` — `if (bridgeConnected) return false` short-circuits the entire post-restart recovery
- `web/js/comfyui-mcp-panel.js:19765-19767` — `isConnected()` is readyState OPEN only, so it stays true right through the restart
- `web/js/comfyui-mcp-panel.js:29685-29723` — `onComfyReconnected`'s only bridge action is `connectAgent()`
- `web/js/comfyui-mcp-panel.js:18340-18347` — `connect()` early-returns while the socket is CONNECTING/OPEN
- `web/js/comfyui-mcp-panel.js:18395-18423` — `sendHello()` is reached only from a FRESH socket's `open` handler
- `web/js/lib/session-rebind.js:36-38` — `shouldRehelloAfterCommand` returns true only for `free_vram`
- `web/js/comfyui-mcp-panel.js:28193-28203` — the #310 re-advertise names the exact symptom and states the assumption that fails here
- `web/js/comfyui-mcp-panel.js:28117-28176` — `comfy_reboot` arms REBOOT_KEY and promises "I'll reconnect and pick up automatically", but never re-advertises the route
- `web/js/comfyui-mcp-panel.js:28454` — the #585 restart resume is driven by a `ready` ack, which only follows a hello
- `web/js/lib/restart-tab-identity.js:141-143`, `web/js/lib/bridge-route.js:3-7` — "A hello is what REGISTERS the route"
- `web/js/comfyui-mcp-panel.js:32820-32827` — the only restart recovery that does fire is mount-time
- `browser_tests/bridge-reregisters-after-restart.spec.ts:16` — the sole e2e coverage assumes "The orchestrator is ComfyUI's child, so a ComfyUI restart kills it"; **the bridge-stays-up shape is untested**

### Fix
Re-advertise the tab on the ComfyUI-restart path when the bridge is still up — the same non-destructive repair #310 already ships for `free_vram`, but triggered by the `reconnected` event rather than a command reply (at `comfy_reboot` reply time ComfyUI is going down, so a hello there is useless).

Add a new pure predicate in `web/js/lib/session-rebind.js` — do NOT widen `shouldRehelloAfterCommand`, whose narrowness is deliberately pinned by `session-rebind.test.mjs:75-78` — e.g. `shouldReadvertiseAfterComfyRestart({ bridgeConnected, outageMs, alreadyReadvertised })`, true only when the bridge stayed connected, the backend outage was long enough to be a real restart rather than a blip, and no re-advertise has fired for this restart. Call it from `onComfyReconnected` (`comfyui-mcp-panel.js:29685-29723`) on the branch that currently returns early, invoking `client?.rehello?.()` — not `connectAgent()`, which is a no-op on an OPEN socket. Reuse the existing outage measurement shape (`createBridgeOutageTracker` / `shouldNudgeAfterMidTaskReconnect`, `session-rebind.js:86-215`) rather than inventing a second clock, and measure on `monotonicNow()`. Unit-test the predicate; extend `browser_tests/bridge-reregisters-after-restart.spec.ts` with a second shape where the mock bridge stays UP across the restart and assert a fresh hello carrying the same composed `wf:<tabRouteId>:<path>` route arrives.

### Risk
This must NOT be implemented by relaxing `shouldResumeAfterComfyReconnect`'s `if (bridgeConnected) return false` — that guard is #278's, and it exists so a benign ComfyUI WS blip (asset view, image check, tab refocus — see `comfyui-mcp-panel.js:29692-29697`) cannot bounce or respawn a live agent session. The fix adds a separate, cheaper action on that branch; the gate stays exactly as strict.

Second hazard: a hello is a full re-greeting and bumps `agentSessionEpoch` (`:19371-19379`), invalidating #291's `canvasToolsProvenEpoch` and drawing a fresh `ready` ack that drives `handleRebootResumeAck` (`:28454`). That is the desired install→restart→continue behaviour, but an ungated version would re-greet on every benign blip — the same storm the title-update path was split out to avoid (`:19473-19477`). So it must be one-shot per restart and gated on a measured outage.

Third: in deployments where the bridge DOES drop, the socket-open handler already sends a hello; firing a second from `reconnected` would produce two greetings and two ready acks, which is #1138's false-nudge-into-a-live-session harm — suppress when a hello has already landed since the outage began. Related but distinct: #1096 ("Connected: none" after a plain bridge drop on a `tmp:` route) should be re-checked after this lands, but its trigger is a socket drop, not a restart.

---

## #1098 — saving a new workflow can trigger UUID mismatch and unresponsive `workflow_open`

**panel-side · confidence medium · effort medium · code read; which await hung is not provable from the report**

### Root cause
The bridge gives `workflow_open` a 15,000 ms budget (orchestrator `src/orchestrator/panel-tools.ts:4082-4083`), and the panel writes a reply only after `await executor(msg)` settles (`comfyui-mcp-panel.js:18966`, delivered at `:19018`) — so a `workflow_open` that never settles is exactly the reported "did not reply to workflow_open within 15000 ms", and it is also unrecoverable, because `noteOpenAttempt` runs only at the end (`:14832`) or from `failOpen` on a throw, while the orchestrator's verify-after-timeout recovery requires a rid-correlated `last_open` receipt (`panel-tools.ts:1560-1613`) — hence "no correlated reply".

`workflow_open` has no end-to-end deadline at all: `s.syncWorkflows()` (`:14062`), `s.openWorkflow(target)` (`:14210`), both `app.loadGraphData` awaits (`:14472`, `:14750`) and `clearSpuriousOpenModified` → `await nextFrame()` (`:5609` → `:5581`, a bare `requestAnimationFrame`) are unbounded.

The Save-As is what steers the recovery open into that last branch deterministically: the Save-As adapter opens/activates the copy so it has a `changeTracker` (`workflow-save.js:1044-1060` ⇒ `wasOpen` true) and `markCopyPersisted` leaves `isModified` false (`:1764-1818` ⇒ `wasDirty` false), so the gate at `comfyui-mcp-panel.js:14595-14604` fires and the executor parks on an rAF — which browsers do not run in a hidden/background tab, a hazard this repo documents and regression-tests for the chat typewriter (`comfyui-mcp-panel.js:26366`, `browser_tests/hidden-tab.spec.ts:1-24`) but never applied here. Because that await sits inside `beginWorkflowReloadStep` (`comfyui-mcp-panel.js:14602`), `pending > 0` also stops the guard's 30 s ceiling from ever expiring (`comfyui-mcp-panel.js:673-674`, `:728-738`), so every later command is refused with "the panel is switching/refreshing …" (`comfyui-mcp-panel.js:18764`) and the canvas stays frozen — the "unresponsive" in the title.

The first half — `root-workflow-uuid-mismatch` on the `panel_run` right after the Save-As — is already understood and disclosed by current code (`web/js/lib/save-reply-identity.js:60-88`): Save-As moves the active pointer without asking for a repaint, and the save reply says so and names `panel_open_workflow` as the remedy.

### Evidence
- `web/js/comfyui-mcp-panel.js:5581` — `nextFrame()` is a bare `requestAnimationFrame` with no timer race and no `document.hidden` fallback
- `web/js/comfyui-mcp-panel.js:5609` — `clearSpuriousOpenModified` awaits that frame before its re-baseline; `:5614` — the `stillOwns()` re-check sits AFTER the frame (pinned by `command-liveness.test.mjs:369-380`)
- `web/js/comfyui-mcp-panel.js:14595-14604` — the open re-baselines only when `!wasDirty && priorInteraction !== null && ownsWorkflowReloadGuard(...)`, i.e. exactly the just-Save-As'd tab
- `web/js/comfyui-mcp-panel.js:13952` — `workflow_open` executor; no end-to-end deadline anywhere in it
- `web/js/comfyui-mcp-panel.js:14062`, `:14210`, `:14472`, `:14750` — the four unbounded awaits (`:14750` is explicitly documented as unbounded)
- `web/js/comfyui-mcp-panel.js:7325` — `RESTORE_LOAD_BUDGET_MS = 15000`: the repo already bounds the equivalent `loadGraphData` elsewhere because "a hung load would lock the user out forever, silently"
- `web/js/comfyui-mcp-panel.js:18966`, `:19018` — the reply is composed and delivered only after the executor settles
- `web/js/comfyui-mcp-panel.js:14832` — the open receipt is journaled only after all the awaits, so a mid-executor hang leaves nothing for rid-correlated recovery
- `web/js/comfyui-mcp-panel.js:673-674`, `:728-738` — the reload guard can never age out while `pending > 0`; `:18764` — every executor is then refused
- `web/js/comfyui-mcp-panel.js:26366` — `commitStream()` already takes a synchronous path when `document.hidden`; `browser_tests/hidden-tab.spec.ts:1-24` — the repo's own regression test for "rAF never fires in a hidden tab"
- `web/js/lib/workflow-save.js:1044-1060` — the Save-As adapter MUST `openWorkflow` the copy ⇒ `wasOpen` true; `:1764-1818` — `markCopyPersisted` clears `isModified` ⇒ `wasDirty` false
- `web/js/lib/save-reply-identity.js:60-88` — #978: Save-As does not request a repaint, so the following graph command legitimately hits the mismatch
- `C:/Users/Artokun/code/comfyui-mcp/src/orchestrator/panel-tools.ts:4082-4083` — 15000 ms budget; `:1560-1613` — verify-after-timeout fires only on a rid-correlated `last_open`

### Fix
Land it in `workflow_open` (`comfyui-mcp-panel.js:13952`), in three parts.

1. **Bound `nextFrame()`** at `:5581` — race the rAF against a short timer, or take the timer path outright when `document.hidden`, mirroring `commitStream` at `:26366` and the rule `hidden-tab.spec.ts` already pins. The `stillOwns()` re-check at `:5554` still protects the re-baseline, and the only cost (the post-load capture may not have landed, so the tab may keep a spurious `isModified`) is one the code already accepts by design for the un-frozen first-time open.
2. **Give the whole executor an end-to-end budget** sized inside the bridge's **15 s** for this command — note the panel's other bounds are sized against an assumed 30 s command budget (see `:771-774`), which is a real drift worth fixing at the same time — and on expiry journal `noteOpenAttempt({applied: "unknown", error: …})` before returning a worded refusal, so verify-after-timeout has a receipt to correlate instead of silence.
3. **Where the outstanding work is a destructive load** (`:14472`, `:14750`), copy `restoreSnapshot`'s precedent at `:7325-7400`: bound the WAIT, keep the reload guard and canvas freeze until the abandoned load actually settles (`noteRestoreLoadStillRunning`), and state in the reply that a late completion may overwrite the canvas.

Add a unit test in the style of `command-liveness.test.mjs` asserting the frame wait cannot outlive its bound, and a `hidden-tab`-style spec driving `panel_open_workflow` with `requestAnimationFrame` neutered.

### Risk
Do NOT fix this by letting the reload guard age out while a step is pending (`:673-674`, `:728-738`). That rule is #442's data-loss fence — expiring mid-await drops the fence, a graph command then runs and is ACKNOWLEDGED, and the late-completing load overwrites that acknowledged edit; the code says so verbatim at `:14742-14748`. Relaxing it reintroduces #442, which is strictly worse than the wedge.

The only guard relaxed here is the rAF wait, which is not a destructive load: its re-baseline stays gated by `stillOwns()` (`:5614`) and the worst outcome of an early wake is a spurious `modified` flag, which the same function already accepts for first-time opens. A fix must keep the orderings pinned by `open-outcome.test.mjs:517-537` and `:557-582` (freeze before the first re-baseline; the failure path stays side-effect free) and `command-liveness.test.mjs:369-380` (ownership check AFTER the wait).

**Stated rather than hidden:** the report does not say whether the ComfyUI browser tab was hidden, so it is not provable WHICH unbounded await hung — a hidden tab implicates `nextFrame()`, a visible tab implicates `openWorkflow`/`loadGraphData`. Either way the fix lands in this function and part (2) covers both, but do not describe the rAF as the confirmed cause in a changelog entry.

Related, not duplicates: #1175 and #1192 are the same class (a bridged command outruns its budget and the caller gets silence or a bare timeout); #817/#1215/#1233 are the mismatch half's family; #978/#941 already disclose the Save-As mismatch itself.

---

## #584 — frontend reload keeps stale panel JS and blocks graph writes

**panel-side · confidence medium · effort medium · code read** · see Cluster A

### Root cause
The stale-bundle healer is wired to exactly one trigger — page load — and the recurring scenario has no page load in it. `healStaleBundleIfNeeded()` is defined at `comfyui-mcp-panel.js:33010` and called exactly once, from the extension's `setup()` hook (`:33173`), and it holds the only fetch of `/comfyui_mcp_panel/version` in the whole pack (`:33021`). The event that actually changes the bundle under a live tab is a pack update plus a ComfyUI restart (`panel_restart_comfyui`, Manager reboot, `install_comfyui(action:"panel")` sync), and the panel already detects that precisely — the `reconnected` listener at `:1487-1508` bumps the reconnect epoch, calls `invalidateManagerDialectCache()` (`:1500`) and `refreshComfyNodeDefs()` (`:1501`) for exactly the same "the backend restarted, my cached state is now wrong" reason — but it never re-probes the version. So the tab keeps running the JS it loaded when the page was opened, re-advertises that old `PANEL_VERSION` (`:1529`) in its hello on every reconnect, and the orchestrator's write fence refuses every mutation while reads keep working. That is the 2026-08-14 recurrence verbatim (0.11.5 → 0.14.35 staged, restarted, "panel_list_workflows reconnects successfully but the existing tab still advertises 0.11.5") and it needs no HTTP-cache theory at all.

Second, compounding defect: when the healer *does* fire, its navigation (`:33113-33120`) carries none of the #701 guards the commanded reload path has (`:30417-30423` refuse-on-unsaved, `:30447` `armReloadBlockedNotice`), while the one-shot marker is armed *before* navigating (`:33076`). A `beforeunload` cancel — the mechanism the maintainer reproduced first-hand and recorded at `__init__.py:466-467` — therefore burns the single heal attempt silently, and the next load reports the wrong reason (`comfyui-mcp-panel.js:33063-33075`).

### Evidence
> **Line refs in this section were re-derived from the symbols on 2026-08-14.** The originals were not merely stale — several were off by ~64 lines *at the commit this doc claims as its basis*, pointing into unrelated code. Every ref below was located by grepping the named symbol at `d7c7497c`.

- `web/js/comfyui-mcp-panel.js:33173` — the ONLY call site, inside the extension `setup()` hook (page load only); the function itself is defined at `:33010`
- `web/js/comfyui-mcp-panel.js:33021` — the only fetch of `/comfyui_mcp_panel/version` in the repo (grep-verified: one hit)
- `web/js/comfyui-mcp-panel.js:1487-1508` — the `reconnected` handler (`api.addEventListener("reconnected", …)` at `:1487`) invalidates the Manager dialect cache (`:1500`) and re-pulls node defs (`:1501`), but never re-probes the pack version
- `web/js/comfyui-mcp-panel.js:33013-33019` — the healer's own doc comment scopes it to `setup()`
- `web/js/comfyui-mcp-panel.js:33076` (`ssSet(BUNDLE_HEAL_KEY, marker)`) vs `:33117` (`window.location.replace(...)`) — the marker is armed before navigating, so a refused unload consumes the one attempt; `:33063-33075` — the burnt-marker branch then misattributes the failure
- `web/js/comfyui-mcp-panel.js:30417-30423`, `:30447` — the commanded reload DOES consult `unsavedReloadBlockers` and arms `armReloadBlockedNotice`; the healer at `:33010-33124` does neither
- `web/js/lib/reload-blocked.js:81-96` — the `beforeunload` wedge, reproduced on the rig: socket torn down first, dialog second, nobody at the keyboard
- `__init__.py:464-467` — **measured**: ComfyUI 0.31.1 already answers `Cache-Control: no-store` on every `/extensions/` path, and what was reproduced as "staleness" was a reload CANCELLED by the unsaved-changes prompt
- `__init__.py:485` + `browser_tests/unit/asset-revalidation.test.mjs:46` — the header backstop is scoped to the literal prefix `/extensions/comfyui-mcp-panel/`, so it is a no-op for an install directory named otherwise (issue #1229 reports `custom_nodes/comfyui-agent-panel/`)
- `web/js/comfyui-mcp-panel.js:1529` = `"0.14.40"` and `pyproject.toml:4` = `0.14.40` — in sync, so a systemic false-stale verdict is ruled out
- `web/js/comfyui-mcp-panel.js:33004-33007` — the structural floor: a bundle older than the healer cannot run it (the 0.11.5 tab is in that class)
- `browser_tests/unit/bundle-version.test.mjs:173-206` — existing source-level pins on the healer that any new trigger must not break

### Fix
Two changes, both in `web/js/comfyui-mcp-panel.js`.

1. **Add the missing trigger**: in the `reconnected` listener (`:1487-1508`), alongside `invalidateManagerDialectCache()` / `refreshComfyNodeDefs()`, call `void healStaleBundleIfNeeded()`. The version route reads `pyproject.toml` at request time (`__init__.py:562-580`), so post-restart it reports the new version; a probe that 404s/500s during a restart window stays "unknown" and does nothing (`bundle-version.js:36-40`) — do not touch that verdict. Consider the same call on bridge (re)connect/hello, which also covers a Manager in-place update with no restart (#1229's shape).
2. **Give the healer's navigation the #701 guards** the commanded path already has: before `ssSet(BUNDLE_HEAL_KEY, marker)` (`:33076`), compute `unsavedReloadBlockers(app?.extensionManager?.workflow?.openWorkflows)` (imported at `:73`, used the same way at `:18680`) — if non-empty, do NOT arm the marker and do NOT navigate; `console.warn` + `appendSystem(reloadWouldBeBlockedMessage(blockers))` so the human and the agent both learn the tab is stale and why it was not reloaded. If empty, arm `armReloadBlockedNotice({ notify })` before `location.replace` (mirroring `:30447`) and clear `BUNDLE_HEAL_KEY` on that notice's fire-path only.

Pin both with source-level asserts in `browser_tests/unit/bundle-version.test.mjs` in the style of `:173-206` (probe reachable from the reconnected handler; blockers consulted before the marker is armed).

### Risk
The reload-loop guard at `:33063-33075`/`:33076-33082` exists because a reload decided on absent evidence loops forever (codex gate round 3). The only relaxation proposed is clearing `BUNDLE_HEAL_KEY` on the `armReloadBlockedNotice` fire-path, which is safe for the reason `reload-blocked.js:20-25` states — a successful navigation destroys the document before the timer fires, so that branch runs only when the unload was provably cancelled, and the healer still attempts at most one navigation per page load. Do NOT relax "unknown ⇒ never reload" (`bundle-version.js:30-34`, pinned by `bundle-version.test.mjs:33-41`): a restart-window probe legitimately fails.

A reconnect-triggered reload interacts with #646/#663 — it must not fire while `comfyBackendSocketDown` is true or while a graph mutation/turn is in flight, or it will destroy the tab mid-command; gate it on the same signals the settle watch uses. It must never suppress `beforeunload` (`reload-blocked.js:93-95`).

**Honest limit**: this cannot heal a tab whose loaded bundle predates the healer (`:33004-33007`) — including the 0.11.5 tab in the 2026-08-14 recurrence — so those still need Ctrl+Shift+R, and making that advice correct is #1229's job (orchestrator-side; it currently tells the agent to `sync` when disk is already newer than the running bundle). Same root-cause family as #1229; not a duplicate, since that issue is the messaging half. Secondary and separable: the `_ASSET_PREFIX` literal (`__init__.py:485`) makes the header backstop a no-op for installs whose `custom_nodes` directory is not named `comfyui-mcp-panel`.

---

## #1181 — PrimitiveNode values lost across subgraph inputs

**panel-side (the misleading claim only) · confidence medium · effort medium · code read; the upstream loss is not verified against a captured prompt**

Read this one carefully before scheduling it: the reported *value loss* is upstream and cannot be fixed here. What is fixable here is that the panel currently asserts the exact opposite of the truth about it.

### Root cause
The panel does not build the prompt (`graph_run` hands it to `app.queuePrompt`, `comfyui-mcp-panel.js:12648`/`:12901`), so the value loss happens in ComfyUI's own `graphToPrompt`. But the reported harm — "canvas state and actual execution prompt disagree, silently" — is manufactured entirely in this repo, by one unconditional claim.

`linkDrivenWidgets` (`lib/graph-read.js:46-60`) decides a widget is link-driven from `inp.link` and the link's `origin_id` alone; it never looks at the origin NODE. `summarizeNode` then emits that map as `driven_by_link` under the flat assertion "names here are OVERRIDDEN by a link at run time — the value in `widgets` is the stale stored value, NOT what executes" (`comfyui-mcp-panel.js:8649-8651`), and the outline/compact rows repeat it as `[⚠ link-driven #N.0]` (`:9800`, `:10233`, `graph-read.js:75-78`). For a virtual `PrimitiveNode` origin that assertion is exactly backwards: the stored inner value is what executes and the link carries nothing.

The panel already owns the predicate that would catch it — `FRONTEND_ONLY_NODE_TYPES` at `lib/node-resolve.js:63-68` lists `PrimitiveNode` — and never consults it on the read path. The run preflight cannot catch it either: `unrunnableNodeIds` only flags serialized entries with no `class_type` (`lib/missing-node-preflight.js:36-57`), and a virtual node that `graphToPrompt` DROPS leaves no entry at all, so the run passes clean and reports success.

### Evidence
- `web/js/lib/graph-read.js:46-60` — `linkDrivenWidgets` reads only `inp.link` → `l.origin_id`/`origin_slot`; the origin node is never inspected, so a virtual/frontend-only source is indistinguishable from a real one
- `web/js/comfyui-mcp-panel.js:8649-8651` — the false claim, emitted unconditionally as `driven_by_link`
- `web/js/comfyui-mcp-panel.js:8624` — `const drivenByLink = drivenWidgetsFor(node, Object.keys(widgets))`
- `web/js/comfyui-mcp-panel.js:8567-8581` — `summarizeNode`'s `inputs[].connected_from` reports the PrimitiveNode as the source with no caveat
- `web/js/comfyui-mcp-panel.js:9777,9725` and `:10228,10158` — outline and compact rows repeat the tag
- `web/js/lib/graph-read.js:7-10,75-78` — the ⚠ link-driven tag's documented meaning is "its stored value is stale"
- `web/js/lib/node-resolve.js:63-68` — `FRONTEND_ONLY_NODE_TYPES` already contains `"PrimitiveNode"`; the exact predicate exists and is unused on this path
- `web/js/lib/missing-node-preflight.js:36-57` and `web/js/comfyui-mcp-panel.js:12661-12711` — the only prompt preflight is the `class_type` check, so a DROPPED virtual node produces nothing to refuse
- `web/js/comfyui-mcp-panel.js:13144-13178` — the #985 disclosure block (live-graph read, `accept.disabled_outputs_*`, swallow-all try/catch): the precedent and the insertion point
- `web/js/lib/muted-subgraph-outputs.js:16-20` — "the panel does not build this prompt and cannot quietly fix it. What it CAN do is stop being silent about it"
- `web/js/lib/widget-write.js:568-576` — `resolveHostPromotedWidgets` returns `[]` when `hostInput.link != null`, so a write on the ENCLOSING subgraph node fails closed in exactly this configuration
- `web/js/lib/set-widget.js:430-478` — the #1087 warning tells the caller a write to the inner widget "will NOT change the render" and to set it on the enclosing subgraph node instead; **in this configuration both halves are wrong** — the inner write is the only one that works, and the enclosing one is refused by `widget-write.js:576`

### Fix
Add a read-only detector (new lib, e.g. `web/js/lib/virtual-source-promotion.js`, unit-tested like `muted-subgraph-outputs.js`) that walks the live graph for links whose ORIGIN node is frontend-only/virtual and cannot relay a value — reuse `FRONTEND_ONLY_NODE_TYPES` (`node-resolve.js:63-86`) — **note there is no `isFrontendOnlyNodeType` export; the type-set is the only membership test that takes a bare type string, while `isFrontendOnlyRegisteredType(registry, type)` and `isAuthorizedFrontendOnlyType(registry, type, node)` both need the registry** — plus "`node.isVirtualNode === true` AND has no inputs to forward through" — and whose TARGET is a promoted host input on a subgraph container (`target.subgraph` present AND the input carries `_widget`/`_subgraphSlot`, per `widget-write.js:565-599`).

Wire it into three places:
1. `summarizeNode` — for such entries, replace the blanket #607 text with a per-entry qualifier naming the source as non-serializing and pointing at the inner widget as the value that actually executes; same for `inputs[].connected_from`.
2. `graph_run` — add it inside the existing #985 try/catch at `:13157-13178` as `accept.virtual_source_note`, so a run that will silently ignore the primitive says so at QUEUE time. Do NOT exempt scoped runs — unlike #985 this is not about execution roots.
3. `set-widget.js:465-478` — when the driving link's origin is such a source, invert the #1087 advice.

Do NOT push the primitive's value into the inner widget during flattening: a read/run path silently mutating widgets is the class of thing #979/#233 exist to forbid, and `unpack-promoted-values.js` only does it on an explicitly destructive, disclosed operation.

### Risk
Relaxes one guard: the #1087 link-driven warning in `set-widget.js:465-478` would be suppressed/inverted for virtual-origin drivers. #1087 exists because writing a widget fed by a promoted rail reported `{previous:14, value:10}` and the queue still sampled at 14 — its premise is "the value arriving on that link is what serializes". When the origin is a virtual node `graphToPrompt` drops, nothing arrives, the premise is false, and the current advice steers the agent to a write that `widget-write.js:576` then refuses (#366 fail-closed, which must NOT be relaxed — the rail is not authoritative here either). The carve-out is narrow (origin-type predicate only) so #1087's measured parent→inner case is untouched; verify by mutation that the #1087 test stays red when the carve-out is over-broadened.

Second risk is over-warning, the same trade #985 accepted explicitly (`muted-subgraph-outputs.js:36-40`): on a future frontend that resolves virtual sources through subgraph boundaries, this warns about a run that was fine. Third, do not identify the TARGET with `isVirtualSubgraphContainer()` — `node-resolve.js:278` returns true for anything with `isVirtualNode === true`, which includes the PrimitiveNode itself; require `node.subgraph` explicitly. No write-authorization path changes, so the #458/#496 fail-closed posture around `FRONTEND_ONLY_NODE_TYPES` is untouched (consulted here as a read only).

---

## Not actionable yet

Four items where the next step is an observation or a different repo, not a patch here. Each line names exactly what would unblock it.

### #701 — `panel_reload(scope:'frontend')` drops the tab socket; `workflow_open` cannot recover "live graph out of sync"
**Verdict: orchestrator-side. Unblocked by: work in `artokun/comfyui-mcp` (`src/orchestrator/panel-tools.ts` + ui-bridge), not by anything in this repo.**

The reporter's "upstream-only: yes" was wrong about defects (1) and (2) — both were panel-produced — but **both are now fixed here**. Defect (2)'s mechanism was `softReload("agent","frontend")` ending in `window.location.replace`: ComfyUI's unsaved-work `beforeunload` cancels the navigation, but the browser tears the WebSocket down BEFORE raising the modal, and the modal blocks the tab's whole JS loop, so nothing panel-side can reconnect (`web/js/lib/reload-blocked.js:81-96`). That is now refused up front on the agent path and the refusal is reported on the `soft_reload` REPLY itself (`comfyui-mcp-panel.js:18669-18688`, `:30407-30422`). Defect (1)'s "remedy does not remedy" loop — ChangeTracker re-baselines only after a command SUCCEEDS, so the refusal blocks the repair that would clear it — is documented under #701 and remedied by #803/#663/#720 (`empty-baseline-deadend.js:32-48`, `:81-94`; `graph-binding.js:2266-2271`, `:2306-2395`).

What remains is upstream: `panel_reload({scope:'orchestrator'})` is dispatched as a `soft_reload` frame over the tab socket, and this pack cannot substitute — `/comfyui_mcp_panel/reload` is a by-design 503 because the orchestrator runs out-of-band (`__init__.py:713-726`) — and the truncated `wf:workf` in `did not reply to "<cmd>"` is composed by ui-bridge, which does not exist in this repo (no such string here, and no routing-key truncation anywhere in the tree).

Upstream work order: (a) handle `scope:'orchestrator'` in-process (respawn/exec the orchestrator) instead of dispatching to a possibly-dead tab socket; (b) print the full tab id in `Panel tab <id> did not reply to "<cmd>" within N ms`, the way the `no connected tab with id "..."` message already does — the panel never truncates routing keys (`bridgeRouteId`, `comfyui-mcp-panel.js:3222-3232`, emits the whole `wf:<path>` string); (c) optionally teach the orchestrator that `scope:'frontend'` can now return `reloadWouldBeBlockedMessage` text instead of "scheduled" (`:18683`) and surface it as a terminal refusal.

Do NOT add a panel-side age cap to `last_open`: the reporter's fifth ask conflicts with #402's dropped-open recovery, and the receipt already ships its own reading rule ("answers ONLY for the command whose id equals rid"). **Upstream risk to carry over:** moving `scope:'orchestrator'` off the tab socket bypasses the panel's interlock — `softReload`'s orchestrator branch sets `SOFT_RELOAD_KEY` + `setSoftReloadGuard` and drives `performSoftReloadRecovery` (`:30452-30520`), which is what makes the fresh orchestrator resume the session and stand auto-respawn down. An out-of-band respawn that skips it will either start a FRESH session or race the panel's auto-respawn `/connect` — the #379/#419 storm. Also do not relax `reload-blocked.js:105-108` (only `isModified === true` blocks): that fail-open keeps `panel_reload` usable on frontends that do not expose the field.

### #976 — the throwing widget callback
**Unblocked by: the raw stack frame from the reporter's browser, or the pack version that actually has a `duration` widget.**

The installed `WhatDreamsCost-ComfyUI/minimax_h3_director.py:83-127` has no `duration` widget at all, so the throwing callback cannot be read from this machine and the "throws on ANY programmatic invocation" claim at `widget-write.js:1300-1309` remains unmeasured. Note the twist: **the fix hint in the #976 section above is precisely the work that makes the missing observation obtainable** — the panel currently discards `err.stack`, which is why two rounds of asking the reporter have produced nothing. Ship the frame capture, then re-ask. Until a frame lands, the final verdict (pack vs. ComfyUI frontend) cannot be assigned, and the ticket should not be closed as upstream.

### #1098 — which unbounded await hung
**Unblocked by: one observation — was the ComfyUI browser tab hidden/backgrounded when `workflow_open` stopped replying?**

Hidden implicates `nextFrame()` (`comfyui-mcp-panel.js:5581`); visible implicates `openWorkflow`/`loadGraphData`. The fix lands in the same function either way and part (2) of the fix covers both, so this is schedulable now — but the changelog and the issue close must not name the rAF as the confirmed cause without that answer.

### #1181 — is the value loss actually upstream?
**Unblocked by: a captured `graphToPrompt` output for the reporter's graph showing the PrimitiveNode dropped and the promoted input carrying no value.**

The panel-side half (the backwards `driven_by_link` assertion) is provable from source and actionable now. The upstream half is inferred from the fact that the panel does not build the prompt, not from a captured prompt. Confirm before filing anything upstream, and before wording the new `virtual_source_note` as a statement about what ComfyUI does.

### Also worth noting
- **#584's tail** cannot be closed here at all for tabs whose loaded bundle predates the healer (`comfyui-mcp-panel.js:33004-33007`) — including the 0.11.5 tab in the 2026-08-14 recurrence. Correcting the advice those users get is **#1229**, orchestrator-side.
- **#1172** is listed as actionable because closing it is the action: it needs one confirmation, the reporter re-running their steps on >= 0.14.34. No code.
- **#817 is NOT in that category any more.** It was originally listed here alongside #1172 as "closing it is the action". Re-reading the thread found three recurrences on 0.14.24, so the ancestry check retires the original mechanism but not the ticket. See the correction at the top of the #817 section.

---

## Re-verification log — 2026-08-14, main at `d7c7497c`

Per-issue outcome of checking each diagnosis against current code and current GitHub state. "Still accurate" means the cited code is byte-identical at `d7c7497c` to what was read at `b84cb37c` **and** the issue is still open.

| Issue | GitHub state | Verdict |
|---|---|---|
| #813 | **CLOSED** (completed, 2026-08-14 22:58Z) | **already-fixed** — `c5293380` / PR #1239, shipped v0.14.40. Diagnosis confirmed by the landed fix; proposed patch superseded (see section) |
| #1172 | open | still accurate — fix confirmed in tree at `asset-staleness.js:901-916`; ancestry re-checked |
| #817 | open (REOPENED) | **corrected** — "verify and close" withdrawn; three recurrences on 0.14.24 |
| #757 | open | still accurate — `widget-write.js:923-931` still throws with no creation branch |
| #1124 | open | still accurate — `run-scope-guard.js:441` is still the only volatility signal |
| #1215 | open | still accurate — `comfyui-mcp-panel.js:14361` capture and `:14354` gate unchanged |
| #976 | open (REOPENED) | still accurate — `describeThrown` still renders `String(err.message ?? err)` and never reads `err.stack` |
| #654 | open (REOPENED) | still accurate — `session-rebind.js:28` gate unchanged; a fresh duplicate landed 2026-08-14 on panel 0.14.34 |
| #1098 | open | still accurate — `nextFrame()` at `:5581` is still rAF with no `document.hidden` path |
| #584 | open (REOPENED) | mechanism still accurate; **line refs corrected** — several were wrong when written, not stale |
| #1181 | open | still accurate; **one symbol name corrected** (`isFrontendOnlyNodeType` does not exist) |
| #701 | open (REOPENED) | still accurate — `__init__.py:713-726` is still the by-design 503 |

**Could not verify:** nothing was left unchecked. The two claims that remain unmeasurable are the ones the doc already labels as such and that no amount of code reading can settle — #976's throwing pack callback (the installed `minimax_h3_director.py` still has no `duration` widget) and #1181's upstream `graphToPrompt` loss (still no captured prompt). Both stay flagged in their sections.

**Mechanical corrections applied:** ~174 `file:line` references re-pointed at `d7c7497c` and content-verified (main moved `comfyui-mcp-panel.js` by +230 lines); a tool name removed in 0.50.0 was replaced with its `install_comfyui(action:"panel")` successor, and a hypothetical `panel_*` tool name was reworded away — both were failing `scripts/check-tool-vocabulary.mjs` and therefore `npm run test:unit`, which this branch did not pass as submitted.