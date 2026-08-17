# #992 — a dropped LATENT fan-out link: four mechanisms eliminated

**Status: negative result. No code change, deliberately.**
Refs artokun/comfyui-mcp-panel#992 — still OPEN, blocked on the reporter since 2026-08-10.

This document exists so nobody re-investigates these four mechanisms. Its value is entirely in
its accuracy, so every claim below is labelled with **how** it was established — measured on a
rig, or reasoned from source. An elimination reached by reading code is a hypothesis, not a
proof, and an elimination measured against code that has since moved is no longer about the
code that ships.

## The report

Panel `0.11.43`, ComfyUI `0.31.1`, frontend `1.48.7`.

`VAEEncode` (140) `LATENT` fanned out to three `KSampler.latent_image` inputs (142, 145, 148).
All three `panel_connect` calls returned success. By queue time the **first** was gone —
`Required input is missing (latent_image)` on node 142 — while 145 and 148 were intact.
Re-issuing the identical connect worked *and persisted*.

The one fingerprint: node 142's `size` changed on its own, `270x262 → 392x286 → 392x262`. No
other node in the sequence changed geometry.

## What was MEASURED

On a live canvas (ComfyUI `0.31.1` / frontend `1.48.7` — the reporter's build), against the
panel at commit `2701103` (`0.11.90`), on 2026-08-10. The exact shape was rebuilt and each
candidate run against it:

| # | mechanism | links after |
|---|---|---|
| 1 | the reported sequence: 3 connects, then 4 `set_widget` on KSampler #1 | **3/3 intact** |
| 2 | `reapplyDefsToLiveNodes` — re-applies `/object_info` to live nodes | 0 changed, **3/3 intact** |
| 3 | `refreshComboOptionsFromDefs` — the path a `scheduler` write takes | 0 changed, **3/3 intact** |
| 4 | `app.registerNodesFromDefs` — full re-registration, what `panel_refresh_nodes` drives | **3/3 intact** |

Node sizes stayed `270x262` throughout all four. **None of the four resizes a node**, so none of
them reproduces the reporter's only fingerprint.

## What was REASONED, not measured

The reframing — that `panel_connect` did not lie — was established by **reading the shipped
verification**, not by executing it against a failing case. It is sound, but it is source
reading:

`graph_connect` does not report success on LiteGraph's return value; that was #397 and it was
fixed. `isLinkPersisted` (`web/js/lib/connect-verify.js`) requires **both** that
`graph.links[link.id]` still exists **and** that the target input at that slot back-references
*that same* link id, checked synchronously, failing closed on any missing or mismatched piece.
The success payload in `graph_connect` is unreachable unless that check passed — the failure
branch throws. There is also a phantom-cleanup path (`removePhantomLink`) for the debris of a
failed attempt, which deliberately never deletes a link a dynamic node re-slotted.

So the payload was accurate when issued: **the link existed, and was destroyed later.** The
reporter's own retry evidence fits — if connect were unreliable the retry would be a coin
flip; if something destroyed the first link, a retry succeeding is exactly what you expect.

### This is now pinned to the reporter's own build

The original claim compared against current source, which does not establish what *the
reporter* was running. Checked since (measured, by blob identity):

`web/js/lib/connect-verify.js` is blob `5fae91a2` — **byte-identical** in the reporter's
`0.11.43` (release commit `a1ac583f`, 2026-08-07), at this branch's merge-base, and on `main`
today. The call site `if (!isLinkPersisted(graph, target, inIdx, link))` was wired in `0.11.43`
as well. The module landed 2026-07-31 in `d5787d69`, which is an ancestor of `a1ac583f`.

So the check the whole argument rests on was genuinely running in the build that failed.

> **Trap worth recording:** `git tag --contains d5787d69` reports the earliest containing tag
> as `v0.11.83`, which reads as "not in 0.11.43". That is wrong — this repo has only 21 tags
> and tagging began at `v0.11.83`, so `0.11.43` has no tag at all. Version questions here must
> be settled by ancestry against the **release commit**, never by tag containment.

## Re-checked 2026-08-14 — what has gone stale

`main` moved 189 commits touching `web/` between the branch point and this re-check. Two
eliminations no longer describe the code that ships.

**Elimination 2 is STALE.** `67e05b53` — `fix(1172)`, landed 2026-08-14 — added a
`refreshComboOptionsFromDefs(...)` call *inside* `reapplyDefsToLiveNodes`. The commit's own
comment states the sweep previously "never touched `options.values`". The function measured on
2026-08-10 is therefore **not** the function shipping today; it now rebuilds every combo
widget's option array on every node it visits.

The conclusion is *probably* unchanged — combo rebuilding writes `w.options.values` and widget
values, never `node.inputs` or `graph.links` — but that sentence is **reasoning**, and it has
replaced a measurement. Elimination 2 should be re-measured before it is relied on again.

**Elimination 4 is transitively affected.** `panel_refresh_nodes` runs `registerNodesFromDefs`
and `reapplyDefsToLiveNodes` in the same pass (`web/js/comfyui-mcp-panel.js`, the `register`
and `reapply` phases). Re-registration itself is unchanged, but the refresh path *as a whole*
now includes the changed sweep, so the row above understates what that command does today.

**Elimination 3 holds.** `refreshComboOptionsFromDefs` gained a fifth parameter
(`mergedInputs`, a per-type cache from #1193). The widget loop's behaviour is unchanged.

**Elimination 1 should be re-run.** `web/js/lib/set-widget.js` changed on 2026-08-11
(`fix(1087)`, the link-driven-widget warning) — after the measurement. The sequence measured is
not quite the sequence a user runs today.

**The reframing holds unchanged.** `connect-verify.js` is byte-identical to the merge-base and
to the reporter's build; nothing in the connect path's structure moved.

## A fifth mechanism, ruled out from the report itself

LiteGraph *does* silently destroy a link on connect: connecting to an input that already holds
a wire drops the previous one. The panel discloses this as `replaced_link` on the success
payload, and that disclosure was present in `0.11.43`.

`142.latent_image` was connected exactly once in the reported sequence, and that payload
carried no `replaced_link`. So replacement-on-reconnect did not destroy this link — established
from the reporter's transcript, not from a rig.

## What is still open

The node-geometry change on the one affected node remains the only fingerprint, and nothing
eliminated above resizes a node. Still needed from the reporter, and the reason this stays
open:

- The **`panel_edit_node` resize calls on 141/144/147, verbatim.** A resize is the only
  operation in the sequence that changes geometry. If one of them reached 142, that ties the
  fingerprint to the lost link and moves the defect into the *edit* path.
- Anything else between the successful connect and the failed run: a refresh, an install, a
  reconnect, a restart, or a manual canvas edit.

### Adjacent reading before re-investigating — not findings

Two modules landed since that characterise frontend rebuild behaviour in this area. Both are
*classification predicates* — they decide whether a difference counts as content loss. Neither
destroys links, and neither is a candidate mechanism. They are listed because they document
measured 1.48.7 behaviour a future investigation would otherwise re-derive:

- `web/js/lib/node-inputs-rebuild.js` (#1467) records, from `ComfyNode.prototype.configure` on
  frontend 1.48.7, that a node's live `inputs` array is **generated from the definition** on
  load rather than restored from the file — definition order, definition `name`/`type`/`shape`/
  `widget`, with unknown slots appended. Saved slot properties (including `link`) are carried
  across **by name**.
- `web/js/lib/definitions-renumber.js` (#886) records that loading a persisted workflow
  **regenerates link identity** (`state.lastLinkId` 2092 → 2106) without changing topology.

## Why this ships no fix

The obvious move is to harden `panel_connect` with a re-verification pass. That would be
ceremony aimed at the wrong mechanism: the evidence says connect is not where it breaks. It
would leave the actual link-destroyer in place, make every graph build slower, and muddy the
tool's contract — while letting the issue be closed as addressed.
