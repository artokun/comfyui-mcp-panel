// #2044 — CivitAI sign-in failed silently.
//
// The popup ends on a bare browser 403 (ComfyUI's `create_origin_only_middleware`
// rejects the cross-site redirect back from CivitAI on the one branch that logs
// NOTHING), and on this side `_oauthPollIv` polled 120 times at 2s and then simply
// stopped. Four minutes, then nothing: no toast, no error, and an empty ComfyUI
// log. The user is left with a raw 403 and no statement that sign-in failed.
//
// The root cause is not fixed here and this file does not pretend otherwise —
// both real fixes are blocked (the loopback-PKCE route needs a CivitAI app
// registration test only the account owner can run; the middleware-insert route
// reaches into core's middleware list and was deliberately not shipped blind).
// What is fixed is the silence.
//
// Pinned on the shipped bundle: the timeout branch is reachable only after 240s of
// real polling, so a behavioural test would have to fake timers through a module
// that owns its own interval. What can be checked without that is that the branch
// EXISTS, says something, and — the part that matters — does not overclaim.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CIVITAI_UI = join(HERE, "../../web/js/cmcp-civitai-ui.js");
const EN = join(HERE, "../../locales/en/main.json");

const src = readFileSync(CIVITAI_UI, "utf8");

test("#2044 the sign-in poll has an else branch at all", () => {
  // The whole defect: `if (state.signedIn) { … }` with nothing after it, so the
  // give-up path was indistinguishable from success.
  const at = src.indexOf("if (state.signedIn || ++tries > 120)");
  assert.ok(at > -1, "the poll's give-up condition moved — re-point this test");
  const branch = src.slice(at, at + 2400);
  assert.ok(branch.includes("} else {"), "the timeout must not fall through silently");
  assert.ok(branch.includes("civitai_ui.sign_in_timed_out"));
});

test("#2044 the message names the remedy that works today", () => {
  const en = JSON.parse(readFileSync(EN, "utf8"));
  const msg = en?.comfyuiMcpPanel?.civitai_ui?.sign_in_timed_out;
  assert.equal(typeof msg, "string", "the key must be in the generated English catalog");
  // The panel already accepts a CivitAI API token server-side, and that path needs
  // no flag and no registration change — so it is the one to point at.
  assert.match(msg, /API token/i);
});

test("#2044 the message does not CLAIM a 403 it never saw", () => {
  // The popup is cross-origin, so this code cannot read its status. Asserting the
  // 403 would be the same overreach as the silence it replaces, pointing the other
  // way — and it would be wrong for every other reason sign-in can fail (the user
  // closing the popup, declining consent, a network drop).
  const en = JSON.parse(readFileSync(EN, "utf8"));
  const msg = en.comfyuiMcpPanel.civitai_ui.sign_in_timed_out;
  assert.ok(/if the popup showed a 403/i.test(msg), "the cause must be offered conditionally");
  assert.ok(
    !/blocked by comfyui's cross-site protection\./i.test(msg.split("If the popup")[0]),
    "nothing before the conditional may state the cause as fact",
  );
});

test("#2044 the SOURCE fallback carries the same conditional, and matches the catalog", () => {
  // The test above reads locales/en/main.json. That is the string that normally
  // renders -- `tr()` resolves the catalog first -- but it is GENERATED from the
  // fallback literal in the source by `npm run i18n:build`, and the fallback is what
  // renders whenever the catalog is not loaded. So flattening the conditional in the
  // source alone leaves that test green while the generated catalog silently drifts
  // out of date, and the un-catalogued path states as fact a 403 this code never saw.
  //
  // This is the panel#2210 shape exactly: a check that reads one of the two copies.
  const at = src.indexOf("CivitAI sign-in did not complete");
  assert.ok(at > -1, "the fallback literal moved — re-point this test");
  const fallback = src.slice(at, src.indexOf('",', at));
  assert.ok(
    /if the popup showed a 403/i.test(fallback),
    "the source fallback must offer the cause conditionally too",
  );
  const en = JSON.parse(readFileSync(EN, "utf8"));
  assert.equal(
    en.comfyuiMcpPanel.civitai_ui.sign_in_timed_out,
    fallback,
    "catalog and fallback have diverged — re-run `npm run i18n:build`",
  );
});

