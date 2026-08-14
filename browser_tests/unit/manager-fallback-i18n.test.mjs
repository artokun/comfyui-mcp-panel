/**
 * #423 — translating an error message must not disarm the fallback that reads it.
 *
 * `panel_list_nodes` and `panel_search_nodes` carry a ladder of fallbacks for the
 * ComfyUI-Manager dialects: retry the absolute (no-/v2) legacy route, self-heal a stale
 * dialect (#605), and finally search installed nodes via `/object_info` (#426). Every rung
 * is gated on `isManagerUnreachable(err)`, which asks the question by matching the English
 * words "not reachable" in the message.
 *
 * The message it reads is produced by `classifyManager404`, which runs it through `tr()`.
 *
 * So on any non-English panel the gate never matches, every rung is skipped, and the
 * generic "Manager not reachable" surfaces — while the Manager is running and answering.
 * That is #423's recurrence on panel 0.14.36: the reporter's error arrived in Japanese, and
 * their `/customnode/installed` was one dead `if` away from being tried.
 *
 * The tests below use the SHIPPED locale catalogues rather than synthetic ones. A synthetic
 * catalogue would prove the mechanism but not that it fires for a real user, and the
 * reporter's exact string is the evidence that it does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { tr, __setCatalogForTest } from "../../web/js/lib/i18n.js";
import { classifyManager404 } from "../../web/js/lib/manager-404.js";
import { isManagerUnreachable } from "../../web/js/lib/manager-install.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The shipped file is namespaced, and `loadCatalog` installs `all[locale][NS]` — so the
 *  test must strip the same layer, or every lookup misses and the suite silently measures
 *  the English fallback instead of the translation. (It did, on the first run; the
 *  "tr() is genuinely in the path" test below exists to keep that from passing quietly.) */
const NS = "comfyuiMcpPanel";
const catalogFor = (locale) => {
  const file = JSON.parse(readFileSync(join(ROOT, "locales", locale, "main.json"), "utf8"));
  const inner = file?.[NS];
  assert.ok(inner, `locales/${locale}/main.json must be namespaced under ${NS}`);
  return inner;
};

/** Rebuild the error exactly as managerV2/managerCall do on a route-missing 404. */
const errorForRouteMissing404 = () => {
  const { routeMissing, message } = classifyManager404("");
  const err = new Error(message);
  if (routeMissing) err.managerRouteMissing = true;
  else err.managerSecurityRefusal = true;
  return err;
};

test.afterEach(() => __setCatalogForTest("en", {}));

test("the reporter's exact Japanese string is what the panel produces", () => {
  // Anchors the whole investigation: this is the string from the #423 recurrence,
  // reproduced from the shipped catalogue rather than assumed.
  __setCatalogForTest("ja", catalogFor("ja"));
  assert.equal(
    errorForRouteMissing404().message,
    "ComfyUI-Manager に接続できません（内蔵 Manager は有効になっていますか？）",
  );
});

