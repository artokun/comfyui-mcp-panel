/**
 * panel#749 — decide how the pairing modal PRESENTS the durability the
 * orchestrator already ships on the `pair_url` frame (comfyui-mcp#1020, #875).
 *
 * The orchestrator computes this from configuration alone and writes one
 * complete human sentence into `note`. This module therefore decides
 * PRESENTATION ONLY — tone, and whether to render at all. It deliberately does
 * not paraphrase, summarise or re-derive the sentence: two spellings of the same
 * explanation drift, and the one on this side would be the one without the facts
 * (it cannot see `pinnedToken` or whether the self-restarter is armed).
 *
 * WHY THIS MATTERS AT ALL. A user reported "updating the npm version bricks my
 * communication with the agent" and asked for a version pin. The version was
 * never the cause: the self-restarter rotates the pair token (unless pinned) and,
 * in tunnel mode, the quick-tunnel hostname (always). They could only infer a
 * cause from a phone that had stopped working. The QR modal is the one moment the
 * user is looking at this URL, so it is where the tradeoff belongs.
 */

/**
 * @param {unknown} durability the frame's `durability` field, or anything else.
 * @returns {{tone:"ok"|"warn", icon:string, note:string, rotates:string[]} | null}
 *   `null` means RENDER NOTHING.
 */
export function pairDurabilityView(durability) {
  // ABSENT ⇒ render nothing. An older orchestrator does not send this field, and
  // the honest response to "we were not told" is silence — not a reassuring tick
  // and not a warning. Both would be claims about a configuration this panel
  // cannot observe. (#402's rule: never fabricate an outcome nobody reported.)
  if (!durability || typeof durability !== "object") return null;
  const raw = /** @type {{note?:unknown, survivesRestart?:unknown, rotates?:unknown}} */ (durability);
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (!note) return null;

  // STRICT `=== true`. A missing, null or truthy-but-not-true flag must NOT read
  // as "survives": this is the reassuring branch, and reassurance is the only
  // direction where being wrong costs the user a phone that silently stops
  // working. Anything unproven falls to the caution branch, which still carries
  // the orchestrator's own sentence and so cannot mislead.
  const survives = raw.survivesRestart === true;

  return {
    tone: survives ? "ok" : "warn",
    icon: survives ? "✓" : "⚠",
    note,
    rotates: Array.isArray(raw.rotates) ? raw.rotates.filter((r) => typeof r === "string") : [],
  };
}
