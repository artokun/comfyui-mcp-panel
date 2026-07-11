// cmcp-a2ui-lit-adapter.js — routes a scoped set of A2UI leaf components
// (Text, Button, Divider, Image) through the vendored @a2ui/lit
// basic catalog (web/js/vendor/a2ui-lit.bundle.js), per Task 1's GO decision.
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
//   - Text, Button, Divider, Image have no children to interleave
//     and no read-back requirement, so each mounts as its own tiny
//     single-component a2ui-surface, wrapped in a plain <span> the
//     hand-rolled container tree slots in like any other child.
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
 *  renders starting from "root"). `disabled` strips a Button's action —
 *  a protocol-level inert with no Shadow DOM reach-in needed. */
function leafMessages(c, disabled) {
  switch (c.type) {
    case "Text":
      return [{ id: "root", component: "Text", text: c.text }];
    case "Divider":
      return [{ id: "root", component: "Divider" }];
    case "Image":
      // Catalog prop names are `url`/`description`, not `src`/`alt`.
      return [{ id: "root", component: "Image", url: c.src, description: c.caption || "" }];
    case "Button": {
      const label = { id: "label", component: "Text", text: c.label };
      const btn = {
        id: "root",
        component: "Button",
        child: "label",
        variant: c.style === "primary" ? "primary" : "default",
      };
      // A mini-surface hosts exactly one Button, so the action payload's
      // content is unused (see onFire()) — the event just needs to fire.
      if (!disabled) btn.action = { event: { name: "reply" } };
      return [label, btn];
    }
    default:
      throw new Error("cmcp-a2ui-lit-adapter: unmapped leaf type " + c.type);
  }
}

/**
 * Mount ONE leaf component as its own tiny a2ui-surface. Returns a plain
 * <span> wrapper synchronously (empty); it fills in once the vendor bundle
 * resolves (cached after the first call across all leaves/cards).
 *
 * onFire(): called when a Button's action fires. No payload is passed —
 * the caller already knows which spec component `c` this wrapper is for.
 */
export function mountA2uiLeaf(c, { onFire } = {}) {
  const wrap = document.createElement("span");
  wrap.className = "cmcp-a2ui-lit-leaf";
  wrap.dataset.a2uiType = c.type;
  wrap._a2uiWantsDisabled = false;

  loadBundle().then(({ basicCatalog, MessageProcessor }) => {
    // Stale-mount guard (reviewer fix): a superseded update() paint (or a
    // removed card) can detach this wrapper before the bundle resolves —
    // don't mount a surface into a dead span.
    if (!wrap.isConnected) return;
    const surfaceId = `leaf-${++_surfaceSeq}`;
    const surfaceEl = document.createElement("a2ui-surface");
    const processor = new MessageProcessor([basicCatalog], () => onFire?.());
    processor.onSurfaceCreated((s) => {
      surfaceEl.surface = s;
    });
    processor.processMessages([
      { version: "v0.9", createSurface: { surfaceId, catalogId: basicCatalog.id } },
      // Mount already-inert if resolve() raced ahead of this promise (e.g.
      // the card was dismissed before the bundle finished loading).
      { version: "v0.9", updateComponents: { surfaceId, components: leafMessages(c, wrap._a2uiWantsDisabled) } },
    ]);
    wrap.appendChild(surfaceEl);
    wrap._a2uiProcessor = processor;
    wrap._a2uiSurfaceId = surfaceId;
  });

  // Card lifecycle hook (called from cmcp-a2ui.js's resolve()): make this
  // leaf inert. No-op for non-Button leaves (Text/Heading/Divider/Image
  // have no interaction to disable).
  wrap._a2uiDisable = () => {
    wrap._a2uiWantsDisabled = true;
    if (c.type !== "Button" || !wrap._a2uiProcessor) return;
    wrap._a2uiProcessor.processMessages([
      { version: "v0.9", updateComponents: { surfaceId: wrap._a2uiSurfaceId, components: leafMessages(c, true) } },
    ]);
  };

  return wrap;
}

/**
 * Entry point cmcp-a2ui.js's mountComponents() calls for the four leaf types
 * routed through Lit (Text, Button, Divider, Image). `ctx` is the same lifecycle context renderA2UICard()
 * builds (buttons/inputs/fields/choose/isResolved) — Button wiring mirrors
 * the hand-rolled Button case exactly (reply text, submit serialization via
 * ctx.fields, ctx.choose()) so resolve()/update() behave identically
 * regardless of which path rendered a given card.
 */
export function mountStandardComponent(c, ctx) {
  if (c.type === "Button") {
    const wrap = mountA2uiLeaf(c, {
      onFire: () => {
        if (ctx.isResolved()) return;
        let text = c.reply ?? c.label;
        if (c.submit) {
          const lines = ctx.fields.map((f) => `${f.name}: ${f.read()}`);
          if (lines.length) text = `${text}\n${lines.join("\n")}`;
        }
        ctx.choose(wrap, text);
      },
    });
    ctx.buttons.push(wrap);
    return wrap;
  }
  return mountA2uiLeaf(c);
}
