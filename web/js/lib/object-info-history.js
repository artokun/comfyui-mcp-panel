// The OBSERVED-BACKEND-HISTORY trust root for the #458 write/add guards, extracted so
// the exact fail-closed rules are unit-testable instead of living as loose module state
// in the 20k-line panel bundle.
//
// WHAT IT IS: the session-scoped set of every node class_type that has appeared in ANY
// backend /object_info response during this session. A type ABSENT from the CURRENT
// /object_info that was EVER seen here is a REMOVED backend node (pack uninstalled) and
// must be refused — a client husk cannot un-see what the backend already reported. A type
// NEVER seen is genuinely frontend-only (Note/MarkdownNote/Reroute/…) and may be exempted.
// This is the one signal the guards' client-side allowlist and provenance markers cannot
// forge, so the whole frontend-only exemption in node-resolve.js rests on it.
//
// THE TWO FAIL-CLOSED RULES (both learned from adversarial review):
//
//   1. UNSEEDED ⇒ CLOSED. Until at least one authoritative /object_info observation has
//      been recorded as a BASELINE, "never seen" means nothing, so wasTypeEverDefined
//      reports EVERY absent-from-current type as removed. A failed seed therefore never
//      opens a hole; it only refuses more.
//
//   2. BASELINE LOST ⇒ LATCHED CLOSED FOR THE SESSION. Once the page-load-anchored
//      observation window has POSITIVELY closed with no data, no later observation can
//      prove a type was "never defined earlier this session": a removal may have happened
//      inside the gap. So after loseBaseline() nothing may mark the history seeded, not
//      even a successful reconnect/refresh_nodes re-register. (Without this latch: the
//      startup fetch fails → a pack is removed → a later fetch installs the POST-removal
//      map as the baseline → a provenance-stripped husk squatting a reserved allowlisted
//      name reads "never seen" and is exempted — the hole the ever-seen gate exists to
//      close.)
//
//      THE LATCH IS ARMED BY EVIDENCE ONLY, NEVER BY A TIMEOUT. "Not seeded yet" and
//      "proven unanchored" are different states and get different handling, because
//      conflating them created a third false refusal on top of the two this work fixes:
//      an /object_info fetch that merely took longer than a tool's bounded wait would
//      latch the session closed, and every subsequent legitimate add/write was refused
//      until the user reloaded the tab — even though the request then returned perfectly
//      healthy definitions. A timeout is the ABSENCE of evidence. The PENDING state
//      (rule 1, below) covers it and is fully RECOVERABLE: the in-flight seed keeps
//      running, a late response still calls markSeeded(), and normal operation resumes
//      on the next call with no reload.
//
// recordTypes() is deliberately NOT latched: recording can only ever ADD evidence that a
// type existed, which can only ever make the gate refuse MORE. Only the "this history is
// trustworthy enough to conclude never-seen" claim is latched.
//
// KNOWN, ACCEPTED RESIDUAL — do not "fix" it by weakening the rules above. The baseline
// can only ever be established from an ASYNCHRONOUS /object_info response, so it is a
// snapshot as of the fetch, not of page load. A pack removed inside that window (page load
// → the first successful fetch; the seed's whole retry sequence is sub-second) is never
// observed, so it would read "never seen". Exploiting that requires a third-party pack to
// squat a ComfyUI-core-RESERVED name (Note/MarkdownNote/Reroute/PrimitiveNode or a
// "… (rgthree)" control node), strip its own frontend class's .nodeData/.comfyClass, AND
// be uninstalled inside that sub-second window — an adversarial construction, not an
// accidental failure, in a product where the panel, orchestrator and user share one
// machine and one trust domain. There is no synchronous page-load oracle that would close
// it. The reserved-name allowlist and the provenance checks are the layered defenses that
// keep the residual to exactly that construction.

import { HISTORY_PENDING, HISTORY_UNSEEDED } from "./node-resolve.js";

