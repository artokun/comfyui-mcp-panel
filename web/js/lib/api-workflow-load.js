import { importFailureNote } from "./pack-import-failures.js";

/**
 * panel#775 — API/prompt-format workflows ARE loadable. The panel was refusing
 * them on a premise that is false.
 *
 * `graph_load` said:
 *
 *     API/prompt format (top-level numeric keys, each an object with
 *     `class_type`) is NOT loadable here
 *     -> "workflow is in API/prompt format; provide the UI workflow JSON
 *         (the pack workflow.json is UI format)"
 *
 * Both halves are wrong. ComfyUI's own frontend carries `isApiJson` and
 * `app.loadApiJson(data, fileName)`, and uses them on its own file-drop path.
 * Measured against the live rig (ComfyUI 0.30.2 / frontend 1.47.12) with the
 * exact workflow from the report — `jcd315/comfyui-mcp-muse`
 * workflows/ltx23_distill_3stage.json, 59 API entries:
 *
 *     app.loadApiJson(api, "ltx23_distill_3stage.json")
 *       -> 56 nodes, 70 links, no throw, no alert
 *
 * Including rgthree's Power Lora Loader, which rebuilt its five widgets. The
 * frontend instantiates real nodes, so widget/link separation is done by the
 * node classes themselves rather than by a converter guessing from
 * `/object_info` — which is why this works where a hand-rolled API->UI
 * conversion would not.
 *
 * And the parenthetical was false for the pack that prompted the report: that
 * pack ships API format, and so does its upstream source. Telling the reader to
 * "provide the UI workflow JSON" pointed at a file that does not exist.
 *
 * WHAT IS GENUINELY LOST, and why the caller is told rather than left to notice:
 * API format has already discarded node POSITIONS, so the layout is synthesized.
 * Nothing about execution changes — topology and widget values are intact — but
 * the graph will not look like the author's, and someone who saves it has
 * replaced the layout for good.
 *
 * THE SHORTFALL IS THE IMPORTANT PART. 59 entries became 56 nodes, and the three
 * that vanished are all `LTXVImgToVideoConditionOnly`, a node type the installed
 * ComfyUI-LTXVideo does not provide. A load that silently drops three nodes and
 * reports success is the failure this codebase keeps fixing, so the count is
 * compared and any missing TYPE is named. Without that, the graph looks loaded
 * and fails at queue time with a disconnected input.
 */

/**
 * Is this the API/prompt shape — a map of node id to `{class_type, inputs}`?
 *
 * Deliberately the same test the caller already used, extracted so it can be
 * exercised directly. It requires EVERY key to be numeric and at least one entry
 * to carry `class_type`: a UI workflow has a top-level `nodes` array and fails
 * the first condition, so the two shapes cannot be confused.
 *
 * @param {unknown} data
 */
export function looksLikeApiWorkflow(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (Array.isArray(/** @type {any} */ (data).nodes)) return false;
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  if (!keys.every((k) => /^\d+$/.test(k))) return false;
  return keys.some((k) => {
    const v = /** @type {any} */ (data)[k];
    return v && typeof v === "object" && "class_type" in v;
  });
}

/** How many of each class_type the API workflow asked for. */
export function apiClassCounts(apiData) {
  const want = new Map();
  for (const v of Object.values(apiData ?? {})) {
    const t = v && typeof v === "object" ? v.class_type : undefined;
    if (typeof t === "string") want.set(t, (want.get(t) ?? 0) + 1);
  }
  return want;
}

/**
 * Which node types asked for did NOT arrive on the canvas.
 *
 * A missing type is almost always an uninstalled custom-node pack, and it is the
 * one thing that makes a "loaded" graph unrunnable while looking fine.
 *
 * @param {object} apiData the API/prompt workflow that was loaded
 * @param {Array<{type?: string}>} landedNodes `graph._nodes` after the load
 * @returns {{type: string, wanted: number, got: number}[]}
 */
export function apiLoadShortfall(apiData, landedNodes) {
  const want = apiClassCounts(apiData);
  const got = new Map();
  for (const n of landedNodes ?? []) {
    const t = n?.type;
    if (typeof t === "string") got.set(t, (got.get(t) ?? 0) + 1);
  }
  const out = [];
  for (const [type, wanted] of want) {
    const have = got.get(type) ?? 0;
    if (have < wanted) out.push({ type, wanted, got: have });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type));
}

/**
 * What to tell the caller about a load that went through the API path.
 *
 * Always states the layout caveat, because it is always true and it is the one
 * consequence a caller cannot see from a node count. Names missing types only
 * when there are any.
 */
export function apiLoadNote(shortfall, importFailures = []) {
  const layout =
    "Loaded from API/prompt format via the frontend's own importer. Node positions are " +
    "NOT in that format, so the layout is generated rather than the author's — execution " +
    "is unaffected (topology and widget values are intact), but saving this workflow " +
    "replaces the original layout permanently.";
  if (!shortfall?.length) return layout;
  const missing = shortfall.map((s) => `${s.type} (${s.wanted - s.got} of ${s.wanted})`).join(", ");
  // Two independent counts, and mixing them reads as a bug in the message itself:
  // ONE missing type can account for SEVERAL missing nodes (the measured case is
  // exactly that — three instances of one type). Types decide "this node type" vs
  // "these node types"; nodes decide "that node" vs "those nodes".
  const typeCount = shortfall.length;
  const nodeCount = shortfall.reduce((n, s) => n + (s.wanted - s.got), 0);
  return (
    `${layout} NODES ARE MISSING: ${missing}. The canvas does not have ${
      typeCount > 1 ? "these node types" : "this node type"
    }, so ${nodeCount > 1 ? "those nodes" : "that node"} did not load and anything wired to ${
      nodeCount > 1 ? "them is" : "it is"
    } now disconnected — this graph will fail at queue time, not at load time. Install the ` +
    `custom-node pack that provides ${typeCount > 1 ? "them" : "it"} and load again.` +
    // #775 — "install the pack" is WRONG ADVICE when the pack is installed and
    // failed to import. I followed it on my own machine, reported a missing
    // dependency on a public issue, and had to correct it: ComfyUI-LTXVideo had
    // IMPORT FAILED, so none of its nodes registered while the core comfy_extras
    // LTX nodes resolved fine — 34 of 35 present, and a broken install looked
    // exactly like a bad manifest.
    importFailureNote(importFailures)
  );
}
