# In-panel "what's new" — surfacing CHANGELOG.md where the user actually is

**Status:** shipped. This started as a draft ask with one open design decision; that decision
has since been made and built, so this file is now the record of *which* option was taken and
why — not a proposal awaiting an answer.
**Origin:** `#758` — filed from seanmcmagic in Discord `#help`: *"What's new and fixed in
0.50.14 and will there be a 'bug fixes' or 'patch notes' in the panel somewhere to reference
what has changed?"*
**Related, and still open:** `#810` (this repo) proposes sending each version's `CHANGELOG.md`
section to the Comfy Registry on publish, so the Registry's own "Updates" surface stops being
blank. It has not merged, so that surface is still blank today. It is a *different* surface
from this one and does not replace it: a user has to go and find the Registry page, which is
the same problem `#758` describes for GitHub.

## Why it matters (from the original filing)

The panel updates from the Comfy Registry and the orchestrator runs `npx comfyui-mcp@latest` —
**the version can move with no deliberate action by the user.** The first signal something
changed is often behavior they didn't expect, which reads as a bug rather than a release.
0.50.x sharpened this: the tool surface consolidated (154→37) and the default tool mode
flipped, so a user noticing different behavior had no in-product way to learn it was
intentional.

## A working precedent existed — but it was the wrong shape to copy directly

`comfyui-mcp-mobile` already has this UX: a one-shot "what's new" modal shown once per update
(`lib/features/whats_new/`). It is worth knowing precisely how it works before assuming it is
the template:

**It is hand-curated, not CHANGELOG.md-driven.** `changelog.dart` is a
`Map<int, ChangelogEntry>` keyed by pubspec build number, with marketing-toned bullets written
by hand for each release — a second, separate source of truth from any changelog file,
deliberately punchier ("One-tap Diagnose on a failed render: when a queued render fails, tap
Diagnose and the agent root-causes it") than a terse commit-derived line would be.

That is a genuinely different design decision than `#758`'s original framing assumed:
*"CHANGELOG.md is already structured... this is a rendering problem not a content problem."*
The mobile precedent says otherwise — it treats the *marketing framing* of a changelog entry
as real content work, not just a rendering pass over existing data.

## The decision: generate from CHANGELOG.md (option 1)

Three options were on the table, and they were materially different builds:

1. **Read `CHANGELOG.md` directly.** Single source of truth, zero duplicate maintenance, but
   entries are commit-derived and technical — closer to what a maintainer writes than what a
   user wants read to them.
2. **Hand-curate a second list**, mirroring the mobile app exactly. Lets every entry be
   written for the reader, but is a second thing to remember to update on every release.
3. **Something hybrid** — `CHANGELOG.md` auto-populates a default, with an optional
   hand-written override for genuinely user-facing releases.

**Option 1 was taken**, and the deciding argument was maintenance realism rather than polish:
a second hand-maintained list is only as good as the discipline to update it, and this repo
has measurably missed that bar on the *first* list. **0.11.42, 0.11.43 and 0.11.44 each shipped
with no `CHANGELOG.md` section at all** — the file jumps straight from `0.11.41` to `0.11.45`.
That gap is still visible today, and it propagates: those three versions are absent from the
generated `web/changelog.json` too, so the panel has nothing to say about them either. A
surface that silently says nothing is worse than a terse one, because it is indistinguishable
from "nothing changed".

Option 3 remains available on top of what shipped — the generator already produces a default
per release, so an override layer would be additive rather than a rewrite.

## What shipped

- **`scripts/gen-changelog-json.mjs`** parses `CHANGELOG.md` into `web/changelog.json`.
  ComfyUI serves a custom node's `web/` directory at `/extensions/<pack>/` while `CHANGELOG.md`
  sits at the repo root, so the panel cannot fetch the markdown directly. Generated, never
  hand-edited. It keeps only each entry's first sentence, which is written as the summary in
  every entry — the full text stays in `CHANGELOG.md`. It runs from `scripts/set-version.mjs`,
  so the shipped copy is refreshed as part of the version bump rather than by memory.
- **`web/js/lib/changelog-delta.js`** decides what to show and how loudly:
  - `releasesSince()` — the delta, bounded above by the running `PANEL_VERSION` so a dev
    running from a checkout is never told about versions their install does not contain.
  - `updateAnnouncement()` — `"major"` when the minor component moved or several releases
    landed at once, `"patch"` otherwise, and `"none"` on a first run or a downgrade. A browser
    with no recorded version is greeted silently and told about the *next* change, which is the
    first one that can honestly be called a change.
  - `summarizeReleases()` — keeps each entry's section, so `Fixed` stays distinguishable from
    `Changed`.
- **The surface itself** is wired in `web/js/comfyui-mcp-panel.js` (fetches
  `/extensions/comfyui-mcp-panel/changelog.json`, renders `[data-testid="panel-whats-new"]`),
  with the seen-version watermark in `localStorage` under
  `comfyui-mcp.panel.lastSeenVersion`.
- **Tests:** `browser_tests/whats-new.spec.ts` asserts the notice actually renders in the
  transcript and is announced only once; `changelog-delta`, `changelog-base` and
  `changelog-integrity` cover the delta logic and the shape of `CHANGELOG.md` itself.

This closes the three requirements `#758` established regardless of sourcing: **delta, not the
whole file**; **prominent for major changes, quiet for a routine patch**; and **`Fixed`
distinguished from `Changed`** — the last of which is the specific message that stops a misfiled
bug report, and the whole reason the feature exists.

The "shown once per version, remember in storage" layer was genuinely new to this repo — the
panel's other one-shot mechanisms are session- or turn-scoped and none of them persist "has this
browser seen release X". That layer is the `lastSeenVersion` watermark above.

## Still open

- **Option 3's override layer** — a hand-written entry for the rare release that deserves
  framing (a consolidation, a default flip), falling back to the generated text otherwise.
  Deliberate work only where it earns its keep, silence otherwise.
- **Whether this shares plumbing with the Registry changelog in `#810`.** Both read the same
  `CHANGELOG.md`, but by different paths: `#810` extracts one version's raw markdown section at
  publish time for the Registry, while this parses every release into JSON at version-bump time
  for the panel. Neither depends on the other, and merging them has not been attempted.
- **The empty-section problem is upstream of both.** Nothing here can surface notes for a
  version that was never written down — 0.11.42–0.11.44 stay blank in every surface until
  `CHANGELOG.md` itself gains those entries.

Refs artokun/comfyui-mcp#758
