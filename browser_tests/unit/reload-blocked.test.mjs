// panel#701(2) — a commanded frontend reload that never happens must say so.
//
// Reproduced on released builds: panel_reload({scope:"frontend"}) returned
// "soft reload (frontend) scheduled", the orchestrator logged
// `panel tab disconnected`, the page never navigated (no cmcpReload param), and
// the socket never came back. ComfyUI's unsaved-work beforeunload had cancelled
// the navigation after the browser began tearing the socket down, leaving a modal
// waiting for a click nobody knew about.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  armReloadBlockedNotice,
  reloadBlockedMessage,
  RELOAD_BLOCKED_AFTER_MS,
  unsavedReloadBlockers,
  reloadWouldBeBlockedMessage,
} from "../../web/js/lib/reload-blocked.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** Capture the scheduled callback instead of waiting on a real clock. */
function fakeTimer() {
  const calls = [];
  return { setTimer: (fn, ms) => (calls.push({ fn, ms }), calls.length), calls };
}

test("#701 the notice fires only if the page SURVIVED the deadline", () => {
  const said = [];
  const t = fakeTimer();
  armReloadBlockedNotice({ notify: (m) => said.push(m), setTimer: t.setTimer });
  assert.equal(said.length, 0, "nothing is said at arm time");
  assert.equal(t.calls[0].ms, RELOAD_BLOCKED_AFTER_MS);
  t.calls[0].fn();
  assert.equal(said.length, 1, "surviving the deadline is the evidence");
});

test("#701 a successful reload says NOTHING — the page is gone", () => {
  // The real mechanism: the document is destroyed and the callback never runs.
  // Modelled by a stillHere that reports the page died, which is also the guard
  // against speaking about a page that no longer exists.
  const said = [];
  const t = fakeTimer();
  armReloadBlockedNotice({ notify: (m) => said.push(m), stillHere: () => false, setTimer: t.setTimer });
  t.calls[0].fn();
  assert.equal(said.length, 0);
});

test("#701 it says NOT YET rather than declaring failure", () => {
  // The one false-positive risk is a navigation slower than the deadline. The
  // wording has to survive that case being wrong.
  const msg = reloadBlockedMessage();
  assert.match(msg, /has NOT happened yet/);
  assert.doesNotMatch(msg, /reload failed|could not reload|reload was refused/i);
});

test("#701 it names the likely cause WITHOUT asserting it", () => {
  // This code cannot see which handler cancelled the unload — another pack or a
  // browser extension can register one too. Unsaved work is by far the likeliest
  // and is named as such, not as fact.
  const msg = reloadBlockedMessage();
  assert.match(msg, /almost certainly/);
  assert.match(msg, /unsaved workflows/);
  assert.doesNotMatch(msg, /because you have unsaved work\b/i);
});

test("#701 it tells the reader what to DO, in the browser", () => {
  const msg = reloadBlockedMessage();
  assert.match(msg, /Check the ComfyUI tab/);
  assert.match(msg, /confirm the prompt|confirm\s+the prompt/i);
  assert.match(msg, /save the modified workflows/);
});

test("#701 it warns that the connection may ALREADY have dropped", () => {
  // The socket teardown begins before the dialog resolves, so "the agent looks
  // disconnected" is expected here and would otherwise read as a second fault.
  assert.match(reloadBlockedMessage(), /may already have dropped/);
});

test("#701 a missing notify sink is a no-op, never a throw", () => {
  // This runs on the way out of the page; throwing here would be the worst
  // possible place to fail.
  assert.equal(armReloadBlockedNotice({}), null);
  assert.equal(armReloadBlockedNotice({ notify: "not a function" }), null);
});

test("#701 WIRING: armed BEFORE the navigation, in the frontend branch", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const i = src.indexOf("armReloadBlockedNotice({ notify:");
  const j = src.indexOf('u.searchParams.set("cmcpReload"', i);
  assert.ok(i !== -1, "the notice must be armed in the shipped source");
  assert.ok(j > i, "…and armed BEFORE location.replace, or the page may die first");
  // The MEMBER LIST is not the invariant — #701's guard imports two more names
  // from the same module. What must hold is that the notice comes from there.
  assert.match(src, /import \{[^}]*armReloadBlockedNotice[^}]*\} from "\.\/lib\/reload-blocked\.js"/);
});

