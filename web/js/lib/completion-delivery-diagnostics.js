// Diagnostics for the panel's completion delivery boundary.
//
// The panel can observe composition time and whether the browser accepted a
// frame with WebSocket.send(). It cannot observe orchestrator receipt: the
// current bridge has no acknowledgement for agent_event. Keep that distinction
// explicit so a local transport result is not reported as end-to-end delivery.

export const COMPLETION_LATE_COMPOSITION_MS = 10_000;

/**
 * Classify the strongest delivery fact available to the panel.
 *
 * `transportAccepted` means only that the browser accepted the frame for the
 * socket. It is intentionally not named "delivered" because the bridge does
 * not acknowledge agent_event frames today.
 */
export function classifyCompletionDelivery({
  sendAttempted = false,
  transportAccepted = false,
  // A completed flush may intentionally produce no frame (for example, an
  // ordinary canvas run with no media). That is delivered by lifecycle
  // contract, not a never-sent transport failure.
  frameEmitted = true,
  compositionMs = null,
  lateCompositionMs = COMPLETION_LATE_COMPOSITION_MS,
} = {}) {
  if (!frameEmitted) return "empty-no-frame";
  if (!sendAttempted) return "never-sent";
  if (!transportAccepted) return "transport-failure";
  if (Number.isFinite(compositionMs) && compositionMs > lateCompositionMs) {
    return "late-composition";
  }
  return "transport-accepted";
}

/**
 * Add the composition-only part of the diagnostic to a completion frame.
 * Transport status is added at the send boundary because composition cannot
 * know whether sendFrame() will accept the frame.
 */
export function completionCompositionDiagnostic({
  compositionMs = null,
  lateCompositionMs = COMPLETION_LATE_COMPOSITION_MS,
} = {}) {
  const normalizedMs = Number.isFinite(compositionMs) ? Math.max(0, compositionMs) : null;
  return {
    source: "panel",
    composition_ms: normalizedMs,
    composition_stage:
      normalizedMs != null && normalizedMs > lateCompositionMs ? "late-composition" : "on-time",
  };
}
