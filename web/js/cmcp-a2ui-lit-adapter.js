// cmcp-a2ui-lit-adapter.js — routes a scoped set of A2UI leaf components
// (Text, Divider, Image) through the vendored @a2ui/lit basic catalog
// (web/js/vendor/a2ui-lit.bundle.js), per Task 1's GO decision.
// Button is a native <button> in cmcp-a2ui.js (#1407).
//
// SCOPE (see task-3-report.md "deviations" for the full rationale):
//   - Row/Column/Card containers stay hand-rolled in cmcp-a2ui.js. The
//     official renderer has no notion of a "foreign" child component type,
//     so a Column containing [Heading, comfy:graph, comfy:chart, Button]
//     (exactly the Step-3 fixture) cannot be expressed as one Lit-managed
//     subtree without a bespoke Catalog. Hand-rolled plain <div>s let any
//     mix of Lit leaves and comfy:* SVG builders sit side by side as
//     ordinary DOM siblings.
//   - TextField/Select/Checkbox stay hand-rolled. Submit-button
//     serialization needs a synchronous, reliable read of each field's
//     CURRENT value; the basic catalog's two-way binding writes through an
//     internal signal/binder with no documented external read API, and
//     ChoicePicker's rendered markup varies by variant/displayStyle. Native
//     <input>/<select> keeps that contract exact and dependency-free.
//   - Heading stays hand-rolled (reviewer fix): the catalog maps it to
//     Text{variant:hN}, which needs a markdown renderer and otherwise
//     renders literal "#" prefixes. A plain <hN> is strictly better.
//   - Text, Divider, Image have no children to interleave and no
//     read-back requirement, so each mounts as its own tiny
//     single-component a2ui-surface, wrapped in a plain <span> the
//     hand-rolled container tree slots in like any other child.
//   - Button is native HTML in cmcp-a2ui.js. The catalog's Shadow DOM
//     action callback does not fire on ComfyUI frontend 1.49.6 (#1407).
//
// The vendor bundle is dynamically imported INSIDE a function, never at
// module top level, so this file (and cmcp-a2ui.js, which imports it) stays
// importable under `node --test` with no DOM/browser present.

let _bundlePromise = null;
function loadBundle() {
  if (!_bundlePromise) _bundlePromise = import("./vendor/a2ui-lit.bundle.js");
  return _bundlePromise;
}

let _surfaceSeq = 0;

/** v0.9 component messages for ONE leaf, id "root" (a2ui-surface always
 *  renders starting from "root"). */
function leafMessages(c) {
  switch (c.type) {
    case "Text":
      return [{ id: "root", component: "Text", text: c.text }];
    case "Divider":
      return [{ id: "root", component: "Divider" }];
    case "Image":
      // Catalog prop names are `url`/`description`, not `src`/`alt`.
      return [{ id: "root", component: "Image", url: c.src, description: c.caption || "" }];
    default:
      throw new Error("cmcp-a2ui-lit-adapter: unmapped leaf type " + c.type);
  }
}

/**
 * Mount ONE leaf component as its own tiny a2ui-surface. Returns a plain
 * <span> wrapper synchronously (empty); it fills in once the vendor bundle
 * resolves (cached after the first call across all leaves/cards).
 */
export function mountA2uiLeaf(c) {
  const wrap = document.createElement("span");
  wrap.className = "cmcp-a2ui-lit-leaf";
  wrap.dataset.a2uiType = c.type;

  loadBundle().then(({ basicCatalog, MessageProcessor }) => {
    // Stale-mount guard (reviewer fix): a superseded update() paint (or a
    // removed card) can detach this wrapper before the bundle resolves —
    // don't mount a surface into a dead span.
    if (!wrap.isConnected) return;
    const surfaceId = `leaf-${++_surfaceSeq}`;
    const surfaceEl = document.createElement("a2ui-surface");
    const processor = new MessageProcessor([basicCatalog]);
    processor.onSurfaceCreated((s) => {
      surfaceEl.surface = s;
    });
    processor.processMessages([
      { version: "v0.9", createSurface: { surfaceId, catalogId: basicCatalog.id } },
      { version: "v0.9", updateComponents: { surfaceId, components: leafMessages(c) } },
    ]);
    wrap.appendChild(surfaceEl);
    wrap._a2uiProcessor = processor;
    wrap._a2uiSurfaceId = surfaceId;
  });

  return wrap;
}

/**
 * Entry point cmcp-a2ui.js's mountComponents() calls for the leaf types
 * routed through Lit (Text, Divider, Image). Button is a native <button>
 * in that file so a click reaches ctx.choose() on frontend 1.49.6 (#1407).
 */
export function mountStandardComponent(c) {
  return mountA2uiLeaf(c);
}
