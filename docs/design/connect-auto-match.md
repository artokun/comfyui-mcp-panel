# `graph_connect` auto-match by type + full slot diagnostics on failure

**Status:** implemented (this PR) · **Implementation branch:** `spec/connect-auto-match` · **Pairs with:** comfyui-mcp `docs/design/panel-connect-auto-match.md` (`panel_connect` schema + DSL wiring warnings)

> Prior art: [filliptm/ComfyUI_FL-MCP](https://github.com/filliptm/ComfyUI_FL-MCP) `fl_api.js` (~638–810): type-based slot auto-matching preferring unconnected inputs, and rich failure diagnostics listing every slot. We port both and add what FL-MCP lacked: `*` wildcard and COMBO handling, widget-input ranking, and an ambiguity guard — plus we never silently fall back when a *named* slot misses.

## Motivation

`graph_connect` today (bundle ~2773; `resolveSlot` ~2385) resolves slots strictly: exact index or case-insensitive exact name, **defaulting to slot 0 when omitted**; a bad name lists only names (no types, no connected flags), and a LiteGraph type refusal names the two slots without saying which slot *would* work. Every failed connect costs a full agent round-trip. Auto-matching and diagnostic errors turn most of those into zero or one retry.

## API (upgraded `graph_connect`, backward compatible)

```jsonc
{
  "rid": "…", "cmd": "graph_connect",
  "from_node_id": 4,
  "from_output": "MODEL",   // string | int | omitted — NEW: omitted = auto-match (was: slot 0)
  "to_node_id": 3,
  "to_input": "model",      // string | int | omitted — NEW: auto-match
  "auto_match": true        // NEW, default true. false = legacy exact behavior (omitted slot = 0)
}
```

### Resolution algorithm (replaces the two bare `resolveSlot` calls at ~2887–2888; the four subgraph-rail branches above them are untouched)

1. **Explicit index** → exact, range-checked (unchanged).
2. **Explicit name** → case-insensitive trim match (unchanged); on miss, fall through to the diagnostic error — a *named* request is never silently rerouted (stricter than FL-MCP, which fell back to slot 0).
3. **Omitted side(s)** with `auto_match`:
   - Both omitted: first type-compatible (output, input) pair, preferring unconnected inputs; ties broken by lowest input index.
   - One side known: match the other by type, preferring unconnected inputs; fall back to a connected type-match (LiteGraph reconnects — reported as `replaced_link`).
4. **Type compatibility** (the part FL-MCP lacked):
   - equal types → compatible;
   - `*` on either side → compatible with anything (LiteGraph's own rule) but ranked **below** exact matches, so a wildcard never steals a better slot;
   - **COMBO inputs** (array type, or `"COMBO"`): only identical array/`COMBO` outputs auto-match; never matched by wildcard; rendered `COMBO(<n> options)` in diagnostics;
   - comma multi-types (`"IMAGE,MASK"` in some packs): compatible if any segment matches.
5. `auto_match: false` → today's behavior exactly, including omitted → index 0.

### Success result (existing shape, additive extensions)

```jsonc
{ "connected": {
    "from": { "node_id": 4, "output": "MODEL", "output_index": 0 },
    "to":   { "node_id": 3, "input": "model", "input_index": 0 },
    "type": "MODEL",
    "auto_matched": ["to_input"],                            // only when a side was inferred
    "replaced_link": { "node_id": 2, "output": "MODEL" }     // only when the input was already connected
} }
```

### Error shape — the diagnostic

Still `{rid, ok: false, error}` with a single formatted string (nothing upstream changes):

```
Could not connect node 4 (CheckpointLoaderSimple) → node 3 (KSampler).
Requested: from_output="CLIP" → to_input=auto.
Node 4 outputs: [0] "MODEL" (MODEL), [1] "CLIP" (CLIP), [2] "VAE" (VAE)
Node 3 inputs:  [0] "model" (MODEL) [connected], [1] "positive" (CONDITIONING), [2] "negative" (CONDITIONING), [3] "latent_image" (LATENT), [4] "seed" (COMBO/widget)
No input on node 3 accepts type CLIP. Tip: CLIP outputs typically feed CLIPTextEncode.clip; check wiring with panel_get_graph.
```

Built by a new helper `slotDiagnostic(origin, target, requested)` beside `resolveSlot` (~2400), and **also reused by the existing explicit-connect refusal path** (~2897) so even an explicit-index type rejection lists all slots. The tip line is generic plus one type-specific hint when the failing type is unambiguous.

## Edge cases

- **Ambiguity guard:** ≥2 equally-ranked unconnected candidates of the same type (e.g. KSampler `positive`/`negative`, both CONDITIONING) → **fail with the diagnostic** listing the tie ("ambiguous: 2 CONDITIONING inputs (positive, negative) — name one") rather than silently picking `positive`. Deliberately stricter than FL-MCP; prevents the classic silently-wrong-negative-prompt bug.
- **Widget-converted inputs** (input that is also a widget, e.g. `seed`): present in `node.inputs` with a `widget` property — ranked **last** for auto-match and tagged `(COMBO/widget)` / `(INT/widget)` in diagnostics.
- **`*`-output nodes** (Reroute, Anything-Everywhere styles): exact-type candidates always outrank wildcard pairings; wildcard→wildcard allowed last.
- **Subgraph rails:** rail branches return before the resolver — unchanged; extending diagnostics to rail mismatches is a follow-up (the refusals at ~2800/2838 already name both types).

## Implementation plan

1. Add `isTypeCompatible(outType, inType)`, `slotDiagnostic(...)`, `autoMatchSlots(origin, target, fromRef, toRef)` beside `resolveSlot` (~2400) in `web/js/comfyui-mcp-panel.js`.
2. Rework only the tail of `graph_connect` (~2885–2908): keep `resolveNode`, rail branches, `beforeChange/afterChange`, `setDirtyCanvas`; replace the two `?? 0` resolutions; capture the pre-existing `target.inputs[inIdx].link` for `replaced_link`; on a refused `connect()` throw `slotDiagnostic` instead of the two-slot message.
3. Update the `describeCommand` `graph_connect` case (~5595) to append "(auto-matched)" when `result.connected.auto_matched` is present.

## Test plan

Playwright `browser_tests/connect-matcher.spec.ts` (existing MockBridge pattern): build CheckpointLoaderSimple + CLIPTextEncode + KSampler via bridge frames; assert (1) omitted `to_input` auto-matches `clip` ← CLIP, (2) CONDITIONING ambiguity errors with both slot names + `[connected]` markers in the message, (3) `auto_match:false` + omitted slots reproduces legacy index-0 behavior, (4) explicit wrong name errors with the full slot listing, (5) reconnect over a connected input reports `replaced_link`, (6) Reroute (`*`) connects but loses to an exact match.

## Rollout / compat

Behavior change to flag in the changelog: **an omitted slot now auto-matches instead of meaning index 0** (with `auto_match` defaulting true). For one-output/one-input nodes this is identical; the ambiguity guard guarantees auto never silently picks a different slot than legacy without type justification. Old panel + new orchestrator: the unknown `auto_match` key is ignored → exact legacy behavior. New panel + old orchestrator: omitted slots start auto-matching — an improvement with the same request shape. **This panel PR ships first.**
