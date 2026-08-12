/**
 * panel#1448 — "it isn't among the saved/open workflows even after a refresh".
 *
 * Two things were wrong with that sentence, and the reporter hit both.
 *
 * 1. IT ASSERTED A REFRESH IT HAD NOT CHECKED. The lookup refreshes only when the
 *    frontend exposes `syncWorkflows`, and a throw from it was swallowed by a
 *    console.warn no agent session ever reads. So on a frontend without that method,
 *    or when the call failed, the message claimed a re-read that never happened —
 *    and the one fact that could have pointed somewhere was the one being fabricated.
 *
 * 2. ITS REMEDY NAMED THE WRONG CAUSE. "For a file outside the workflows folder"
 *    reads as a diagnosis, and the reporter's file was INSIDE the folder — they had
 *    confirmed it on disk, twice. Being told to look outside sent them away from a
 *    file that was exactly where they thought.
 *
 * ## What could NOT be reproduced, and is therefore not claimed
 *
 * Measured on ComfyUI 0.32.0 / frontend 1.48.7: `syncWorkflows()` genuinely re-reads
 * (the store went 109 -> 107, dropping two stale entries), every file on disk was
 * present afterwards, and a bare `<name>.json` selector matches a saved record via
 * its `key`. So the refresh path works on that build, and this does not pretend to
 * have fixed a lookup failure it could not observe. What it fixes is the message,
 * which was making a claim it had no evidence for either way.
 */

/** The selector forms a saved record answers to, sampled so the caller can SEE the
 *  shape rather than guess it. Deliberately a sample: a store with 100+ entries in a
 *  refusal is noise, and the shape is what disambiguates, not the inventory. */
export function knownSelectorSample(records, limit = 3) {
  const out = [];
  for (const w of records ?? []) {
    if (out.length >= limit) break;
    const path = typeof w?.path === "string" ? w.path : null;
    if (!path || w?.isPersisted !== true) continue;
    out.push(path);
  }
  return out;
}

/**
 * The refusal, saying what was actually done.
 *
 * `refresh` is one of: "ok" (the list was re-read), "unavailable" (this frontend has
 * no syncWorkflows, so it never was), "not-needed", or "failed: <reason>".
 */
export function openWorkflowNotFoundMessage({ path, refresh, known = [] } = {}) {
  const refreshClause =
    refresh === "ok"
      ? `The workflow list WAS re-read from the server first, and it still does not contain it.`
      : refresh === "unavailable"
        ? `The list was NOT re-read: this ComfyUI frontend exposes no workflow-sync method, so a ` +
          `file staged since the tab loaded may simply not be known yet. Reload the ComfyUI browser ` +
          `tab and try again before concluding the file is missing.`
        : typeof refresh === "string" && refresh.startsWith("failed")
          ? `The re-read of the workflow list FAILED (${refresh.slice("failed: ".length)}), so this ` +
            `is not evidence the file is absent — the list may simply be stale.`
          : `The list was already current.`;

  const shape = known.length
    ? ` Saved workflows here are addressed as e.g. ${known.map((k) => `"${k}"`).join(", ")} — the ` +
      `same file also answers to its bare name with or without ".json".`
    : "";

  return (
    `no workflow matching "${path}". ${refreshClause}${shape} If the file IS in the workflows ` +
    `folder, check the name matches exactly (including case and any subfolder); if it is anywhere ` +
    `else, load it with panel_load_workflow path:<file>, which reads any readable path.`
  );
}
