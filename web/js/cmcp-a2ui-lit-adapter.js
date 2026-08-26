// cmcp-a2ui-lit-adapter.js — renders the scoped set of A2UI leaf components
// (Text, Divider, Image) as plain DOM.
//
// #1854 — the vendored @a2ui/lit bundle this file used to dynamically import
// has been REMOVED. It was 234 KB of minified third-party code (bundling zod)
// whose entire job was producing a span, an hr and an img. Every other
// component type was already hand-rolled here or in cmcp-a2ui.js because the
// catalog did not fit: Row/Column/Card containers, TextField/Select/Checkbox
// (no reliable synchronous value read-back), Heading (the catalog rendered
// literal "#" prefixes), and Button, whose Shadow DOM action callback never
// fires on ComfyUI frontend 1.49.6 (#1407).
//
// It also carried three Comfy Registry scanner findings — obfuscated-code,
// credential-access and any-folder-access — on a file no reviewer can read.
//
// Removing it closes an async hole as well. The old mount returned an EMPTY
// wrapper synchronously and filled it in only once the dynamic import
// resolved, which needed a stale-mount guard for the case where the card was
// repainted or detached in between. These render synchronously, so a leaf is
// never briefly blank and there is no window in which to be superseded.
//
// Button stays native HTML in cmcp-a2ui.js (#1407); this file must never
// handle it, and a test asserts that.

/**
 * Mount ONE leaf component as plain DOM, synchronously.
 *
 * Every leaf keeps the same outer span.cmcp-a2ui-lit-leaf wrapper the Lit
 * version returned, so existing card CSS and the hand-rolled container tree
 * in cmcp-a2ui.js slot these in unchanged.
 *
 * Image src is NOT widened here: cmcp-a2ui.js's validator already restricts it
 * via isAllowedImageSrc() to ComfyUI /view, blob: and data:image/ URLs, and a
 * spec that fails validation never reaches this function.
 */
export function mountA2uiLeaf(c) {
  const wrap = document.createElement("span");
  wrap.className = "cmcp-a2ui-lit-leaf";
  wrap.dataset.a2uiType = c.type;

  switch (c.type) {
    case "Text":
      wrap.textContent = typeof c.text === "string" ? c.text : "";
      return wrap;
    case "Divider":
      wrap.appendChild(document.createElement("hr"));
      return wrap;
    case "Image": {
      const img = document.createElement("img");
      img.src = c.src;
      // The catalog called these url/description; the spec calls them
      // src/caption. Caption doubles as alt text, empty when absent.
      img.alt = typeof c.caption === "string" ? c.caption : "";
      wrap.appendChild(img);
      return wrap;
    }
    default:
      throw new Error("cmcp-a2ui-lit-adapter: unmapped leaf type " + c.type);
  }
}

/**
 * Entry point cmcp-a2ui.js's mountComponents() calls for the leaf types routed
 * through this adapter (Text, Divider, Image).
 */
export function mountStandardComponent(c) {
  return mountA2uiLeaf(c);
}
