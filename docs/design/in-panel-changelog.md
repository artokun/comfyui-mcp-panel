# In-panel "what's new" — surfacing CHANGELOG.md where the user actually is

**Status:** draft ask, not scoped for build. One design decision below is the crux of the whole spec.
**Origin:** `#758` — filed from seanmcmagic in Discord `#help`: *"What's new and fixed in 0.50.14 and will there be a 'bug fixes' or 'patch notes' in the panel somewhere to reference what has changed?"*
**Precursor, now built:** `#810` (this repo) sends the version's `CHANGELOG.md` section to the Comfy Registry on publish — so the Registry's own "Updates" surface is no longer blank. This spec is about a **second**, panel-native surface; #810 doesn't replace it, since a user has to go find the Registry page, same problem #758 describes for GitHub.

## Why it matters (from the original filing)

The panel updates from the Comfy Registry and the orchestrator runs `npx comfyui-mcp@latest` — **the version can move with no deliberate action by the user.** The first signal something changed is often behavior they didn't expect, which reads as a bug rather than a release. 0.50.x sharpened this: the tool surface consolidated (154→37) and the default tool mode flipped, so a user noticing different behavior has no in-product way to learn it was intentional.

## A working precedent exists — but it's the wrong shape to copy directly

`comfyui-mcp-mobile` already has exactly this UX: a one-shot "what's new" modal shown once per update (`lib/features/whats_new/`). Worth knowing precisely how it works before assuming it's the template:

**It is hand-curated, not CHANGELOG.md-driven.** `changelog.dart` is a `Map<int, ChangelogEntry>` keyed by pubspec build number, with marketing-toned bullets written by hand for each release — a second, separate source of truth from any changelog file, deliberately punchier ("One-tap Diagnose on a failed render: when a queued render fails, tap Diagnose and the agent root-causes it") than a terse commit-derived line would be.

That's a genuinely different design decision than #758's original framing assumed: *"CHANGELOG.md is already structured... this is a rendering problem not a content problem."* The mobile precedent says otherwise — it treats the *marketing framing* of a changelog entry as real content work, not just a rendering pass over existing data.

## The actual open question — pick one, they're materially different builds

1. **Read `CHANGELOG.md` directly** (the original #758 framing). Single source of truth, zero duplicate maintenance, but entries are commit-derived and technical — closer to what a maintainer writes than what a user wants read to them. Fine for "Fixed" items; awkward for framing something like the 154→37 consolidation as a positive change rather than a wall of PR links.
2. **Hand-curate a second list**, mirroring the mobile app exactly. Lets every entry be written for the reader, but is a second thing to remember to update on every release — and this project has already hit "shipped without updating X" more than once tonight alone (`CHANGELOG.md` itself went three versions without an entry, per `#810`'s own commit).
3. **Something hybrid** — e.g. `CHANGELOG.md` sections auto-populate a default, with an optional hand-written override for genuinely user-facing releases (a consolidation, a default flip) — deliberate work only where it earns its keep, silence otherwise.

This is the decision that determines almost everything else about the build, so it's the one thing this spec leaves for the owner rather than guessing.

## What else the spec (from #758) already establishes, regardless of which option above

- **Delta, not the whole file.** Show what changed since the version the user was previously on, not the full history.
- **Prominent for major changes** (a consolidation, a default flip), quiet for a routine patch.
- **Distinguish Fixed from Changed** — *"this used to work differently on purpose"* is the specific message that stops a misfiled bug report, which is the whole reason this exists.

## What's genuinely new infrastructure for this repo

Checked: **no existing "shown once per version, remember in storage" UI pattern exists in the panel today.** The panel's one-shot mechanisms are session/turn-scoped (a provider-switch transcript replay, an armed context for the next message) — nothing persists "has this browser/user seen release X's notes" the way the mobile app's build-number tracking does. That storage-and-dismiss layer is new work here, not a port of something that already exists in this repo.

## Explicitly not decided here

- Whether this shares plumbing with the Registry changelog from `#810` (option 1/3 above would let it), or is fully independent (option 2).
- Where in the panel it surfaces — a toast, a settings-panel readout, a dismissible card in chat. Not scoped; depends partly on the sourcing decision above (a hand-curated marketing entry probably wants a more prominent presentation than an auto-pulled `CHANGELOG.md` diff).
