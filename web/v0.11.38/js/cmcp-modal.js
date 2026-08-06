// Shared themed-modal primitives for the side-panel surfaces.
//
// `openSubModal` + `toast` were originally private to cmcp-civitai-ui.js; they
// are lifted here VERBATIM (same DOM, same class vocabulary, same z-indexes) so
// the Apps tab can reuse the exact same themed chrome instead of native
// window.* dialogs. Civitai imports them back and passes its own `_subModals`
// tracker Set, keeping its behavior byte-identical (its Playwright specs depend
// on the sub-modal DOM + the stacked-close/escape semantics).
//
// On top of those primitives this module builds three promise-returning helpers
// the Apps UI uses to replace confirm()/alert()/prompt():
//   confirmModal({title,message,confirmLabel,cancelLabel,danger}) -> Promise<bool>
//   promptModal ({title,label,value,placeholder,multiline})       -> Promise<string|null>
//   formModal   ({title,fields[],submitLabel,cancelLabel})        -> Promise<values|null>
//
// All user text goes through textContent (el() below) — no HTML injection.

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/** Themed sub-modal on document.body — overlay z-10001, above the side-panel
 *  shell. `tracker`, when given, is a Set the closer registers itself in (so a
 *  caller can sweep every stacked sheet + gate Escape); omit it for one-off
 *  modals. Returns { body, close }. Behaviorally identical to civitai-ui's
 *  original private openSubModal. */
export function openSubModal(title, onClose, tracker) {
  const ov = el("div", "cmcp-cv-overlay"); ov.style.zIndex = "10001";
  const m = el("div", "cmcp-modal"); m.style.maxWidth = "40rem"; m.style.width = "min(40rem, 92vw)";
  m.style.maxHeight = "85vh"; m.style.overflowY = "auto";
  const head2 = el("div", "cmcp-modal-title", title);
  const x = el("button", "cmcp-cv-iconbtn"); x.innerHTML = '<i class="pi pi-times"></i>';
  x.style.cssText = "position:absolute;top:.5rem;right:.5rem";
  const b = el("div"); m.style.position = "relative";
  // Every close path (✕ button, backdrop click, sheet.close()) funnels here,
  // so a caller-supplied teardown runs no matter how the sheet is dismissed.
  const close2 = () => { if (tracker) tracker.delete(close2); ov.remove(); if (onClose) onClose(); };
  if (tracker) tracker.add(close2);
  x.addEventListener("click", close2);
  ov.addEventListener("mousedown", (e) => { if (e.target === ov) close2(); });
  m.append(head2, x, b); ov.appendChild(m); document.body.appendChild(ov);
  return { body: b, close: close2 };
}

