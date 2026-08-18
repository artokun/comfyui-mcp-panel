# `root-shape-mismatch`: why the root tag cannot be trusted, and why settling the tracker cannot verify

**Status:** RESOLVED — third attempt shipped (additive structural containment + the identity
conjunct, `graphRootStructureExtendsActiveWorkflow`) · **Issue:** artokun/comfyui-mcp-panel#1187 ·
**Investigated on:** `fix/1187-root-tag-outranks-tracker` (PR #1212) · **Last re-verified:** 2026-08-14

This records two fixes that were **built, reviewed and rejected**. It exists so the third
attempt does not rebuild either one. If you are about to change the `rootShapeMismatch`
expression in `web/js/lib/graph-binding.js`, read this first — both dead ends look correct,
both passed the full unit suite, and one of them was mutation-verified before it was rejected.

## The bug is real

`web/js/lib/graph-binding.js`, `resolveGraphBindingVerdict` (currently lines 2183–2185; every
line number in this document is as of the re-verification date above — search the symbol, not
the number, if they have drifted):

```js
const rootShapeMismatch =
  contentDiffers &&
  !(structureMatches && graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid }));
```

The positive tag is consulted only as a **conjunct of** `structureMatches`. A hand edit
differs structurally by definition, so `structureMatches` is `false`, the term collapses,
and the workflow's own identity stamp can never rescue the read.

Meanwhile ComfyUI's ChangeTracker captures on user-input events, so there is a window where
`activeState` reports the old node count, `_nodes` reports the new one, and `isModified` has
**not** flipped — so the dirty-tab escape hatch at `graph-binding.js:1017` does not fire
either. Every read and every mutation refuses. It self-clears once the tracker captures,
which is why it presents as intermittent rather than as the deterministic race it is.

## Attempt 1 — let the tag outrank the content comparison. Rejected, P0.

```js
const rootShapeMismatch = contentDiffers && !tagMatches;   // structure conjunct deleted
```

This fixes the reported symptom. It is still unsafe, because it deletes the **structure**
conjunct. `graph-binding.js:1117` states of that same identity+structure pair that "the
relaxation is deliberately NARROW, and both conjuncts are load-bearing", and the STRUCTURE
clause (1128–1133) says what its half buys: "a different node set, a different id or type,
different links, groups, reroutes, floating links, top-level subgraphs, definitions or
content-bearing extra all remain refusals, so **#349 is untouched**." Deleting it is
therefore not a narrowing of the fence, it is the removal of the half that keeps #349
closed. (The IDENTITY clause above it carries the *other* half — it is there because
"structural equality alone cannot tell the active tab's canvas from a DUPLICATE tab's".
Neither conjunct substitutes for the other; that is the whole point of the pair.)

Every stale-tag mitigation the file already ships — `staleTagOnEmptyCanvas`,
`contentProvesActiveWorkflow` — demands **content** proof. None trusts the tag by itself.
The attempt inverted the file's own rule.

Also surfaced: the containment claimed for it was caller-dependent. `graphCommandBindingBar`
sets `includeBaselineReadGuard: false` for every classified read (`graph-binding.js:2091`),
which disables **both** `midPopulation` and `baselineReadDesync`, so reads like
`graph_serialize` had no backstop at all.

### Can workflow A's tag really sit on canvas B? — READ THIS BEFORE RE-DERIVING IT

The original rejection cited `graph-binding.js:1757-1777`, which records from #565 and #817
that some ComfyUI builds do **not** reset `graph.extra` in `configure()`, so a reused
`app.graph` carries the previous workflow's tag.

**That citation stops fifteen lines too early, and the next block qualifies it.** Lines
1779–1794 of the same doc comment record a measurement taken 2026-08-09 on ComfyUI frontend
**1.48.7**:

```
configure(payload with extra:{})      -> tag gone, nodes 10 -> 1
configure(payload with NO extra key)  -> tag gone, nodes  1 -> 2
clear()                               -> tag gone, nodes    -> 0
```

— i.e. on that build a tag does **not** survive a content change, and the file concludes the
#565/#817 premise "is therefore frontend-specific, and the clauses may simply not be
reachable on current builds." #1187's own reporter is on frontend **1.48.6**, the same
generation as the measured build.

So do not defend the P0 on the `configure()` mechanism alone; on current frontends it may
well be unreachable. The rejection stands on three other legs:

1. **The measurement is one frontend, and says so.** Its own closing line: "Verified on one
   frontend, which is exactly why neither statement should be universal." It licenses no
   universal trust in the tag in either direction.
2. **#565 and #817 are real reports from builds where the tag did survive, and #817 is still
   open.** The asymmetry matters: the existing stale-tag clauses are safe to leave in place
   when unreachable because they **admit** (they widen the fence), so an unreachable one
   costs nothing. A fix that *relies* on the tag being fresh does the opposite — it fails
   open on exactly the builds that reported the problem.
3. **There is a build-independent route to "A's tag on a canvas A does not own."**
   `graph-binding.js:1145-1161` records it as a known, deliberate gap: `sealProvenRootBinding`
   will stamp A's tag onto an untagged root that serializes equal to A with no other **open**
   workflow matching it — and a **closed** duplicate's stranded canvas satisfies that,
   because the exclusivity sweep can only see open tabs. Today the structure conjunct is what
   bounds that gap to "still structurally A". Attempt 1 deletes exactly that bound.

Leg 3 involves no frontend behaviour at all, and is the one to reason from.

## Attempt 2 — settle the lagging tracker, then re-ask. Rejected, same P0, and worse.

On `root-shape-mismatch` + a matching tag + a clean tab: call `captureCanvasIntoTracker`
(`web/js/comfyui-mcp-panel.js:2343`), then re-run the same resolver, unchanged.

It rested on one sentence that was never verified — *"after the capture the content still has
to agree."* **It does not.** The capture flips `isModified`, and `isModified === true` makes
`graphRootMismatchesActiveWorkflow` return `false` immediately (`graph-binding.js:1017`). The
comparison is not re-run, it is **suppressed**. The capture does not validate the canvas; it
silences the check that would have caught it. Same P0 by a longer route.

Two costs attempt 1 did not have:

- it fires on merely **reading** a wrongly-mounted canvas, not only after a real edit;
- a capture that sees a change "pushes an undo entry and clears the redo queue"
  (`comfyui-mcp-panel.js:2397-2398`), recording canvas B as workflow A's change. A user could
  lose a redo by reading.

**And the test written to prove it safe was vacuous.** It forced `rootUuidMismatch: true` —
the case where the tag is provably *foreign*. The dangerous case is a **stale tag that still
matches**, where that flag is `false`. It asserted the safe case and labelled it the
dangerous one.

## Why this is hard

Three facts that cannot be combined into a proof using the tracker alone:

1. **The tag can be stale** → identity is not proof.
2. **The tracker lags** → content is not currently accurate.
3. **Making the tracker current flips `isModified`** → which disables the content check outright.

The root reason: the ChangeTracker follows whatever canvas is **mounted**. It cannot
distinguish *"the user edited A"* from *"this is B wearing A's tag"*, because in both cases it
faithfully reports the canvas in front of it.

## What a third attempt probably needs

Evidence the tracker does not carry — the workflow's own **persisted/serialized** content,
which is what `rootContentProvesActiveWorkflow` and `contentProofExclusiveAmongOpen` already
reason about. Compare the live root against *workflow A's own stored state*, not against a
snapshot of whatever is mounted.

That likely depends on **#1014** (a saved workflow loses its identity across a reconnect;
still open) landing first, since it is the case where no published UUID exists to anchor any
of this.

