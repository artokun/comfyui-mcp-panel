// The two things graph_add_node's post-create widget guard needs in order to be HONEST
// about what it actually observed (#700): a backend definition nothing has been allowed
// to rewrite, and a diagnosis that matches the condition that really held.
//
// #700 BACKGROUND. ComfyUI's core Comfy.UploadImage extension registers a
// `beforeRegisterNodeDef` hook that INJECTS a required input the backend never declares:
//
//   required.upload = ["IMAGEUPLOAD", { ...imageConfig, imageInputName }]
//
// and its IMAGEUPLOAD constructor materializes that input as
//
//   node.addWidget("button", "upload", "image", cb, { serialize: false, canvasOnly: true })
//
// A perfectly healthy LoadImage therefore ALWAYS carries an `upload` widget that does not
// serialize — which is exactly the shape the materialization guard treats as "did not
// materialize", because for a genuinely BACKEND-required input a canvas-only control
// cannot carry the prompt value (#580). The guards resolve this by scanning the FRESH
// backend /object_info definition, where `upload` simply does not exist (#620/#626).
//
// That only works while the fetched definition still says what the backend said.

/**
 * Deep copy of the JSON-shaped values /object_info returns. Anything that is not a plain
 * object or an array is passed through by identity — the payload is parsed JSON, so that
 * only ever covers primitives, and copying by reference is the safe default for a value
 * this module does not understand.
 */
