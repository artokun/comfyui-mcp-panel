// comfyui-mcp#1569 — a write to `elements_data` on KJNodes' `Ideogram4PromptBuilderKJ`
// cannot reach the render, so it is refused rather than reported as a success.
//
// The reported shape, and the reason it was so hard to place: all THREE of these were
// true at once. `panel_set_widget` reported success for every field. `panel_query_graph`
// then showed the new values. And `panel_run` still rendered the OLD subject — the
// Margot Robbie portrait that was in the previously-serialized `elements_data`.
//
// FOUR FACTS FROM THE PACK'S OWN SOURCE (comfyui-kjnodes
// `web/js/ideogram4_prompt_builder.js` @ 95389ef, the build the pack pins), not inferred
// from the report. The first is on its own enough:
//
//  1. The widget defines its own `serializeValue`, and NO branch of it reads
//     `widget.value`:
//
//         elementsWidget.serializeValue = () => {
//           const always = findW("import_mode")?.value === "always";
//           if (importConnected() && (always || !node._boxes.length)) {
//             return JSON.stringify({ _refresh: (node._serialSeq = (node._serialSeq || 0) + 1) });
//           }
//           return node._boxes.length ? JSON.stringify(node._boxes) : "";
//         };
//
//     ComfyUI does not queue `widget.value`: `graphToPrompt` asks a widget for
//     `serializeValue()` whenever it defines one. So the queued `elements_data` is
//     built from `node._boxes` — the editor's in-memory region list — and an
//     assignment to the widget is simply not part of that computation.
//
//  2. The widget value is a DERIVED WRITE-BACK of that same state, not an input to it:
//
//         function serialize() {
//           if (elementsWidget) elementsWidget.value = node._boxes.length ? JSON.stringify(node._boxes) : "";
//           ...
//         }
//
//     `serialize()` runs from the editor's `commit()` and `touch()`, so the next
//     interaction with the node's UI overwrites whatever was assigned.
//
//  3. A reload does not rescue it either. `onSerialize` stores the regions in the node's
//     own blob (`o.ideo = { boxes: node._boxes, ... }`) and `onConfigure` prefers that
//     blob over the widget, falling back to `_parseBoxes(elementsWidget.value)` only
//     when the blob is absent.
//
//  4. The server really does read the queued value — `Ideogram4PromptBuilderKJ.execute()`
//     does `boxes = _parse_json_list(elements_data)` — which is why fact 1 changes the
//     IMAGE and not merely the display.
//
// So the value in the reply is real on the canvas and means nothing to the render. That
// is exactly the silent-success shape `panel_set_widget` must not produce, and it is the
// same defect class already refused for rgthree's Fast Groups toggle (#983) and for the
// LTXDirector / PromptRelay derived timeline widgets (#314, #506).
//
// WHY A REFUSAL AND NOT A ROUTE. The LTXDirector route (#314) drives the node's own
// `_applyLoadedTimeline`; this node exposes no equivalent. Its `commit()`, `serialize()`
// and `rebuildStylePalette()` are closure-locals inside `onNodeCreated` and are not
// reachable from the node object, so a route would have to assign `node._boxes` directly
// and then also repair `_selection`, `_activeIdx` and the DOM editor that renders them —
// guessing at a third-party node's internals, which is what makes the write unsound in
// the first place. Refusing costs the caller one tool call and cannot corrupt a graph.
//
// WHY `style_palette_data` IS DELIBERATELY NOT REFUSED, even though facts 2 and 3 apply
// to it as well: fact 1 does NOT. The pack installs `serializeValue` on the elements
// widget and on no other (it is the only such assignment in the file), so a
// `style_palette_data` write DOES reach the queue for the run at hand. It is fragile —
// the next editor interaction refreshes it from `node._stylePalette` — but refusing a
// write that reaches the render would block real work to prevent a misunderstanding.
// The same goes for the ordinary prompt fields (`high_level_description`, `background`,
// `style`, `aesthetics`, `lighting`, `medium`): plain string widgets with no serializer
// of their own, which is why the reporter's new strings DID apply and only the regions
// stayed stale.
//
// Dependency-free (no DOM, no LiteGraph). Unit-testable with plain fixtures.

/** The KJNodes node type whose regions are derived from the editor's in-memory state. */
export const IDEOGRAM4_PROMPT_BUILDER_TYPE = "Ideogram4PromptBuilderKJ";

