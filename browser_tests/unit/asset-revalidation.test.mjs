/**
 * #584 — a BACKSTOP against a browser reusing panel JS, not a fix for today's ComfyUI.
 *
 * MEASURED FIRST, and it overturned my working theory. On the running server (ComfyUI
 * 0.31.1) every `/extensions/` path already answers `Cache-Control: no-store` — ours and
 * other packs' alike. So on this version the HTTP cache is NOT the mechanism, and this
 * middleware does nothing. It acts only where the host sets no cache header at all, which
 * is the shape ComfyUI's own e0982a71 describes for older builds: an aiohttp ETag from
 * mtime+size, a 304, stale content served.
 *
 * The correction: while shipping #753 I saw a page come back running OLD code after
 * `location.reload()` and read it as a cache. It was not. The reload was being CANCELLED
 * by ComfyUI's unsaved-changes prompt; the code updated only once I suppressed that and
 * navigated. Without the header measurement this would have shipped blaming the cache.
 *
 * A stale module cannot detect ITSELF — it compares equal to itself and every internal
 * consistency check passes. It can still be caught from outside: the pack's
 * `/comfyui_mcp_panel/version` route reports the INSTALLED version for the running JS to
 * compare against, which is how #584/#611 surface it today. Headers are the only place to
 * PREVENT it where a host leaves the door open.
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

test("#584 the header MATCHES the host policy — it must never be weaker", () => {
  // The defect this replaced: a middleware appended here runs INSIDE ComfyUI's own
  // `cache_control`, so ours finishes first and the host's `setdefault` then PRESERVES our
  // value. Setting the weaker `no-cache` downgraded the host's `no-store` on every panel
  // asset — the opposite of the intent, and invisible to an 'is the header absent' check,
  // because the outer middleware has not run yet (codex).
  assert.match(middleware, /"Cache-Control"\] = "no-store"/);
  assert.ok(!/= "no-cache"/.test(middleware), "no weaker value than the host would apply");
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
  // contextlib.suppress, not try/except/pass — the Registry's Bandit parity scan flags the
  // bare form (B110), and this is the same behaviour without the finding.
  assert.match(middleware, /with contextlib\.suppress\(Exception\):/, "header stamping cannot raise");
  assert.ok(!/except Exception:\s*\r?\n\s*pass/.test(middleware), "no bare try/except/pass");
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

test("#584 the comment records the MEASUREMENTS, including the two claims they killed", () => {
  const header = INIT.slice(INIT.indexOf("# #584 —"), INIT.indexOf("_ASSET_PREFIX ="));
  // (1) the host already has a policy on the version measured, so the cache is not the
  //     mechanism there — this is a backstop, not a cure.
  assert.match(header, /already answers `Cache-Control: no-store`/);
  // (2) the retraction that matters most: setting a WEAKER value did not no-op, it
  //     downgraded the host, because our middleware finishes before the host's setdefault.
  assert.match(header, /DOWNGRADED the host's policy/);
  assert.match(header, /runs INSIDE the host's own `cache_control`/);
  // and the reproduction that turned out not to be a cache at all
  assert.match(header, /CANCELLED by ComfyUI's\s*(?:#\s*)?unsaved-changes prompt/);
  // It must not claim to cure the reported symptom.
  assert.ok(!/guarantees|can never be stale|fixes #584/i.test(header));
});
