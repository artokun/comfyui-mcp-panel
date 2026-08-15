/**
 * panel#779 — every place the panel reaches into ComfyUI's OWN DOM, declared.
 *
 * ComfyUI 1.50 moved a sidebar tab's id from a CSS class to a `data-testid`
 * attribute. The panel read that class in two places. One blanked the panel
 * entirely for a new user (#784); the other only degraded, so nobody noticed
 * (#786). Both were found by hand, after the fact, by diffing two frontend
 * bundles — which is not a process, it is luck.
 *
 * This is the list that makes the next skew a REVIEW instead of a discovery.
 * Every selector below targets markup we do not own and cannot change, and a
 * test fails if the panel grows one that is not declared here.
 *
 * WHAT THIS IS NOT. It cannot tell you a selector has stopped matching — only a
 * real frontend can, and the test has no browser. What it does is make the
 * surface finite, attributed and reviewable, so "check our DOM assumptions
 * against the new frontend" is a task someone can actually complete.
 *
 * `verified` records the frontend versions each selector was CHECKED against by
 * grepping the shipped bundles — not versions it is assumed to work on. Add to
 * it when you check; do not widen it because it probably still works.
 */

/** Frontend bundles whose markup has been inspected for these selectors. */
export const VERIFIED_FRONTENDS = ["1.47.12", "1.50.3"];

/**
 * @type {{ selector: string, why: string, fallback?: string, verified: string[] }[]}
 */
export const COMFYUI_DOM_DEPS = [
  {
    selector: ".side-bar-button-selected",
    why: "Which sidebar tab is currently selected — read by the guard that detaches our root when another tab is active, and by the render watchdog that reports a selected-but-never-painted tab.",
    fallback: "None. An unreadable selection is treated as UNKNOWN and changes nothing (#784); the watchdog likewise never speaks on UNKNOWN.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: ".side-tool-bar-container",
    why: "The sidebar rail. The guard observes it for tab-selection changes; the render watchdog only waits for it to EXIST (proof this page has a sidebar we understand) and then observes the document instead.",
    fallback: "Retried while the frontend boots; absent means the guard never arms and the watchdog stays silent (no rail, no evidence). NOTE 1: the rail's CONTENTS are not evidence — ComfyUI's LinearView renders it filtered via `visible-tab-ids`, so our button being missing from it means nothing. NOTE 2: this element is NOT STABLE — it is `v-if`-gated in GraphCanvas.vue, so focus/linear/builder mode destroy and recreate it (verified 1.47.12/1.48.7/1.50.3/1.51.5). Anything holding a reference to it goes deaf on the first toggle.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: ".side-tool-bar-container, .side-tool-bar-end, nav.side-tool-bar",
    why: "Where our tab's rail icon lives, for the unread/working badge.",
    fallback: "Scans for our own glyph inside these containers.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: 'button[class~="${esc}"]',
    why: "Our tab's rail button on frontends <=1.49, where the id was a CSS class. 1.50 moved it to data-testid, which is tried FIRST (#786).",
    fallback: "data-testid is the primary; this is the older form.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: ".side-bar-panel",
    why: "The pane our tab content is mounted into — used to size/scroll correctly.",
    fallback: "[class*='sidebar'], then the element itself.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: "[class*='sidebar']",
    why: "Fallback for the mounting pane when .side-bar-panel is absent.",
    fallback: "The element itself.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: "[id*='vue']",
    why: "The frontend's Vue root, when #vue-app is not present.",
    fallback: "getElementById('vue-app') is tried first.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: ".p-dialog-mask, dialog[open]",
    why: "An open PrimeVue dialog or native <dialog>, so the panel does not steal focus from one.",
    fallback: "None needed — absence simply means no modal is open.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: ".pi",
    why: "A PrimeIcons glyph inside our own rail button, to swap for the badge state.",
    fallback: "[data-cmcp-agent-icon] is tried first, and marks the element once found.",
    verified: ["1.47.12", "1.50.3"],
  },
  {
    selector: ".fg",
    why: "LiteGraph's foreground canvas, for pointer-coordinate mapping.",
    fallback: "app.canvas is the primary source; this is a DOM-side lookup.",
    verified: ["1.47.12", "1.50.3"],
  },
];

/** Declared selectors, for the gate. */
export function declaredSelectors() {
  return new Set(COMFYUI_DOM_DEPS.map((d) => d.selector));
}
