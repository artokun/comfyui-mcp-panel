/**
 * #1964 — serialize the LIVE CivitAI lightbox (what the user is looking at).
 *
 * `panel_civitai_open_lightbox` and the human "Ask agent to download" button
 * already hand a download intent to an agent that cannot see the view it
 * comes from: which of ~27 version pills is selected, the file on that pill
 * (name / size / format / scan / Early Access), the creator's distribution
 * note. The grid row only names the first version's "best match" file, so an
 * agent that re-fetches CivitAI (or reads `civitai_results` items) cannot
 * recover the lightbox. RED content is not on the public API at all (#1962).
 *
 * This module is the pane-path read: it copies the already-open lightbox's
 * in-memory objects. It does not fetch, does not call CivitAI, and never
 * carries image bytes. Wired into `panel_civitai_results` as `lightbox`.
 */

export const CIVITAI_NOTE_CAP = 4000;
export const CIVITAI_LIGHTBOX_EXAMPLES = 12;

/** Same map the model-detail download button uses (cmcp-civitai-ui SUBFOLDER). */
const SUBFOLDER = {
  LORA: "loras", Workflows: "workflows", TextualInversion: "embeddings",
  VAE: "vae", Controlnet: "controlnet", Checkpoint: "checkpoints",
};

export function civitaiDownloadSubfolder(type) {
  return SUBFOLDER[type] || "checkpoints";
}

/** Strip CivitAI description HTML to the text the lightbox shows. Pure — no DOM. */
export function htmlToPlain(html) {
  if (typeof html !== "string" || !html) return null;
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return text || null;
}

function capNote(text) {
  if (!text) return null;
  return text.length > CIVITAI_NOTE_CAP ? text.slice(0, CIVITAI_NOTE_CAP) + "…" : text;
}

function copyHashes(h) {
  if (!h || typeof h !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function serializeFile(f) {
  if (!f) return null;
  return {
    id: f.id ?? null,
    name: f.name || "",
    sizeKB: f.sizeKB ?? null,
    type: f.type || null,
    format: f.format || null,
    primary: f.primary === true,
    pickleScanResult: f.pickleScanResult || null,
    virusScanResult: f.virusScanResult || null,
    hashes: copyHashes(f.hashes),
  };
}

function earlyAccessFrom(v) {
  if (!v) return null;
  const cfg = v.earlyAccessConfig && typeof v.earlyAccessConfig === "object"
    ? v.earlyAccessConfig : null;
  return {
    availability: v.availability || null,
    endsAt: v.earlyAccessEndsAt || null,
    chargeForDownload: cfg && typeof cfg.chargeForDownload === "boolean" ? cfg.chargeForDownload : null,
    downloadPrice: cfg && cfg.downloadPrice != null ? cfg.downloadPrice : null,
    timeframe: cfg && cfg.timeframe != null ? cfg.timeframe : null,
  };
}

/** One media row — same gated contract as serializeCivitaiResults (mcp#623). */
function serializeMediaItem(x) {
  if (!x) return null;
  const gated = x.gated === true || !x.thumbnailUrl;
  return {
    id: x.id,
    kind: x.type === "video" ? "video" : "image",
    creator: x.author || null,
    baseModel: x.modelName || null,
    type: x.type || null,
    stats: { reactions: x.reactions ?? null },
    urls: [x.thumbnailUrl, x.fullUrl].filter(Boolean),
    gated,
  };
}

function serializeVersionChip(v, selectedId) {
  return {
    id: v.id,
    name: v.name || null,
    baseModel: v.baseModel || null,
    selected: v.id === selectedId,
  };
}

function serializeSelectedVersion(v) {
  if (!v) return null;
  const files = Array.isArray(v.files) ? v.files.map(serializeFile).filter(Boolean) : [];
  return {
    id: v.id,
    name: v.name || null,
    baseModel: v.baseModel || null,
    fileName: v.fileName || null,
    trainedWords: Array.isArray(v.trainedWords) ? [...v.trainedWords] : [],
    files,
    earlyAccess: earlyAccessFrom(v),
  };
}

function serializeModel(view, { forDownload } = {}) {
  const detail = view.detail;
  const version = view.version;
  if (view.loading || !detail) {
    return {
      open: true,
      kind: "model",
      loading: true,
      id: view.id ?? null,
      title: view.title || null,
      type: view.type || null,
      creator: view.creator || null,
      creatorNote: null,
      versions: [],
      selectedVersion: null,
      downloadTarget: null,
      examples: [],
    };
  }
  const selected = version || (Array.isArray(detail.versions) ? detail.versions[0] : null);
  const versions = Array.isArray(detail.versions)
    ? detail.versions.map((v) => serializeVersionChip(v, selected?.id))
    : [];
  const noteHtml = selected?.descriptionHtml || detail.descriptionHtml || null;
  const creatorNote = capNote(htmlToPlain(noteHtml));
  const type = detail.type || null;
  const out = {
    open: true,
    kind: "model",
    loading: false,
    id: detail.id,
    title: detail.name || view.title || null,
    type,
    creator: detail.creator || view.creator || null,
    creatorNote,
    versions,
    selectedVersion: serializeSelectedVersion(selected),
    downloadTarget: selected ? {
      model_id: detail.id,
      model_version_id: selected.id,
      versionName: selected.name || null,
      type,
      subfolder: civitaiDownloadSubfolder(type),
      fileName: selected.fileName || null,
    } : null,
    examples: [],
  };
  if (!forDownload && selected && Array.isArray(selected.examples)) {
    out.examples = selected.examples.slice(0, CIVITAI_LIGHTBOX_EXAMPLES).map(serializeMediaItem);
  }
  return out;
}

function serializeMedia(view) {
  const item = view.item;
  if (!item) {
    return { open: true, kind: "media", loading: true, id: view.id ?? null, item: null };
  }
  return {
    open: true,
    kind: "media",
    loading: false,
    id: item.id,
    title: item.author ? `@${item.author}` : null,
    creator: item.author || null,
    index: Number.isFinite(view.index) ? view.index : null,
    total: Number.isFinite(view.total) ? view.total : null,
    more: view.done === false,
    item: serializeMediaItem(item),
  };
}

/**
 * Snapshot the live lightbox for the agent. `view` is the pane's in-memory
 * object (`{open:false}` when nothing is open); never a CivitAI HTTP body.
 *
 * `forDownload: true` drops the examples grid — the "Ask agent to download"
 * payload carries identity, version ladder, files, and the creator note
 * (issue items 1–4), not the examples (item 5).
 */
export function serializeCivitaiLightbox(view, { forDownload = false } = {}) {
  if (!view || view.open !== true) return { open: false };
  if (view.kind === "media") return serializeMedia(view);
  if (view.kind === "model") return serializeModel(view, { forDownload });
  return { open: false };
}
