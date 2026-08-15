/**
 * comfyui-mcp#1448 — ask the SERVER whether the workflow exists, before refusing.
 *
 * The open lookup is a pure in-memory scan of the frontend's workflow store. Nothing
 * in the path ever asks the server, so a `.json` staged into `user/default/workflows/`
 * out-of-band — unzipped from a CivitAI bundle, in the reporter's case — is reported
 * as "no workflow matching" while sitting exactly where they said it was.
 *
 * ## Both halves of that staleness were REPRODUCED on a live rig
 *
 * ComfyUI 0.33.1 / frontend 1.48.7. A file written directly into the workflows folder,
 * with the tab already open:
 *
 *   before syncWorkflows()  → on disk: YES, in store: NO   ← the reporter's failure
 *   after  syncWorkflows()  → on disk: YES, in store: YES
 *
 * and the mirror, after deleting it out-of-band:
 *
 *   before syncWorkflows()  → on disk: NO,  in store: YES  ← the reporter's other
 *   after  syncWorkflows()  → on disk: NO,  in store: NO      symptom, a listed
 *                                                             workflow not on disk
 *
 * So the store lags disk in BOTH directions, and `/userdata` answers correctly at the
 * exact moment the refusal is being written. On that build the sync did close the gap
 * — which is why this does not claim to fix a lookup failure it could not observe.
 * What it fixes is that the refusal can finally tell the two cases apart: a file that
 * is genuinely absent, and a file that is on disk while the list is stale. Those need
 * opposite actions from the caller and were previously the same sentence.
 *
 * The panel cannot detect a silently-failed sync (that store's `syncWorkflows` is a
 * VueUse `useAsyncState` execute wrapper built without `throwError`, so a failed read
 * resolves normally — see open-workflow-not-found.js). This probe is the only thing in
 * the path that can contradict a stale list with evidence.
 *
 * ## Measured response shape
 *
 * `GET /api/userdata?dir=workflows&recurse=true&split=false` → 200, a flat array of
 * STRINGS relative to the workflows dir, e.g. `"Anima Wojak Batch.json"`,
 * `"sub/Nested.json"`. The bare `/userdata` prefix answers identically. `split=true`
 * returns `[path, path]` pairs instead, which this does not use.
 */

/**
 * Canonical form for comparing a workflow selector against a disk listing.
 *
 * Store records carry `workflows/X.json` while the listing returns `X.json`, so the
 * prefix is stripped; separators are normalised because Windows answers with both.
 * The extension is NOT stripped here — `hasSelector` compares with and without it,
 * so `X`, `X.json` and `workflows/X.json` all resolve to the same file without this
 * function having to guess which form it was handed.
 */
export function canonicalWorkflowPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^workflows\//i, "")
    .replace(/^\/+/, "");
}

/** The same value without a trailing `.json`, for extension-insensitive matching. */
function withoutJson(p) {
  return p.replace(/\.json$/i, "");
}

/**
 * Does the server's listing contain this selector?
 *
 * Matches the selector forms a saved record answers to — full relative path, bare
 * name, with or without `.json` — because the caller's `path` may be any of them and
 * the store itself accepts all three.
 *
 * Case-insensitive: the reporter is on Windows, where a listing that differs only in
 * case names the same file, and answering "not on disk" for it would reproduce this
 * bug with better wording.
 *
 * @returns {string|null} the listing entry that matched, or null.
 */
export function diskListingEntryFor(listing, selector) {
  const found = matchDiskListing(listing, selector);
  return found.matches.length === 1 ? found.matches[0] : null;
}

/**
 * The full result: every entry the selector could name.
 *
 * AMBIGUITY IS REPORTED, NOT RESOLVED (review, P1). An earlier version returned the
 * first base-name hit and the refusal then said the requested file "IS on disk",
 * naming a file the caller may not have meant and prescribing a reload that would not
 * help. Worse, the comment claimed it was "deliberately not resolved to a guess"
 * while the code did exactly that — the reassurance was the tell.
 *
 * An EXACT path match is unambiguous by construction and wins outright: `b/Same.json`
 * names one file even when `a/Same.json` exists. Only a BARE name can fan out, and
 * when it does the caller is told which folders hold it rather than being sent to one
 * of them.
 *
 * @returns {{matches: string[], exact: boolean}}
 */
export function matchDiskListing(listing, selector) {
  const none = { matches: [], exact: false };
  if (!Array.isArray(listing)) return none;
  const want = canonicalWorkflowPath(selector);
  if (!want) return none;
  const wantNoExt = withoutJson(want).toLowerCase();
  const wantBase = wantNoExt.split("/").pop();
  const qualified = wantNoExt.includes("/");
  const byBase = [];
  for (const raw of listing) {
    const entry = canonicalWorkflowPath(typeof raw === "string" ? raw : raw?.[0]);
    if (!entry) continue;
    const entryNoExt = withoutJson(entry).toLowerCase();
    if (entryNoExt === wantNoExt) return { matches: [entry], exact: true };
    if (!qualified && entryNoExt.split("/").pop() === wantBase) byBase.push(entry);
  }
  return { matches: byBase, exact: false };
}

/**
 * The probe's verdict, kept separate from the fetch so it is testable without a
 * server and so the FAIL-OPEN rule is enforced in one place.
 *
 * Fail-open is the property that matters. Every previous round of this issue shipped
 * a message that claimed more than it knew, so an unreachable `/userdata`, a build
 * that does not serve it, a non-array body, or any throw must answer "unknown" — not
 * "absent". A probe that turned a stale-list refusal into a confident "your file does
 * not exist" would be the same bug with more authority.
 *
 * @param {{ok: boolean, status?: number, body?: unknown}|null} response
 * @param {string} selector
 * @returns {{onDisk: "yes"|"no"|"unknown", entry?: string, why?: string}}
 */
export function classifyDiskProbe(response, selector) {
  if (!response || response.ok !== true) {
    return { onDisk: "unknown", why: response?.status ? `HTTP ${response.status}` : "no response" };
  }
  if (!Array.isArray(response.body)) return { onDisk: "unknown", why: "unrecognised listing shape" };
  const { matches } = matchDiskListing(response.body, selector);
  if (matches.length === 1) return { onDisk: "yes", entry: matches[0] };
  // Several files share that bare name. Saying "yes" here would name one of them and
  // tell the caller to reload for a file they may not have meant (review, P1); saying
  // "no" would be false. The honest answer is that the name is under-specified, and
  // the caller can act on it — qualify the folder.
  if (matches.length > 1) return { onDisk: "ambiguous", candidates: matches };
  return { onDisk: "no" };
}
