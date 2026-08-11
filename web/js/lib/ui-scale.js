// Panel UI scale (#753).
//
// THE REPORT. A user on Windows 11 found the sidebar text barely readable, and
// the fix anyone would reach for does nothing: `.cmcp-root` sets
// `font-size: 0.8125rem`. Historically the panel's inner rules were `rem`, resolving
// against the PAGE root rather than against the panel. Overriding
// `.cmcp-root { font-size }` in a user stylesheet therefore moves only the few
// elements that inherit, and every rem-sized label stays exactly as it was.
// Scaling the whole panel is the one lever that works.
//
// This module is the arithmetic, kept out of the DOM closure so it can be tested
// against the real implementation rather than a copy of it.

/** The range the setting offers. A stored value outside it — an older build, a
 *  hand-edited comfy.settings.json — is clamped rather than honoured. */
export const PANEL_UI_SCALE_MIN = 100;
export const PANEL_UI_SCALE_MAX = 250;

/**
 * The scale to apply, as a fraction (1 = 100%).
 *
 * FAIL-SAFE, and that is the whole point of it being a function. `Number(null)`
 * is 0 and `Number([])` is 0, so a clamp that trusted `Number()` alone would
 * collapse the panel to nothing for a setting it merely could not read. Anything
 * non-finite reads as 100% — the panel stays exactly as it was, which is the only
 * answer that cannot make things worse than not having the setting at all.
 */
export function panelUiScaleFraction(raw) {
  const pct = Number(raw);
  if (!Number.isFinite(pct)) return 1;
  return Math.min(PANEL_UI_SCALE_MAX, Math.max(PANEL_UI_SCALE_MIN, pct)) / 100;
}
