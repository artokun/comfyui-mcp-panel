# `graph_auto_layout` — topological auto-layout with group + reroute handling

**Status:** implemented (this PR) · **Implementation branch:** `spec/auto-layout-engine` · **Pairs with:** comfyui-mcp `docs/design/panel-auto-layout-tool.md` (`panel_auto_layout` tool)

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `web/js/layout_engine.js` — a dependency-aware column layout (DFS topo sort, depth = max(input depths)+1, cumulative column widths). We port that core and fix its three known gaps: LiteGraph **groups** are ignored (members scatter, boxes orphan), **Reroute** nodes each get a full column (blowing up horizontal span), and there is **no overlap resolution** when a subset layout collides with untouched nodes.

## Motivation

Agents currently place nodes with `placementFor`'s naive "cascade right of the last node" default and fix things up with dozens of `panel_move_node` round-trips. One `graph_auto_layout` call produces a readable graph; `dry_run` additionally gives the agent a planner — propose positions, inspect, then apply — replacing FL-MCP's separate `preCalculatePositions` API for about-to-be-created nodes.

## Bridge command API

Request frame (existing `{rid, cmd, ...args}` shape):

```jsonc
{
  "rid": "…",
  "cmd": "graph_auto_layout",
  "node_ids": [4, 7, 9],       // optional int[]; omitted/null = ALL nodes in the ACTIVE graph (root or entered subgraph, via getGraphCtx())
  "mode": "flow_horizontal",   // "flow_horizontal" (default) | "flow_vertical" | "grid"
  "spacing": 1.0,              // 0.25–4, multiplier on base gaps {h:50, v:30}
  "align": "start",            // "start" (default, stacking) | "center" — cross-axis alignment within a column/row
  "anchor": "bbox",            // "bbox" (default): keep the moved set's bounding-box top-left in place; "origin": [0,0]; or explicit [x, y]
  "groups": "preserve",        // "preserve" (default) | "cluster" | "ignore"
  "dry_run": false             // true = compute + return positions, apply NOTHING
}
```

Success result (`{rid, ok: true, result}`):

```jsonc
{
  "applied": true,             // false when dry_run
  "mode": "flow_horizontal",
  "node_count": 9,
  "columns": 5,                // depth levels (rows for flow_vertical)
  "moved": [ { "node_id": 4, "from": [100, 100], "to": [0, 0], "column": 0 } ],
  "groups": [ { "group_id": 1, "title": "Sampling", "bounds": [x, y, w, h] } ],
  "skipped": [ { "node_id": 12, "reason": "pinned" } ]
}
```

Errors (thrown in the executor → `{rid, ok: false, error}` via the existing dispatcher): `"No node with id 99 in the current graph"` (reuses `resolveNode`), `"Graph is empty — nothing to lay out"`, `"Unknown layout mode \"x\" (flow_horizontal | flow_vertical | grid)"`.

## Architecture: pure engine module + thin executor

