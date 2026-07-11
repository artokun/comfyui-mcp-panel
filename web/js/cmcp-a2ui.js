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
  // Detach from the caller: a JSON round-trip strips getters/functions/symbols,
  // so the data we VALIDATE is exactly the data we RETURN (no re-read can change
  // it after validation), and cyclic raw objects are rejected up front.
  try {
    raw = JSON.parse(JSON.stringify(raw));
  } catch {
    return { ok: false, errors: ["spec must be plain JSON-serializable data"] };
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
        else if (c.children.length > A2UI_CAPS.maxComponents) err(`"${c.id}": too many children (> ${A2UI_CAPS.maxComponents})`);
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
        if (c.x !== undefined && (!Array.isArray(c.x) || c.x.length > A2UI_CAPS.maxChartPoints || c.x.some((l) => !capped(l, A2UI_CAPS.maxLabelLen)))) err(`"${c.id}": x labels invalid or too many`);
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

  // Cycle + depth check via DFS from root — and cap total INSTANCES: repeated
  // child references multiply the render tree, so we count every visit, not
  // just declared components (2 declared components must not render 50k nodes).
  const visiting = new Set();
  let instances = 0;
  let imageInstances = 0;
  const walk = (id, depth) => {
    if (errors.length) return;
    if (++instances > A2UI_CAPS.maxComponents) { err(`render tree exceeds ${A2UI_CAPS.maxComponents} component instances (repeated child references count)`); return; }
    if (depth > A2UI_CAPS.maxDepth) { err(`nesting depth exceeds ${A2UI_CAPS.maxDepth}`); return; }
    if (visiting.has(id)) { err(`reference cycle through "${id}"`); return; }
    const c = byId.get(id);
    if (c.type === "Image" && ++imageInstances > A2UI_CAPS.maxImages) { err(`render tree exceeds ${A2UI_CAPS.maxImages} image instances`); return; }
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

// ---------------------------------------------------------------------------
// Part 2: renderer + card lifecycle. document is touched only inside calls.
//
// GO branch (Task 1 spike decided GO — see .superpowers/sdd/task-1-report.md):
// Text/Heading/Button/Divider/Image mount through the vendored @a2ui/lit
// basic catalog via cmcp-a2ui-lit-adapter.js. Row/Column/Card containers and
// TextField/Select/Checkbox form fields stay hand-rolled here — see the
// scope note at the top of cmcp-a2ui-lit-adapter.js and task-3-report.md for
// why (container interleaving with comfy:graph/comfy:chart; reliable
// synchronous read-back for submit serialization). comfy:graph/comfy:chart
// are always hand-rolled: we draw those SVGs from data, which IS the custom
// catalog. This static import is DOM-free at module scope (the adapter
// lazy-imports the vendor bundle inside a function), so this file stays
// importable under `node --test`.
// ---------------------------------------------------------------------------

import { mountStandardComponent } from "./cmcp-a2ui-lit-adapter.js";

export const A2UI_CSS = `
:root {
  /* a2ui/lit basic-catalog theming -- mapped to the panel's own dark
     palette (see web/js/comfyui-mcp-panel.js). CSS custom properties cross
     shadow boundaries by design, so this reaches every a2ui-surface. */
  --a2ui-color-background: var(--p-content-background, #18181b);
  --a2ui-color-on-background: var(--p-text-color, #e4e4e7);
  --a2ui-color-surface: var(--p-surface-800, #27272a);
  --a2ui-color-on-surface: var(--p-text-color, #e4e4e7);
  --a2ui-color-border: var(--p-content-border-color, #3f3f46);
  --a2ui-color-input: var(--p-surface-900, #18181b);
  --a2ui-color-on-input: var(--p-text-color, #e4e4e7);
  --a2ui-color-primary: var(--p-primary-color, #60a5fa);
  --a2ui-color-on-primary: var(--p-primary-contrast-color, #18181b);
  --a2ui-color-primary-hover: #7db8fb;
  --a2ui-color-secondary: var(--p-surface-800, #27272a);
  --a2ui-color-on-secondary: var(--p-text-color, #e4e4e7);
  --a2ui-color-secondary-hover: var(--p-content-border-color, #3f3f46);
  --a2ui-border-radius: 6px;
  --a2ui-border-width: 1px;
  --a2ui-spacing-xs: 4px;
  --a2ui-spacing-s: 8px;
  --a2ui-spacing-m: 12px;
  --a2ui-spacing-l: 16px;
}
.cmcp-a2ui { border: 1px solid var(--p-content-border-color, #3f3f46); border-left: 3px solid var(--p-primary-color, #3a7bd5);
  border-radius: 8px; padding: 0.6rem 0.7rem; margin: 0.35rem 0; background: var(--p-content-background, #1f1f23);
  font-size: 0.8rem; position: relative; }
.cmcp-a2ui.resolved { opacity: 0.85; }
.cmcp-a2ui-title { font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em;
  opacity: 0.7; margin-bottom: 0.4rem; padding-right: 1.2rem; }
.cmcp-a2ui-x { position: absolute; top: 0.35rem; right: 0.4rem; background: none; border: none; cursor: pointer;
  color: var(--p-text-muted-color, #a1a1aa); font-size: 0.7rem; line-height: 1; padding: 0.15rem; }
.cmcp-a2ui-x:hover { color: var(--p-text-color, #e4e4e7); }
.cmcp-a2ui-row { display: flex; flex-direction: row; gap: 0.4rem; flex-wrap: wrap; align-items: flex-start; }
.cmcp-a2ui-col { display: flex; flex-direction: column; gap: 0.4rem; }
.cmcp-a2ui-card { border: 1px solid var(--p-content-border-color, #3f3f46); border-radius: 6px; padding: 0.5rem;
  display: flex; flex-direction: column; gap: 0.4rem; background: var(--p-content-hover-background, #26262a); }
.cmcp-a2ui-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.cmcp-a2ui h1, .cmcp-a2ui h2, .cmcp-a2ui h3 { margin: 0.1rem 0; font-size: 0.95rem; }
.cmcp-a2ui h1 { font-size: 1.05rem; } .cmcp-a2ui h3 { font-size: 0.85rem; }
.cmcp-a2ui hr { border: none; border-top: 1px solid var(--p-content-border-color, #3f3f46); margin: 0.3rem 0; width: 100%; }
.cmcp-a2ui-btn { display: block; width: 100%; text-align: left; padding: 0.4rem 0.6rem; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--p-content-border-color, #3f3f46); background: var(--p-content-hover-background, #26262a);
  color: var(--p-text-color, #e4e4e7); font-size: 0.78rem; }
.cmcp-a2ui-btn:hover:not(:disabled) { border-color: var(--p-primary-color, #3a7bd5); }
.cmcp-a2ui-btn.primary { background: var(--p-primary-color, #3a7bd5); border-color: transparent; color: #fff; }
.cmcp-a2ui-btn:disabled { opacity: 0.45; cursor: default; }
.cmcp-a2ui-btn.chosen { border-color: var(--p-primary-color, #3a7bd5); box-shadow: 0 0 0 1px var(--p-primary-color, #3a7bd5) inset; opacity: 1; }
.cmcp-a2ui-field { display: flex; flex-direction: column; gap: 0.2rem; }
.cmcp-a2ui-field > span { font-size: 0.68rem; opacity: 0.75; }
.cmcp-a2ui input[type="text"], .cmcp-a2ui select { background: var(--p-form-field-background, #18181b);
  border: 1px solid var(--p-content-border-color, #3f3f46); border-radius: 5px; color: inherit;
  padding: 0.3rem 0.45rem; font-size: 0.78rem; width: 100%; box-sizing: border-box; }
.cmcp-a2ui-check { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; }
.cmcp-a2ui img { max-width: 100%; border-radius: 6px; display: block; }
.cmcp-a2ui-cap { font-size: 0.625rem; color: var(--p-text-muted-color, #a1a1aa); margin-top: 0.15rem; }
.cmcp-a2ui svg { max-width: 100%; height: auto; display: block; }
.cmcp-a2ui-fail { border-left-color: var(--p-orange-400, #fb923c); }
.cmcp-a2ui-fail pre { max-height: 12rem; overflow: auto; font-size: 0.68rem; background: var(--p-form-field-background, #18181b);
  border-radius: 5px; padding: 0.4rem; margin: 0.3rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.cmcp-a2ui-choice { font-weight: 600; margin-top: 0.35rem; color: var(--p-primary-color, #6ea8fe); font-size: 0.75rem; }
.cmcp-a2ui-lit-leaf { display: block; width: 100%; }
.cmcp-a2ui-lit-leaf.chosen { outline: 2px solid var(--p-primary-color, #3a7bd5); outline-offset: 2px; border-radius: 6px; }
.cmcp-a2ui-lit-leaf.cmcp-a2ui-lit-inert { opacity: 0.55; pointer-events: none; }
`;

const SVG_NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** Layered left-to-right (or top-to-bottom) DAG drawing from DATA. Longest-path
 *  layering; cycles fall back to declaration order. All labels via textContent. */
function buildGraphSVG(c) {
  const dirLR = (c.direction ?? "lr") === "lr";
  const nodes = c.nodes, edges = c.edges ?? [];
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  // longest-path layer assignment (bounded: caps guarantee small N)
  const layer = new Array(nodes.length).fill(0);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      const f = idx.get(e.from), t = idx.get(e.to);
      if (layer[t] < layer[f] + 1) { layer[t] = layer[f] + 1; changed = true; }
      if (layer[t] > nodes.length) return buildGraphFallbackList(c); // cycle guard
    }
    if (!changed) break;
  }
  const byLayer = new Map();
  nodes.forEach((n, i) => {
    const l = layer[i];
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(i);
  });
  const NODE_W = 130, NODE_H = 34, GAP_X = 70, GAP_Y = 18;
  const pos = new Array(nodes.length);
  let maxLane = 0;
  for (const [l, members] of byLayer) {
    members.forEach((i, lane) => {
      pos[i] = dirLR
        ? { x: l * (NODE_W + GAP_X), y: lane * (NODE_H + GAP_Y) }
        : { x: lane * (NODE_W + GAP_X), y: l * (NODE_H + GAP_Y) };
      maxLane = Math.max(maxLane, lane);
    });
  }
  const layers = byLayer.size;
  const width = dirLR ? layers * NODE_W + (layers - 1) * GAP_X : (maxLane + 1) * NODE_W + maxLane * GAP_X;
  const height = dirLR ? (maxLane + 1) * NODE_H + maxLane * GAP_Y : layers * NODE_H + (layers - 1) * GAP_Y;
  const svg = svgEl("svg", { viewBox: `-4 -4 ${width + 8} ${height + 8}`, role: "img" });

  const marker = svgEl("marker", { id: "cmcp-a2ui-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
  marker.appendChild(svgEl("path", { d: "M 0 0 L 8 4 L 0 8 z", fill: "var(--p-text-muted-color, #a1a1aa)" }));
  const defs = svgEl("defs");
  defs.appendChild(marker);
  svg.appendChild(defs);

  for (const e of edges) {
    const f = pos[idx.get(e.from)], t = pos[idx.get(e.to)];
    const x1 = dirLR ? f.x + NODE_W : f.x + NODE_W / 2;
    const y1 = dirLR ? f.y + NODE_H / 2 : f.y + NODE_H;
    const x2 = dirLR ? t.x : t.x + NODE_W / 2;
    const y2 = dirLR ? t.y + NODE_H / 2 : t.y;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const d = dirLR
      ? `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
    svg.appendChild(svgEl("path", { d, fill: "none", stroke: "var(--p-text-muted-color, #a1a1aa)", "stroke-width": 1.5, "marker-end": "url(#cmcp-a2ui-arrow)" }));
    if (e.label) {
      const t2 = svgEl("text", { x: mx, y: my - 4, "text-anchor": "middle", "font-size": 9, fill: "var(--p-text-muted-color, #a1a1aa)" });
      t2.textContent = e.label;
      svg.appendChild(t2);
    }
  }
  nodes.forEach((n, i) => {
    const p = pos[i];
    const g = svgEl("g");
    g.appendChild(svgEl("rect", { x: p.x, y: p.y, width: NODE_W, height: NODE_H, rx: 6,
      fill: n.color || "var(--p-content-hover-background, #26262a)",
      stroke: "var(--p-content-border-color, #52525b)", "stroke-width": 1 }));
    const label = svgEl("text", { x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 + 3.5, "text-anchor": "middle",
      "font-size": 10.5, fill: "var(--p-text-color, #e4e4e7)" });
    label.textContent = n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label;
    const titleEl = svgEl("title");
    titleEl.textContent = n.label;
    g.appendChild(label);
    g.appendChild(titleEl);
    svg.appendChild(g);
  });
  return svg;
}

/** Cycle fallback: render the graph as a plain node list (never a broken drawing). */
function buildGraphFallbackList(c) {
  const div = document.createElement("div");
  div.className = "cmcp-a2ui-text";
  div.textContent = "Graph: " + c.nodes.map((n) => n.label).join(" · ");
  return div;
}

const CHART_COLORS = ["#6ea8fe", "#7ee2b8", "#fca5a5", "#fcd34d", "#c4b5fd", "#f9a8d4", "#93c5fd", "#a3e635"];

function buildChartSVG(c) {
  const W = 420, H = 200, PAD = { l: 36, r: 8, t: 8, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const all = c.series.flatMap((s) => s.values);
  const maxV = Math.max(...all, 0), minV = Math.min(...all, 0);
  const span = maxV - minV || 1;
  const nPts = Math.max(...c.series.map((s) => s.values.length));
  const sy = (v) => PAD.t + ih - ((v - minV) / span) * ih;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });

  // axes + 3 gridlines with value labels
  for (const frac of [0, 0.5, 1]) {
    const v = minV + span * frac, y = sy(v);
    svg.appendChild(svgEl("line", { x1: PAD.l, y1: y, x2: W - PAD.r, y2: y, stroke: "var(--p-content-border-color, #3f3f46)", "stroke-width": 0.5 }));
    const t = svgEl("text", { x: PAD.l - 4, y: y + 3, "text-anchor": "end", "font-size": 8.5, fill: "var(--p-text-muted-color, #a1a1aa)" });
    t.textContent = Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v * 100) / 100);
    svg.appendChild(t);
  }
  if (c.kind === "line") {
    const sx = (i) => PAD.l + (nPts <= 1 ? iw / 2 : (i / (nPts - 1)) * iw);
    c.series.forEach((s, si) => {
      const d = s.values.map((v, i) => `${i ? "L" : "M"} ${sx(i)} ${sy(v)}`).join(" ");
      svg.appendChild(svgEl("path", { d, fill: "none", stroke: CHART_COLORS[si % CHART_COLORS.length], "stroke-width": 1.8 }));
    });
  } else {
    const groups = nPts, nSer = c.series.length;
    const groupW = iw / groups, barW = Math.max(2, (groupW * 0.8) / nSer);
    c.series.forEach((s, si) => {
      s.values.forEach((v, i) => {
        const x = PAD.l + i * groupW + groupW * 0.1 + si * barW;
        const y0 = sy(Math.max(0, minV)), y1 = sy(v);
        svg.appendChild(svgEl("rect", { x, y: Math.min(y0, y1), width: barW - 1, height: Math.max(1, Math.abs(y0 - y1)), fill: CHART_COLORS[si % CHART_COLORS.length] }));
      });
    });
  }
  // x labels (thinned to ≤8)
  const xs = Array.isArray(c.x) ? c.x : [];
  const step = Math.max(1, Math.ceil(xs.length / 8));
  xs.forEach((lbl, i) => {
    if (i % step) return;
    const x = PAD.l + (xs.length <= 1 ? iw / 2 : (i / (xs.length - 1)) * iw);
    const t = svgEl("text", { x, y: H - 8, "text-anchor": "middle", "font-size": 8.5, fill: "var(--p-text-muted-color, #a1a1aa)" });
    t.textContent = lbl.length > 10 ? lbl.slice(0, 9) + "…" : lbl;
    svg.appendChild(t);
  });
  // legend
  if (c.series.length > 1) {
    c.series.forEach((s, si) => {
      const lx = PAD.l + si * 90;
      svg.appendChild(svgEl("rect", { x: lx, y: 0, width: 8, height: 8, rx: 2, fill: CHART_COLORS[si % CHART_COLORS.length] }));
      const t = svgEl("text", { x: lx + 11, y: 7.5, "font-size": 8.5, fill: "var(--p-text-muted-color, #a1a1aa)" });
      t.textContent = s.label.length > 12 ? s.label.slice(0, 11) + "…" : s.label;
      svg.appendChild(t);
    });
  }
  return svg;
}

/**
 * Mount one validated spec into a container element. Internal seam: standard
 * leaf types (Text/Heading/Button/Divider/Image) delegate to the Lit adapter;
 * containers (Row/Column/Card), form fields (TextField/Select/Checkbox), and
 * comfy:* stay hand-rolled here (see cmcp-a2ui-lit-adapter.js's scope note).
 * Returns nothing; ctx.fields collects { name, read() } for submit serialization.
 */
function mountComponents(container, spec, ctx) {
  const byId = new Map(spec.components.map((c) => [c.id, c]));
  const fields = []; // { name, read() }
  ctx.fields = fields;

  const build = (id) => {
    const c = byId.get(id);
    switch (c.type) {
      case "Text":
      case "Heading":
      case "Button":
      case "Divider":
      case "Image":
        return mountStandardComponent(c, ctx);
      case "Row": case "Column": case "Card": {
        const d = document.createElement("div");
        d.className = c.type === "Row" ? "cmcp-a2ui-row" : c.type === "Card" ? "cmcp-a2ui-card" : "cmcp-a2ui-col";
        for (const k of c.children ?? []) d.appendChild(build(k));
        return d;
      }
      case "TextField": {
        const wrap = document.createElement("label");
        wrap.className = "cmcp-a2ui-field";
        const lbl = document.createElement("span");
        lbl.textContent = c.label;
        const input = document.createElement("input");
        input.type = "text";
        if (c.value) input.value = c.value;
        if (c.placeholder) input.placeholder = c.placeholder;
        wrap.append(lbl, input);
        fields.push({ name: c.name, read: () => input.value });
        ctx.inputs.push(input);
        return wrap;
      }
      case "Select": {
        const wrap = document.createElement("label");
        wrap.className = "cmcp-a2ui-field";
        const lbl = document.createElement("span");
        lbl.textContent = c.label;
        const sel = document.createElement("select");
        for (const o of c.options) {
          const opt = document.createElement("option");
          opt.value = o.value ?? o.label;
          opt.textContent = o.label;
          sel.appendChild(opt);
        }
        if (c.value !== undefined) sel.value = c.value;
        wrap.append(lbl, sel);
        fields.push({ name: c.name, read: () => sel.value });
        ctx.inputs.push(sel);
        return wrap;
      }
      case "Checkbox": {
        const wrap = document.createElement("label");
        wrap.className = "cmcp-a2ui-check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!c.checked;
        const lbl = document.createElement("span");
        lbl.textContent = c.label;
        wrap.append(box, lbl);
        fields.push({ name: c.name, read: () => (box.checked ? "yes" : "no") });
        ctx.inputs.push(box);
        return wrap;
      }
      case "comfy:graph":
        return buildGraphSVG(c);
      case "comfy:chart":
        return buildChartSVG(c);
    }
  };

  container.appendChild(build(spec.root));
}

let _cardSeq = 0;

/**
 * Render a VALIDATED spec as a live interactive card.
 * onAction(text): user clicked a button / submitted — send `text` as a visible
 * chat message and mark the card resolved. onDismiss(): user hit ✕.
 */
export function renderA2UICard(spec, { onAction, onDismiss } = {}) {
  const cardId = `a2ui-${Date.now().toString(36)}-${++_cardSeq}`;
  const el = document.createElement("div");
  el.className = "cmcp-a2ui";
  el.dataset.cardId = cardId;

  let resolved = false;
  const ctx = {
    buttons: [],
    inputs: [],
    fields: [],
    isResolved: () => resolved,
    choose: (btn, text) => {
      handle.resolve(text, btn);
      onAction?.(text);
    },
  };

  const paint = (s) => {
    el.replaceChildren();
    ctx.buttons = [];
    ctx.inputs = [];
    if (s.title) {
      const t = document.createElement("div");
      t.className = "cmcp-a2ui-title";
      t.textContent = s.title;
      el.appendChild(t);
    }
    if (!resolved) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "cmcp-a2ui-x";
      x.title = "Dismiss";
      x.textContent = "✕";
      x.addEventListener("click", () => {
        if (resolved) return;
        handle.resolve(null); // inert, no message to the agent
        onDismiss?.();
      });
      el.appendChild(x);
    }
    mountComponents(el, s, ctx);
  };

  const handle = {
    el,
    cardId,
    isResolved: () => resolved,
    /** In-place re-render with a NEW validated spec (panel_ui_update). No-op once resolved. */
    update(newSpec) {
      if (resolved) return false;
      spec = newSpec;
      paint(spec);
      return true;
    },
    /** Make the card inert. choiceText null = dismissed (no highlight). */
    resolve(choiceText, chosenBtn = null) {
      if (resolved) return;
      resolved = true;
      el.classList.add("resolved");
      el.querySelector(".cmcp-a2ui-x")?.remove();
      for (const b of ctx.buttons) {
        b.disabled = true; // harmless on the Lit wrapper <span>; real effect if ever a native <button>
        b.classList?.add("cmcp-a2ui-lit-inert");
        b._a2uiDisable?.(); // Lit path: strip the Button's action at the protocol level
      }
      if (chosenBtn) chosenBtn.classList.add("chosen");
      for (const i of ctx.inputs) i.disabled = true;
      if (choiceText) {
        const d = document.createElement("div");
        d.className = "cmcp-a2ui-choice";
        d.textContent = `✓ ${choiceText.split("\n")[0]}`;
        el.appendChild(d);
      }
    },
  };

  paint(spec);
  return handle;
}

/** Replay a persisted card inert (reload / workflow switch). */
export function renderA2UIInert(spec, choice) {
  const handle = renderA2UICard(spec, {});
  handle.resolve(choice || null);
  return handle.el;
}

/** Fail-soft "unsupported card" chip with expandable raw JSON. */
export function renderA2UIFailCard(rawText, errors) {
  const el = document.createElement("div");
  el.className = "cmcp-a2ui cmcp-a2ui-fail";
  const t = document.createElement("div");
  t.className = "cmcp-a2ui-title";
  t.textContent = "Unsupported card";
  el.appendChild(t);
  const why = document.createElement("div");
  why.className = "cmcp-a2ui-text";
  why.textContent = (errors && errors.length ? errors.slice(0, 3).join("; ") : "could not render") + " — tap to view raw";
  why.style.cursor = "pointer";
  const pre = document.createElement("pre");
  pre.textContent = typeof rawText === "string" ? rawText : JSON.stringify(rawText, null, 2);
  pre.hidden = true;
  why.addEventListener("click", () => { pre.hidden = !pre.hidden; });
  el.append(why, pre);
  return el;
}
