/**
 * #584/#611 — detect and heal a STALE PANEL BUNDLE.
 *
 * The pack on disk can be current while the browser tab keeps running a CACHED
 * older bundle: ComfyUI serves the extension web dir with plain static-file
 * semantics, so heuristic freshness lets an old module graph survive a backend
 * restart, a reconnect, and even a plain page reload. The stale bundle then
 * advertises its old (or no) capabilities in the bridge hello, and the
 * orchestrator's write fence refuses every mutation with "does not enforce
 * per-command workflow targeting (detected panel version unknown)".
 *
 * The only actor that can fix a cached bundle is the bundle itself: probe the
 * backend for the INSTALLED pack version, and when it provably differs from
 * the running PANEL_VERSION, force-revalidate the pack's whole module graph
 * (fetch with cache:"reload" walks the static import graph) and reload the
 * page once, guarded against reload loops by the caller's sessionStorage
 * marker.
 *
 * These helpers are PURE / dependency-injected (no DOM, no ComfyUI globals) so
 * the verdict and the crawl are unit-testable without a browser.
 */

/**
 * The staleness verdict for the running bundle versus the installed pack.
 *
 *   "current" — both versions are well-formed and EQUAL: nothing to do.
 *   "stale"   — both versions are well-formed and DIFFER: the browser is
 *               provably running a different bundle than the pack on disk
 *               (upgrade OR downgrade — the heal is the same reload).
 *   "unknown" — either side is missing/malformed (old backend without the
 *               version route, unreadable pyproject, non-string payload).
 *               Fail-open: NEVER trigger a reload on an unreadable probe —
 *               a reload decided on absent evidence is a reload loop waiting
 *               for one failed fetch.
 */
export function resolveBundleStaleness({ running, installed } = {}) {
  const ok = (v) => typeof v === "string" && v.trim().length > 0;
  if (!ok(running) || !ok(installed)) return "unknown";
  return running.trim() === installed.trim() ? "current" : "stale";
}

/**
 * Extract RELATIVE module specifiers ("./x.js", "../y.js") from a module's
 * static import/export statements AND its literal dynamic import("...") calls
 * (e.g. cmcp-a2ui-lit-adapter.js's lazily-loaded vendor bundle — omitting it
 * would leave a real module stale after an update, a mixed bundle). A dynamic
 * import with a computed (non-literal) specifier is not parseable by this
 * syntax scan. Bare specifiers ("/scripts/app.js", "lit", …) are skipped —
 * they resolve outside the pack's web dir and are not this pack's cache
 * problem.
 */
export function collectRelativeImportSpecifiers(source) {
  if (typeof source !== "string" || !source) return [];
  const out = [];
  const push = (spec) => {
    if (spec.startsWith("./") || spec.startsWith("../")) out.push(spec);
  };
  // import ... from "spec" | import "spec" | export ... from "spec" — including
  // MINIFIED forms with no whitespace around the braces/from (import{x}from"./a";
  // codex gate round 4): the crawl must find dependencies in any legal spelling,
  // or a minified module's children stay stale through the one-shot heal.
  const staticRe = /(?:^|[;\n\r])\s*(?:import(?:[^'";]*?from)?|export[^'";]*?from)\s*["']([^"']+)["']/g;
  // import("spec") — literal dynamic imports only
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = staticRe.exec(source)) !== null) push(m[1]);
  while ((m = dynamicRe.exec(source)) !== null) push(m[1]);
  return out;
}

/**
 * Force-revalidate the pack's ENTIRE static module graph in the browser HTTP
 * cache, starting at `entryUrl` (the panel's import.meta.url). Each module is
 * fetched THROUGH `fetchImpl` with `{ cache: "reload" }` as the second
 * argument — bypassing the cached copy and storing the fresh response — so
 * the page reload that follows re-imports the NEW modules instead of the
 * stale ones a normal reload would keep. The cache mode is fixed HERE, not
 * left to the caller, because forced revalidation is the entire point of the
 * prime; `fetchImpl` may layer its own options (credentials) on top.
 *
 * The crawl stays INSIDE the pack's web dir (the entry's own directory): a
 * root-relative or bare import belongs to ComfyUI core, not this pack. Cyclic
 * imports are visited once; `maxModules` bounds the work.
 *
 * Returns { primed, failed, truncated }. A module that fails to fetch is
 * collected in `failed` rather than thrown: the caller decides whether a
 * partial prime is worth reloading over (a half-refreshed module graph is no
 * worse than the fully stale one it replaces, but the caller may prefer to
 * keep the old graph and tell the user to hard-refresh).
 */
export async function primeModuleCache({ entryUrl, fetchImpl, maxModules = 400 } = {}) {
  const primed = [];
  const failed = [];
  if (typeof entryUrl !== "string" || !entryUrl || typeof fetchImpl !== "function") {
    return { primed, failed, truncated: false };
  }
  const entryDir = new URL(".", entryUrl).toString();
  const seen = new Set();
  const queue = [entryUrl];
  let truncated = false;
  while (queue.length) {
    if (seen.size >= maxModules) {
      truncated = true;
      break;
    }
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    let text;
    try {
      const res = await fetchImpl(url, { cache: "reload" });
      if (!res || res.ok === false || typeof res.text !== "function") {
        failed.push(url);
        continue;
      }
      text = await res.text();
    } catch {
      failed.push(url);
      continue;
    }
    primed.push(url);
    for (const spec of collectRelativeImportSpecifiers(text)) {
      try {
        const child = new URL(spec, url).toString();
        if (child.startsWith(entryDir) && !seen.has(child)) queue.push(child);
      } catch {
        // An unparseable specifier contributes nothing — skip it.
      }
    }
  }
  return { primed, failed, truncated };
}
