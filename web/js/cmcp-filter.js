// Shared filter affordance for the side-panel surfaces (Apps redesign P1c).
//
// Extracted from cmcp-civitai-ui.js so the CivitAI browser AND the Apps tab share
// ONE filter paradigm: a header filter icon-button (with a "dirty" dot) that opens
// a themed chip-row panel. CivitAI keeps its own panel BODY (creator picker +
// base-model omni-search + browsing levels), but now builds its chip rows and its
// header filter button through these helpers instead of local copies, so the two
// surfaces stay in visual + behavioural lockstep as the catalogue grows. Apps
// reuses the same three helpers to render a Sort chip-row (and, later, tag/category
// rows) with identical UX + theme.
//
// DOM + class vocabulary is CivitAI's, VERBATIM (cmcp-cv-iconbtn / cmcp-cv-dot /
// cmcp-cv-filters / cmcp-cv-flabel / cmcp-cv-frow / cmcp-cv-chip) so CivitAI's
// filter panel + its Playwright/agent-drive specs keep working unchanged.

import { openSubModal as openSubModalBase } from "./cmcp-modal.js";

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

// The shell (cmcp-sidepanel-ui.js) already injects .cmcp-cv-frow / .cmcp-cv-chip /
// .cmcp-cv-iconbtn / .cmcp-cv-dot; CivitAI injects .cmcp-cv-filters / .cmcp-cv-flabel
// only when ITS tab is first opened. Re-inject those two here (idempotent, same
// values) so the Apps tab has them even if CivitAI was never visited this session.
let _cssInjected = false;
function injectFilterCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const css = `
  .cmcp-cv-filters { display: flex; flex-direction: column; gap: .7rem; }
  .cmcp-cv-flabel { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em;
    color: var(--p-text-muted-color,#a1a1aa); width: 100%; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** Build one labeled chip row into `container`: a .cmcp-cv-flabel caption + a
 *  .cmcp-cv-frow of .cmcp-cv-chip buttons. `isOn(value)` decides the pressed
 *  (.on) chip; clicking a chip calls `onPick(value)`. Byte-identical to the chip
 *  rows CivitAI's filter sheet has always rendered. Returns the row element so a
 *  caller can rebuild it in place (as CivitAI's base-model pills do). */
export function chipRow(container, label, options, isOn, onPick) {
  container.appendChild(el("div", "cmcp-cv-flabel", label));
  const row = el("div", "cmcp-cv-frow");
  for (const o of options) {
    const chip = el("button", "cmcp-cv-chip", o.label);
    if (isOn(o.value)) chip.classList.add("on");
    chip.addEventListener("click", () => onPick(o.value));
    row.appendChild(chip);
  }
  container.appendChild(row);
  return row;
}

/** The header filter button: a .cmcp-cv-iconbtn carrying the sliders icon and a
 *  .cmcp-cv-dot "dirty" indicator (hidden until setActive(true)). `onOpen` fires
 *  on click. marginLeftAuto pushes it to the subnav's right edge (CivitAI's
 *  layout). `title` is applied only when truthy — CivitAI passes null to stay
 *  byte-identical to its original title-less button. Returns { btn, dot,
 *  setActive }. */
export function makeFilterButton({ onOpen, title = "Filters", marginLeftAuto = true } = {}) {
  const btn = el("button", "cmcp-cv-iconbtn");
  if (marginLeftAuto) btn.style.marginLeft = "auto";
  if (title) btn.title = title;
  btn.innerHTML = '<i class="pi pi-sliders-h"></i>';
  const dot = el("span", "cmcp-cv-dot");
  dot.style.display = "none";
  btn.appendChild(dot);
  btn.addEventListener("click", () => { if (onOpen) onOpen(); });
  const setActive = (on) => { dot.style.display = on ? "" : "none"; };
  return { btn, dot, setActive };
}

/** Open a themed chip-row filter panel. Opens a sub-modal (via `openModal`,
 *  default the shared openSubModal — pass a tracker-threading opener to keep the
 *  sheet in a surface's stacked-close/Escape set) titled `title`, and calls
 *  `render(wrap, rerender)` to fill a .cmcp-cv-filters column. `rerender`
 *  re-invokes render after a chip toggles so its pressed state flips immediately
 *  (the pattern CivitAI's sheet uses). `onClose` runs on any dismissal. Returns
 *  the sheet handle ({ body, close }). */
export function openFilterPanel({ openModal = openSubModalBase, title = "Filters", onClose, render } = {}) {
  injectFilterCss();
  const sheet = openModal(title, onClose);
  const rerender = () => {
    sheet.body.innerHTML = "";
    const wrap = el("div", "cmcp-cv-filters");
    sheet.body.appendChild(wrap);
    if (render) render(wrap, rerender);
  };
  rerender();
  return sheet;
}
