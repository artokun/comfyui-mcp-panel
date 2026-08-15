/**
 * #986 — the same finished output re-announced as several separate completions.
 *
 * REPORTED: one 10s clip (`Video_00144.mp4`) delivered to the agent six or more times
 * in ~30 seconds. Each arrived with a DIFFERENT prompt id, an implausible render time
 * (0.3s, 0.1s, …) against a genuine first render of 10m51s, an identical contact
 * sheet, and the "origin is UNDETERMINED" banner. Every one demanded a reply, and the
 * agent had no way to tell a replay from a real re-render.
 *
 * WHY THE EXISTING FENCE DOES NOT CATCH IT. `run-completion.js` dedupes on the PROMPT
 * ID (`delivered` is keyed by it). These were genuinely different prompts: the user
 * queued, cancelled and re-queued from the canvas, and ComfyUI served the identical
 * output from cache each time — which is also why the durations are sub-second. So
 * the fence is working exactly as designed and is simply looking at the wrong thing.
 * Nothing keyed on prompt id can collapse them.
 *
 * WHAT IS THE SAME is the OUTPUT. So the dedupe is on the media itself.
 *
 * NOTHING IS EVER WITHHELD. The first design suppressed a repeat that looked cached,
 * and review showed that cannot be made sound: a fixed-name writer can produce
 * different bytes in under a second with a normal lifecycle, so no duration threshold
 * separates a replay from a fast re-render. A completion is therefore always
 * delivered, ANNOTATED with the prompt it duplicates and whether it looks cached —
 * which is what the agent lacked. Losing a render someone waited for is the worse
 * failure, and it is the one this cannot commit.
 *
 * A panel-queued run is never even annotated as a duplicate: `panel_run` promised the
 * agent a notification and told it to end its turn, so that delivery is its own event.
 */

/**
 * A stable identity for a completion's media: what files it delivered, not which
 * prompt produced them.
 *
 * Sorted so ordering differences cannot mint a new signature, and built from the
 * fields that identify a file on the server (`filename`, `subfolder`, `type`).
 * Returns null when there is nothing identifying to hash — no signature means no
 * duplicate claim, which is the safe direction.
 */
export function mediaSignature(images, videos) {
  const parts = [];
  const add = (kind, list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      // Reconciled videos arrive WRAPPED as `{ m, nodeId }` from parseHistoryEntry,
      // not as the bare ref (codex). Unwrapping here rather than at each call site
      // keeps the two paths producing the SAME signature — without it a recovered
      // video signed as null, so the reported clip shape seeded nothing and its next
      // replay was announced again.
      const ref = item.m && typeof item.m === "object" ? item.m : item;
      const filename = ref.filename ?? ref.name ?? null;
      // A media item with no filename cannot be identified across runs. Including a
      // placeholder would let two DIFFERENT unnamed outputs collide, so the whole
      // signature is abandoned instead (see the null return below).
      if (typeof filename !== "string" || filename === "") return null;
      // JSON-encoded per FIELD, not concatenated (codex). An earlier attempt encoded
      // only the outer array while each part stayed `kind:type/subfolder/filename`,
      // so `type:"output/foo" subfolder:"bar"` and `type:"output" subfolder:"foo/bar"`
      // still produced the same part — a collision here suppresses a real result.
      parts.push(JSON.stringify([kind, ref.type ?? "", ref.subfolder ?? "", filename]));
    }
  };
  if (add("i", images) === null) return null;
  if (add("v", videos) === null) return null;
  if (!parts.length) return null;
  parts.sort();
  return JSON.stringify(parts);
}

/**
 * Tracks which media sets have already been announced, so an identical one arriving
 * again under a new prompt id can be recognised.
 *
 * `ttlMs` bounds it in time rather than in count: two renders of the same file an hour
 * apart are two real events and must both be delivered. The default window is minutes,
 * which covers the reported burst (six in ~30 seconds) without swallowing a later
 * deliberate re-render.
 */