export function toast(msg, { ms = 3500 } = {}) {
  const t = el("div", null, msg);
  // ALWAYS mount on <body> above every overlay — sub-modals (10001), the
  // lightbox (10002) and the workflow picker sit above the base modal, and a
  // toast rendered inside `modal` (z-index 80) was hidden behind them, so a
  // gated-download hint or a load error read as "nothing happened". A fixed,
  // top-of-stack toast is visible no matter which sheet is open (or if the
  // whole explorer just closed after a successful load).
  t.style.cssText = "position:fixed;bottom:1.25rem;left:50%;transform:translateX(-50%);" +
    "max-width:min(38rem,90vw);text-align:center;background:var(--p-surface-800,#27272a);" +
    "color:#fafafa;padding:.55rem .9rem;border-radius:8px;z-index:10060;font-size:.82rem;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.5)";
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

let _mdlCss = false;
function injectModalCss() {
  if (_mdlCss) return;
  _mdlCss = true;
  const css = `
.cmcp-mdl{display:flex;flex-direction:column;gap:.85rem;}
.cmcp-mdl-msg{font-size:.85rem;line-height:1.55;white-space:pre-wrap;color:var(--p-text-color,#fafafa);}
.cmcp-mdl-field{display:flex;flex-direction:column;gap:.3rem;}
.cmcp-mdl-label{font-size:.72rem;font-weight:600;opacity:.8;text-transform:uppercase;letter-spacing:.03em;}
.cmcp-mdl-field input,.cmcp-mdl-field textarea{padding:.5rem .6rem;border-radius:8px;
  border:1px solid var(--p-content-border-color,#3f3f46);background:var(--p-surface-950,#111113);
  color:var(--p-text-color,#fafafa);font:inherit;font-size:.85rem;box-sizing:border-box;width:100%;}
.cmcp-mdl-field input:focus,.cmcp-mdl-field textarea:focus{outline:none;border-color:var(--p-primary-color,#60a5fa);}
.cmcp-mdl-field textarea{resize:vertical;min-height:4.5rem;}
.cmcp-mdl-btns{display:flex;justify-content:flex-end;gap:.5rem;margin-top:.15rem;}
.cmcp-mdl-btns .cmcp-btn{align-self:auto;}
.cmcp-mdl-secondary{background:transparent;border:1px solid var(--p-content-border-color,#3f3f46);
  color:var(--p-text-color,#fafafa);font-weight:600;}
.cmcp-btn.cmcp-mdl-danger{background:var(--p-red-500,#dc2626);border:1px solid transparent;color:#fff;}
.cmcp-btn.cmcp-mdl-danger:hover{opacity:.9;}
`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}

/** Yes/No confirmation. Resolves true only when the confirm button is clicked;
 *  ✕ / backdrop / cancel all resolve false. */
export function confirmModal({
  title = "Confirm",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  injectModalCss();
  return new Promise((resolve) => {
    let settled = false;
    let sheet;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); sheet.close(); };
    sheet = openSubModal(title, () => finish(false));
    const wrap = el("div", "cmcp-mdl");
    if (message) wrap.append(el("div", "cmcp-mdl-msg", message));
    const btns = el("div", "cmcp-mdl-btns");
    const cancel = el("button", "cmcp-btn cmcp-mdl-secondary cmcp-mdl-cancel", cancelLabel);
    cancel.type = "button";
    const ok = el("button", "cmcp-btn primary cmcp-mdl-ok", confirmLabel);
    ok.type = "button";
    if (danger) ok.classList.add("cmcp-mdl-danger");
    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    btns.append(cancel, ok);
    wrap.append(btns);
    sheet.body.append(wrap);
    ok.focus();
  });
}

/** Multi-field form modal. `fields` = [{key,label,value,placeholder,type,multiline,rows}].
 *  Resolves a { key: value } object on submit, or null when dismissed. */
export function formModal({ title = "", fields = [], submitLabel = "Save", cancelLabel = "Cancel" } = {}) {
  injectModalCss();
  return new Promise((resolve) => {
    let settled = false;
    let sheet;
    const finish = (v) => { if (settled) return; settled = true; resolve(v); sheet.close(); };
    sheet = openSubModal(title, () => finish(null));
    const form = document.createElement("form");
    form.className = "cmcp-mdl";
    const getters = [];
    for (const f of fields) {
      const row = el("div", "cmcp-mdl-field");
      if (f.label) row.append(el("label", "cmcp-mdl-label", f.label));
      let input;
      if (f.type === "textarea" || f.multiline) {
        input = document.createElement("textarea");
        input.rows = f.rows || 4;
      } else {
        input = document.createElement("input");
        input.type = f.type || "text";
      }
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.value != null) input.value = String(f.value);
      if (f.maxLength) input.maxLength = f.maxLength;
      row.append(input);
      getters.push([f.key, () => input.value]);
      form.append(row);
    }
    const submit = () => {
      const out = {};
      for (const [k, g] of getters) out[k] = g();
      finish(out);
    };
    const btns = el("div", "cmcp-mdl-btns");
    const cancel = el("button", "cmcp-btn cmcp-mdl-secondary cmcp-mdl-cancel", cancelLabel);
    cancel.type = "button";
    const ok = el("button", "cmcp-btn primary cmcp-mdl-ok", submitLabel);
    ok.type = "submit";
    cancel.addEventListener("click", () => finish(null));
    // Native <form> submit → Enter in any single-line input confirms; the
    // textarea keeps Enter for newlines. Guard against a full page navigation.
    form.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    btns.append(cancel, ok);
    form.append(btns);
    sheet.body.append(form);
    const first = form.querySelector("input, textarea");
    if (first) { first.focus(); if (first.select) first.select(); }
  });
}

/** Single-field prompt (window.prompt replacement). Resolves the typed string
 *  (possibly empty) on submit, or null when dismissed — matching prompt()'s
 *  "" vs null distinction. */
export function promptModal({
  title = "",
  label = "",
  value = "",
  placeholder = "",
  multiline = false,
  submitLabel = "OK",
  cancelLabel = "Cancel",
} = {}) {
  return formModal({
    title,
    submitLabel,
    cancelLabel,
    fields: [{ key: "value", label, value, placeholder, multiline }],
  }).then((v) => (v ? v.value : null));
}
