// The Director's side-panel content-provider.
//
// This is the whole of BenjiDirector's contact surface with comfyui-mcp-panel. The panel's
// side-panel shell (`web/js/cmcp-sidepanel-ui.js`) owns the overlay, the tab bar, the search
// row, the dock, the ✕, Escape and backdrop close; a provider supplies the body and nothing
// else. CivitAI, Apps, Training and RunPod are all the same shape — this one just happens to
// live in a different repo and ship as a vendored bundle.
//
// The contract, verbatim from the shell's own header:
//   { key, label, icon, hasSearch, searchPlaceholder, mount(bodyEl), onSearch(v, opts),
//     subnavExtras(), drive, driveKind, update(), onActivate(), onDeactivate(),
//     teardown(), escapeBlocked() }
//
// TWO TRAPS THAT COST OTHER PROVIDERS TIME — both silent:
//
//   1. `label` must not be captured at module scope. The shell's TABS array is built at
//      import time, BEFORE the i18n catalog loads, so a plain string freezes the English
//      fallback permanently. The shell uses a getter for exactly this reason.
//
//   2. Everything the agent can reach goes through `drive`, and the shell gates it on the
//      ACTIVE tab's `driveKind`. A drive call therefore doubles as an is-it-open probe, and
//      the throw is load-bearing — do not soften it into a no-op.
//
// The React bundle is imported LAZILY, on first mount. Opening CivitAI must not pay for
// ~350KB of editor the user did not ask for.

let _cssInjected = false;
/**
 * The Vite lib build emits `style.css` beside the JS rather than inlining it, and the panel
 * is served raw with no bundler to pick it up. Resolve it against `import.meta.url` — a
 * relative href would resolve against the ComfyUI document, not this module, and 404.
 */
function ensureCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  // Stamped like the JS import below, so a re-vendor cannot leave a browser on the old CSS.
  link.href = new URL("./style.css?v=cd7c1cc396b0", import.meta.url).href;
  document.head.appendChild(link);
  // Geist (the design language's face). Google Fonts is reachable from the ComfyUI page; if it
  // is not, the stack falls through to the system UI font and nothing breaks.
  if (!document.querySelector('link[data-bd-fonts="1"]')) {
    const fonts = document.createElement("link");
    fonts.rel = "stylesheet";
    fonts.dataset.bdFonts = "1";
    fonts.href = "https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap";
    document.head.appendChild(fonts);
  }
}

/**
 * Markdown → safe HTML for the editor's notes, from the host's own `marked` + `DOMPurify`.
 * Returns undefined when either is missing so the editor falls back to escaped plain text —
 * a note must never render unsanitised HTML because the sanitiser was absent. A `marked` in
 * async mode hands back a Promise; that throws here, and the editor's guard falls back too.
 */
function markdownRenderer(ctx) {
  const marked = ctx?.marked;
  const purify = ctx?.DOMPurify;
  if (typeof marked?.parse !== "function" || typeof purify?.sanitize !== "function") return undefined;
  return (md) => {
    const html = marked.parse(String(md ?? ""));
    if (typeof html !== "string") throw new Error("marked.parse returned no HTML (async mode?)");
    return purify.sanitize(html);
  };
}

/**
 * @param {object} ctx   host capability bag (api, callTool, marked, DOMPurify, openUrl, …)
 * @param {object} shell { body, searchEl, subnav, close, applyDock, switchTab, isDocked, … }
 * @param {object} opts  per-open seed passed through `tabOpts`
 */
export function createDirectorContent(ctx, shell, opts = {}) {
  let handle = null;
  let mountEl = null;
  let loading = false;

  const notMounted = () => {
    throw new Error("director pane not open");
  };

  async function boot(bodyEl) {
    if (handle || loading) return;
    loading = true;
    try {
      // The "?v=" stamp is rewritten by scripts/sync-to-panel.mjs with the bundle's content
      // hash. Without it the browser caches this module indefinitely: the panel is served raw
      // with no bundler, so nothing else busts it, and a user who updated the pack would keep
      // running the old editor with no way to tell.
      const mod = await import("./director-app.js?v=cd7c1cc396b0");
      // The pane can be torn down while the dynamic import is in flight; mounting into a
      // detached node would leak a React root that nothing will ever unmount.
      if (mountEl !== bodyEl || !bodyEl.isConnected) return;
      bodyEl.textContent = "";
      handle = mod.mountDirector(bodyEl, {
        calliopeBaseUrl: opts.calliopeBaseUrl,
        renderMarkdown: markdownRenderer(ctx),
      });
    } catch (err) {
      if (mountEl === bodyEl && bodyEl.isConnected) {
        bodyEl.textContent = "";
        const p = document.createElement("div");
        p.className = "cmcp-director-error";
        p.textContent = `Director failed to load: ${err?.message || err}`;
        bodyEl.appendChild(p);
      }
    } finally {
      loading = false;
    }
  }

  return {
    key: "director",
    label: "Director",
    icon: "pi-video",
    driveKind: "director",
    hasSearch: false,

    mount(bodyEl) {
      ensureCss();
      mountEl = bodyEl;
      bodyEl.classList.add("cmcp-director-body");
      const wait = document.createElement("div");
      wait.className = "cmcp-director-loading";
      wait.textContent = "Loading Director…";
      bodyEl.appendChild(wait);
      void boot(bodyEl);
    },

    onActivate() {},
    onDeactivate() {},

    teardown() {
      try {
        handle?.teardown?.();
      } finally {
        handle = null;
        mountEl = null;
      }
    },

    // Agent-facing surface. One generic entry point: the editor owns the command vocabulary
    // (`outline`, `add_node`, `connect`, `promote`, …) and mints every id. Every method must
    // tolerate the pane having closed underneath it — the orchestrator unmounts these tools on
    // close, but a call already in flight can still land — hence the throw.
    drive: {
      cmd: (name, args) => (handle?.ready?.() ? handle.drive(name, args || {}) : notMounted()),
      read: () => ({ mounted: !!handle?.ready?.(), loading }),
    },
  };
}
