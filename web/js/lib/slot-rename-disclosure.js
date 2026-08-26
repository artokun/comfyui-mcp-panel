/**
 * #1873 — a connect that silently RE-ADDRESSES its target must say so.
 *
 * The reporter wired IMAGE producers into a dynamic-input selector node with
 * `panel_connect`, every call reported success, `panel_query_graph` showed the
 * links — and the queued prompt did not carry the selected input:
 *
 *     NodeInputError: Node 550 says it needs input image0, but there is no
 *     input to that node at all
 *     ImpactSwitch: invalid select index (ignored)
 *
 * ## Why a live link can be absent from the prompt, read from source
 *
 * ComfyUI keys a prompt's inputs on the LIVE SLOT NAME at serialization time.
 * From `graphToPrompt` in comfyui_frontend_package 1.49.6 — the reporter's own
 * version — the prompt entry for a node is built as:
 *
 *     for (const [i, slot] of dto.inputs.entries()) {
 *       const resolved = dto.resolveInput(i)
 *       if (resolved) { … inputs[slot.name] = [String(origin_id), origin_slot] }
 *     }
 *
 * and `dto.inputs` is `node.inputs.map(s => ({ linkId: …, name: s.name, … }))`,
 * captured at serialize time. So the key the backend sees is whatever the slot
 * is called AT THE MOMENT OF THE RUN — not what it was called when the wire was
 * made. `image0` is "not there at all" precisely when no live slot is NAMED
 * `image0` any more, however many wires the canvas shows.
 *
 * ## What renames them
 *
 * The node packs do, from inside the connect itself. LiteGraph runs
 * `onConnectionsChange` from within `connectSlots`, and these packs rebuild
 * their slot names FROM POSITION every time it fires.
 *
 * ComfyUI-Impact-Pack (js/impact-pack.js, verified against the installed pack)
 * registers this for ImpactSwitch / LatentSwitch / SEGSSwitch and the
 * ImpactMake / Combine family:
 *
 *     let slot_i = 1;
 *     for (let i = 0; i < this.inputs.length; i++) {
 *       let input_i = this.inputs[i];
 *       if (input_i.name != 'select' && input_i.name != 'sel_mode') {
 *         input_i.name = `${input_name}${slot_i}`      // <-- renames EVERY slot
 *         slot_i++;
 *       }
 *     }
 *     if (connected) this.addInput(`${input_name}${slot_i}`, this.outputs[0].type);
 *     if (this.widgets?.[0]) {
 *       this.widgets[0].options.max = this.inputs.length - 3;
 *       this.widgets[0].value = Math.min(this.widgets[0].value, …);  // <-- and CLAMPS select
 *     }
 *
 * It also rewrites `this.outputs[0].name` to the propagated type when the
 * output was still `*`. ComfyUI-Easy-Use does the positional-name variant for
 * its *IndexSwitch nodes (web_version/v2, verified in the installed pack):
 * `this.addInput(prefix + s.length, "*")` when every slot is filled, and
 * `this.removeInput(i + 1)` when a trailing one empties — so a slot removed
 * ahead of others shifts the names that follow it.
 *
 * None of that is wrong of the packs; it is how a dynamic-input node works. What
 * was wrong is that `panel_connect` reported the name it saw and said nothing
 * when the NEXT `panel_connect` to the same node moved it. The caller then set
 * `index` / `select` against a name that had already shifted, and the run failed
 * with the message above — from the backend, several steps later, naming a slot
 * the panel had told them was connected.
 *
 * ## What this module does — and does NOT do
 *
 * It DISCLOSES. It does not rename anything back: the pack owns these names on
 * purpose (positional naming is the contract that makes `select`/`index` mean
 * anything), and putting an old name back would break the very addressing the
 * node depends on. This is the same call the sibling #1855 disclosure made for
 * node titles — see node-title-rewrite.js, same hook, same "the caller is left
 * holding a stale name" defect.
 *
 * Only state the caller COULD ALREADY HOLD is reported: a slot index that
 * existed before the connect and now carries a different name, or no longer
 * exists at all. A brand-new trailing slot is never reported — materialising the
 * next empty input is the expected behaviour of every node in this class, and
 * reporting it would put a warning on every correct ImpactSwitch connect.
 *
 * Never throws. It is a rider on a verdict that has already been decided, and it
 * must never turn a wire that landed into a reported failure.
 */

/** A slot list's names, in order. Never throws. */
function slotNames(slots) {
  const names = [];
  for (const slot of Array.isArray(slots) ? slots : []) {
    try {
      names.push(typeof slot?.name === "string" ? slot.name : null);
    } catch {
      names.push(null);
    }
  }
  return names;
}

/**
 * A widget list's `{ name, value }` pairs, in order. Never throws — a widget may
 * expose `value` as a getter that does, and a disclosure rider must not be the
 * thing that raises.
 */
