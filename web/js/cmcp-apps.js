// Micro-Apps service — conversion + manifest logic (pure, unit-testable) and a
// thin HTTP client for the pack's py/apps_routes.py surface.
//
// An "app" = { manifest, workflow(UI) , prompt(API snapshot) , thumbnail } —
// the snapshot exists because there is NO client-side UI→API converter, so we
// capture `app.graphToPrompt()` once at conversion time and patch widget
// values into it per run. Everything here is pure except AppsClient's fetch
// calls: the graph-touching bits live in cmcp-apps-ui.js, which passes plain
// JSON (serialize() / graphToPrompt() output) into AppBuilder.

const API_BASE = "/comfyui_mcp_panel/apps";

/** Default registry base URL (the production Worker once deployed; override
 *  via localStorage `comfyui-mcp.panel.registryUrl` — e.g. a wrangler dev
 *  instance). Empty = registry features show a configure hint. */
export const DEFAULT_REGISTRY_URL = "https://cmcp-apps-registry.artokun.workers.dev";

export function registryBaseUrl() {
  try {
    const override = localStorage.getItem("comfyui-mcp.panel.registryUrl");
    if (override && override.trim()) return override.trim().replace(/\/+$/, "");
  } catch { /* storage blocked */ }
  return DEFAULT_REGISTRY_URL;
}

/** This install's creator key (64 hex) — generated once, kept in localStorage.
 *  The registry stores only sha256(key) as creator_id. */
export function creatorKey() {
  return _stableKey("comfyui-mcp.panel.creatorKey", 64);
}

/** Anonymous star/run identity key — one per install. */
export function starKey() {
  return _stableKey("comfyui-mcp.panel.starKey", 36);
}

function _stableKey(storageKey, len) {
  let key = null;
  try {
    key = localStorage.getItem(storageKey);
  } catch { /* storage blocked */ }
  if (key) return key;
  key = crypto.randomUUID().replace(/-/g, "");
  if (len === 64) key = key + crypto.randomUUID().replace(/-/g, "");
  key = key.slice(0, len);
  try {
    localStorage.setItem(storageKey, key);
  } catch { /* storage blocked */ }
  return key;
}

/** HTTP client for the Cloudflare registry worker. */
export class RegistryClient {
  constructor(base = registryBaseUrl()) {
    this.base = base;
  }

  get configured() {
    return !!this.base;
  }

  async _req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `registry ${res.status}`);
    return data;
  }

  list({ sort = "trending", q = "", creator = "", cursor = "", nsfw = false, limit = 24 } = {}) {
    const p = new URLSearchParams({ sort, limit: String(limit) });
    if (q) p.set("q", q);
    if (creator) p.set("creator", creator);
    if (cursor) p.set("cursor", cursor);
    if (nsfw) p.set("nsfw", "1");
    return this._req("GET", `/v1/apps?${p}`);
  }
  get(id) {
    return this._req("GET", `/v1/apps/${id}`);
  }
  bundle(id) {
    return this._req("GET", `/v1/apps/${id}/bundle`);
  }
  star(id, on = true) {
    return this._req("POST", `/v1/apps/${id}/${on ? "star" : "unstar"}`, { star_key: starKey() });
  }
  ran(id) {
    return this._req("POST", `/v1/apps/${id}/ran`, { star_key: starKey() }).catch(() => {});
  }
  report(id, reason) {
    return this._req("POST", `/v1/apps/${id}/report`, { reason });
  }
  publish({ app, prompt, workflow, thumbnail_b64, creatorName }) {
    return this._req("POST", "/v1/apps", {
      creator_key: creatorKey(),
      creator_name: creatorName,
      app,
      prompt,
      ...(workflow ? { workflow } : {}),
      ...(thumbnail_b64 ? { thumbnail_b64 } : {}),
    });
  }
  thumbnailUrl(id) {
    return `${this.base}/v1/apps/${id}/thumbnail`;
  }
}

/** Thin fetch wrapper for the apps routes. Errors throw with the server's
 *  `error` message when present. */
export class AppsClient {
  constructor(base = API_BASE) {
    this.base = base;
  }

