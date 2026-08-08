/**
 * panel#779 — the panel renders blank on ComfyUI frontend 1.50.x, and the cause
 * is ours.
 *
 * `installSidebarTabGuard` removes our root whenever another sidebar tab is
 * active, so a stray panel can't linger over someone else's tab. It identified
 * the active tab by reading the selected button's CSS classes:
 *
 *     [...b.classList].find((c) => c.endsWith("-tab-button"))
 *
 * ComfyUI 1.50 moved the id out of the class and into an attribute. Verified by
 * diffing the shipped bundles:
 *
 *     1.47.12   class: I(e.id + `-tab-button`)
 *     1.50.3    "data-testid": `${e.id}-tab-button`      (the class is gone)
 *
 * So on 1.50 the lookup found nothing, returned null, and the guard read that as
 * "some OTHER tab is active" — then removed `.cmcp-root` the moment `render()`
 * attached it. The MutationObserver watches class changes on the toolbar, so
 * selecting our tab is itself what triggered the removal. Symptom: the tab
 * registers, is selectable, nothing paints, `.cmcp-root` is absent, and no error
 * is attributed to us. A new user was blocked on first install.
 *
 * TWO CHANGES, AND THE SECOND MATTERS MORE.
 *
 * 1. Read `data-testid` first, then fall back to the class, so both frontend
 *    generations work.
 *
 * 2. NEVER DESTROY ON AN UNREADABLE SELECTION. A selected button we cannot
 *    identify is "I do not know which tab is active" — not "it is not ours"
 *    (#796). The first is the only honest reading, and it is the one that would
 *    have made this a cosmetic bug instead of a blank panel: the next time
 *    ComfyUI moves this marker, the panel keeps working.
 *
 * The three states are deliberately distinct:
 *   - "none"    no tab is selected at all → our content genuinely should detach
 *   - "id"      we know which tab is active → compare it
 *   - "unknown" a tab is selected but unidentifiable → change nothing
 */

const SUFFIX = "-tab-button";

/**
 * Which sidebar tab is active, as a three-state answer.
 *
 * @param {Element|null|undefined} selectedButton the `.side-bar-button-selected`
 *   element, or null/undefined when none is selected.
 * @returns {{state: "none"} | {state: "id", id: string} | {state: "unknown"}}
 */
export function readActiveSidebarTab(selectedButton) {
  if (!selectedButton) return { state: "none" };

  // 1.50+: the id lives on data-testid.
  const testId =
    typeof selectedButton.getAttribute === "function"
      ? selectedButton.getAttribute("data-testid")
      : null;
  if (typeof testId === "string" && testId.endsWith(SUFFIX) && testId.length > SUFFIX.length) {
    return { state: "id", id: testId.slice(0, -SUFFIX.length) };
  }

  // <=1.49: the id was a CSS class.
  const classes = selectedButton.classList ? [...selectedButton.classList] : [];
  const cls = classes.find((c) => c.endsWith(SUFFIX) && c.length > SUFFIX.length);
  if (cls) return { state: "id", id: cls.slice(0, -SUFFIX.length) };

  // A tab IS selected and we cannot name it. Saying "not ours" here is what
  // blanked the panel on 1.50.
  return { state: "unknown" };
}

/**
 * Should the guard detach our root right now?
 *
 * Only on evidence: either nothing is selected, or something else provably is.
 *
 * @param {ReturnType<typeof readActiveSidebarTab>} active
 * @param {string} ourTabId
 */
export function shouldDetachPanelRoot(active, ourTabId) {
  if (!active) return false;
  if (active.state === "none") return true;
  if (active.state === "unknown") return false;
  return active.id !== ourTabId;
}
