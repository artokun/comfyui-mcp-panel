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
 * Did a workflow-list re-read demonstrably HAPPEN? (#1448 r2)
 *
 * `syncWorkflows` is a VueUse `useAsyncState` execute wrapper built without
 * `throwError`, so it resolves whether the read succeeded or failed and the
 * store never exposes the error. "The call returned" is therefore no evidence at
 * all, and treating it as evidence is what made every refusal claim the list had
 * been re-read.
 *
 * What IS evidence is the store changing: a genuine re-read rebuilds the arrays,
 * so entries appear or disappear (measured on a live rig: 109 → 107) or the
 * array identity is replaced. Either proves it ran.
 *
 * Seeing NEITHER proves nothing — an unchanged directory re-reads to an
 * identical list — hence "unconfirmed" rather than "failed". Lives here, out of
 * the DOM-bound panel module, so the decision is testable on its own; mutation
 * showed the message tests could not see it at all.
 *
 * @param {{counts: string, open: unknown, saved: unknown}} before
 * @param {{counts: string, open: unknown, saved: unknown}} after
 * @returns {"ok"|"unconfirmed"}
 */
export function classifyWorkflowRefresh(before, after) {
  if (!before || !after) return "unconfirmed"; // nothing to compare — claim nothing
  const countsMoved = before.counts !== after.counts;
  const arraysReplaced = before.open !== after.open || before.saved !== after.saved;
  return countsMoved || arraysReplaced ? "ok" : "unconfirmed";
}

/**
 * The refusal, saying what was actually done.
 *
 * `refresh` is one of: "ok" (the re-read was OBSERVED to change the store),
 * "unconfirmed" (the call resolved but nothing observable changed), "unavailable"
 * (this frontend has no syncWorkflows, so it never was), "not-needed", or
 * "failed: <reason>".
 *
 * "unconfirmed" exists because the previous three-way split collapsed to a single
 * outcome in practice (#1448 r2): `syncWorkflows` is a VueUse `useAsyncState`
 * execute wrapper built without `throwError`, so a failed re-read resolves
 * normally and the panel cannot see it. Every refusal therefore claimed the list
 * "WAS re-read" — a stronger assertion than the one this issue was filed about.
 * The caller now proves the re-read by watching the store change, and says
 * "unconfirmed" when it cannot.
 */
export function openWorkflowNotFoundMessage({ path, refresh, known = [] } = {}) {
  const refreshClause =
    refresh === "ok"
      ? `The workflow list WAS re-read from the server first (the list changed), and it still does ` +
        `not contain it.`
      : refresh === "unconfirmed"
        ? `A re-read of the workflow list was requested and returned, but NOTHING in the list ` +
          `changed — so this panel cannot confirm the list was actually refreshed, and cannot ` +
          `treat the absence as proof the file is missing. (This frontend's sync swallows its own ` +
          `errors, so a silent failure looks exactly like a directory that did not change.) If the ` +
          `file IS on disk, reload the ComfyUI browser tab and try again.`
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
