/**
 * #887 — what `workflow_open` may claim about which workflow is active.
 *
 * The reply names the workflow the caller ASKED for (`opened`, `routing_key`) and says
 * nothing about what the panel observed to be active when it composed that reply. The
 * orchestrator turns those fields into a flat assertion — "the canvas IS bound to X … You
 * are NOT on the wrong workflow" — and the reporter saw `panel_list_workflows` name a
 * different workflow immediately afterwards, with the graph fence still on it. Their
 * concern was the sharp end: a Save-As at that moment could write the wrong canvas.
 *
 * What this does NOT claim to fix: a reply is a statement about a moment, and the active
 * workflow can change the instant after it is composed. Measured on 0.11.81 — steal the
 * active slot while an open is in flight and the reply still carries the target's uuid,
 * because at emission the target genuinely WAS active. No check can close that; the panel
 * cannot report the future.
 *
 * What it does fix: the reply never said what it observed. A caller could not tell "the
 * target is active" from "the target is what you asked for", so a stale reply was
 * indistinguishable from a confirmed one, and the only honest reading — "this was true when
 * emitted" — was unavailable. Reporting the observed active routing key alongside the
 * requested one lets the caller compare, and lets a disagreement be surfaced as a
 * disagreement instead of an assertion.
 */

/**
 * Describe the binding a `workflow_open` reply may honestly claim.
 *
 * @param {{targetRoutingKey?: string|null, activeRoutingKey?: string|null}} observed
 *   routing keys read from the TARGET and from the live active workflow, both at reply
 *   emission. `activeRoutingKey` null means the panel could not read one.
 * The hint is FIXED WORDING. Routing keys are workflow-derived — a user names their own
 * files — and interpolating them into instruction-shaped prose puts attacker-influenced
 * text inside a sentence a model reads as trusted (codex). The values stay in the
 * structured fields, where a consumer presents them as data.
 *
 * @returns {{active_routing_key: string|null, active_matches_target: boolean|null,
 *   active_mismatch_hint?: string}}
 */
export function describeOpenActiveBinding({ targetRoutingKey, activeRoutingKey } = {}) {
  const target = typeof targetRoutingKey === "string" && targetRoutingKey ? targetRoutingKey : null;
  const active = typeof activeRoutingKey === "string" && activeRoutingKey ? activeRoutingKey : null;
  // UNKNOWN, not false. Reporting a mismatch we did not observe would send a caller
  // chasing a switch that never failed — the #886 complaint, which is this one inverted:
  // a false failure is as expensive as a false success.
  if (!target || !active) {
    return { active_routing_key: active, active_matches_target: null };
  }
  if (active === target) {
    return { active_routing_key: active, active_matches_target: true };
  }
  return {
    active_routing_key: active,
    active_matches_target: false,
    active_mismatch_hint:
      "The open ran, but at the moment this reply was composed the ACTIVE workflow was not " +
      "the requested one. Do not treat the requested workflow as bound: re-read " +
      "panel_list_workflows, and do NOT save — a save targets the live canvas, which is a " +
      "different workflow than the one you asked for. The two routing keys are reported in " +
      "`active_routing_key` and `routing_key`.",
  };
}