A narrower option that leg 3 above does **not** rule out: keep the structure conjunct and
attack the *staleness of the comparison input* instead — but note that attempt 2 is the
obvious form of that idea and it fails, so any variant has to show how it avoids flipping
`isModified` before the comparison is re-read.

## What shipped (the third attempt)

`graphRootStructureExtendsActiveWorkflow`, consulted as a second disjunct beside
`structureMatches` — still only ever as a **conjunct of the identity tag**:

```js
const rootShapeMismatch =
  contentDiffers &&
  !((structureMatches || structureExtends) &&
    graphRootWorkflowUuidMatches({ rootGraph, activeWorkflowUuid }));
```

The content proof is **containment, not equality**: every node and link the workflow's own
current state carries must be present on the live root, and every other structural surface
must be equal — while the live root may carry *more*. A hand edit inside the capture lag is
exactly "the workflow's structure plus the edit", which equality can never see and
containment can. Neither rejected mechanism is used: the tag is never trusted alone (the
containment proof is demanded alongside it, and no foreign canvas satisfies it), and the
tracker is never settled (nothing captures, `isModified` is never flipped by the check).

The bounds, stated plainly:

- **Additions only.** A hand *removal* in the lag window still refuses and self-clears on
  the next capture, because the mirror relation (live ⊆ state) would admit a canvas
  **missing** content the workflow owns — the under-reporting direction (#618's lesson).
  An admitted canvas always holds everything the workflow owns.
- **Leg 3's bound widens from "still structurally A" to "structurally A plus additions"**:
  a sealed closed-duplicate's stranded canvas that then gains nodes keeps its reads. That
  widening is not avoidable by any fix — *"the user added a node to A"* and *"the sealed
  duplicate gained the same node"* are observationally identical to every signal the panel
  has — and it is the same ambiguity the equality relaxation's own comment already accepts
  knowingly for content drift, bounded in the direction that matters: nothing A owns can
  be absent from an admitted canvas.
- The #1014 dependency this document predicted does **not** block this fix: #1187's
  reporter has a published UUID to anchor the identity conjunct. #1014 remains the
  no-anchor case and is untouched by it.

Verified by mutation, not only by the suite: deleting the disjunct, forcing containment
true, dropping the link-containment clause, and dropping the surface-equality clause each
turn targeted tests red (the pre-existing #696 structural-refusal test catches the last
two as well).

## What the verification did and did not prove

Both attempts were carried to completion before being rejected — full unit suite green, and
mutation-verified (6 mutations on attempt 2, all confirmed red) — which is precisely why they
are worth recording. **A green suite and a clean mutation run did not make either one safe.**
Attempt 2's suite passed 143/143 while the P0 path was untested, and the shared fence harness
does not inject the settle path's dependencies, so those tests silently exercised a degraded
no-op.
