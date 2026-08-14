/**
 * panel#779 — a blank tab is not an acceptable failure state.
 *
 * A new user installed the pack, opened the Agent tab, and got a black rectangle.
 * No header, no Connect button, no "not connected" state, nothing in the console
 * attributed to us. They could not tell "broken" from "not connected" from "not
 * installed", so they uninstalled and reinstalled ComfyUI, tried a second
 * browser, and hard-refreshed both — an hour spent on things that were never the
 * problem. The actual cause (a frontend DOM marker that moved, #784) is fixed;
 * this is the floor underneath it.
 *
 * `render(container)` builds the panel on first entry. If ANYTHING in that path
 * throws, the exception escapes into ComfyUI's `mountCustomExtension = (e, t) =>
 * e.render(t)`, which has no handler — the container simply stays empty. Every
 * future cause of that lands the same way, which is why the fix is a floor rather
 * than another special case.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: diagnose. It cannot know why the build
 * failed, and inventing a cause is what sent this reporter to reinstall. It
 * reports what it OBSERVED — that construction threw, with the message and the
 * versions — and says where to send it. A wrong explanation would be worse than
 * the blank tab, because it would be acted on.
 */
import { tr } from "./i18n.js";

/** Kept inline: the panel stylesheet is loaded by the panel we just failed to build. */
const STYLE = {
  wrap: "padding:16px;font:13px/1.5 system-ui,sans-serif;color:#ddd;height:100%;overflow:auto;box-sizing:border-box",
  h: "margin:0 0 10px;font-size:14px;font-weight:600;color:#ff8a80",
  p: "margin:0 0 10px",
  pre: "margin:0 0 10px;padding:8px;background:#00000055;border:1px solid #ffffff22;border-radius:4px;white-space:pre-wrap;word-break:break-word;font:11px/1.45 ui-monospace,monospace;color:#ffb4a8",
  dl: "margin:0 0 10px;font:11px/1.6 ui-monospace,monospace;color:#aaa",
};

/**
 * The text of the failure notice.
 *
 * Separated from the DOM so it can be asserted without a document, and so the
 * wording is reviewable on its own.
 *
 * @param {unknown} err
 * @param {{ panelVersion?: string, frontendVersion?: string }} [info]
 */
export function panelFailureReport(err, info = {}) {
  const message =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string" && err
        ? err
        : tr("failure_shell.the_failure_produced_no_message", "(the failure produced no message)");
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  // `body` and `where` are the two sentences that actually do the work of #779 —
  // ruling out the reinstall, and saying where to send it — so they are the last
  // text that should stay English for a Korean user staring at a dead tab. The
  // extractor could not see them: it reads ONE quoted literal at a time and these
  // are multi-line `+` concatenations, so no single literal is the string. Each
  // keeps its whole sentence as the fallback, concatenation and all; only `title:`
  // (a single literal) had been converted before.
  return {
    title: tr("failure_shell.the_agent_panel_could_not_start", "The agent panel could not start."),
    body: tr(
      "failure_shell.building_the_panel_threw_so_nothing_was",
      "Building the panel threw, so nothing was rendered. This is a fault in the panel " +
        "itself — it is NOT a connection problem, and reinstalling ComfyUI or the pack will " +
        "not change it. The details below are what was actually observed; nothing here is a " +
        "diagnosis of the cause.",
    ),
    message,
    stack,
    panelVersion: info.panelVersion || "unknown",
    frontendVersion: info.frontendVersion || "unknown",
    // `{url}` rather than baking the address into the sentence, because the gate
    // can police a hole and cannot police a literal: i18n-check.mjs extracts
    // `{name}` runs from English and from each target and hard-fails on a
    // mismatch, so a translation that loses or mistypes the placeholder is caught
    // in CI. A pasted URL is checked by nobody — and this is the one sentence in
    // #779 whose whole job is telling the user where to send the report, so
    // losing it re-creates the defect for every language but English.
    where: tr(
      "failure_shell.please_report_this_at_with_the_text",
      "Please report this at {url} with the text above, your ComfyUI frontend " +
        "version, and your browser.",
      { url: "https://github.com/artokun/comfyui-mcp-panel/issues" },
    ),
  };
}

/**
 * Build the failure shell element.
 *
 * Never throws: it runs because something already did, and a second throw here
 * would put us back at the blank tab this exists to prevent.
 *
 * @param {Document} doc
 * @param {unknown} err
 * @param {{ panelVersion?: string, frontendVersion?: string }} [info]
 * @returns {Element|null} null only if the document itself cannot make elements
 */
export function buildPanelFailureShell(doc, err, info = {}) {
  try {
    if (!doc || typeof doc.createElement !== "function") return null;
    const r = panelFailureReport(err, info);
    const wrap = doc.createElement("div");
    wrap.className = "cmcp-failure-shell";
    wrap.setAttribute("style", STYLE.wrap);

    const h = doc.createElement("div");
    h.setAttribute("style", STYLE.h);
    h.textContent = r.title;
    wrap.appendChild(h);

    const p = doc.createElement("div");
    p.setAttribute("style", STYLE.p);
    p.textContent = r.body;
    wrap.appendChild(p);

    const pre = doc.createElement("pre");
    pre.setAttribute("style", STYLE.pre);
    // textContent, never innerHTML — the message can carry anything.
    pre.textContent = r.stack ? `${r.message}\n\n${r.stack}` : r.message;
    wrap.appendChild(pre);

    const dl = doc.createElement("div");
    dl.setAttribute("style", STYLE.dl);
    dl.textContent = tr("failure_shell.version_line", "panel {panel} · ComfyUI frontend {frontend}", { panel: r.panelVersion, frontend: r.frontendVersion });
    wrap.appendChild(dl);

    const w = doc.createElement("div");
    w.setAttribute("style", STYLE.p);
    w.textContent = r.where;
    wrap.appendChild(w);

    return wrap;
  } catch {
    return null;
  }
}
