# Design: Model picker → omni-search (spec)

**Status:** DRAFT / spec-only — no implementation yet. Opening as a draft PR for review before building.

## Motivation

Today each provider has its own model **dropdown**. Two problems:

1. **Truncation.** OpenRouter serves ~300–400 models; the orchestrator alphabetically-sorted then sliced to 150, so late-alphabet vendors (`z-ai/*` GLM 5.x) were unreachable — the list "stopped at moonshot/kimi-k3" ([mcp #326](https://github.com/artokun/comfyui-mcp/issues/326)). Fixed backend-side (mcp #333 raises the cap to serve the whole catalog).
2. **A 400-item `<select>` is unusable.** Even with the full list served, a raw dropdown of hundreds of models — across several connected providers — is a wall you scroll, not something you *find* a model in.

**Goal:** replace the per-provider dropdown with a single **omni-search** picker: start typing, see matching models across **all connected providers**, virtualized so hundreds of rows scroll smoothly.

## The feature

A searchable, keyboard-navigable model picker that:

- **Searches across every connected provider at once.** Type `glm` → GLM models from OpenRouter *and* the direct z.ai provider; type `qwen` → Qwen across Ollama / OpenRouter / etc. Each row shows the model label + a **provider tag** so identical-named models are distinguishable and picking one also selects its provider.
- **Empty query = the good defaults.** With no text, show the **pinned/recommended** models on top (the curated arena-winners already surfaced), then the current selection, then recents — not a raw dump.
- **Infinite scroll / virtualization for long lists.** Any list > ~150 rows renders windowed (only visible rows in the DOM) and loads more on scroll, so the full OpenRouter catalog scrolls at 60fps instead of injecting ~400 `<option>` nodes at once.
- **Keyboard-first.** ↑/↓ to move, Enter to select, Esc to close; the search input is focused on open. Fuzzy/substring match on both the model id and its label.

## Design

### Data — aggregate every connected backend

The picker's source is the union of each **connected** provider's `listModels()`:

```
connectedProviders()               // from the readiness/backends frame
  .flatMap(p => p.models.map(m => ({ ...m, provider: p.id, providerLabel: p.label })))
```

- Backends already expose `listModels()` (Claude/Codex/Gemini/Grok/Ollama/OpenRouter/GLM/Kimi/Moonshot/…); the panel already receives per-provider catalogs. This change **aggregates** them into one searchable index instead of showing one provider's list at a time.
- The full lists are now available (mcp #333). Fetch lazily per provider (on connect / on first open) and cache; refresh on the readiness push.
- Selecting a row sets **both** the model and its provider (a cross-provider pick may switch the active backend — confirm/route through the existing backend-select path).

### Component

Replace the `<select>` with a combobox:

```
[ search input ]                         ← focus on open, filters as you type
─────────────────────────────
★ Pinned / recommended         (empty query only)
  Current: <model>  ·  <provider>
─────────────────────────────
<virtualized result rows>                ← windowed; row = label + provider tag
  … loads more on scroll …
```

- **Virtualization:** a lightweight windowing pass (render only rows in view + a small buffer); no heavy dep needed for a single-column list.
- **Filtering:** client-side substring/fuzzy over the aggregated index; cheap enough for a few hundred rows without a worker.
- **Provider tag:** small pill (`OpenRouter`, `z.ai`, `Ollama`, …) so `glm-4.6` on OpenRouter vs the direct z.ai `glm` are distinct.

### Edge cases

- **One provider connected** → still works, just no cross-provider mixing; the search + virtualization still help for OpenRouter's long list.
- **A provider mid-fetch** → show what's cached, mark the rest "loading…"; never block the picker on a slow `listModels()`.
- **Selection that switches backend** → route through the existing provider-switch flow (it may reset/rebind the session per current rules) rather than silently swapping.
- **No results** → "No model matches '…' across N connected providers" + a hint to connect more.

## Scope / phasing

1. **MVP:** aggregate connected providers → searchable combobox + virtualization + pinned-on-empty. Replaces the current dropdown.
2. **Polish:** recents, fuzzy ranking, per-provider "loading" states, remembering last query.
3. **Later (optional):** show *disconnected* providers' models greyed with a "connect to use" affordance.

## Dependencies / open questions

- Rides on **mcp #333** (full catalog served) — already up.
- Confirm the readiness/backends frame carries each connected provider's model list (or add a lazy per-provider fetch on first open).
- Decide whether a cross-provider pick may **switch the active backend** inline, or is limited to models of the currently-selected provider (leaning: allow the switch, routed through the existing backend-select path with its session rules).
- Virtualization approach: hand-rolled windowing vs a tiny vendored helper — lean hand-rolled for one column.
