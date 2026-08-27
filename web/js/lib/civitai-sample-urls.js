/**
 * #1958 / #623 — make civitai_results URLs fetchable as sample thumbnails.
 *
 * The orchestrator (`panel_civitai_results`) fetches the top non-gated
 * `urls[0]` and returns them as inline IMAGE blocks. It ONLY accepts a
 * root-absolute same-origin path of exactly `/comfyui_mcp_panel/civitai/media`.
 *
 * The pane's `CivitaiClient.mediaUrl` goes through ComfyUI's `api.apiURL()`,
 * which prefixes `/api` and often the origin. Serialized as-is, every sample
 * URL is skipped (full URL fails the leading-`/` guard; `/api/...` fails the
 * exact-path check) and the promised IMAGE blocks never arrive — even when
 * every result is `gated:false`.
 *
 * Rewrite recognised proxy URLs to that exact path (+ query). Anything else
 * is passed through so tests and non-proxy thumbs keep their existing shape.
 *
 * Also emit a `pageUrl` the agent can open outside the pane (civitai.com
 * model/image page). The proxy thumbs alone cannot produce that link.
 */

export const CIVITAI_MEDIA_PROXY_PATH = "/comfyui_mcp_panel/civitai/media";

function splitPathAndSearch(raw) {
  if (typeof raw !== "string" || !raw) return null;
  if (raw.startsWith("//") || raw.includes("\\")) return null;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
      const u = new URL(raw);
      return { pathname: u.pathname, search: u.search };
    }
    if (raw.startsWith("/")) {
      const u = new URL(raw, "http://civitai.panel.local");
      return { pathname: u.pathname, search: u.search };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * If `raw` is the pane's CivitAI media proxy (origin, `/api` prefix, or
 * already root-absolute), return the orchestrator-fetchable path+query.
 * Otherwise return `raw` unchanged (or null for empty/non-string).
 */
export function civitaiProxyMediaPath(raw) {
  if (typeof raw !== "string" || !raw) return null;
  // Fail closed on the same shapes the orchestrator refuses (protocol-relative
  // and backslash-authority). Passing them through would leave a URL that
  // looks like a path (`//host` starts with `/`) in the serialized reply.
  if (raw.startsWith("//") || raw.includes("\\")) return null;
  const parts = splitPathAndSearch(raw);
  if (!parts) return raw;
  const stripped = parts.pathname.replace(/^\/api(?=\/)/, "");
  if (stripped !== CIVITAI_MEDIA_PROXY_PATH) return raw;
  return stripped + parts.search;
}

export function normalizeCivitaiResultUrls(urls) {
  if (!Array.isArray(urls)) return [];
  const out = [];
  for (const u of urls) {
    const n = civitaiProxyMediaPath(u);
    if (n) out.push(n);
  }
  return out;
}

/** Public CivitAI page for a serialized result. Models use /models/{id};
 *  images and videos use /images/{id} (CivitAI's media route). */
export function civitaiPageUrl({ kind, id } = {}) {
  if (id == null || id === "") return null;
  const n = String(id);
  if (!n || n === "undefined" || n === "null") return null;
  if (kind === "model") return `https://civitai.com/models/${n}`;
  if (kind === "image" || kind === "video") return `https://civitai.com/images/${n}`;
  return null;
}
