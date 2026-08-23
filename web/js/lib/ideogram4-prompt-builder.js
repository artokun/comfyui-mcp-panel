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

function findWidget(node, name) {
  return Array.isArray(node?.widgets) ? node.widgets.find((w) => w?.name === name) : null;
}

function stringWidgetValue(node, name) {
  const value = findWidget(node, name)?.value;
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function currentStylePalette(node) {
  const widgetValue = findWidget(node, "style_palette_data")?.value;
  if (typeof widgetValue === "string") {
    try {
      const parsed = JSON.parse(widgetValue);
      if (Array.isArray(parsed) && parsed.every((color) => typeof color === "string")) return parsed;
    } catch {
      // Fall through to the live editor state. A malformed hidden widget is not
      // evidence that the editor has no palette.
    }
  }
  return Array.isArray(node?._stylePalette) ? node._stylePalette : [];
}

function finiteBoxNumber(value, field, index) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`elements_data[${index}].${field} must be a finite number`);
  }
  return value;
}

function normalizeRegionBoxes(value) {
  let parsed = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("elements_data must be a JSON array of Ideogram region objects");
    }
  }
  if (!Array.isArray(parsed)) {
    throw new Error("elements_data must be a JSON array of Ideogram region objects");
  }
  return parsed.map((box, index) => {
    if (!box || typeof box !== "object" || Array.isArray(box)) {
      throw new Error(`elements_data[${index}] must be an object`);
    }
    const x = finiteBoxNumber(box.x, "x", index);
    const y = finiteBoxNumber(box.y, "y", index);
    const w = finiteBoxNumber(box.w, "w", index);
    const h = finiteBoxNumber(box.h, "h", index);
    if (x < 0 || y < 0 || w < 0 || h < 0 || x + w > 1 || y + h > 1) {
      throw new Error(`elements_data[${index}] has a region outside the normalized 0..1 canvas`);
    }
    const text = box.text == null ? "" : box.text;
    const desc = box.desc == null ? "" : box.desc;
    if (typeof text !== "string" || typeof desc !== "string") {
      throw new Error(`elements_data[${index}].text and .desc must be strings when present`);
    }
    const palette = box.palette == null ? [] : box.palette;
    if (!Array.isArray(palette) || palette.some((color) => typeof color !== "string")) {
      throw new Error(`elements_data[${index}].palette must be an array of strings when present`);
    }
    return {
      x,
      y,
      w,
      h,
      type: box.type === "text" ? "text" : "obj",
      text,
      desc,
      palette: [...palette],
      ...(box.nobbox === true ? { nobbox: true } : {}),
      ...(box.locked === true ? { locked: true } : {}),
    };
  });
}

function regionToCaptionElement(box) {
  const element = { type: box.type, desc: box.desc };
  if (box.type === "text") element.text = box.text;
  if (!box.nobbox) {
    // KJNodes' import callback accepts the same 0..1000 y/x/y/x order that its
    // caption exporter emits. Round at the boundary so the rehydrated editor has
    // the exact representation its own serializer will produce.
    element.bbox = [
      Math.round(box.y * 1000),
      Math.round(box.x * 1000),
      Math.round((box.y + box.h) * 1000),
      Math.round((box.x + box.w) * 1000),
    ];
  }
  if (box.palette.length) element.color_palette = [...box.palette];
  return element;
}

function currentCaptionForRegions(node, boxes) {
  const caption = {
    compositional_deconstruction: {
      background: stringWidgetValue(node, "background"),
      elements: boxes.map(regionToCaptionElement),
    },
  };
  const highLevel = stringWidgetValue(node, "high_level_description");
  if (highLevel) caption.high_level_description = highLevel;

  const style = stringWidgetValue(node, "style");
  if (style === "photo" || style === "art_style") {
    const styleDescription = {
      aesthetics: stringWidgetValue(node, "aesthetics"),
      lighting: stringWidgetValue(node, "lighting"),
      medium: stringWidgetValue(node, "medium"),
    };
    if (style === "photo") styleDescription.photo = stringWidgetValue(node, "style.photo");
    else styleDescription.art_style = stringWidgetValue(node, "style.art_style");
    const palette = currentStylePalette(node);
    if (palette.length) {
      styleDescription.color_palette = [...palette];
    }
    caption.style_description = styleDescription;
  }
  return caption;
}

function connectedImportSource(node) {
  try {
    const input = (node?.inputs ?? []).find((entry) => entry?.name === "import_json");
    const link = input?.link;
    if (link == null) return null;
    const source = node.graph?.links?.[link] ?? null;
    if (!source) return null;
    // KJNodes deliberately keeps muted/bypassed links in the graph while treating
    // them as disconnected for queue-time authority.
    const origin = node.graph?.getNodeById?.(source.origin_id);
    if (origin && [2, 4].includes(origin.mode)) return null;
    return source;
  } catch {
    return null;
  }
}

function regionShape(box) {
  return {
    type: box?.type === "text" ? "text" : "obj",
    text: typeof box?.text === "string" ? box.text : "",
    desc: typeof box?.desc === "string" ? box.desc : "",
    x: Number(box?.x),
    y: Number(box?.y),
    w: Number(box?.w),
    h: Number(box?.h),
    nobbox: box?.nobbox === true,
    palette: Array.isArray(box?.palette) ? box.palette.map((color) => String(color)) : [],
  };
}

