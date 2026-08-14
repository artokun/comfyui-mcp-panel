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
 * What was OBSERVED about the workflow list across a re-read attempt (#1448 r2).
 *
 * This deliberately says nothing about whether `syncWorkflows()` succeeded, and
 * that restraint is the whole point. Two rounds of this fix tried to prove the
 * read happened and both were wrong:
 *
 *   1. "the call resolved" — worthless. `syncWorkflows` is a VueUse
 *      `useAsyncState` execute wrapper built without `throwError`, so a failed
 *      read is caught into a private ref and execute resolves normally.
 *   2. "the list changed, therefore the read worked" — a CAUSAL claim from a
 *      CORRELATION (review). Another writer can change the store during the
 *      await while the sync silently fails, and a reactive getter that
 *      materialises a fresh array per access makes the identity test fire every
 *      single time — which would restore the original bug wearing new wording.
 *
 * So the verdict describes the LIST, which is the thing actually observed:
 * "changed" or "unchanged". The caller's message must not upgrade either into a
 * statement about the server read.
 *
 * Identity is calibrated PER LIST, and separately, because the two need not
 * behave alike: the store can expose one as a plain array and the other as a
 * reactive getter that materialises a fresh array per access. A single
 * all-or-nothing flag would disable identity for both the moment either one is
 * fresh, throwing away a real signal from the stable list (review, round 2). The
 * caller detects each by sampling twice with nothing in between.
 *
 * @param {{counts: string, open: unknown, saved: unknown}|null} before
 * @param {{counts: string, open: unknown, saved: unknown}|null} after
 * @param {{openIdentityMeaningful?: boolean, savedIdentityMeaningful?: boolean}} [opts]
 * @returns {"changed"|"unchanged"}
 */
export function classifyWorkflowRefresh(before, after, opts = {}) {
  if (!before || !after) return "unchanged"; // nothing to compare — claim nothing
  if (before.counts !== after.counts) return "changed";
  const openMoved = opts.openIdentityMeaningful !== false && before.open !== after.open;
  const savedMoved = opts.savedIdentityMeaningful !== false && before.saved !== after.saved;
  return openMoved || savedMoved ? "changed" : "unchanged";
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
export function openWorkflowNotFoundMessage({ path, refresh, known = [], disk } = {}) {
  // #1448 (the half the reporter actually filed) — the SERVER was asked whether the
  // file exists, and when it says yes this is a different failure entirely. Handled
  // first and returned early: none of the list-refresh reasoning below applies once
  // the file is known to be on disk, and appending it would bury the one fact that
  // decides what the caller should do next.
  //
  // The two cases need OPPOSITE actions — reload the tab vs fix the name — and were
  // previously the same sentence, which is why the reporter went looking for a file
  // that was exactly where they left it.
  if (disk?.onDisk === "yes") {
    return (
      `"${path}" IS on disk in the workflows folder (the server lists it as ` +
      `"${disk.entry}"), but this ComfyUI frontend's workflow list does not contain it. ` +
      `The file is not missing — the list is stale, and a re-read did not pick it up ` +
      `(this frontend's sync swallows its own errors, so a silent failure is invisible ` +
      `from here). RELOAD THE COMFYUI BROWSER TAB and try again; the entry appears once ` +
      `the frontend re-reads the folder. To open it right now without reloading, use ` +
      `panel_load_workflow path:<file> — it reads the file directly, though the tab ` +
      `lands unsaved rather than as a saved library entry.`
    );
  }

  // Several files on disk answer to that bare name. Naming one and telling the caller
  // to reload would send them to a file they may not have meant (review, P1), so the
  // refusal reports the fan-out and the action that resolves it.
  if (disk?.onDisk === "ambiguous") {
    const list = (disk.candidates ?? []).map((c) => `"${c}"`).join(", ");
    return (
      `"${path}" is ambiguous: the workflows folder on disk holds more than one file with ` +
      `that name — ${list}. Qualify it with the subfolder (e.g. panel_open_workflow ` +
      `path:"<subfolder>/<name>.json") so this opens the one you mean.`
    );
  }

  const refreshClause =
    refresh === "changed"
      ? `A re-read of the workflow list was requested and the list DID change, and it still does ` +
        `not contain a match. (The panel cannot see whether the server read itself succeeded — ` +
        `this frontend's sync swallows its own errors — so this reports the list, not the read.)`
      : refresh === "unchanged"
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

  // What the SERVER said, when it could be asked. "no" is the first evidence this
  // refusal has ever had for the absence it asserts; "unknown" keeps the old,
  // unevidenced wording rather than inventing a stronger claim (#1448).
  const diskClause =
    disk?.onDisk === "no"
      ? ` The server was also asked directly: the workflows folder on disk does NOT contain ` +
        `it either, so this is not a stale-list problem.`
      : disk?.onDisk === "unknown"
        ? ` The server could not be asked whether the file is on disk (${disk.why ?? "probe failed"}), ` +
          `so absence from the list is not by itself proof the file is missing.`
        : "";

  return (
    `no workflow matching "${path}". ${refreshClause}${diskClause}${shape} If the file IS in the ` +
    `workflows folder, check the name matches exactly (including case and any subfolder); if it is ` +
    `anywhere else, load it with panel_load_workflow path:<file>, which reads any readable path.`
  );
}
