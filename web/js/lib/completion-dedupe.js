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
 * SCOPED TO RUNS THE PANEL DID NOT QUEUE. A panel-queued run was promised a
 * notification — `panel_run` tells the agent "you will be notified automatically, do
 * NOT poll, end your turn now" — so suppressing one would wedge the agent waiting for
 * a message that never comes. That is a worse failure than the duplicates. A canvas
 * run carries no such promise, which is exactly the case the report is about.
 */

/**
 * A stable identity for a completion's media: what files it delivered, not which
 * prompt produced them.
 *
 * Sorted so ordering differences cannot mint a new signature, and built from the
 * fields that identify a file on the server (`filename`, `subfolder`, `type`).
 * Returns null when there is nothing identifying to hash — no signature means no
 * suppression, which is the safe direction.
 */
export function mediaSignature(images, videos) {
  const parts = [];
  const add = (kind, list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const filename = item.filename ?? item.name ?? null;
      // A media item with no filename cannot be identified across runs. Including a
      // placeholder would let two DIFFERENT unnamed outputs collide, so the whole
      // signature is abandoned instead (see the null return below).
      if (typeof filename !== "string" || filename === "") return null;
      parts.push(`${kind}:${item.type ?? ""}/${item.subfolder ?? ""}/${filename}`);
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
  // #986 (codex NO-SHIP): same filename is NOT the same result. A node that writes a
  // fixed name — no counter in the prefix — produces two REAL renders with identical
  // signatures, and suppressing the second loses work the user waited for.
  //
  // The reporter's own evidence supplies the discriminator: the duplicates ran in
  // 0.1-0.3s against a genuine first render of 10m51s. Nothing renders a 10s clip in
  // 100ms; that is ComfyUI returning a cached result. So a repeat is only suppressed
  // when it did not actually render. A real overwrite render takes real time and is
  // always delivered.
  //
  // An UNKNOWN duration never suppresses: a missing start yields null, and null is
  // not evidence of a cache hit.
  cacheHitMaxMs = 1500,
} = {}) {
  const seen = new Map(); // signature -> { at, promptId }

  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [sig, entry] of seen) if (entry.at < cutoff) seen.delete(sig);
  };

  return {
    /**
     * Should this completion be delivered?
     *
     * Returns `{ deliver, duplicateOf }`. `deliver` is false ONLY when every condition
     * holds: the panel did not queue this run, the media is identifiable, and the same
     * media was announced within the window. Anything unestablished delivers — a
     * missed duplicate costs a redundant message, a wrongly-suppressed completion
     * costs the result itself.
     */
    consider({ signature, panelQueued, promptId, durationMs }) {
      prune();
      if (panelQueued) return { deliver: true, duplicateOf: null };
      if (!signature) return { deliver: true, duplicateOf: null };
      const hit = seen.get(signature);
      if (!hit) {
        seen.set(signature, { at: now(), promptId: promptId ?? null });
        return { deliver: true, duplicateOf: null };
      }
      // Same output as something already announced — but that alone does not make it
      // a replay. Only a run that plainly did not render is suppressed.
      const looksCached = typeof durationMs === "number" && durationMs >= 0 && durationMs <= cacheHitMaxMs;
      if (!looksCached) return { deliver: true, duplicateOf: null };
      return { deliver: false, duplicateOf: hit.promptId ?? null };
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
export function duplicateSuppressedNote(count, duplicateOf) {
  if (!count) return "";
  return (
    `${count} further completion${count === 1 ? "" : "s"} carrying this exact output ` +
    `${count === 1 ? "was" : "were"} not re-announced. They arrived under different prompt ids ` +
    `${duplicateOf ? `(first seen as ${duplicateOf}) ` : ""}but delivered the same file(s), which is ` +
    `what a re-queue served from ComfyUI's cache looks like — the sub-second durations are the ` +
    `giveaway. Runs queued through panel_run are never suppressed, so a result you asked for ` +
    `always arrives.`
  );
}