test("a route-missing 404 stays recognisable in EVERY shipped locale", () => {
  const locales = readdirSync(join(ROOT, "locales"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(locales.length > 1, "more than English must be shipped for this to mean anything");

  const blind = [];
  for (const locale of locales) {
    __setCatalogForTest(locale, catalogFor(locale));
    const err = errorForRouteMissing404();
    // The claim under test: the fallback ladder can still read this error.
    if (!isManagerUnreachable(err)) blind.push({ locale, message: err.message });
  }
  assert.deepEqual(
    blind,
    [],
    "these locales silently disable every Manager fallback:\n" +
      blind.map((b) => `  ${b.locale}: ${b.message}`).join("\n"),
  );
});

test("the verdict does not depend on the WORDING at all", () => {
  // The durable form of the above. Even a locale that has not been written yet — or a
  // reworded English message — must not change the answer, because the fact being asked
  // about (the route 404'd) is structural and was known before any text was composed.
  // NS-stripped, like catalogFor above — `__setCatalogForTest` takes what
  // `loadCatalog` installs, not the file layout.
  __setCatalogForTest("xx", {
    manager_404: { comfyui_manager_not_reachable_is_the_built: "🙈" },
  });
  const err = errorForRouteMissing404();
  assert.equal(err.message, "🙈", "the catalogue is live");
  assert.ok(isManagerUnreachable(err), "a fallback gate must not read prose");
});

test("the security refusal is still NOT treated as unreachable, in any locale", () => {
  // The #706 distinction must survive the fix. A security refusal means a handler RAN and
  // declined; retrying it on another dialect re-sends an operation the Manager already
  // processed. Only the route-missing branch may open the fallback ladder.
  for (const locale of ["en", "ja", "fr"]) {
    __setCatalogForTest(locale, catalogFor(locale));
    const { routeMissing, message } = classifyManager404(
      "A security error has occurred. Please check the terminal logs",
    );
    assert.equal(routeMissing, false, `${locale}: a security refusal is not route-missing`);
    const err = new Error(message);
    err.managerSecurityRefusal = true;
    assert.ok(!isManagerUnreachable(err), `${locale}: a refusal must not authorise a fallback`);
  }
});

test("a security refusal is refused even when the UPSTREAM body says 'not reachable'", () => {
  // The sharp version of the test above. `summarizeManagerBody` embeds up to 300
  // characters of the Manager's own body into the message, so the words in it are
  // upstream text, not ours. Before this fix the #706 invariant held only because that
  // text happened never to contain "not reachable" — a guarantee nobody could make.
  __setCatalogForTest("en", {});
  const { routeMissing, message } = classifyManager404(
    "A security error has occurred. The registry endpoint is not reachable from this host. " +
      "Please check the terminal logs",
  );
  assert.equal(routeMissing, false, "still classified as a refusal, not a missing route");
  const err = new Error(message);
  err.managerSecurityRefusal = true;
  assert.match(err.message, /not reachable/i, "the hostile phrase really is in the message");
  assert.ok(
    !isManagerUnreachable(err),
    "a handler ran and declined — the fallback ladder must stay shut whatever the body says",
  );
});

test("a security refusal VETOES the tags, not the other way round", () => {
  // The call sites set exactly one of these today (`if (routeMissing) … else …`), so an
  // error carrying both is not reachable from current code. The precedence is still a
  // decision worth stating: "a handler ran and declined" is the fact that must win,
  // because acting on the other one re-sends work the Manager already processed. Pinning
  // it means a future path that tags an error it re-throws cannot quietly invert it.
  __setCatalogForTest("en", {});
  for (const tag of ["managerRouteMissing", "managerTransportUnreachable"]) {
    const err = new Error("...");
    err.managerSecurityRefusal = true;
    err[tag] = true;
    assert.ok(!isManagerUnreachable(err), `${tag} must not override a refusal`);
  }
});

test("a TAGGED transport failure opens the ladder whatever its message says", () => {
  // The other direction: the transports' no-response throw is raw English today, but the
  // i18n gate takes new strings over time. Once tagged, the wording stops mattering — so
  // translating it later cannot re-introduce this bug.
  __setCatalogForTest("ja", catalogFor("ja"));
  const err = new Error("ComfyUI-Manager に接続できません");
  assert.ok(!isManagerUnreachable(err), "untagged and untranslatable-by-regex: not matched");
  err.managerTransportUnreachable = true;
  assert.ok(isManagerUnreachable(err), "tagged: matched");
});

test("the untranslated transport throws keep working", () => {
  // managerV2/managerCall throw a RAW English literal when there is no response at all,
  // and detectManagerDialect throws one when neither queue probe answers. Those are not
  // routed through tr(), so they matched before and must still match — the fix must add a
  // structural path without removing the one that already worked.
  __setCatalogForTest("ja", catalogFor("ja"));
  for (const msg of [
    "ComfyUI-Manager not reachable (is the built-in Manager enabled?)",
    "ComfyUI-Manager's queue API is not reachable (neither /v2/manager/queue/status nor /manager/queue/status answered with a queue status). Is the built-in Manager installed and enabled on the connected ComfyUI?",
  ]) {
    assert.ok(isManagerUnreachable(new Error(msg)), `still matched: ${msg.slice(0, 40)}…`);
  }
});

test("an unrelated Manager error still does not open the fallback ladder", () => {
  __setCatalogForTest("ja", catalogFor("ja"));
  for (const err of [
    new Error("Manager customnode/installed: HTTP 500"),
    new Error("boom"),
    null,
    undefined,
  ]) {
    assert.ok(!isManagerUnreachable(err), `must not match: ${String(err?.message ?? err)}`);
  }
});

test("tr() is genuinely in the path — this suite is not testing a constant", () => {
  // Guards against the mechanism quietly changing under the test: if classifyManager404
  // ever stops translating, these assertions would pass for the wrong reason.
  __setCatalogForTest("ja", catalogFor("ja"));
  assert.notEqual(
    tr("manager_404.comfyui_manager_not_reachable_is_the_built", "ComfyUI-Manager not reachable (is the built-in Manager enabled?)"),
    "ComfyUI-Manager not reachable (is the built-in Manager enabled?)",
  );
});