export function createCompletionDeduper({
  ttlMs = 5 * 60 * 1000,
  now = () => Date.now(),
  // Below this, a repeat is flagged as looking like a cache hit rather than work. The
  // reporter's numbers set it: 0.1-0.3s replays against a genuine 10m51s first render.
  // It only ever changes the WORDING of an annotation — nothing is withheld on it —
  // so being approximate here is cheap.
  cacheHitMaxMs = 1500,
} = {}) {
  const seen = new Map(); // signature -> { at, promptId }

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [sig, entry] of seen) if (entry.at < cutoff) seen.delete(sig);
  };

  return {
    /**
     * How should this completion be reported?
     *
     * Returns `{ deliver, duplicateOf, looksCached }`. `deliver` is ALWAYS true — see
     * the module header. `duplicateOf` names the earlier prompt that delivered this
     * exact media, or null; `looksCached` says whether this repeat also failed to
     * spend any real time rendering, which is the strongest available hint that it
     * came from ComfyUI's cache rather than from work.
     */
    consider({ signature, panelQueued, promptId, durationMs, durationTrusted = false }) {
      prune();
      if (panelQueued) return { deliver: true, duplicateOf: null };
      if (!signature) return { deliver: true, duplicateOf: null };
      const hit = seen.get(signature);
      if (!hit) {
        seen.set(signature, { at: now(), promptId: promptId ?? null });
        return { deliver: true, duplicateOf: null };
      }
      // Same output as one already announced. Whether that is a cache REPLAY or a
      // genuinely fast re-render CANNOT be proven from here (codex, final round): a
      // custom fixed-name writer can legitimately produce different bytes in under a
      // second, with an entirely normal lifecycle making its duration trustworthy. No
      // threshold separates the two, and a first-run comparator does not either.
      //
      // So nothing is ever withheld. Losing a render someone waited for is a worse
      // outcome than an extra message, and the agent's actual complaint — being unable
      // to tell a replay from a real result — is answered by SAYING which it looks
      // like, not by deciding on its behalf.
      //
      // `durationTrusted` still gates the flag. When execution_start and executing()
      // are both dropped the tracker invents a start at the final output event, so a
      // ten-minute render can report a sub-second duration; calling that a cache hit
      // would be wrong on the facts as well as unhelpful.
      const looksCached =
        durationTrusted &&
        typeof durationMs === "number" &&
        Number.isFinite(durationMs) &&
        durationMs >= 0 &&
        durationMs <= cacheHitMaxMs;
      return { deliver: true, duplicateOf: hit.promptId ?? null, looksCached };
    },

    /**
     * Record a delivery made outside `consider` (a panel-queued run), so a later
     * canvas re-queue of the SAME output is recognised as the duplicate it is.
     * Without this the first canvas replay after a panel run would always get through.
     */
    record({ signature, promptId }) {
      if (!signature) return;
      prune();
      if (!seen.has(signature)) seen.set(signature, { at: now(), promptId: promptId ?? null });
    },

    /** Test/observability seam: how many signatures are currently held. */
    size() {
      prune();
      return seen.size;
    },
  };
}

/**
 * The note attached to a suppressed duplicate's counterpart — used by the caller to
 * explain, once, that further identical completions are being collapsed. States what
 * was observed rather than diagnosing ComfyUI's caching.
 */
export function duplicateCompletionNote(duplicateOf, looksCached) {
  if (!duplicateOf) return "";
  // Says only what the mechanism saw (codex). It compared FILE REFERENCES, not bytes,
  // and `looksCached === false` covers "took longer than the threshold" AND "the
  // duration could not be trusted" — two different things, neither of which is proof
  // that work happened.
  return (
    `Prompt ${duplicateOf} already delivered output with the same file reference(s) — same ` +
    `name, folder and type. The panel compares references, not file contents, so it cannot ` +
    `say whether the bytes are the same.` +
    (looksCached
      ? ` This run also finished too fast to have rendered anything, which is what a re-queue ` +
        `served from ComfyUI's cache looks like.`
      : ` This run did NOT finish suspiciously fast, so it may be a genuine re-render that ` +
        `happens to write the same filename — or its duration simply could not be established. ` +
        `Either way the panel does not guess.`) +
    ` Nothing is withheld on any of this: a completion is always delivered, because losing a ` +
    `render you waited for would be worse than an extra message.`
  );
}
