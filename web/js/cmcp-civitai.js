// CivitAI data client for the panel's CivitAI modal — a JS port of the mobile
// app's civitai_service.dart + civitai_models.dart. Every network call goes
// through the same-origin Python proxy (/comfyui_mcp_panel/civitai/*, see
// py/civitai_proxy.py) because a browser can't set the bot-gate headers or beat
// CORS. Media (thumbs/full/video) resolve to same-origin /media URLs usable as
// <img>/<video> src and fetchable as Blobs for share-with-agent.
//
// NOTE (parity, no NSFW gate): all browsing levels are freely selectable; there
// is no sign-in clamp. OAuth only enables the Favorites tab.

// ── constants (mirror civitai_models.dart) ─────────────────────────────────
export const LEVELS = [
  { label: "PG", level: 1 },
  { label: "PG-13", level: 2 },
  { label: "R", level: 4 },
  { label: "X", level: 8 },
  { label: "XXX", level: 16 },
];
export const PERIODS = ["Day", "Week", "Month", "Year", "AllTime"];
export const IMAGE_SORTS = ["Most Reactions", "Most Comments", "Most Collected", "Newest", "Oldest"];
export const MODEL_SORTS = ["Most Downloaded", "Highest Rated", "Most Liked", "Newest", "Oldest"];
export const BASE_MODELS = [
  "SD 1.4", "SD 1.5", "SD 1.5 LCM", "SD 2.0", "SD 2.1", "SDXL 0.9", "SDXL 1.0",
  "SDXL Turbo", "SDXL Lightning", "Pony", "Illustrious", "NoobAI", "SD 3", "SD 3.5",
  "SD 3.5 Medium", "SD 3.5 Large", "SD 3.5 Large Turbo", "Flux.1 S", "Flux.1 D",
  "Flux.1 Kontext", "Hunyuan Video", "Wan Video 2.2 I2V-A14B", "Wan Video 2.2 T2V-A14B",
  "Wan Video 14B t2v", "Wan Video 14B i2v 480p", "Wan Video 14B i2v 720p", "LTXV",
  "Mochi", "CogVideoX", "Kolors", "Qwen", "Chroma", "HiDream", "Lumina", "PixArt a",
  "PixArt E", "Playground v2", "Stable Cascade", "Aura Flow", "Other",
];

export const DEFAULT_FILTERS = Object.freeze({
  period: "Week",
  baseModels: [],
  imageSort: "Most Reactions",
  modelSort: "Most Downloaded",
  browsingLevels: [1],
  favorited: false,
  username: null, // creator filter — null means everyone
});

/**
 * GitHub-style search qualifiers: an "@name" token anywhere in the input sets
 * the creator filter; every other token stays part of the ranked full-text
 * query. "@ba0zi cyberpunk city rain" -> { creator: "ba0zi", query:
 * "cyberpunk city rain" }. The terms deliberately remain Meili `q` (typo-
 * tolerant, relevance-ranked) rather than exact tagNames filters, which would
 * be brittle. Only the FIRST @token is the creator; later ones are treated as
 * plain terms so a pasted sentence can't silently retarget the filter.
 */
export function parseCreatorQuery(raw) {
  const tokens = String(raw ?? "").trim().split(/\s+/).filter(Boolean);
  const at = tokens.find((t) => t.length > 1 && t.startsWith("@"));
  return {
    creator: at ? at.slice(1) : null,
    query: tokens.filter((t) => t !== at).join(" "),
  };
}

export function filtersDirty(f) {
  return (
    f.period !== "Week" ||
    f.imageSort !== "Most Reactions" ||
    f.modelSort !== "Most Downloaded" ||
    f.baseModels.length > 0 ||
    f.favorited ||
    !!f.username ||
    !(f.browsingLevels.length === 1 && f.browsingLevels[0] === 1)
  );
}

export function bitmask(levels) {
  if (!levels || levels.length === 0) return 1;
  return levels.reduce((a, b) => a | b, 0);
}

// ── hosts / keys (mirror civitai_service.dart) ─────────────────────────────
const API = "https://civitai.red/api";
const SEARCH_URL = "https://search-new.civitai.com/multi-search";
const SEARCH_KEY =
  "8c46eb2508e21db1e9828a97968d91ab1ca1caa5f70a00e88a2ba1e286603b61";