// The remedy names a SETTING, and that setting's label is translated in every
// locale while this toast is not — so quoting the English label told a French
// reader to look for "Set CivitAI token…" while their menu said "Définir le jeton
// CivitAI…". The one actionable sentence in a message about a sign-in that cannot
// succeed was the part they could not act on.
//
// Referenced, not copied: the quoted text is whatever the running UI shows, in any
// locale, and cannot drift if the label is reworded.
test("panel#2044 the timeout toast REFERENCES the setting label, never copies it", () => {
  const src = readFileSync(
    new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url),
    "utf8",
  );
  const at = src.indexOf("civitai_ui.sign_in_timed_out");
  assert.ok(at > 0, "the timeout toast is gone");
  const region = src.slice(at, at + 900);
  assert.ok(region.includes("{setting}"), "the toast stopped interpolating the label");
  assert.ok(
    region.includes('tr("panel.set_civitai_token"'),
    "the toast stopped resolving the label through tr()",
  );
  // The literal English label must not be re-embedded in the message itself.
  const message = region.slice(0, region.indexOf("{ setting:"));
  assert.equal(
    message.includes("Set CivitAI token"),
    false,
    "the English label is hard-coded in the message again",
  );
});

// The catalog is what non-English users resolve through, so the placeholder has to
// survive `npm run i18n:build` — a fallback fixed in source but not regenerated
// would leave every locale on the old hard-coded string.
test("panel#2044 the generated en catalog carries the placeholder", () => {
  const cat = JSON.parse(
    readFileSync(new URL("../../locales/en/main.json", import.meta.url), "utf8"),
  );
  const find = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (k === "sign_in_timed_out" && typeof v === "string") return v;
      if (v && typeof v === "object") {
        const hit = find(v);
        if (hit) return hit;
      }
    }
    return null;
  };
  const entry = find(cat);
  assert.ok(entry, "sign_in_timed_out missing from the en catalog");
  assert.ok(entry.includes("{setting}"), "catalog entry lost the placeholder");
  assert.equal(entry.includes("Set CivitAI token"), false, "catalog re-embedded the label");
});

test("#2044 refreshAuth cannot REJECT, which is what makes the timeout reachable", () => {
  // Load-bearing in a way neither site states. The poll body is:
  //
  //   await refreshAuth();
  //   if (!isOpen) { ... return; }
  //   if (state.signedIn || ++tries > 120) { ... }
  //
  // `++tries` sits AFTER the await. If refreshAuth ever propagated a rejection the
  // async interval callback would abort before the counter moved, the count would
  // never reach 120, and the give-up branch this PR adds would never fire --
  // restoring the exact silence #2044 is about, under a server-down/network-error
  // condition that is one of the likelier reasons a sign-in does not complete.
  //
  // Safe today only because refreshAuth swallows its own failure and records a
  // signed-out state. Asserted HERE, at the place that depends on it, so a later
  // refactor letting it throw fails this test rather than silently un-fixing the
  // timeout.
  const at = src.indexOf("async function refreshAuth()");
  assert.ok(at > -1, "refreshAuth moved or was renamed -- re-point this test");
  const body = src.slice(at, at + 400);
  assert.ok(body.includes("await ctx.api.fetchApi("), "the body must still be the fetching one");
  assert.match(
    body,
    /catch\s*\{[^}]*state\.signedIn\s*=\s*false/,
    "refreshAuth must swallow its fetch failure and record signed-out, or the poll never reaches ++tries",
  );
});