function sameRegionShape(actual, expected) {
  const a = regionShape(actual);
  const e = regionShape(expected);
  return (
    a.type === e.type &&
    a.text === e.text &&
    a.desc === e.desc &&
    a.nobbox === e.nobbox &&
    a.palette.length === e.palette.length &&
    a.palette.every((color, index) => color === e.palette[index]) &&
    (e.nobbox || ["x", "y", "w", "h"].every((key) => Math.abs(a[key] - e[key]) <= 0.001))
  );
}

function cloneEditorBoxes(boxes) {
  return (Array.isArray(boxes) ? boxes : []).map((box) => ({
    ...box,
    ...(Array.isArray(box?.palette) ? { palette: [...box.palette] } : {}),
  }));
}

function readSerializedRegions(elementsWidget) {
  const raw = elementsWidget.serializeValue();
  // KJNodes uses an empty string for an empty editor, not JSON `[]`.
  if (raw === "") return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * Rehydrate the live KJNodes editor from an elements_data region list.
 *
 * The node's own `onExecuted({caption:[…]})` callback is the frontend half of its
 * supported `import_json` path: KJNodes parses the caption, rebuilds `_boxes`,
 * refreshes the hidden widgets, and repaints the editor. Calling the generic widget
 * setter cannot do that because `serializeValue()` ignores `widget.value`.
 *
 * An active import_json connection is authoritative in "always" mode, and while
 * the local editor is empty in "when empty" mode. In the latter mode, existing
 * local regions are intentionally authoritative, matching KJNodes' serializer.
 * Refuse only the source-authoritative cases and tell the caller to update the
 * connected source.
 */
export function applyIdeogram4PromptBuilderWrite(
  node,
  value,
  { beforeChange, afterChange, setDirty } = {},
) {
  if (classifyIdeogram4PromptBuilderWrite(node, IDEOGRAM4_ELEMENTS_WIDGET) !== "derived") {
    throw new Error(
      `Ideogram4PromptBuilder node ${node?.id ?? "?"} does not expose the live elements editor serializer; ` +
        "refresh the ComfyUI tab and retry.",
    );
  }
  const importLink = connectedImportSource(node);
  const boxes = normalizeRegionBoxes(value);
  const elementsWidget = findWidget(node, IDEOGRAM4_ELEMENTS_WIDGET);
  let current;
  try {
    current = readSerializedRegions(elementsWidget);
  } catch {
    throw new Error(
      `Ideogram4PromptBuilderKJ node ${node?.id ?? "?"} did not expose a readable elements_data serialization; ` +
        "nothing was changed.",
    );
  }
  if (!Array.isArray(current)) {
    throw new Error(
      `Ideogram4PromptBuilderKJ node ${node?.id ?? "?"} returned a non-array elements_data serialization; ` +
        "nothing was changed.",
    );
  }
  const importMode = stringWidgetValue(node, "import_mode");
  if (importLink && (importMode === "always" || current.length === 0)) {
    throw new Error(
      `Ideogram4PromptBuilderKJ node ${node?.id ?? "?"} has a live import_json connection, which is ` +
        "the queue's authoritative region source in the current import mode. Update the connected " +
        "PrimitiveStringMultiline value or leave local regions in place before using panel_set_widget.",
    );
  }
  if (typeof node?.onExecuted !== "function") {
    throw new Error(
      `Ideogram4PromptBuilderKJ node ${node?.id ?? "?"} has no live import callback; ` +
        "refresh the ComfyUI tab and retry.",
    );
  }

  const previousBoxes = cloneEditorBoxes(node._boxes);
  const previousPalette = Array.isArray(node._stylePalette) ? [...node._stylePalette] : node._stylePalette;
  const previousLastImported = node._lastImported;
  const previousWidgets = (node.widgets ?? []).map((widget) => ({ widget, value: widget.value }));
  const previousSize = Array.isArray(node.size) ? [...node.size] : null;
  beforeChange?.();
  try {
    node.onExecuted({ caption: [JSON.stringify(currentCaptionForRegions(node, boxes))] });
    // The callback is the mutation boundary. Verify the exact semantic fields that
    // the caption format carries before reporting success; a callback that exists but
    // is from an incompatible KJNodes build must not become a silent success.
    const serialized = readSerializedRegions(elementsWidget);
    if (
      !Array.isArray(serialized) ||
      serialized.length !== boxes.length ||
      serialized.some((box, index) => !sameRegionShape(box, boxes[index]))
    ) {
      throw new Error(
        `Ideogram4PromptBuilderKJ node ${node?.id ?? "?"} did not rehydrate elements_data to the requested ` +
          "regions; nothing was reported as applied.",
      );
    }
    // The caption format has no lock bit; restore that editor-only flag after the
    // node's own import callback and refresh the serialized hidden widget so a locked
    // region is not silently unlocked by a programmatic replacement.
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].locked === true && node._boxes?.[i]) node._boxes[i].locked = true;
    }
    elementsWidget.value = JSON.stringify(node._boxes ?? serialized);
  } catch (error) {
    // The callback is third-party node code. If a future KJNodes build changes its
    // caption semantics, restore every state we can observe before exposing the
    // failure to the generic handler.
    node._boxes = previousBoxes;
    node._stylePalette = previousPalette;
    node._lastImported = previousLastImported;
    for (const { widget, value: previousValue } of previousWidgets) widget.value = previousValue;
    if (previousSize && typeof node.setSize === "function") node.setSize(previousSize);
    throw error;
  } finally {
    afterChange?.();
  }
  setDirty?.();
  return {
    ideogram4_prompt_builder: {
      node_id: node?.id,
      widget: IDEOGRAM4_ELEMENTS_WIDGET,
      driven: true,
      editor_driven: true,
      previous_regions: current.length,
      regions: boxes.length,
      verified: true,
    },
  };
}