export function createObjectInfoHistory() {
  const seen = new Set();
  let seeded = false;
  let baselineLost = false;

  return {
    /** Record every class_type in a real /object_info payload. Returns `defs` unchanged
     *  so it can wrap a fetch inline. A null/non-object payload records nothing. */
    recordTypes(defs) {
      if (defs && typeof defs === "object") {
        for (const key of Object.keys(defs)) seen.add(key);
      }
      return defs;
    },

    /** Promote the recorded history to a trustworthy BASELINE. A no-op once the baseline
     *  has been lost — that is rule 2, and it is the whole point of this module. */
    markSeeded() {
      if (baselineLost) return false;
      seeded = true;
      return true;
    },

    /** Latch: POSITIVE EVIDENCE that the page-load-anchored observation window closed
     *  WITHOUT data, so no later fetch can serve as a baseline. IRREVERSIBLE, and it
     *  demotes any existing baseline.
     *
     *  ARM THIS ONLY ON EVIDENCE, NEVER ON A TIMEOUT. A timeout is the ABSENCE of
     *  evidence, not evidence: the request may still be in flight and about to return
     *  perfectly healthy definitions. Latching on one would turn ordinary latency into a
     *  permanent, session-long false refusal of every legitimate add/write — the exact
     *  bug class (#496/#507) this module's consumers exist to fix. Use the recoverable
     *  PENDING state for "no baseline yet"; the only caller here is the startup seed
     *  after its whole attempt sequence has finished with nothing. */
    loseBaseline() {
      baselineLost = true;
      seeded = false;
    },

    /** The oracle the #458 guards inject. TRUE ⇒ "treat as defined earlier this session",
     *  which for a type absent from the CURRENT /object_info means REMOVED ⇒ refuse.
     *
     *  Without a baseline it returns one of two TRUTHY sentinels — truthy so a consumer
     *  that only tests for truth still fails closed, distinct so the guards can say what
     *  is actually wrong instead of falsely blaming a removed pack (nonsense for a
     *  MarkdownNote, and exactly the misleading diagnosis #496 was filed about):
     *    HISTORY_PENDING  — the baseline has not ARRIVED yet. TEMPORARY and RECOVERABLE:
     *                       a late /object_info response still calls markSeeded(), after
     *                       which the very next call authorizes normally, no tab reload.
     *    HISTORY_UNSEEDED — the observation window closed with nothing (latched). Only a
     *                       reload can re-establish a baseline. */
    wasTypeEverDefined(type) {
      if (seeded) return seen.has(type);
      return baselineLost ? HISTORY_UNSEEDED : HISTORY_PENDING;
    },

    get seeded() {
      return seeded;
    },
    get baselineLost() {
      return baselineLost;
    },
    /** Test/diagnostic view of the recorded set. */
    has(type) {
      return seen.has(type);
    },
  };
}

/**
 * Wait (BOUNDED) for the startup baseline seed, then return REGARDLESS of whether it
 * landed. Extracted from the panel so the rule below is directly testable — the bug it
 * encodes was found in review, not by a test, precisely because this logic had no seam.
 *
 * THE RULE, AND THE WHOLE REASON THIS FUNCTION EXISTS: it must NEVER mutate `history`.
 * The bound exists only so a getNodeDefs() that never settles cannot hang a graph tool
 * forever; giving up on the WAIT teaches us nothing about the backend. If this called
 * history.loseBaseline(), a fetch that merely took a moment longer than the bound would
 * latch the session closed and every subsequent legitimate add/write would be refused
 * until the user reloaded the tab — ordinary latency causing permanent breakage, the same
 * false-refusal bug class (#496/#507) this guard family was fixed to stop producing.
 *
 * Nor may it start a REPLACEMENT seed: that fetch would be anchored after an unobserved
 * window, and installing its map as the baseline is exactly the removed-pack hole.
 *
 * So: on return the history is either SEEDED (proceed normally) or PENDING (refuse this
 * one call, temporarily). `seedPromise` keeps running either way, and a late response
 * still calls markSeeded(), so the next call authorizes with no reload. `history` is
 * accepted only so callers and tests can state that invariant explicitly.
 */
export async function awaitHistoryBaseline(history, seedPromise, timeoutMs) {
  let timer;
  try {
    await Promise.race([
      // A rejected seed is not an error here — it simply leaves the history unseeded.
      Promise.resolve(seedPromise).catch(() => {}),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    // Clear the losing timer so a fast seed does not pin a handle per graph tool call.
    clearTimeout(timer);
  }
  // Deliberately no state change. See the rule above before adding one.
  return history?.seeded ?? false;
}