  async _req(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      ...(body !== undefined
        ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
        : {}),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON (e.g. proxy error page) — fall through to status error */
    }
    if (!res.ok) {
      throw new Error((data && data.error) || `apps API ${res.status}`);
    }
    return data;
  }

  list() {
    return this._req("GET", "").then((d) => d.apps || []);
  }
  get(id) {
    return this._req("GET", `/${id}`);
  }
  bundle(id) {
    return this._req("GET", `/${id}/bundle`);
  }
  create(bundle) {
    return this._req("POST", "", bundle);
  }
  update(id, patch) {
    return this._req("PUT", `/${id}`, patch);
  }
  remove(id) {
    return this._req("DELETE", `/${id}`);
  }
  run(id, values, { dry = false } = {}) {
    return this._req("POST", `/${id}/run`, { values, ...(dry ? { dry: true } : {}) });
  }
  runStatus(id, promptId) {
    return this._req("GET", `/${id}/runs/${promptId}`);
  }
  thumbnailUrl(id) {
    return `${this.base}/${id}/thumbnail`;
  }
}

export class AppBuilder {
  /** Candidate locations for the ComfyUI frontend's APP-mode config inside a
   *  saved workflow JSON. The exact key shipped with frontend ≥1.41.13; we
   *  probe defensively (extra.* first, then top-level) so older/newer
   *  frontends keep importing. Each entry is a path array. */
  static APP_MODE_PATHS = [
    ["extra", "appMode"],
    ["extra", "app_mode"],
    ["extra", "apps"],
    ["appMode"],
    ["app_mode"],
    ["apps"],
  ];

  /** Find + normalize the frontend APP-mode config in a saved UI workflow.
   *  Returns { inputs, outputs } in OUR shape (nodeId numbers), or null when
   *  the workflow was never app-mode-configured. Tolerant of the frontend's
   *  exact item shape — node ids may arrive as strings, widget as name/key. */
  static findAppModeConfig(workflow) {
    if (!workflow || typeof workflow !== "object") return null;
    for (const path of AppBuilder.APP_MODE_PATHS) {
      let cur = workflow;
      for (const key of path) {
        cur = cur && typeof cur === "object" ? cur[key] : undefined;
      }
      const cfg = AppBuilder._normalizeAppMode(cur);
      if (cfg) return cfg;
    }
    return null;
  }

