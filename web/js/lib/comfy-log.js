// #1180 — the repo's one bounded-step primitive.
import { withTimeout } from "./bounded-step.js";

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
/**
 * #1180 — how long the log read may take before it gives up and says nothing.
 *
 * This runs while EXPLAINING a refusal, on the same server whose half-open connection is
 * the reason the refusal is being written. Unbounded, it inherits that stall: the catch
 * below handles a fetch that FAILS, but a fetch that never settles is not caught by
 * anything, so `graph_add_node` parked here after every other fetch on that path had been
 * bounded. A diagnostic must never outlive the thing it is diagnosing.
 *
 * Short on purpose. The log is a nicety that sharpens a message the caller can already
 * write without it, so waiting is worth less here than anywhere else on this path.
 */
export const COMFY_LOG_READ_TIMEOUT_MS = 3000;

export async function readComfyLogText(api, { timeoutMs = COMFY_LOG_READ_TIMEOUT_MS } = {}) {
  try {
    const route = "/internal/logs/raw";
    const url = typeof api?.fileURL === "function" ? api.fileURL(route) : route;
    // ONE bound over the WHOLE read — headers AND body.
    //
    // Bounding `fetch` alone did not bound this call. `fetch` resolves as soon as the
    // response HEAD arrives; the bytes stream afterwards, inside `res.json()`. So a server
    // that sent headers and then stopped — the half-open case this whole issue is about —
    // parked on the body read exactly as it did before there was any bound here, and the
    // constant above claimed to cover a read it covered a fraction of.
    const body = await withTimeout(
      Promise.resolve()
        .then(async () => {
          const res = await fetch(url, { cache: "no-store" });
          return res?.ok ? await res.json() : null;
        })
        .catch(() => null),
      timeoutMs,
      () => null,
    );
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
