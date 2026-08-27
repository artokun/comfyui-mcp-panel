/**
 * #1958 — CivitAI browser tab catalog + empty-grid type attribution.
 *
 * The docked browser's tab enum used to be images/videos/checkpoints/loras/
 * workflows/favorites. CivitAI's model `type` is a different vocabulary
 * (Checkpoint, LORA, Upscaler, TextualInversion, Poses, …). Upscaler mapped
 * to none of those tabs, so a checkpoints search for "ESRGAN upscaler" came
 * back as an honest-looking total:0 and the agent concluded "no upscalers
 * exist on CivitAI".
 *
 * This module is the single list of tabs the pane actually has, the CivitAI
 * type each one searches, and the note a ZERO-result reply must carry so a
 * total:0 cannot be read as "that type does not exist".
 */
import { summarizeSearchFilters } from "./civitai-search-echo.js";

/** One row per pane tab. `model` is the CivitAI /v1/models `types=` value;
 *  `media` is the images/videos feed type; `fav` is the likes collection. */
export const CIVITAI_TAB_DEFS = Object.freeze([
  { key: "images", media: "image" },
  { key: "videos", media: "video" },
  { key: "checkpoints", model: "Checkpoint", subfolder: "checkpoints" },
  { key: "loras", model: "LORA", subfolder: "loras" },
  { key: "upscalers", model: "Upscaler", subfolder: "upscale_models" },
  { key: "embeddings", model: "TextualInversion", subfolder: "embeddings" },
  { key: "poses", model: "Poses", subfolder: "poses" },
  { key: "workflows", model: "Workflows", subfolder: "workflows" },
  { key: "favorites", media: "image", fav: true },
]);

/** CivitAI /v1/models types that still have no pane tab. Named in empty-grid
 *  notes so a total:0 cannot be read as "CivitAI does not have these". */
export const CIVITAI_UNTABBED_TYPES = Object.freeze([
  "VAE", "Controlnet", "LoCon", "DoRA", "Hypernetwork", "MotionModule",
  "Wildcards", "AestheticGradient", "Detection", "Other",
]);

const TAB_BY_KEY = new Map(CIVITAI_TAB_DEFS.map((t) => [t.key, t]));

/** Loose aliases an agent (or a human) might pass instead of the exact key. */
const TAB_ALIASES = Object.freeze({
  image: "images",
  images: "images",
  video: "videos",
  videos: "videos",
  checkpoint: "checkpoints",
  checkpoints: "checkpoints",
  lora: "loras",
  loras: "loras",
  upscaler: "upscalers",
  upscalers: "upscalers",
  embedding: "embeddings",
  embeddings: "embeddings",
  textualinversion: "embeddings",
  pose: "poses",
  poses: "poses",
  workflow: "workflows",
  workflows: "workflows",
  favorite: "favorites",
  favorites: "favorites",
  favourite: "favorites",
  favourites: "favorites",
});

export function civitaiTabCatalog() {
  return CIVITAI_TAB_DEFS.map((t) => ({
    key: t.key,
    kind: t.model ? "model" : (t.fav ? "favorites" : "media"),
    type: t.model || t.media,
    ...(t.subfolder ? { subfolder: t.subfolder } : {}),
  }));
}

export function civitaiKnownTabKeys() {
  return CIVITAI_TAB_DEFS.map((t) => t.key);
}

/** Resolve a caller-supplied tab key (exact, or a known alias) to a catalog
 *  key. Unknown values return null — the pane must not silently fall through
 *  to a different type. */
export function resolveCivitaiTab(key) {
  if (key == null || key === "") return null;
  const raw = String(key);
  if (TAB_BY_KEY.has(raw)) return raw;
  const compact = raw.toLowerCase().replace(/[\s_-]+/g, "");
  const mapped = TAB_ALIASES[compact];
  return mapped && TAB_BY_KEY.has(mapped) ? mapped : null;
}

export function civitaiTabDef(key) {
  const resolved = resolveCivitaiTab(key);
  return resolved ? TAB_BY_KEY.get(resolved) : undefined;
}

export function civitaiVisibleType(tab) {
  const t = civitaiTabDef(tab);
  return t ? (t.model || t.media || null) : null;
}

export function civitaiUnseenTypes(tab) {
  const visible = civitaiVisibleType(tab);
  const out = [];
  const seen = new Set();
  for (const ty of [
    ...CIVITAI_TAB_DEFS.map((t) => t.model || t.media),
    ...CIVITAI_UNTABBED_TYPES,
  ]) {
    if (!ty || ty === visible || seen.has(ty)) continue;
    seen.add(ty);
    out.push(ty);
  }
  return out;
}

/**
 * Empty-grid attribution. Emitted only when the reply would otherwise look
 * like "nothing matched": total is 0, no upstream error, not still loading.
 * Names the type THIS tab searches and every type it cannot see (with the
 * tab key that can, when one exists).
 */
export function civitaiTypeNote({ tab, total, error, loading } = {}) {
  if (loading) return undefined;
  if (error) return undefined;
  if (Number(total) !== 0) return undefined;
  const resolved = resolveCivitaiTab(tab) || "images";
  const t = TAB_BY_KEY.get(resolved) || CIVITAI_TAB_DEFS[0];
  const visible = t.model || t.media || t.key;
  const otherTabs = CIVITAI_TAB_DEFS
    .filter((x) => x.key !== t.key)
    .map((x) => `${x.model || x.media} (tab: ${x.key})`)
    .join(", ");
  return (
    `This tab (${t.key}) only searches CivitAI type "${visible}". ` +
    `It cannot see: ${otherTabs}. ` +
    `Types with no tab: ${CIVITAI_UNTABBED_TYPES.join(", ")}. ` +
    `total:0 here is NOT evidence those types have no matches on CivitAI — ` +
    `switch tab (or search CivitAI by type) before concluding they do not exist.`
  );
}

/**
 * Open-receipt shape. `panel_civitai_search` already echoes tab/query/filters;
 * `panel_open_civitai` used to return a bare `{ok:true}` with no applied state.
 */
export function summarizeOpenCivitai({
  tab, query, filters, browsingLevels, docked, renderRev, creator,
} = {}) {
  const resolved = resolveCivitaiTab(tab) || "images";
  const q = typeof query === "string" ? query : "";
  const modelTab = !!civitaiTabDef(resolved)?.model;
  const filterState = {
    ...(filters && typeof filters === "object" ? filters : {}),
  };
  if (Array.isArray(browsingLevels)) filterState.browsingLevels = [...browsingLevels];
  const echoed = summarizeSearchFilters({
    filters: filterState,
    query: q,
    modelTab,
  });
  return {
    ok: true,
    tab: resolved,
    query: q,
    creator: creator ?? filterState.username ?? null,
    docked: docked !== false,
    renderRev: Number.isFinite(Number(renderRev)) ? Number(renderRev) : 0,
    tabs: civitaiTabCatalog(),
    visibleType: civitaiVisibleType(resolved),
    ...echoed,
  };
}

/**
 * Clear-highlight receipt. Used to be a bare `{ok:true}` with no count, so
 * the agent could not tell "cleared 3" from "there was nothing to clear".
 */
export function summarizeClearHighlight({ cleared = 0, renderRev } = {}) {
  const n = Number(cleared);
  return {
    ok: true,
    cleared: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    renderRev: Number.isFinite(Number(renderRev)) ? Number(renderRev) : 0,
  };
}