  static _normalizeAppMode(raw) {
    if (!raw || typeof raw !== "object") return null;
    const rawInputs = raw.inputs ?? raw.parameters ?? raw.exposedInputs;
    const rawOutputs = raw.outputs ?? raw.exposedOutputs;
    if (!Array.isArray(rawInputs) && !Array.isArray(rawOutputs)) return null;
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const inputs = (Array.isArray(rawInputs) ? rawInputs : [])
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const nodeId = num(it.nodeId ?? it.node_id ?? it.id);
        const widget = String(it.widget ?? it.name ?? it.key ?? "").trim();
        if (nodeId == null || !widget) return null;
        return {
          nodeId,
          widget,
          label: String(it.label ?? it.title ?? widget),
          kind: String(it.kind ?? it.type ?? "text"),
        };
      })
      .filter(Boolean);
    const outputs = (Array.isArray(rawOutputs) ? rawOutputs : [])
      .map((it) => {
        if (!it || typeof it !== "object") return null;
        const nodeId = num(it.nodeId ?? it.node_id ?? it.id);
        if (nodeId == null) return null;
        return { nodeId, kind: String(it.kind ?? it.type ?? "images") };
      })
      .filter(Boolean);
    if (!inputs.length && !outputs.length) return null;
    return { inputs, outputs, importedFromFrontend: true };
  }

  /** Node types whose widgets are natural app INPUTS by default (mirrors what
   *  the frontend APP builder highlights: prompt text, images, models,
   *  primitives, seeds/steps-samplers). */
  static INPUT_HINT_TYPES = new Set([
    "CLIPTextEncode",
    "LoadImage",
    "LoadImageMask",
    "CheckpointLoaderSimple",
    "CheckpointLoader",
    "LoraLoader",
    "VAELoader",
    "UNETLoader",
    "CLIPLoader",
    "ControlNetLoader",
    "UpscaleModelLoader",
    "PrimitiveNode",
    "PrimitiveInt",
    "PrimitiveFloat",
    "PrimitiveString",
    "KSampler",
    "KSamplerAdvanced",
    "SamplerCustom",
  ]);

  /** Widget value → app input kind. `nodeType` refines (LoadImage → image
   *  upload; *Loader → model picker). */
  static classifyWidget(nodeType, widgetName, value) {
    const t = String(nodeType || "");
    if (/loadimage/i.test(t)) return "image";
    if (/loader/i.test(t) || /_name$/i.test(widgetName)) return "model";
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "toggle";
    if (Array.isArray(value)) return "combo";
    return "text";
  }

  /** Heuristic app definition for a workflow with NO frontend app-mode config:
   *  inputs = widgets of hint-type nodes that aren't link-driven; outputs =
   *  output nodes (Save…/Preview…). `nodes` are litegraph-serialized nodes
   *  (id/type/widgets_values/inputs). Returns the same shape as
   *  findAppModeConfig (minus importedFromFrontend). */
  static heuristicAppMode(nodes) {
    const inputs = [];
    const outputs = [];
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (!node || typeof node !== "object") continue;
      const id = Number(node.id);
      if (!Number.isFinite(id)) continue;
      const type = String(node.type || "");
      const isOutput =
        node.constructor?.nodeData?.output_node === true ||
        /^(SaveImage|PreviewImage|SaveVideo|SaveAudio|PreviewAudio|ShowText|PreviewAsText)/.test(
          type,
        );
      if (isOutput) {
        outputs.push({ nodeId: id, kind: /^Show|^PreviewAs/.test(type) ? "text" : "images" });
        continue;
      }
      if (!AppBuilder.INPUT_HINT_TYPES.has(type)) continue;
      const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
      // widgets_values aligns positionally with the node's widget list; with
      // only serialized JSON we lack widget NAMES — the UI layer enriches from
      // live node defs. Here we record positional candidates; `widget` gets
      // resolved to a real name by enrichInputs() in the UI when the live
      // graph is available, and left as the positional index otherwise.
      values.forEach((v, i) => {
        if (v === null || v === undefined) return;
        if (typeof v === "object" && !Array.isArray(v)) return; // link marker
        inputs.push({
          nodeId: id,
          widget: String(i),
          label: `${type} #${id} · ${i}`,
          kind: AppBuilder.classifyWidget(type, "", v),
          positional: true,
        });
      });
    }
    return { inputs, outputs, importedFromFrontend: false };
  }

  /** Dependency scan over an API-format prompt. `knownTypes` = class_types
   *  ComfyUI already has (pass the live def keys; empty set → everything
   *  non-core is reported). Models = loader widget values. */
  static depsFromPrompt(prompt, knownTypes = new Set()) {
    const models = [];
    const customNodes = new Set();
    for (const node of Object.values(prompt || {})) {
      if (!node || typeof node !== "object") continue;
      const ct = String(node.class_type || "");
      if (ct && !knownTypes.has(ct)) customNodes.add(ct);
      if (/loader/i.test(ct)) {
        for (const [k, v] of Object.entries(node.inputs || {})) {
          if (typeof v === "string" && /(_name|ckpt|model)/i.test(k) && v) {
            models.push({ name: v, nodeType: ct, widget: k });
          }
        }
      }
    }
    return { models, customNodes: [...customNodes] };
  }

  /** Assemble the manifest object the server expects (see py/apps_routes.py
   *  _sanitize_manifest). `id` comes from crypto.randomUUID(). */
  static buildManifest({ id, name, description = "", appMode, hideWorkflow = false, source, deps }) {
    if (!id) throw new Error("buildManifest: id required");
    if (!name || !String(name).trim()) throw new Error("buildManifest: name required");
    return {
      id,
      name: String(name).trim(),
      description: String(description || ""),
      version: 1,
      source: source || { type: "canvas", workflowUuid: null, registryId: null },
      appMode: appMode || { inputs: [], outputs: [], importedFromFrontend: false },
      hideWorkflow: !!hideWorkflow,
      deps: deps || { models: [], customNodes: [] },
      published: null,
    };
  }
}