function cloneDefValue(value) {
  if (Array.isArray(value)) return value.map(cloneDefValue);
  if (value && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const copy = {};
    for (const [key, inner] of Object.entries(value)) {
      // defineProperty, not `copy[key] = …`: JSON.parse gives `__proto__` as an OWN data
      // property, and a plain assignment to that name runs Object.prototype's setter — it
      // would silently DROP the entry from the snapshot (and re-parent the clone). A
      // required input the snapshot loses is a required input the guards stop checking,
      // which is the one direction this module must never fail in.
      Object.defineProperty(copy, key, {
        value: cloneDefValue(inner),
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return copy;
  }
  return value;
}

/**
 * The backend's OWN definition of `classType`, detached from the /object_info map it came
 * out of.
 *
 * This must be a SNAPSHOT, never a reference (#700). graph_add_node hands the very map it
 * fetched to `refresh` → app.registerNodesFromDefs, and ComfyUI passes each def object
 * STRAIGHT to the extensions' beforeRegisterNodeDef, which mutate it IN PLACE (verified
 * against the shipped frontend: `registerNodeDef(t, n)` invokes the hooks on `n` and only
 * then wraps it as the class's nodeData). Reading the def back afterwards no longer yields
 * the backend's requirements — it yields the backend's requirements plus whatever the
 * frontend injected. For any image/video/audio-upload loader that means an `upload` input
 * the backend never required, whose only possible widget is canvas-only, so the post-create
 * guard refuses a node it just built correctly, with a message blaming the extension
 * registration that in fact succeeded.
 *
 * Take it the instant the payload arrives and before anything can register from it.
 * Returns `undefined` when the map has no entry for the type — the frontend-only exemption
 * (Note/Reroute/…), where there is no backend definition to consult and the guards
 * correctly fall back to scanning the registered node data.
 */
export function snapshotBackendDef(defs, classType) {
  if (!defs || typeof defs !== "object") return undefined;
  if (typeof classType !== "string") return undefined;
  if (!Object.prototype.hasOwnProperty.call(defs, classType)) return undefined;
  return cloneDefValue(defs[classType]) ?? undefined;
}

/** The required input was never built onto the node at all. */
export const WIDGET_ABSENT = "absent";
/** The widget IS on the node, but it serializes no prompt value (options.serialize:false). */
export const WIDGET_NON_SERIALIZING = "non-serializing";

/**
 * Which of the two conditions the materialization guard reports actually held for `name`.
 * They are different faults with different remedies, and the pre-#700 message asserted the
 * first one unconditionally.
 */
export function classifyUnmaterializedWidget(node, name) {
  const widgets = Array.isArray(node?.widgets) ? node.widgets : [];
  const widget = widgets.find((candidate) => candidate?.name === name);
  return widget ? WIDGET_NON_SERIALIZING : WIDGET_ABSENT;
}

function quoteNames(names) {
  return names.map((name) => `"${name}"`).join(", ");
}

/**
 * The refusal graph_add_node raises when a required input has no usable widget on the node
 * it just created.
 *
 * The message this replaced said, for every case:
 *
 *   Required custom widget "upload" did not initialize for "LoadImage".
 *   Reload ComfyUI so its node extension can register, then retry.
 *
 * Both halves could be false at once. The widget had initialized — it was sitting on the
 * node — and the extension had registered; the caller's own preflight
 * (awaitRequiredCustomWidgetRegistration) had just PROVEN the constructor was present, so
 * the guard was recommending a reload to fix something it knew was not broken. #700 was
 * filed after ~90 tool calls spent investigating extension registration on that advice.
 *
 * So: say which condition held, say that nothing was added, and let the remedy assert
 * nothing about WHY beyond what was observed.
 *
 * The remedy is deliberately mechanism-free (codex gate r2 P2). Two earlier drafts named
 * a cause and both were falsifiable: "reload so the node's extension re-runs" misdescribes
 * a core/built-in widget that has no node extension behind it, and "reloading helps only
 * if the pack's frontend changed on disk" is wrong for a constructor that reads a mutable
 * setting, where changing the setting and reloading does fix it. The one causal claim left
 * is the one the caller PROVED — the constructor is registered — and it is made only in
 * the branch where the widget was also observed on the node.
 */
export function describeUnmaterializedRequiredWidgets(classType, node, names) {
  const list = Array.isArray(names) ? names : [];
  const absent = list.filter((name) => classifyUnmaterializedWidget(node, name) === WIDGET_ABSENT);
  const nonSerializing = list.filter(
    (name) => classifyUnmaterializedWidget(node, name) === WIDGET_NON_SERIALIZING,
  );

  const findings = [];
  if (absent.length) {
    findings.push(
      `required input${absent.length === 1 ? "" : "s"} ${quoteNames(absent)} ` +
        `${absent.length === 1 ? "was" : "were"} not built onto the node, even though a widget ` +
        `constructor for ${absent.length === 1 ? "its" : "their"} type is registered`,
    );
  }
  if (nonSerializing.length) {
    // State the flag that was actually read (options.serialize === false) and nothing
    // more. An earlier draft called these widgets "canvas-only", which the guard never
    // checks — a widget can carry serialize:false without canvasOnly, and describing a
    // state the code did not observe is the same fault this message exists to correct.
    findings.push(
      `required input${nonSerializing.length === 1 ? "" : "s"} ${quoteNames(nonSerializing)} ` +
        `${nonSerializing.length === 1 ? "is" : "are"} present but ` +
        `${nonSerializing.length === 1 ? "does" : "do"} not serialize a value ` +
        `(serialize:false), so a queued prompt would omit ` +
        `${nonSerializing.length === 1 ? "it" : "them"}`,
    );
  }

  // Stated only where the widget was actually SEEN on the node, which is exactly where it
  // is provable — and it is the correction #700 needs, because the old message asserted
  // the opposite of it.
  const notARegistrationFailure = nonSerializing.length
    ? "The widget constructor is registered and the widget was built, so this is not a " +
      "widget-registration failure. "
    : "";
  const remedy =
    "Reload the ComfyUI tab so this node type is registered again from the current " +
    "definition, then retry. If it still fails, this node's frontend and backend " +
    "definitions disagree and its pack needs updating (or its author needs to hear about it).";

  return (
    `Cannot add "${classType}": ${findings.join("; and ")}. Nothing was added. ` +
    `${notARegistrationFailure}${remedy}`
  );
}