const CDN_TOKEN = "xG1nkqKTMzGDvpLrqFT7WA";

const _levelFromString = (s) =>
  ({ None: 1, Soft: 2, Mature: 4, X: 8, XXX: 16 }[s] || 1);

export class CivitaiClient {
  /** @param {object} api ComfyUI api ({fetchApi, apiURL}) injected by the monolith. */
  constructor(api) {
    this.api = api;
  }

  // ── proxy plumbing ───────────────────────────────────────────────────────
  async _get(url, { auth = false, headers } = {}) {
    return this._request({ url, method: "GET", auth, headers });
  }

  async _request({ url, method = "GET", body, auth = false, headers }) {
    const res = await this.api.fetchApi("/comfyui_mcp_panel/civitai/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, method, body, auth, headers }),
    });
    if (!res.ok) throw new Error(`civitai proxy ${res.status}`);
    return res.json();
  }

  /** Same-origin CDN media URL (usable as <img>/<video> src AND fetchable as a Blob). */
  mediaUrl(uuid, transform, ext) {
    const q = new URLSearchParams({ uuid, transform, ext });
    return this.api.apiURL(`/comfyui_mcp_panel/civitai/media?${q.toString()}`);
  }

  _thumb(uuid, isVideo) {
    return isVideo
      ? this.mediaUrl(uuid, "anim=false,transcode=true,width=450,original=false,optimized=true", "jpeg")
      : this.mediaUrl(uuid, "width=450", "jpeg");
  }
  _full(uuid, isVideo) {
    return isVideo
      ? this.mediaUrl(uuid, "transcode=true,width=450,optimized=true", "mp4")
      : this.mediaUrl(uuid, "original=true", "jpeg");
  }

  // Strip a full CDN url down to its uuid (the path segment after the token);
  // MeiliSearch already gives a bare uuid.
  _uuid(u) {
    if (typeof u !== "string" || !u.startsWith("http")) return u;
    const parts = u.split("/").filter(Boolean);
    const i = parts.indexOf(CDN_TOKEN);
    return i >= 0 && parts[i + 1] ? parts[i + 1] : parts[parts.length - 2] || u;
  }

  // primary downloadable file name for a model version (for "in library" matching)
  _primaryFile(v) {
    const files = (v && v.files) || [];
    const f = files.find((x) => x.primary) || files[0];
    return f && f.name ? f.name : null;
  }

  /** Parse the `list_local_models` markdown into a Set of normalized local
   *  filenames (lowercased full name AND stem) for "in library" matching. */
  static parseLocalNames(text) {
    const set = new Set();
    for (const line of (text || "").split("\n")) {
      const m = line.match(/^\s*-\s+(.+?)(?:\s+\(\d|\s*$)/);
      if (!m) continue;
      const name = m[1].trim().toLowerCase();
      if (!name || name.startsWith("trigger words") || name.startsWith("base:")) continue;
      set.add(name);
      set.add(name.replace(/\.[a-z0-9]+$/, "")); // stem, for extension mismatches
    }
    return set;
  }

  _reactions(m) {
    const k = (a, b) => (m[a] ?? m[b] ?? 0);
    return k("likeCount", "likeCountAllTime") + k("heartCount", "heartCountAllTime") +
      k("laughCount", "laughCountAllTime") + k("cryCount", "cryCountAllTime");
  }

  // ── parsers ────────────────────────────────────────────────────────────
  _fromRest(j) {
    const isVideo = (j.type || "image") === "video";
    const uuid = this._uuid(j.url);
    const nsfw = typeof j.nsfwLevel === "string" ? _levelFromString(j.nsfwLevel) : (j.nsfwLevel || 1);
    return {
      id: j.id, uuid, type: isVideo ? "video" : "image",
      thumbnailUrl: this._thumb(uuid, isVideo), fullUrl: this._full(uuid, isVideo),
      width: j.width || 0, height: j.height || 0, nsfwLevel: nsfw,
      prompt: j.meta?.prompt || null, modelName: j.meta?.Model || j.baseModel || null,
      author: j.username || null, reactions: this._reactions(j.stats || {}),
      meta: j.meta || null,
    };
  }

  _fromMeili(j) {
    const isVideo = (j.type || "image") === "video";
    const uuid = this._uuid(j.url);
    return {
      id: j.id, uuid, type: isVideo ? "video" : "image",
      thumbnailUrl: this._thumb(uuid, isVideo), fullUrl: this._full(uuid, isVideo),
      width: j.width || 0, height: j.height || 0, nsfwLevel: j.nsfwLevel || 1,
      prompt: j.meta?.prompt || null, modelName: j.meta?.Model || j.baseModel || null,
      author: j.user?.username || j.username || null, reactions: this._reactions(j.stats || j),
      meta: j.meta || null,
    };
  }

  // pick the highest-level cover image whose level is in the selected set (mask);
  // drop the model entirely if none qualify (no NSFW cover leaking into an SFW view)
  _modelFromJson(j, levels) {
    const mask = bitmask(levels);
    let best = null, bestLvl = -1;
    for (const v of j.modelVersions || []) {
      for (const img of v.images || []) {
        const lvl = img.nsfwLevel || 1;
        if ((lvl & mask) !== 0 && lvl > bestLvl) { best = img; bestLvl = lvl; }
      }
    }
    if (!best) return null;
    const uuid = this._uuid(best.url);
    const isVideo = (best.type || "image") === "video";
    return {
      id: j.id, name: j.name, type: j.type,
      coverUrl: this._thumb(uuid, isVideo), coverIsVideo: isVideo,
      nsfwLevel: bestLvl, baseModel: j.modelVersions?.[0]?.baseModel || null,
      creator: j.creator?.username || null,
      downloadCount: j.stats?.downloadCount, thumbsUp: j.stats?.thumbsUpCount,
      fileName: this._primaryFile(j.modelVersions?.[0]),
    };
  }

  _versionFromJson(v, levels) {
    const mask = bitmask(levels);
    const examples = (v.images || [])
      .filter((img) => (((img.nsfwLevel || 1) & mask) !== 0))
      .map((img) => this._fromRest({ ...img, url: img.url }));
    return {
      id: v.id, name: v.name || null, baseModel: v.baseModel || null,
      descriptionHtml: v.description || null,
      trainedWords: v.trainedWords || [], examples,
      downloadCount: v.stats?.downloadCount,
      fileName: this._primaryFile(v),
    };
  }

  /** Escape a string for use inside a quoted MeiliSearch filter value.
   *  Backslashes FIRST, then quotes — the other order would re-escape the
   *  quote escaping, letting a trailing `\` (or a crafted `\"`) break out of
   *  the quoted string and alter the filter. */
  static escapeMeili(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ── public API ───────────────────────────────────────────────────────────
  async fetchFeed({ type = "image", period = "Week", sort = "Most Reactions", levels = [1], limit = 100, cursor, username } = {}) {
    const q = new URLSearchParams({
      limit: String(limit), browsingLevel: String(bitmask(levels)),
      period, type, sort,
    });
    if (username) q.set("username", username); // narrow to one creator's posts
    if (cursor) q.set("cursor", cursor);
    const data = await this._get(`${API}/v1/images?${q.toString()}`);
    return {
      items: (data.items || []).map((x) => this._fromRest(x)),
      nextCursor: data.metadata?.nextCursor || null,
    };
  }

  async fetchModelImages(modelVersionId, { levels = [1], sort = "Most Reactions", limit = 30 } = {}) {
    const q = new URLSearchParams({
      limit: String(limit), modelVersionId: String(modelVersionId),
      browsingLevel: String(bitmask(levels)), sort,
      nsfw: bitmask(levels) > 2 ? "X" : "None",
    });
    const data = await this._get(`${API}/v1/images?${q.toString()}`);
    return (data.items || []).map((x) => this._fromRest(x));
  }

  async searchMedia(query, { type = "image", levels = [1], limit = 100, offset = 0, username } = {}) {
    const filter = [`type = ${type}`, `nsfwLevel IN [${levels.join(", ")}]`];
    // Creator filter — the index exposes the author under `user.username`
    // (live-verified filterable on the mobile app). Quoted + escaped so any
    // legal username parses without breaking out of the filter string.
    if (username) filter.push(`user.username = "${CivitaiClient.escapeMeili(username)}"`);
    const data = await this._request({
      url: SEARCH_URL, method: "POST",
      headers: {
        authorization: `Bearer ${SEARCH_KEY}`,
        origin: "https://civitai.red",
        "x-meilisearch-client":
          "Meilisearch instant-meilisearch (v0.13.5) ; Meilisearch JavaScript (v0.34.0)",
      },
      body: { queries: [{ indexUid: "images_v6", q: query, limit, offset, filter }] },
    });
    return (data.results?.[0]?.hits || []).map((x) => this._fromMeili(x));
  }

  /** Toggle the signed-in user's "Like" on an image (tRPC reaction.toggle —
   *  the same mutation the CivitAI site fires; calling it again un-likes).
   *  Requires OAuth (auth: true). Returns the raw tRPC result. */
  async toggleReaction(imageId, reaction = "Like") {
    return this._request({
      url: `${API}/trpc/reaction.toggle`,
      method: "POST",
      body: { json: { entityType: "image", entityId: imageId, reaction } },
      auth: true,
    });
  }

  // ── collections (the "likes folder") ────────────────────────────────────
  /** The signed-in user's image collections they can add to. */
  async getUserCollections() {
    const enc = encodeURIComponent(JSON.stringify({ json: { permissions: ["ADD"], type: "Image" } }));
    const data = await this._get(`${API}/trpc/collection.getAllUser?input=${enc}`, { auth: true });
    const j = data.result?.data?.json;
    const list = Array.isArray(j) ? j : j?.collections || [];
    return list.map((c) => ({ id: c.id, name: c.name, type: c.type }));
  }

  /** Create a new (private) image collection and return {id, name}. */
  async createCollection(name) {
    const data = await this._request({
      url: `${API}/trpc/collection.upsert`,
      method: "POST",
      body: { json: { name, type: "Image", read: "Private", write: "Private" } },
      auth: true,
    });
    const j = data.result?.data?.json || {};
    return { id: j.id, name: j.name || name };
  }

  /** Add (or remove) an image in a collection — the like's "folder" side. */
  async setImageInCollection(imageId, collectionId, on = true) {
    return this._request({
      url: `${API}/trpc/collection.saveItem`,
      method: "POST",
      body: {
        json: on
          ? { imageId, collections: [{ collectionId }], type: "Image" }
          : { imageId, collections: [], removeFromCollectionIds: [collectionId], type: "Image" },
      },
      auth: true,
    });
  }

  async fetchFavorites({ levels = [1, 2, 4, 8, 16], cursor, types } = {}) {
    const input = {
      json: {
        period: "AllTime", sort: "Newest", reactions: ["Like"],
        browsingLevel: bitmask(levels), cursor: cursor ?? null, authed: true,
        limit: 100,
        ...(Array.isArray(types) && types.length ? { types } : {}),
      },
    };
    if (cursor == null) input.meta = { values: { cursor: ["undefined"] } };
    const enc = encodeURIComponent(JSON.stringify(input));
    const data = await this._get(`${API}/trpc/image.getInfinite?input=${enc}`, { auth: true });
    const j = data.result?.data?.json || {};
    return { items: (j.items || []).map((x) => this._fromMeili(x)), nextCursor: j.nextCursor || null };
  }

  async fetchModels({ type, sort = "Most Downloaded", period = "Week", baseModels = [], levels = [1], limit = 100, cursor, query, username } = {}) {
    const base = new URLSearchParams({
      limit: String(limit), types: type, sort, period,
      nsfw: bitmask(levels) > 2 ? "true" : "false",
    });
    for (const b of baseModels) base.append("baseModels", b);
    // API QUIRK (live-verified on mobile): /v1/models returns an EMPTY page
    // when BOTH `query` and `username` are sent — so with a creator picked,
    // send only `username` and match the keyword client-side below.
    const clientFilter = !!(query && username);
    if (query && !username) base.set("query", query);
    if (username) base.set("username", username);
    const kw = clientFilter ? String(query).toLowerCase() : null;
    let next = cursor || null;
    let models = [];
    // Exactly ONE request on every path except keyword×creator, whose
    // client-side matching can empty a page — that combo (and ONLY that
    // combo) chases a few more pages so a thinned page isn't a dead end.
    for (let hop = 0; ; hop++) {
      const q = new URLSearchParams(base);
      if (next) q.set("cursor", next);
      const data = await this._get(`${API}/v1/models?${q.toString()}`);
      models = (data.items || [])
        .map((x) => this._modelFromJson(x, levels))
        .filter(Boolean);
      if (kw) models = models.filter((m) => (m.name || "").toLowerCase().includes(kw));
      next = data.metadata?.nextCursor || null;
      if (!clientFilter || models.length || !next || hop >= 4) break;
    }
    return { models, nextCursor: next };
  }

  async fetchModelDetail(modelId, { levels = [1] } = {}) {
    const j = await this._get(`${API}/v1/models/${modelId}`);
    return {
      id: j.id, name: j.name, type: j.type,
      versions: (j.modelVersions || []).map((v) => this._versionFromJson(v, levels)),
      creator: j.creator?.username || null, descriptionHtml: j.description || null,
      downloadCount: j.stats?.downloadCount, thumbsUp: j.stats?.thumbsUpCount,
      tags: j.tags || [],
    };
  }

  // ── creators (leaderboard tRPC + /v1/creators search) ────────────────────
  /** The site's creator leaderboard (civitai.com/leaderboard, "Creators"
   *  board) via tRPC — the public v1 API exposes NO leaderboard ordering
   *  (/v1/creators is join-date ordered), so this mirrors the website's own
   *  request. The endpoint intermittently 401s bare user agents; the proxy's
   *  browser-shaped headers usually pass, but callers must degrade gracefully
   *  (the picker shows "Top creators unavailable right now"). */
  async fetchTopCreators({ limit = 25 } = {}) {
    const enc = encodeURIComponent(JSON.stringify({ json: { id: "overall" } }));
    const data = await this._get(`${API}/trpc/leaderboard.getLeaderboard?input=${enc}`);
    const entries = data.result?.data?.json;
    if (!Array.isArray(entries)) return [];
    const out = [];
    for (const e of entries) {
      const username = e?.user?.username;
      if (!username || e?.user?.deletedAt != null) continue;
      const metric = (t) =>
        Array.isArray(e.metrics) ? e.metrics.find((m) => m?.type === t)?.value ?? null : null;
      out.push({
        username, position: e.position ?? null, score: e.score ?? null,
        downloads: metric("downloadCount"), thumbsUp: metric("thumbsUpCount"),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Search creators by (partial) username via the public /v1/creators API.
   *  Unranked (join-date order) — for ranked names use fetchTopCreators. */
  async searchCreators(query, { limit = 20 } = {}) {
    const trimmed = String(query || "").trim();
    if (!trimmed) return [];
    const q = new URLSearchParams({ query: trimmed, limit: String(limit) });
    const data = await this._get(`${API}/v1/creators?${q.toString()}`);
    return (data.items || [])
      .filter((j) => j && j.username)
      .map((j) => ({ username: j.username, modelCount: j.modelCount ?? 0 }));
  }

  async getGenerationData(imageId) {
    const enc = encodeURIComponent(JSON.stringify({ json: { id: imageId } }));
    const data = await this._get(`${API}/trpc/image.getGenerationData?input=${enc}`);
    const j = data.result?.data?.json || {};
    return {
      meta: j.meta || {},
      hasComfyWorkflow: j.meta?.comfy != null,
      resourceCount: (j.resources || []).length,
    };
  }

  /** Parse the embedded ComfyUI graph from generation meta (prefer UI-format). */
  static comfyGraph(meta) {
    if (!meta || meta.comfy == null) return null;
    let c = meta.comfy;
    if (typeof c === "string") {
      try { c = JSON.parse(c); } catch { return null; }
    }
    if (c && typeof c === "object") {
      if (c.workflow) return typeof c.workflow === "string" ? JSON.parse(c.workflow) : c.workflow;
      if (c.prompt) return typeof c.prompt === "string" ? JSON.parse(c.prompt) : c.prompt;
    }
    return c;
  }

  /** Ordered generation params for the info panel. */
  static params(meta) {
    if (!meta) return [];
    const val = (v) => (v && typeof v === "object" && v.inputs ? v.inputs.value ?? "" : v);
    const rows = [
      ["Model", meta.Model], ["sampler", meta.sampler], ["scheduler", meta.scheduler],
      ["steps", meta.steps], ["cfg", meta.cfgScale], ["seed", meta.seed],
      ["denoise", meta.denoise], ["size", meta.width && meta.height ? `${val(meta.width)}×${val(meta.height)}` : null],
    ];
    return rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(val(v))]);
  }
}
