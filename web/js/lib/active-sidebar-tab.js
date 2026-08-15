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

/**
 * The sidebar rail BUTTON for a given tab id, however this frontend marks it.
 *
 * #779 had two sites reading the id out of a CSS class. The guard was the one
 * that blanked the panel; this is the other — `findAgentTabIcon`, which paints
 * the unread/working badge on the rail. It fails softer (there is a fallback
 * that scans the toolbar for our glyph), which is exactly why it would have gone
 * unnoticed: on 1.50 the fallback is no longer a fallback, it is the only path,
 * and it matches `.pi-comments` — an icon another extension is free to use.
 *
 * Verified against the shipped bundles: 1.50.3 marks the button with
 * `data-testid="<tabId>-tab-button"`, 1.47.12 with a `<tabId>-tab-button` CLASS.
 * Every other ComfyUI selector the panel relies on is present in both.
 *
 * The id contains a dot ("comfyui-mcp.agent"), which is why the class form uses
 * `[class~=...]` rather than `.<id>-tab-button` — the latter would parse the dot
 * as a descendant class.
 *
 * @param {Document|Element|null} root
 * @param {string} tabId
 * @returns {Element|null}
 */
export function findSidebarTabButton(root, tabId) {
  if (!root || typeof root.querySelector !== "function") return null;
  if (typeof tabId !== "string" || !tabId) return null;
  // No regex here on purpose. The first draft escaped quotes with a character
  // class, and the backslashes were eaten in transit — leaving `/["\]/g`, which
  // is an invalid regular expression and took the whole module down at import.
  // CSS.escape exists in every browser that runs ComfyUI; the bare fallback is
  // only for a non-DOM test environment, and this id is a known constant with
  // no quotes or backslashes in it.
  const marker = `${tabId}-tab-button`;
  const esc =
    typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(marker) : marker;
  try {
    // 1.50+ — the current source of truth.
    const byTestId = root.querySelector(`[data-testid="${esc}"]`);
    if (byTestId) return byTestId;
  } catch { /* an unsupported selector must not take the fallback down with it */ }
  try {
    // <=1.49 — the id was a class.
    return root.querySelector(`button[class~="${esc}"]`) ?? null;
  } catch {
    return null;
  }
}