function widgetValues(widgets) {
  const entries = [];
  for (const widget of Array.isArray(widgets) ? widgets : []) {
    try {
      entries.push({ name: typeof widget?.name === "string" ? widget.name : null, value: widget?.value });
    } catch {
      entries.push({ name: null, value: undefined });
    }
  }
  return entries;
}

/**
 * Snapshot the addressable state of the nodes a connect is about to touch,
 * BEFORE it runs: input slot names, output slot names, and widget values.
 *
 * Deduplicated by node IDENTITY so a self-connect (origin === target) is
 * captured once and cannot report itself twice. Non-objects are skipped rather
 * than throwing, for the same reason `captureNodeTitles` skips them.
 */
export function captureSlotNames(nodes) {
  const snapshot = [];
  for (const node of nodes ?? []) {
    if (!node || typeof node !== "object") continue;
    if (snapshot.some((entry) => entry.node === node)) continue;
    try {
      snapshot.push({
        node,
        inputs: slotNames(node.inputs),
        outputs: slotNames(node.outputs),
        widgets: widgetValues(node.widgets),
      });
    } catch {
      /* an unreadable node contributes no disclosure */
    }
  }
  return snapshot;
}

/**
 * Which slot names the connect's own side effects moved, and which widget values
 * it changed.
 *
 * Compared BY INDEX, and only over indices that existed BEFORE the mutation —
 * that bound is what keeps the expected "materialise the next empty slot"
 * behaviour silent while still catching a rename or a removal. `to: null` means
 * the slot at that index is gone entirely.
 *
 * Widget entries are reported only when the widget at that index still has the
 * SAME name: a name change at an index is a widget-list reshape, not a value
 * the caller set going stale, and describing it as one would be a guess.
 * `Object.is` rather than `!==` so a NaN-valued widget is not reported as
 * changing on every connect.
 *
 * @returns {Array<{node_id: unknown, slots: Array<{kind: string, index: number,
 *   from: string|null, to: string|null}>, widgets: Array<{name: string|null,
 *   from: string|number|boolean|null, to: string|number|boolean|null}>}>} one
 *   entry per node that actually changed. Widget values and node ids are safe,
 *   bounded JSON scalars; the live values remain private to this comparison.
 */
export function describeSlotRewrites(snapshot) {
  const rewrites = [];
  for (const entry of snapshot ?? []) {
    const node = entry?.node;
    if (!node || typeof node !== "object") continue;
    // Per-node try, matching `captureSlotNames`. `node.inputs` / `node.outputs` /
    // `node.widgets` / `node.id` are property READS, and an extension is free to
    // install a throwing getter or a Proxy over any of them (cg-use-everywhere
    // already replaces frontend API surface this panel calls). Without this, such
    // a read escapes AFTER the wire has landed and turns a successful connect
    // into a reported failure — the exact outcome the "never throws" contract in
    // the header exists to prevent, and the one #1272 spent a whole issue undoing.
    try {
      const slots = [];
      for (const kind of ["input", "output"]) {
        const before = (kind === "input" ? entry.inputs : entry.outputs) ?? [];
        const after = slotNames(kind === "input" ? node.inputs : node.outputs);
        for (let i = 0; i < before.length; i++) {
          // `i >= after.length` is a REMOVAL, reported as `to: null`. Indices at or
          // beyond `before.length` are new slots and are deliberately not read.
          const to = i < after.length ? after[i] : null;
          if (before[i] === to) continue;
          slots.push({
            kind,
            index: i,
            from: safeDisclosureValue(before[i] ?? null),
            to: safeDisclosureValue(to),
          });
        }
      }
      const widgets = [];
      const widgetsBefore = entry.widgets ?? [];
      const widgetsAfter = widgetValues(node.widgets);
      for (let i = 0; i < widgetsBefore.length && i < widgetsAfter.length; i++) {
        const was = widgetsBefore[i];
        const now = widgetsAfter[i];
        if (was?.name !== now?.name) continue;
        if (Object.is(was?.value, now?.value)) continue;
        widgets.push({
          name: safeDisclosureValue(was?.name ?? null),
          from: safeDisclosureValue(was?.value),
          to: safeDisclosureValue(now?.value),
        });
      }
      if (!slots.length && !widgets.length) continue;
      rewrites.push({ node_id: safeDisclosureValue(node.id), slots, widgets });
    } catch {
      /* an unreadable node contributes no disclosure, never a thrown verdict */
    }
  }
  return rewrites;
}

const MAX_DISCLOSURE_VALUE_LENGTH = 120;

function boundDisclosureText(text) {
  return text.length > MAX_DISCLOSURE_VALUE_LENGTH
    ? `${text.slice(0, MAX_DISCLOSURE_VALUE_LENGTH)}…`
    : text;
}

