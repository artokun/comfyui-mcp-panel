/**
 * comfyui-mcp#1136 — the status chip read "disconnected" on a working session, because
 * the panel dialed a dead port while a healthy bridge answered next door.
 *
 * Measured on the reporting machine:
 *
 *   9180   LISTENING, HTTP 426 Upgrade Required   <- the live single-port bridge
 *   52727  ECONNREFUSED                            <- comfyui-mcp.bridgeUrl.claude
 *
 * with `defaultBackend: "claude"`. The chip faithfully reported that socket as down;
 * the label was never wrong, its SUBJECT was.
 *
 * ## How the dead port became permanent
 *
 * A one-time migration copies the pre-per-backend `comfyui-mcp.bridgeUrl` into the
 * Claude group "so a returning user's custom port isn't lost" — but that value is an
 * EPHEMERAL orchestrator port. The connect path honours any URL differing from the
 * default as a deliberate override, and external-orchestrator mode never POSTs
 * /connect, so the orchestrator's advertised bridge_url never corrects it.
 *
 * ## Why this is NOT solved by working out who chose the URL
 *
 * Two earlier attempts tried exactly that and were refused by review, from opposite
 * directions. A localStorage marker recording the migration never cleared when the user
 * edited the field, and could desynchronise from the SYNCED setting it described.
 * Deriving it instead — "the per-backend value still equals the legacy one" — breaks
 * the moment the legacy setting changes independently, reclassifying the stale URL as
 * chosen and restoring the bug.
 *
 * Authorship is not recoverable from what the panel stores, so every encoding of it
 * either rots or over-claims — and both punish a user who deliberately picks the old
 * value.
 *
 * ## LIVENESS instead
 *
 * The defect is not "the panel honours the wrong URL", it is "the panel dials a dead
 * port forever and never recovers". That needs no theory of intent:
 *
 *   - the configured URL is honoured exactly as before, whoever set it
 *   - when it will not connect, try the bridge that should be there, and SAY so
 *   - a URL that answers is never second-guessed
 *
 * This also covers what no provenance rule reaches: a port the user genuinely typed and
 * then moved.
 */

/** Normalise for COMPARISON only — never the value we dial. */
function norm(url) {
  return typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}

/** Are these the same bridge address? */
export function sameBridge(a, b) {
  const x = norm(a);
  const y = norm(b);
  return !!x && x === y;
}

/**
 * What to try when the configured bridge did not answer.
 *
 * Returns `null` when there is nothing useful to do — no fallback known, the fallback
 * is the address that just refused, or we already fell back to it. Otherwise returns
 * the URL to dial and the notice explaining why.
 *
 * `attempted` is what this session has already tried, so two dead ports cannot start a
 * loop. The caller records the fallback there before dialing.
 */
export function bridgeFallbackPlan({ configured, fallback, attempted } = {}) {
  const to = norm(fallback);
  if (!to) return null;
  // Redialing the address that just refused gains nothing and would loop.
  if (sameBridge(configured, fallback)) return null;
  const tried = attempted instanceof Set ? attempted : new Set(attempted ?? []);
  if (tried.has(to)) return null;
  return { url: fallback, key: to, notice: bridgeFallbackNotice(configured, fallback) };
}

/**
 * The notice shown when falling back.
 *
 * States what did not answer, what is being tried, and WHY a configured URL can be
 * dead — a reader who does not know bridge URLs can outlive their process reads a bare
 * "trying something else" as the panel being flaky. It also promises nothing about the
 * fallback working, and says the configured value was not silently rewritten, because
 * a setting that changes itself is its own bug.
 */
export function bridgeFallbackNotice(configured, fallback) {
  return (
    `No agent answered on the configured bridge (${configured}). Trying this panel's ` +
    `default bridge (${fallback}) instead. A bridge URL can outlive the process that ` +
    `owned it: an orchestrator restarted on a different port leaves the old address ` +
    `configured but dead, and in external-orchestrator mode nothing corrects it ` +
    `automatically (#1136). Your configured URL has NOT been changed — if the fallback ` +
    `connects, update it in Settings to make that stick.`
  );
}
