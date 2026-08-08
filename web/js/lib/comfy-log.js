/**
 * Read ComfyUI's raw log feed.
 *
 * NOT via `api.fetchApi`. That prefixes every route with `/api`, and this
 * endpoint does not live there — measured in a real browser against a live
 * ComfyUI 0.30.2:
 *
 *     api.fetchApi("/internal/logs/raw")        ->  /api/internal/logs/raw   404
 *     fetch(api.fileURL("/internal/logs/raw"))  ->  /internal/logs/raw       200
 *
 * Both features that read this log shipped calling `fetchApi`, and were therefore
 * SILENT NO-OPS in a browser: the save-failure cause always reported "could not
 * be read", and the failed-import note never appeared. Their unit tests passed
 * because they inject a fake `fetchApi` that does no URL rewriting — the wiring
 * was tested and the TRANSPORT was not. Nothing short of loading the shipped
 * module in a real page would have caught it.
 *
 * `api.fileURL` is preferred over a bare "/internal/logs/raw" so a ComfyUI
 * mounted under a base path still resolves.
 *
 * @param {{ fileURL?: (route: string) => string }} api
 * @returns {Promise<string>} the joined log text, or "" when it cannot be read
 */
export async function readComfyLogText(api) {
  try {
    const route = "/internal/logs/raw";
    const url = typeof api?.fileURL === "function" ? api.fileURL(route) : route;
    const res = await fetch(url, { cache: "no-store" });
    if (!res || !res.ok) return "";
    const body = await res.json().catch(() => null);
    const entries = Array.isArray(body) ? body : Array.isArray(body?.entries) ? body.entries : null;
    if (entries) {
      return entries.map((e) => (typeof e === "string" ? e : (e?.m ?? ""))).join("\n");
    }
    if (typeof body === "string") return body;
    return "";
  } catch {
    // This runs while explaining a failure. Returning "" keeps the caller on its
    // "could not be read" branch, which is already worded for exactly this.
    return "";
  }
}