/**
 * Convert an arbitrary live graph value to a bounded JSON-safe scalar. The
 * comparison above deliberately retains the original values so Object.is()
 * can distinguish real changes; this is the boundary where those values must
 * stop being able to enter a graph_connect reply.
 */
function safeDisclosureValue(value) {
  try {
    if (value === null || value === undefined) return null;
    switch (typeof value) {
      case "string":
        return boundDisclosureText(value);
      case "number":
      case "boolean":
        return value;
      case "bigint":
        return boundDisclosureText(`${value}n`);
      case "symbol":
        return "(symbol)";
      case "function":
        return "(function)";
      default: {
        const json = JSON.stringify(value);
        if (typeof json !== "string") return "(unrenderable)";
        return boundDisclosureText(json);
      }
    }
  } catch {
    return "(unrenderable)";
  }
}

/**
 * A never-throwing, bounded rendering of an arbitrary value.
 *
 * Slot NAMES arrive here already coerced to `string | null` by `slotNames`, but
 * WIDGET VALUES are whatever the pack put on the widget, and a bare
 * `JSON.stringify` on those has two failure modes that both end in a `TypeError`
 * thrown from a disclosure rider — i.e. a landed connect reported as an error,
 * the precise thing this module must never cause:
 *
 *   - a BigInt: "Do not know how to serialize a BigInt"
 *   - a circular object: "Converting circular structure to JSON"
 *
 * Length is bounded for a third reason that is not a throw: a widget holding a
 * large object (a Load3D transform, a serialized curve) would otherwise paste its
 * entire JSON into a warning sentence.
 */
function renderValue(value) {
  try {
    if (value === null || value === undefined) return "null";
    const type = typeof value;
    if (type === "bigint") return boundDisclosureText(`${value}n`);
    if (type === "number" || type === "boolean") return String(value);
    if (type === "symbol" || type === "function") return `(${type})`;
    const json = JSON.stringify(value);
    // `undefined` when the value is not serialisable at all — never interpolate that.
    if (typeof json !== "string") return `(${type})`;
    return boundDisclosureText(json);
  } catch {
    return "(unrenderable)";
  }
}

/** `"input3" → "input2"`, or `"input4" → (removed)` for a slot that is gone. */
function renderSlot(change) {
  const to = change.to == null ? "(removed)" : renderValue(change.to);
  return `${change.kind} ${change.index} ${renderValue(change.from)} → ${to}`;
}

/**
 * The prose that rides alongside `slots_rewritten`.
 *
 * It carries the two things the structured field cannot: that the rename came
 * from the NODE PACK and not from the panel, and — the part that actually saves
 * the caller — that ComfyUI keys the queued prompt on the LIVE slot name, so a
 * selector widget left pointing at the old name fails at RUN time with a message
 * that names the panel's own reported slot.
 */
export function slotRewriteWarning(rewrites) {
  if (!rewrites?.length) return "";
  // Every value that reaches the template goes through `renderValue`, and the
  // whole list is built inside a try: this function is called from the RETURN
  // EXPRESSION of a connect whose wire has already landed, so a throw here would
  // report a successful mutation as a failure. When the list cannot be rendered
  // the disclosure still goes out — the caller needs to know their names moved
  // far more than they need the itemisation.
  let list = "";
  try {
    list = rewrites
      .map((r) => {
        const parts = r.slots.map(renderSlot);
        for (const w of r.widgets) {
          parts.push(`widget ${renderValue(w.name)} ${renderValue(w.from)} → ${renderValue(w.to)}`);
        }
        return `node ${renderValue(r.node_id)}: ${parts.join(", ")}`;
      })
      .join("; ");
  } catch {
    list = "the details could not be rendered";
  }
  return (
    `This connect RE-ADDRESSED ${rewrites.length === 1 ? "a node" : `${rewrites.length} nodes`} — ${list}. ` +
    `The panel did not do this: LiteGraph runs the target's own onConnectionsChange hook from ` +
    `inside the connect, and a dynamic-input pack rebuilds its slot names FROM POSITION there ` +
    `(ComfyUI-Impact-Pack renames every non-select input to "<prefix><n>" on each change and ` +
    `clamps its "select" widget; ComfyUI-Easy-Use's *IndexSwitch nodes append and remove ` +
    `position-named slots). ` +
    `Any input or output NAME an earlier panel_connect, panel_add_node or panel_query_graph ` +
    `reported for ${rewrites.length === 1 ? "that node" : "those nodes"} is now STALE — including ` +
    `the slot you may have picked a "select" / "index" value for. ` +
    `This matters at RUN time, not now: ComfyUI keys the queued prompt on the LIVE slot name, so ` +
    `a selector still naming the old slot fails with "Node <id> says it needs input <name>, but ` +
    `there is no input to that node at all" (#1873). ` +
    `Re-read the node with panel_query_graph before wiring anything else to it or setting its selector.`
  );
}
