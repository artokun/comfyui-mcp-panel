/**
 * #907 — the e2e suite saves real workflows into the developer's own library and
 * leaves them there. Measured on this machine: 1269 of 1286 files were
 * `Untitled 2026-08-*` test output, so ~99% of a real workflow library was
 * litter, and every `workflows` store read the panel does on a dev box
 * enumerated 1286 entries — a shape no user's install has.
 *
 * WHY THIS IS NOT PER-SPEC CLEANUP. The suite already tried that. Three specs
 * delete what they saved and two do not, and the two that do not were written
 * before the review that added it to the others. Worse, the cleanup that DOES
 * exist sits at the end of the test body — so it runs only when the test PASSES.
 * A failing or timing-out spec leaks by construction, which is exactly when a
 * spec is most likely to run.
 *
 * So the guarantee belongs to the suite, and this module holds the part worth
 * testing: deciding what may be deleted. Everything here is pure.
 *
 * THE SAFETY PROPERTY. This deletes files from a directory that also holds the
 * developer's real work, so "delete what the tests made" must never widen into
 * "delete what looks disposable". A file is removable only when BOTH hold:
 *
 *   1. it did not exist when the run started, and
 *   2. its name matches a pattern the suite itself produces.
 *
 * Either alone is unsafe. (1) alone would delete a workflow the user saved while
 * the suite ran. (2) alone would delete the `Untitled 2026-08-04.json` they made
 * last week — the same shape ComfyUI gives every unnamed save, including theirs.
 */

/** Names the suite is known to create. */
const LITTER_PATTERNS: readonly RegExp[] = [
  // ComfyUI's default name for an unnamed `workflow_save`. MEASURED against the
  // real directory rather than assumed: it carries a TIME as well as a date —
  // "Untitled 2026-08-09 19-37-51.json". The first version of this pattern
  // stopped at the date and matched ZERO of the 1272 real files, which would have
  // deleted nothing and then failed every run by reporting all of them as
  // unrecognised. The date-only form is kept as an alternative because older
  // frontends produced it.
  /^Untitled \d{4}-\d{2}-\d{2}(?: \d{2}-\d{2}-\d{2})?(?: \(\d+\))?\.json$/,
  // The suite's own explicit prefix, used by specs that save under a nonce.
  /^cmcp-e2e-[A-Za-z0-9-]+\.json$/,
]

/** Does this filename match something the suite creates? */
export function isTestLitter(name: string): boolean {
  if (typeof name !== 'string' || !name) return false
  return LITTER_PATTERNS.some((re) => re.test(name))
}

/**
 * The files this run may delete: new since the baseline AND recognisably ours.
 *
 * `before`/`after` are the raw listings from ComfyUI's userdata API.
 */
export function plannedDeletions(before: readonly string[], after: readonly string[]): string[] {
  const baseline = new Set(before ?? [])
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of after ?? []) {
    if (typeof name !== 'string' || baseline.has(name) || seen.has(name)) continue
    seen.add(name)
    if (isTestLitter(name)) out.push(name)
  }
  return out.sort()
}

/**
 * What is left over after the deletions ran — the LEAK REPORT.
 *
 * A cleanup that silently stops working is the defect this issue actually
 * describes: 1269 files accumulated with nobody noticing. So the teardown does
 * not just delete, it checks, and anything new that it could NOT account for is
 * named rather than shrugged off.
 *
 * Deliberately reports two kinds separately, because they mean different things:
 *
 *   `undeleted` — we recognised it and the delete did not take (an API failure,
 *                 a permission problem). The cleanup is broken.
 *   `unrecognised` — new, but matching no pattern we know. Either a spec started
 *                 saving under a new name, or the user saved something mid-run.
 *                 Naming it is the only way the first case gets noticed.
 */
export function leakReport(
  before: readonly string[],
  afterCleanup: readonly string[],
  attempted: readonly string[],
): { undeleted: string[]; unrecognised: string[] } {
  const baseline = new Set(before ?? [])
  const tried = new Set(attempted ?? [])
  const undeleted: string[] = []
  const unrecognised: string[] = []
  for (const name of afterCleanup ?? []) {
    if (typeof name !== 'string' || baseline.has(name)) continue
    if (tried.has(name)) undeleted.push(name)
    else unrecognised.push(name)
  }
  return { undeleted: undeleted.sort(), unrecognised: unrecognised.sort() }
}

/** The userdata path for a workflow filename. */
export function workflowUserdataPath(name: string): string {
  return `workflows/${name}`
}