/** The one widget on it whose queued value is computed from `node._boxes`. */
export const IDEOGRAM4_ELEMENTS_WIDGET = "elements_data";

/** The base widget name a request addresses, with any composite sub-field removed, so
 *  `"elements_data.0"` cannot slip past a guard that `"elements_data"` would catch.
 *  Kept local, matching the sibling guard in `rgthree-fast-groups.js`: sharing three
 *  lines would mean this node-specific module importing an rgthree-specific one. */
function baseWidgetName(widgetName) {
  if (typeof widgetName !== "string") return "";
  const dot = widgetName.indexOf(".");
  return dot === -1 ? widgetName : widgetName.slice(0, dot);
}

/**
 * `"derived"` when this write targets the elements widget on a live prompt-builder node
 * that actually installs the serializer, else null.
 *
 * Keyed on THREE things, and each one is load-bearing:
 *
 *   - the NODE TYPE, so the name `elements_data` on an unrelated node is untouched;
 *   - the WIDGET NAME, so every other widget on this node keeps working exactly as it
 *     does today (its prompt fields are ordinary string widgets and land fine);
 *   - the LIVE PRESENCE of the widget's own `serializeValue`, which is the fact that
 *     makes the write dead. Gating on the mechanism rather than on the type alone means
 *     the refusal cannot outlive its proof: if a later KJNodes build drops the override
 *     and honours the assignment, the write stops being refused with no change here.
 *
 * A widget that is ABSENT is not classified — the ordinary write path already reports an
 * unresolved widget, and that message is more accurate than this one would be.
 *
 * @param {{type?: unknown, widgets?: unknown}} node
 * @param {unknown} widgetName
 * @returns {"derived"|null}
 */
export function classifyIdeogram4PromptBuilderWrite(node, widgetName) {
  const type = node && typeof node === "object" ? node.type : undefined;
  if (type !== IDEOGRAM4_PROMPT_BUILDER_TYPE) return null;
  if (baseWidgetName(widgetName) !== IDEOGRAM4_ELEMENTS_WIDGET) return null;
  const widgets = node && Array.isArray(node.widgets) ? node.widgets : [];
  const widget = widgets.find((w) => w && w.name === IDEOGRAM4_ELEMENTS_WIDGET);
  if (!widget) return null;
  try {
    return typeof widget.serializeValue === "function" ? "derived" : null;
  } catch {
    // A throwing accessor tells us nothing about the override — but this is already the
    // node type and widget the pack is known to derive, so fail CLOSED for it rather than
    // let an unreadable probe hand back the silent success this guard exists to prevent.
    return "derived";
  }
}

/**
 * The refusal. Names what the widget actually is, why the write cannot reach the render,
 * and three remedies that do work — including the one the reporter verified themselves.
 */
export function ideogram4PromptBuilderRefusal(widgetName, nodeId) {
  return (
    `panel_set_widget cannot drive "${widgetName}" on ${IDEOGRAM4_PROMPT_BUILDER_TYPE} node ` +
    `${nodeId}: the regions are held in the node's own in-browser editor (\`node._boxes\`), and ` +
    `the widget is a DERIVED WRITE-BACK of that state rather than an input to it (#1569). The ` +
    `widget installs its own \`serializeValue()\`, which builds the queued value from the ` +
    `editor's regions and never reads the widget — and ComfyUI queues \`serializeValue()\`, not ` +
    `\`widget.value\`. So a direct write shows in the reply and in panel_query_graph, and the ` +
    `render still uses the OLD regions; the node also refreshes the widget from its own state ` +
    `on the next edit, and prefers its own saved blob on reload.\n` +
    `Three things do work. Edit the regions in the node's editor UI, which is what updates the ` +
    `state the queue reads. Or drive the node's \`import_json\` INPUT — it is declared ` +
    `force_input, so wire a string source into that socket and the node loads it into the ` +
    `editor and drives the output per \`import_mode\`. Or bypass the builder's conditioning ` +
    `entirely by encoding your prompt with a CLIPTextEncode wired straight into the sampler.\n` +
    `Every OTHER widget on this node is unaffected and still writable — its prompt fields ` +
    `(high_level_description, background, style, aesthetics, lighting, medium) are ordinary ` +
    `string widgets that reach the render normally.`
  );
}