// panel#701 defect (2) — reproduced on the rig: with 3 unsaved workflows open,
// panel_reload({scope:"frontend"}) reported "scheduled", the orchestrator logged
// `panel tab disconnected`, and then nothing happened. The page never navigated
// (no `cmcpReload` in the URL, unsaved `*` still in the title) and stopped
// accepting script injection at all.
//
// beforeunload is the mechanism, and the ORDER is what turns it into a wedge: the
// browser drops the socket first, THEN raises "Leave site?" — which nobody is
// there to answer during an agent-commanded reload. The tab is left with neither
// a reload nor a bridge, strictly worse than before the command.

test("#701 unsaved workflows are reported as reload blockers", () => {
  const blockers = unsavedReloadBlockers([
    { isModified: true, filename: "a.json" },
    { isModified: false, filename: "b.json" },
    { isModified: true, path: "workflows/c.json" },
  ])
  assert.deepEqual(blockers, ["a.json", "workflows/c.json"])
})

test("#701 an UNKNOWN modified flag is not treated as unsaved work", () => {
  // Refusing on an absent flag would make the reload unusable on any build that
  // does not expose the field — an unobserved edit is not an observed one.
  assert.deepEqual(unsavedReloadBlockers([{ filename: "a.json" }]), [])
  assert.deepEqual(unsavedReloadBlockers([{ isModified: undefined }]), [])
  assert.deepEqual(unsavedReloadBlockers([{ isModified: "yes" }]), [])
  assert.deepEqual(unsavedReloadBlockers(null), [])
  assert.deepEqual(unsavedReloadBlockers([]), [])
})

test("#701 a blocked reload names the tabs, the mechanism, and BOTH ways out", () => {
  const msg = reloadWouldBeBlockedMessage(["a.json", "b.json"])
  assert.match(msg, /Did NOT reload/)
  assert.match(msg, /a\.json, b\.json/)
  assert.match(msg, /drops this tab's bridge connection BEFORE/)
  assert.match(msg, /Nothing was changed/)
  assert.match(msg, /Save or close/)
  assert.match(msg, /Ctrl\+Shift\+R/)
})

test("#701 WIRING: only the AGENT path refuses, and it refuses BEFORE navigating", async () => {
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  )
  const i = src.indexOf('if (scope === "frontend")')
  assert.ok(i > 0)
  const block = src.slice(i, i + 2600)
  // The guard is gated on the commanded path — a user standing at the keyboard
  // can answer the dialog, so their reload must still proceed.
  assert.match(block, /if \(origin === "agent"\)[\s\S]{0,400}unsavedReloadBlockers/)
  // …and it must return BEFORE the navigation, not merely warn about it.
  const guardAt = block.indexOf("unsavedReloadBlockers")
  const navAt = block.indexOf("cmcpReload")
  assert.ok(guardAt > 0 && navAt > guardAt, "the blocker check must precede the navigation")
  assert.match(block.slice(guardAt, navAt), /return;/)
})

test("#701 WIRING: the soft_reload REPLY reports the refusal, before scheduling anything", async () => {
  // Live-verified on the rig that the guard works and the socket survives — and
  // that the agent was still told "soft reload (frontend) scheduled", with the
  // panel-side notice nowhere the agent can read it. A command that reports the
  // REQUEST instead of the observed EFFECT is the defect, not the navigation.
  const { readFileSync } = await import("node:fs")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  )
  const i = src.indexOf('msg.cmd === "soft_reload"')
  assert.ok(i > 0)
  const block = src.slice(i, i + 1800)
  // The blockers are consulted in the command handler…
  assert.match(block, /unsavedReloadBlockers\(app\?\.extensionManager\?\.workflow\?\.openWorkflows\)/)
  // …the refusal becomes the REPLY…
  assert.match(block, /result = reloadWouldBeBlockedMessage\(reloadBlockers\)/)
  // …and "scheduled" + the actual reload are the ELSE branch, so a blocked
  // reload can never be reported as scheduled.
  const refusalAt = block.indexOf("reloadWouldBeBlockedMessage(reloadBlockers)")
  const schedAt = block.indexOf("scheduled`")
  assert.ok(refusalAt > 0 && schedAt > refusalAt, "the refusal must be decided before the scheduled reply")
  assert.match(block.slice(refusalAt, schedAt), /\} else \{/)
  // Only the frontend scope is gated — an orchestrator respawn does not navigate.
  assert.match(block, /scope === "frontend"\s*\?\s*unsavedReloadBlockers/)
})
