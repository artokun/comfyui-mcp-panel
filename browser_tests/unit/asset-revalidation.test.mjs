/**
 * #584 — a reload that keeps running the OLD panel JS.
 *
 * Reproduced on a dev machine while shipping #753, which is why this exists as a fix rather
 * than more instrumentation: after editing the panel source, `location.reload()` brought the
 * page back with the extension registered and the panel rendered — running the OLD code.
 * Fetching the same URL returned the NEW bytes while the live stylesheet still held the OLD
 * rules. Getting the new code needed `fetch(url, {cache:'reload'})` per file plus a
 * navigation with a changed query string.
 *
 * The reported shape is the same: an installed 0.11.38 with a tab running 0.11.34, surviving
 * a ComfyUI restart and `panel_reload(scope:'frontend')`, cleared only by Ctrl+Shift+R.
 *
 * A stale module cannot be detected from inside the page — it compares equal to itself and
 * every consistency check it can run passes. The only place it can be PREVENTED is the
 * response headers, which is what these tests pin.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const INIT = readFileSync(new URL("../../__init__.py", import.meta.url), "utf8");

/** The middleware body, so an assertion cannot pass by matching prose elsewhere. */
const middleware = (() => {
  const start = INIT.indexOf("def _install_no_cache_middleware(");
  assert.ok(start > 0, "the middleware installer exists");
  const end = INIT.indexOf("\ndef ", start + 1);
  return INIT.slice(start, end === -1 ? undefined : end);
})();

test("#584 panel assets are told to REVALIDATE, not to skip the cache", () => {
  // no-cache: the browser may keep the file but must ask before reusing it.
  assert.match(middleware, /"Cache-Control"\] = "no-cache"/);
  // no-store would forbid caching entirely and re-download every module on every load, for
  // a pack that ships 100+ of them. Revalidation costs a conditional request and answers
  // 304 when nothing changed — ComfyUI already serves an ETag from mtime+size.
  assert.ok(!/no-store/.test(middleware), "never no-store — that is a different, worse trade");
});

test("#584 it is scoped to THIS pack's assets", () => {
  assert.match(INIT, /_ASSET_PREFIX = "\/extensions\/comfyui-mcp-panel\/"/);
  assert.match(middleware, /request\.path\.startswith\(_ASSET_PREFIX\)/);
  // A middleware runs for every request the host serves. Stamping anything wider would
  // change caching for ComfyUI itself, which is not ours to decide.
  assert.ok(!/startswith\("\/"\)/.test(middleware));
});

test("#584 a header the host already set is left alone", () => {
  // If ComfyUI (or another pack) deliberately set Cache-Control for a path of ours, it wins.
  // Overwriting it would make this a policy override rather than a default.
  assert.match(middleware, /if not response\.headers\.get\("Cache-Control"\):/);
});

test("#584 a cache header can never break a response or the panel load", () => {
  // Three independent failure paths, each swallowed:
  //   - no PromptServer / no app (headless host)
  //   - aiohttp FREEZES middlewares once the app starts; a host that imports packs late
  //     would raise on append
  //   - anything thrown while stamping the header itself
  assert.match(middleware, /except Exception as _e:.*\r?\n\s*_log\("asset revalidation not installed \(no app\)/);
  // The append must sit INSIDE a try. A mutant that removed the try survived an earlier
  // version of this test: the file is read as text, so an arrangement that would not even
  // parse as Python still matched a bare "append(...)" assertion.
  assert.match(
    middleware,
    /try:\s*\r?\n(?:[^\n]*\r?\n){0,8}?\s*app\.middlewares\.append\(_revalidate_panel_assets\)/,
    "the append is guarded",
  );
  assert.match(middleware, /except Exception as _e:.*\r?\n\s*_log\("asset revalidation not installed:/);
  assert.match(middleware, /except Exception:\s*#[^\n]*\r?\n\s*pass/, "header stamping cannot raise");
  // and it returns the response either way
  assert.match(middleware, /return response/);
});

test("#584 the installer is actually CALLED during registration", () => {
  // A middleware that is defined and never installed is the same as no middleware, and
  // would still pass every assertion above.
  const reg = INIT.slice(INIT.indexOf("def _register_routes():"));
  assert.match(reg, /_install_no_cache_middleware\(web\)/);
  // Registration order: after the routes, before the "registered" log line, so a failure to
  // install is visible in the same place a user already looks for panel startup problems.
  const call = reg.indexOf("_install_no_cache_middleware(web)");
  const log = reg.indexOf('_log("agent panel routes registered');
  assert.ok(call > 0 && log > call, "installed before the completion log");
});

test("#584 the comment records the measurement, not a guess", () => {
  const header = INIT.slice(INIT.indexOf("# #584 —"), INIT.indexOf("_ASSET_PREFIX ="));
  assert.match(header, /Reproduced on a dev machine/, "this was observed, not theorised");
  assert.match(header, /compares equal to itself/, "why the page cannot self-diagnose");
  assert.match(header, /ETag/, "and why revalidation is cheap here");
  // It must not promise the thing headers cannot deliver: a tab that is ALREADY stale still
  // has to revalidate once before it can notice.
  assert.ok(!/guarantees|can never be stale/i.test(header));
});