**New file `web/js/lib/layout-engine.js`** — a pure, dependency-free ES module (no `scripts/app.js` import, unlike FL-MCP's). The bundle is live-served; `web/js/vendor/` proves sibling relative imports load fine, and `scripts/panel-guard.mjs` already watches `web/js/**/*.js` recursively. A pure module is unit-testable under plain `node --test` and cannot break ComfyUI's extension loader with side effects.

```js
computeLayout(snapshot, opts) -> { positions: Map<id, [x, y]>, columns, skipped }
// snapshot: { nodes: [{id, x, y, width, height, pinned, collapsed}],
//             edges: [{from, to}],
//             groups: [{id, memberIds, bounds, collapsed}] }
// opts:     { mode, spacing, align, anchor, clusters?: [{id, memberIds}] }
```

### Ported core (FL-MCP `layout_engine.js`)

- DFS topological sort visiting inputs first; cycles detected via a `visiting` set and skipped (their lines 464–497).
- Column assignment: depth = `max(depth(inputs)) + 1`, sources = 0; memoized with cycle-safe visited sets (506–560).
- Column X = cumulative max node width per column + horizontal gap; vertical stacking within columns (301–353); `flow_vertical` = same rotated; `grid` = `ceil(sqrt(n))` uniform cells.
- Base gaps `{h:50, v:30}` × `spacing` multiplier.
- No-edge fallback: a selection with zero edges lays out as a sequential row (their documented all-in-column-0 pitfall fix, 136–144).

### Improvements over FL-MCP

1. **Reroute awareness:** nodes of type `Reroute` (and native reroute points) don't open a new column — a reroute inherits `depth(input) + 0.5` in a slim virtual column (own width, half gap) and is centered vertically between its endpoints, so reroute chains don't double the span.
2. **Barycenter ordering within columns:** one left→right sweep sorts each column's nodes by the mean Y-index of their upstream neighbors — far fewer link crossings for zero extra API.
3. **Subset overlap resolution:** when `node_ids` is a subset, the laid-out block anchors at its original bbox top-left, then a single vertical push-apart pass shifts the **block** (never the untouched nodes) below any unavoidable collision.
4. **Group handling** (executor-side except clustering):
   - `preserve` (default): lay out nodes individually, then re-fit each group's box around its members (`g.pos`/`g.size` from member bbox + title padding, mirroring `graph_edit_group`'s fit logic ~line 3790); groups with only some members in the set re-fit around current members; groups are never deleted.
   - `cluster`: each group becomes a rigid super-node in the engine (bbox size, union of member edges) via `opts.clusters`; members translate rigidly by the group delta. Lives in `computeLayout` so it stays unit-testable.
   - `ignore`: FL-MCP behavior (boxes untouched) — escape hatch.
   - Collapsed groups always move as rigid clusters; pinned nodes (`node.flags?.pinned`) are skipped and reported (FL-MCP moves them).

## Bundle wiring (`web/js/comfyui-mcp-panel.js`)

- Top of file: `import { computeLayout } from "./lib/layout-engine.js";` (same pattern as `vendor/` imports).
- New executor `graph_auto_layout` in `GRAPH_TOOL_EXECUTORS` (~line 2415, near `graph_move_node`): build the snapshot from `getGraphCtx().graph` (`_nodes`, `graph.links`, `_groups` with `g.recomputeInsideNodes?.()` — same calls `summarizeGroup` (~2281) already makes); call `computeLayout`; on `dry_run` return without touching the graph; otherwise wrap ALL position writes in one `graph.beforeChange()` / `graph.afterChange()` pair (single Ctrl+Z — the `graph_clear` convention) and finish with `graph.setDirtyCanvas(true, true)`.
- Collapsed nodes measured via `boundingRect`/collapsed size, not full `size` (see the fit handler ~2997), so columns stay tight.
- Subgraph boundary rail proxy nodes (ids −10/−20) are excluded and untouched; `getGraphCtx()` already scopes to the active (sub)graph.
- Add `"graph_auto_layout"` to `AUTOFIT_CMDS` (~8194) so the debounced auto-fit frames the result; add a `describeCommand` case (~5583): `{ icon: "pi-th-large", text: "Auto-arranged N nodes (M columns)" }`.
- `placementFor` is untouched (follow-up: reuse the engine's no-edge fallback there).

## Edge cases

- Empty graph / empty `node_ids` → explicit error (matches `graph_canvas` fit's "Graph is empty").
- Cycles: back edge skipped in topo sort; depth memoization keeps its visited-set guard.
- `dry_run` never calls `beforeChange` — no phantom undo step.

## Test plan

- **Unit (new):** add `"test:unit": "node --test browser_tests/unit/"` to `package.json`; `browser_tests/unit/layout-engine.test.mjs` covers: diamond-graph column assignment; cycle doesn't hang; reroute gets a half-column; barycenter reduces crossings on a fixed fixture; cluster translation is rigid; no-edge fallback; spacing multiplier; no-two-rects-overlap property check over random DAGs.
- **Playwright e2e (`browser_tests/auto-layout.spec.ts`):** via the existing MockBridge fixture (sends arbitrary `{rid, cmd}` frames): build a small graph with `graph_add_node`/`graph_connect`, assert `dry_run:true` returns positions while `graph_get_state` shows unchanged `pos`; apply and assert monotone column X ordering, group bounds containing members, and single-undo restoration (Ctrl+Z, re-read state).

## Rollout / compat

Purely additive; no existing command changes. Old orchestrator + new panel: inert. New orchestrator + old panel: `Unknown command "graph_auto_layout"` — agent-readable; **this panel PR ships first**. `web/js/lib/` sits inside `WEB_DIRECTORY` so it ships automatically; confirm `.comfyignore` doesn't exclude it.
