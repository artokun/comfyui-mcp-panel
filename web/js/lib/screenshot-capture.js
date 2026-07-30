// Pure helpers for graph_screenshot — kept side-effect-free so they can be
// unit-tested headlessly (the actual canvas capture / DOM composite cannot be).
//
// Covers three defects in the screenshot capture path:
//  - #335/#329/#189: under ComfyUI's Vue-based node renderer
//    (`Comfy.VueNodes.Enabled`) node bodies are DOM/Vue elements layered OVER
//    the LiteGraph canvas, so a raw `canvas.toDataURL()` serializes only what
//    LiteGraph still paints (groups, link splines, HUD) — every node body is
//    missing. Detect the renderer so the capture path can force the LiteGraph
//    paint path before capturing.
//  - #335 (framing): ds.scale/ds.offset operate in CSS pixels, but the fit math
//    used the canvas backing-store dims (cv.width === cssPx * devicePixelRatio),
//    zooming the graph by DPR and clipping it on HiDPI displays.
//  - #237: the capture must not leave graph tools scoped to a different
//    (sub)graph than where they started.

/** Whether ComfyUI's Vue-based node renderer is active. When true, node bodies
 *  are NOT painted on the LiteGraph 2D canvas, so a raw canvas capture misses
 *  them. `getSettingValue` is `app.ui.settings.getSettingValue` (or any
 *  id → value getter). Defaults to false on any error / missing store. */
export function isVueNodesEnabled(getSettingValue) {
  try {
    return getSettingValue?.("Comfy.VueNodes.Enabled") === true;
  } catch {
    return false;
  }
}

/** Whether the Vue node renderer is actually painting *right now*. Prefers the
 *  live LiteGraph flag (`LiteGraph.vueNodesMode`), which the canvas draw path
 *  reads synchronously, and falls back to the persisted setting when the flag is
 *  absent.
 *
 *  This is the flag to save/restore DIRECTLY around a capture: toggling the
 *  *setting* (`Comfy.VueNodes.Enabled`) is async — ComfyUI's compat setter kicks
 *  off a store update and the renderer switches through a batched Vue watcher, so
 *  a synchronous false→draw→true sequence coalesces and never actually forces the
 *  LiteGraph paint path. Setting `LiteGraph.vueNodesMode = false` takes effect on
 *  the very next `canvas.draw()`. */
export function vueNodesActive(getSettingValue, litegraph) {
  if (litegraph && typeof litegraph.vueNodesMode === "boolean") {
    return litegraph.vueNodesMode === true;
  }
  return isVueNodesEnabled(getSettingValue);
}

/** Fit transform for framing the whole graph within the viewport.
 *
 *  ds.scale / ds.offset are in CSS pixels (LGraphCanvas scales the 2D context by
 *  devicePixelRatio), so the viewport dims passed here MUST be CSS pixels
 *  (cv.clientWidth/clientHeight, or cv.width / devicePixelRatio) — NOT the
 *  backing-store cv.width/cv.height, which are DPR times larger.
 *
 *  Returns { scale, offsetX, offsetY } to assign to ds.scale / ds.offset. */
export function computeFitTransform({
  boundsX,
  boundsY,
  boundsW,
  boundsH,
  viewCssW,
  viewCssH,
  pad = 60,
  maxScale = 1.5,
}) {
  const w = boundsW + pad * 2;
  const h = boundsH + pad * 2;
  const scale = Math.min(viewCssW / w, viewCssH / h, maxScale);
  const offsetX = -boundsX + pad + (viewCssW / scale - w) / 2;
  const offsetY = -boundsY + pad + (viewCssH / scale - h) / 2;
  return { scale, offsetX, offsetY };
}

/** CSS-pixel viewport dims for a canvas element, preferring the laid-out
 *  clientWidth/clientHeight and falling back to backing-store / devicePixelRatio.
 *  `dpr` is injected for testability (default reads the global). */
export function cssViewport(cv, dpr = (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1) {
  const w = cv?.clientWidth || (cv?.width || 0) / dpr;
  const h = cv?.clientHeight || (cv?.height || 0) / dpr;
  return { viewCssW: w, viewCssH: h };
}

/** True when the active viewing scope changed during the capture and must be
 *  restored (#237). Compares graph references — a changed reference means graph
 *  tools would otherwise be left pointed at the wrong (sub)graph. */
export function scopeChanged(beforeGraph, afterGraph) {
  return !!beforeGraph && !!afterGraph && beforeGraph !== afterGraph;
}
