// cmcp-a2ui.js — A2UI-subset cards for the agent panel chat.
// Part 1: pure validation/normalization (DOM-free — also runs under node --test).
// Part 2 (below): renderer + card lifecycle (touches document only when called).
//
// SECURITY WALL: every agent-supplied string renders via textContent/text nodes.
// Component types and attributes come from the enums validated here. See
// docs/superpowers/specs/2026-07-10-a2ui-chat-design.md.

export const A2UI_CAPS = Object.freeze({
  maxComponents: 64,
  maxDepth: 8,
  maxGraphNodes: 30,
  maxGraphEdges: 60,
  maxChartSeries: 8,
  maxChartPoints: 256,
  maxSelectOptions: 24,
  maxImages: 4,
  maxTextLen: 2000,
  maxLabelLen: 200,
});

/** ComfyUI-origin /view URLs, plus the panel's existing blob/data-image pipeline. */
export function isAllowedImageSrc(src) {
  if (typeof src !== "string") return false;
  if (/^\/(api\/)?view\?/.test(src)) return true;
  if (/^blob:/.test(src)) return true;
  if (/^data:image\//.test(src)) return true;
  return false;
}

const CONTAINER_TYPES = new Set(["Row", "Column", "Card"]);
const KNOWN_TYPES = new Set([
  "Text", "Heading", "Button", "Row", "Column", "Card", "Divider",
  "Image", "TextField", "Select", "Checkbox", "comfy:graph", "comfy:chart",
]);

const str = (v) => typeof v === "string";
const capped = (v, n) => str(v) && v.length <= n;

/**
 * Validate + normalize a raw card spec. Returns { ok:true, spec } with defaults
 * applied, or { ok:false, errors:[...] }. Never throws.
 */
export function validateA2UISpec(raw) {
  const errors = [];
  const err = (m) => { errors.push(m); };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["spec must be an object"] };
  }
  const spec = {
    surface: raw.surface === undefined ? "inline" : raw.surface,
    title: raw.title,
    root: raw.root,
    components: raw.components,
  };
  if (spec.surface !== "inline" && spec.surface !== "wide") err(`surface must be "inline" or "wide"`);
  if (spec.title !== undefined && !capped(spec.title, A2UI_CAPS.maxLabelLen)) err("title missing or too long");
  if (!str(spec.root)) err("root (component id) is required");
  if (!Array.isArray(spec.components)) err("components array is required");
  if (errors.length) return { ok: false, errors };
  if (spec.components.length === 0) return { ok: false, errors: ["components must not be empty"] };
  if (spec.components.length > A2UI_CAPS.maxComponents) {
    return { ok: false, errors: [`too many components (${spec.components.length} > ${A2UI_CAPS.maxComponents})`] };
  }

  const byId = new Map();
  let imageCount = 0;

  for (const c of spec.components) {
    if (!c || typeof c !== "object") { err("component must be an object"); continue; }
    if (!capped(c.id, A2UI_CAPS.maxLabelLen) || !c.id) { err("component id missing/too long"); continue; }
    if (byId.has(c.id)) { err(`duplicate id "${c.id}"`); continue; }
    if (!KNOWN_TYPES.has(c.type)) { err(`unknown type "${String(c.type)}" (id "${c.id}")`); continue; }
    byId.set(c.id, c);

    const label = (field, max = A2UI_CAPS.maxLabelLen) => {
      if (!capped(c[field], max)) err(`"${c.id}": ${field} missing or too long`);
    };
    switch (c.type) {
      case "Text":
        if (!capped(c.text, A2UI_CAPS.maxTextLen)) err(`"${c.id}": text missing or too long`);
        break;
      case "Heading":
        if (!capped(c.text, A2UI_CAPS.maxLabelLen)) err(`"${c.id}": text missing or too long`);
        if (c.level !== undefined && ![1, 2, 3].includes(c.level)) err(`"${c.id}": level must be 1-3`);
        break;
      case "Button":
        label("label");
        if (c.reply !== undefined && !capped(c.reply, A2UI_CAPS.maxTextLen)) err(`"${c.id}": reply too long`);
        if (c.style !== undefined && c.style !== "primary" && c.style !== "secondary") err(`"${c.id}": bad style`);
        break;
      case "Row": case "Column": case "Card":
        if (!Array.isArray(c.children)) err(`"${c.id}": children array required`);
        else if (c.children.some((k) => !str(k))) err(`"${c.id}": children must be id strings`);
        break;
      case "Divider":
        break;
      case "Image":
        imageCount++;
        if (!isAllowedImageSrc(c.src)) err(`"${c.id}": image src not allowed (ComfyUI /view, blob:, data:image/ only)`);
        if (c.caption !== undefined) label("caption");
        break;
      case "TextField":
        label("label"); label("name");
        if (c.value !== undefined && !capped(c.value, A2UI_CAPS.maxTextLen)) err(`"${c.id}": value too long`);
        if (c.placeholder !== undefined) label("placeholder");
        break;
      case "Select": {
        label("label"); label("name");
        const opts = c.options;
        if (!Array.isArray(opts) || opts.length === 0) err(`"${c.id}": options array required`);
        else if (opts.length > A2UI_CAPS.maxSelectOptions) err(`"${c.id}": too many options (> ${A2UI_CAPS.maxSelectOptions})`);
        else for (const o of opts) {
          if (!o || !capped(o.label, A2UI_CAPS.maxLabelLen)) { err(`"${c.id}": option label missing/too long`); break; }
          if (o.value !== undefined && !capped(o.value, A2UI_CAPS.maxLabelLen)) { err(`"${c.id}": option value too long`); break; }
        }
        break;
      }
      case "Checkbox":
        label("label"); label("name");
        break;
      case "comfy:graph": {
        const nodes = c.nodes, edges = c.edges ?? [];
        if (!Array.isArray(nodes) || nodes.length === 0) { err(`"${c.id}": nodes array required`); break; }
        if (nodes.length > A2UI_CAPS.maxGraphNodes) { err(`"${c.id}": too many graph nodes (> ${A2UI_CAPS.maxGraphNodes})`); break; }
        if (!Array.isArray(edges) || edges.length > A2UI_CAPS.maxGraphEdges) { err(`"${c.id}": too many graph edges`); break; }
        const nodeIds = new Set();
        for (const n of nodes) {
          if (!n || !capped(n.id, A2UI_CAPS.maxLabelLen) || !capped(n.label, A2UI_CAPS.maxLabelLen)) { err(`"${c.id}": graph node id/label missing`); break; }
          if (n.color !== undefined && !/^#[0-9a-fA-F]{3,8}$/.test(n.color)) { err(`"${c.id}": node color must be a hex color`); break; }
          nodeIds.add(n.id);
        }
        for (const e of edges) {
          if (!e || !nodeIds.has(e.from) || !nodeIds.has(e.to)) { err(`"${c.id}": edge references unknown graph node`); break; }
          if (e.label !== undefined && !capped(e.label, A2UI_CAPS.maxLabelLen)) { err(`"${c.id}": edge label too long`); break; }
        }
        if (c.direction !== undefined && c.direction !== "lr" && c.direction !== "tb") err(`"${c.id}": direction must be "lr" or "tb"`);
        break;
      }
      case "comfy:chart": {
        if (c.kind !== "bar" && c.kind !== "line") { err(`"${c.id}": kind must be "bar" or "line"`); break; }
        const series = c.series;
        if (!Array.isArray(series) || series.length === 0) { err(`"${c.id}": series array required`); break; }
        if (series.length > A2UI_CAPS.maxChartSeries) { err(`"${c.id}": too many series (> ${A2UI_CAPS.maxChartSeries})`); break; }
        for (const s of series) {
          if (!s || !capped(s.label, A2UI_CAPS.maxLabelLen) || !Array.isArray(s.values) || s.values.length === 0) { err(`"${c.id}": series label/values missing`); break; }
          if (s.values.length > A2UI_CAPS.maxChartPoints) { err(`"${c.id}": too many points (> ${A2UI_CAPS.maxChartPoints})`); break; }
          if (s.values.some((v) => typeof v !== "number" || !Number.isFinite(v))) { err(`"${c.id}": values must be finite numbers`); break; }
        }
        if (c.x !== undefined && (!Array.isArray(c.x) || c.x.some((l) => !capped(l, A2UI_CAPS.maxLabelLen)))) err(`"${c.id}": x labels invalid`);
        break;
      }
    }
  }
  if (imageCount > A2UI_CAPS.maxImages) err(`too many images (${imageCount} > ${A2UI_CAPS.maxImages})`);

  // Root + child references must resolve; the render tree must be acyclic and shallow.
  if (!byId.has(spec.root)) err(`root: unknown component id "${spec.root}"`);
  for (const c of byId.values()) {
    if (!CONTAINER_TYPES.has(c.type)) continue;
    for (const k of c.children ?? []) {
      if (!byId.has(k)) err(`"${c.id}": child references unknown component id "${k}"`);
    }
  }
  if (errors.length) return { ok: false, errors };

  // Cycle + depth check via DFS from root.
  const visiting = new Set();
  const walk = (id, depth) => {
    if (depth > A2UI_CAPS.maxDepth) { err(`nesting depth exceeds ${A2UI_CAPS.maxDepth}`); return; }
    if (visiting.has(id)) { err(`reference cycle through "${id}"`); return; }
    const c = byId.get(id);
    if (!CONTAINER_TYPES.has(c.type)) return;
    visiting.add(id);
    for (const k of c.children ?? []) {
      walk(k, depth + 1);
      if (errors.length) { visiting.delete(id); return; }
    }
    visiting.delete(id);
  };
  walk(spec.root, 1);
  if (errors.length) return { ok: false, errors };

  return { ok: true, spec };
}
