// #1198 — the Settings path commits the durable default before #1184's guard can abort.
//
// #1184 stopped `connectBackend()` committing anything until the old provider's session was
// durably invalidated. The Settings dropdown slips past that entirely, because ComfyUI has
// already written `SETTING_BACKEND` by the time it notifies the panel at all:
//
//   combo → ComfyUI writes the SAVED default → onChange → applyBackend → connectBackend →
//   #1184's guard aborts → the saved default still names a backend never connected to.
//
// `STORAGE_KEY_BACKEND` (which #1184 leaves alone on an abort) shadows it on this machine,
// so the damage only surfaces where there is no runtime pick to shadow it: a fresh profile,
// another browser, a cleared site. That is what makes it worth a test rather than a look.
//
// THE HARD PART IS NOT THE ROLLBACK, IT IS ROLLING BACK WITHOUT THE STORM. Writing this
// setting is what caused the 9181 "ready"/"waiting" connect storm, so the tests below drive
// the panel's REAL onChange and REAL applyBackend over a model of the REAL ComfyUI settings
// store, and count connects. A rollback that re-entered would show up as more than one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { BACKEND_SWITCH } from "../../web/js/lib/backend-switch.js";
import {
  SETTINGS_BACKEND_ROLLBACK,
  createSettingsBackendDefault,
  planSettingsBackendRollback,
} from "../../web/js/lib/settings-backend-default.js";

const PANEL_LF = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const SETTING_BACKEND = "comfyui-mcp.defaultBackend";

// ---------------------------------------------------------------------------
// A model of ComfyUI's settings store, transcribed from the shipped frontend.
//
// From `src/platform/settings/settingStore.ts` (ComfyUI_frontend 1.50.3, read out of the
// sourcemap shipped beside the bundle). All three behaviours below are load-bearing for
// the fix, so they are modelled rather than assumed:
//
//   (A) `onChange(newValue, oldValue)` is dispatched SYNCHRONOUSLY from inside
//       `setSettingValue`, and it is handed the PREVIOUS value;
//   (B) `if (newValue === oldValue) return undefined` — an unchanged write is a complete
//       no-op: no notification, no server call;
//   (C) `settingValues[key] = newValue` and `await api.storeSetting(...)` both happen
//       AFTER the notification, so a handler still reads the OLD value while it runs.
//
// `deferNotify` models a frontend that delivers the notification later instead. Nothing in
// the settings API promises (A), and `suppressSettingOnChange` is documented in the panel as
// best-effort for exactly that reason — so the fix has to hold in both modes, and is tested
// in both.
// ---------------------------------------------------------------------------
function createComfySettingStore({ initial = {}, deferNotify = false } = {}) {
  const values = { ...initial };
  const handlers = new Map();
  const serverWrites = [];
  const queue = [];
  return {
    register: (key, onChange) => handlers.set(key, onChange),
    get: (key) => values[key],
    serverWrites,
    /** ComfyUI's `settingStore.set`, in the order the real one does it. */
    set(key, value) {
      const oldValue = values[key];
      if (value === oldValue) return; // (B)
      const notify = () => handlers.get(key)?.(value, oldValue); // (A)
      if (deferNotify) queue.push(notify);
      else notify();
      values[key] = value; // (C) — after the notification, not before
      serverWrites.push({ key, value });
    },
    /** Deliver whatever a deferred frontend would have delivered later. */
    drain() {
      while (queue.length) queue.shift()();
    },
  };
}

// ---------------------------------------------------------------------------
// The SHIPPED handler bodies, extracted and run.
//
// A module can be perfectly correct and never reached; the panel is 1.7MB of IIFE, so the
// only way to prove these two are wired is to lift them out of the source and drive them.
// ---------------------------------------------------------------------------
function loneMatch(re, what) {
  const all = [...PANEL_LF.matchAll(re)];
  assert.equal(all.length, 1, `expected exactly 1 ${what}, got ${all.length}`);
  return all[0][0];
}

const onChangeSrc = loneMatch(
  /\n {6}onChange: \(v, previous\) => \{[\s\S]*?\n {6}\},/g,
  "SETTING_BACKEND onChange",
);
const applyBackendSrc = loneMatch(
  /\n {2}panelHooks\.applyBackend = async \(id, previous\) => \{[\s\S]*?\n {2}\};/g,
  "panelHooks.applyBackend",
);

test("#1198 the extracted bodies really are the shipped ones", () => {
  assert.match(onChangeSrc, /panelHooks\.applyBackend\?\.\(v, previous\)/, "onChange slice reaches the hook call");
  assert.match(applyBackendSrc, /await connectBackend\(id\)/, "applyBackend slice reaches the switch");
  // The onChange slice must be the one attached to SETTING_BACKEND and no other row. Every
  // other setting in this list takes `(v)`, so the arity is the discriminator — assert the
  // slice sits inside the SETTING_BACKEND block rather than trusting that.
  const backendAt = PANEL_LF.indexOf("id: SETTING_BACKEND");
  const sliceAt = PANEL_LF.indexOf(onChangeSrc);
  assert.ok(backendAt > 0 && sliceAt > backendAt, "the extracted onChange must belong to SETTING_BACKEND");
  assert.equal(
    PANEL_LF.slice(backendAt + "id: SETTING_BACKEND".length, sliceAt).indexOf("id: SETTING_"),
    -1,
    "…and no other setting may start between the two",
  );
});

/**
 * Wire the real onChange + real applyBackend + real settings-backend-default module to a
 * modelled ComfyUI store. Only `connectBackend` is a stub — it is the thing under whose
 * outcome this whole decision hangs.
 */
function buildPanel({
  storedBackend = "claude",
  selectedBackend = "claude",
  outcome = BACKEND_SWITCH.INVALIDATE_FAILED,
  deferNotify = false,
  onConnect = null,
} = {}) {
  const store = createComfySettingStore({ initial: { [SETTING_BACKEND]: storedBackend }, deferNotify });
  const transcript = [];
  const connects = [];

  // The panel's own module-scope helpers, same shape as the real ones.
  let suppressSettingOnChange = false;
  const getSetting = (id) => store.get(id);
  const setSetting = (id, value) => {
    try {
      suppressSettingOnChange = true;
      store.set(id, value);
    } finally {
      suppressSettingOnChange = false;
    }
  };
  const settingsBackendDefault = createSettingsBackendDefault({
    read: () => getSetting(SETTING_BACKEND),
    write: (value) => setSetting(SETTING_BACKEND, value),
  });

  const panelHooks = { applyBackend: null };
  const connectBackend = async (id) => {
    connects.push(id);
    // A real switch awaits the invalidate before it can decide, so the window this fix has
    // to survive is real. `onConnect` is how a test moves the world during that window.
    await null;
    if (onConnect) onConnect({ id, store, setSetting });
    const result = typeof outcome === "function" ? outcome(id) : outcome;
    return { switched: result === BACKEND_SWITCH.SWITCHED, reason: result };
  };

  const applyFactory = new Function(
    "deps",
    `
    let { selectedBackend } = deps;
    const { panelHooks, appendSystem, tr, BACKEND_LABELS, connectBackend, BACKEND_SWITCH, settingsBackendDefault } = deps;
    ${applyBackendSrc}
    return panelHooks.applyBackend;
    `,
  );
  panelHooks.applyBackend = applyFactory({
    selectedBackend,
    panelHooks,
    appendSystem: (m) => transcript.push(m),
    tr: (_key, fallback, params) =>
      fallback.replace(/\{(\w+)\}/g, (_m, k) => (params && params[k] != null ? params[k] : `{${k}}`)),
    BACKEND_LABELS: { claude: "Claude", codex: "ChatGPT (Codex)", gemini: "Gemini" },
    connectBackend,
    BACKEND_SWITCH,
    settingsBackendDefault,
  });

  // The onChange body reads `suppressSettingOnChange` and `settingsArmed` as live module
  // bindings, so they are `let`s inside the built scope rather than snapshotted parameters.
  const onChangeFactory = new Function(
    "deps",
    `
    let settingsArmed = deps.settingsArmed;
    const { panelHooks, settingsBackendDefault } = deps;
    let suppressSettingOnChange = false;
    const row = {
      ${onChangeSrc.trim().replace(/,$/, "")}
    };
    return {
      onChange: row.onChange,
      setSuppress: (x) => { suppressSettingOnChange = x; },
      readSuppress: () => suppressSettingOnChange,
    };
  `,
  );
  const built = onChangeFactory({ settingsArmed: true, panelHooks, settingsBackendDefault });

  // The panel's real `setSetting` raises the suppress flag around ITS writes. The extracted
  // onChange closes over its own copy, so mirror the flag across for the duration of a write
  // — otherwise the "identified before suppressed" ordering could never be exercised.
  store.register(SETTING_BACKEND, (v, previous) => {
    built.setSuppress(suppressSettingOnChange);
    try {
      return built.onChange(v, previous);
    } finally {
      built.setSuppress(false);
    }
  });

  return {
    store,
    transcript,
    connects,
    settingsBackendDefault,
    /** What a user picking a row in the Settings combo does. */
    pick: (id) => store.set(SETTING_BACKEND, id),
    savedDefault: () => store.get(SETTING_BACKEND),
  };
}

/** Let every promise chain started by a synchronous notification settle. */
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// ---------------------------------------------------------------------------
// THE DEFECT
// ---------------------------------------------------------------------------

test("#1198 an ABORTED Settings switch does not leave the saved default naming it", async () => {
  const p = buildPanel({ storedBackend: "claude", selectedBackend: "claude" });
  p.pick("codex");
  await settle();

  assert.deepEqual(p.connects, ["codex"], "the switch is attempted exactly once");
  assert.equal(
    p.savedDefault(),
    "claude",
    "the saved default must not name a backend the panel never connected to — that is #1198",
  );
  // The server write is what outlives the tab and wins on a fresh profile, so assert the
  // durable half explicitly rather than inferring it from the in-memory value.
  assert.deepEqual(
    p.store.serverWrites.map((w) => w.value),
    ["codex", "claude"],
    "the restore must be PERSISTED, not just corrected in memory",
  );
});

test("#1198 the abort does not claim the default changed", async () => {
  const p = buildPanel();
  p.pick("codex");
  await settle();
  assert.deepEqual(
    p.transcript,
    [],
    "announcing 'Default backend → X' for a switch that was then rolled back is the false-reassurance shape this repo keeps fixing",
  );
});

test("#1198 a SUCCESSFUL Settings switch keeps the new default, and says so", async () => {
  const p = buildPanel({ outcome: BACKEND_SWITCH.SWITCHED });
  p.pick("codex");
  await settle();
  assert.equal(p.savedDefault(), "codex", "a switch that happened must keep the default it set");
  assert.deepEqual(p.transcript, ["Default backend → ChatGPT (Codex)."]);
});

test("#1198 a FIRST CONNECT via Settings keeps the default too", async () => {
  // CONNECTED, not SWITCHED: nothing was live, so there was no session to invalidate and no
  // switch to abort. `switched` is false here exactly as it is for an abort, which is why
  // the rollback keys on `reason` — a boolean would roll this one back and wipe the
  // default the user just chose.
  const p = buildPanel({ outcome: BACKEND_SWITCH.CONNECTED });
  p.pick("codex");
  await settle();
  assert.equal(p.savedDefault(), "codex", "a first connect is not an abort");
  assert.deepEqual(p.transcript, ["Default backend → ChatGPT (Codex)."]);
});

// ---------------------------------------------------------------------------
// THE 9181 STORM — the reason the obvious fix was called wrong in the issue
// ---------------------------------------------------------------------------

test("#1198 the rollback does not re-enter connectBackend — the 9181 storm stays fixed", async () => {
  const p = buildPanel();
  p.pick("codex");
  await settle();
  assert.deepEqual(
    p.connects,
    ["codex"],
    "the restore write must not come back round through onChange → applyBackend → connectBackend",
  );
  assert.equal(p.settingsBackendDefault.outstandingWrite(), null, "and its echo must have been consumed");
});

test("#1198 …and still does not, when the notification is DEFERRED", async () => {
  // The scar's premise: ComfyUI fires onChange after `suppressSettingOnChange` has reset. It
  // does not on 1.50.3 — the dispatch is synchronous — but nothing in the API promises that,
  // so the marker has to carry the fix on its own with the flag contributing nothing.
  const p = buildPanel({ deferNotify: true });
  p.pick("codex");
  p.store.drain();
  await settle();
  p.store.drain();
  await settle();

  assert.deepEqual(p.connects, ["codex"], "a deferred echo must be IDENTIFIED, not raced");
  assert.equal(p.savedDefault(), "claude", "and the rollback still lands");
});

// ---------------------------------------------------------------------------
// THE RACES
// ---------------------------------------------------------------------------

test("#1198 a rollback never clobbers a pick the user made while the switch was awaiting", async () => {
  // The compare-and-swap. The invalidate is awaited, so the user has a real window in which
  // to change the setting again; putting the old value back at that point would silently
  // discard a choice they did make — worse than the defect being fixed. Here the second
  // switch SUCCEEDS, so the setting must be left naming it.
  const p = buildPanel({
    outcome: (id) => (id === "codex" ? BACKEND_SWITCH.INVALIDATE_FAILED : BACKEND_SWITCH.SWITCHED),
    onConnect: ({ id, store }) => {
      if (id === "codex") store.set(SETTING_BACKEND, "gemini");
    },
  });
  p.pick("codex");
  await settle();
  assert.deepEqual(p.connects, ["codex", "gemini"], "the second pick really is attempted");
  assert.equal(p.savedDefault(), "gemini", "the newer pick, which SUCCEEDED, must survive the stale rollback");
});

test("#1198 two overlapping aborted switches unwind to the last backend actually reached", async () => {
  // Not exotic: a wedged history store fails EVERY switch, so a user who tries twice lands
  // here every time. The second rollback's `previous` is the first switch's un-reached
  // backend ("codex"), so restoring to it would leave the saved default naming a backend the
  // panel never connected to — this defect, one step down the chain. It must reach "claude".
  const p = buildPanel({
    onConnect: ({ store }) => store.set(SETTING_BACKEND, "gemini"),
  });
  p.pick("codex");
  await settle();
  assert.deepEqual(p.connects, ["codex", "gemini"]);
  assert.equal(
    p.savedDefault(),
    "claude",
    "unwinding one step lands on 'codex', which was never reached either",
  );
});

test("#1198 the restore target is the SETTING's previous value, not the live backend", async () => {
  // These legitimately diverge: a chip pick moves the runtime backend WITHOUT touching the
  // saved default (#1184's FIX 1). Here the saved default is "claude" while the panel is
  // running on "codex" from a chip. Restoring to the live backend would write a default the
  // user never chose — a different wrong-default bug wearing the fix's clothes.
  const p = buildPanel({ storedBackend: "claude", selectedBackend: "codex" });
  p.pick("gemini");
  await settle();
  assert.equal(p.savedDefault(), "claude", "roll back to what the SETTING held, not to selectedBackend");
});

test("#1198 re-picking the backend the panel is already on stays a no-op", async () => {
  const p = buildPanel({ storedBackend: "claude", selectedBackend: "codex" });
  p.pick("codex");
  await settle();
  assert.deepEqual(p.connects, [], "applyBackend's idempotence guard still short-circuits");
  assert.equal(p.savedDefault(), "codex", "and the default the user chose is left alone");
});

// ---------------------------------------------------------------------------
// THE PLANNER, branch by branch
// ---------------------------------------------------------------------------

test("#1198 only the #1184 abort rolls back — every other outcome opts out", () => {
  for (const outcome of [BACKEND_SWITCH.SWITCHED, BACKEND_SWITCH.CONNECTED, "some_future_reason", undefined]) {
    assert.deepEqual(
      planSettingsBackendRollback({ outcome, attempted: "codex", previous: "claude", current: "codex" }),
      { restore: false, to: null, reason: SETTINGS_BACKEND_ROLLBACK.NOT_ABORTED },
      `${String(outcome)} must not inherit a rollback by falling through`,
    );
  }
});

test("#1198 the planner refuses without a usable previous value", () => {
  const base = { outcome: BACKEND_SWITCH.INVALIDATE_FAILED, attempted: "codex", current: "codex" };
  for (const previous of [undefined, null, "", 7, {}, "codex"]) {
    assert.equal(
      planSettingsBackendRollback({ ...base, previous }).reason,
      SETTINGS_BACKEND_ROLLBACK.NO_PREVIOUS,
      `previous=${JSON.stringify(previous)} gives nothing to restore to`,
    );
  }
});

test("#1198 the planner refuses when the setting has moved on", () => {
  assert.deepEqual(
    planSettingsBackendRollback({
      outcome: BACKEND_SWITCH.INVALIDATE_FAILED,
      attempted: "codex",
      previous: "claude",
      current: "gemini",
    }),
    { restore: false, to: null, reason: SETTINGS_BACKEND_ROLLBACK.SUPERSEDED },
  );
});

test("#1198 the planner restores when, and only when, all three hold", () => {
  assert.deepEqual(
    planSettingsBackendRollback({
      outcome: BACKEND_SWITCH.INVALIDATE_FAILED,
      attempted: "codex",
      previous: "claude",
      current: "codex",
    }),
    { restore: true, to: "claude", reason: SETTINGS_BACKEND_ROLLBACK.RESTORED },
  );
});

// ---------------------------------------------------------------------------
// THE ECHO MARKER
// ---------------------------------------------------------------------------

function marker({ current = "codex", write = () => {} } = {}) {
  return createSettingsBackendDefault({ read: () => current, write });
}

test("#1198 isSelfWrite is false when the panel has written nothing", () => {
  assert.equal(marker().isSelfWrite("claude"), false);
});

test("#1198 the marker is consumed once and does not linger", () => {
  const d = marker();
  d.rollback({ outcome: BACKEND_SWITCH.INVALIDATE_FAILED, attempted: "codex", previous: "claude" });
  assert.equal(d.outstandingWrite(), "claude", "a deferred frontend has not delivered it yet");
  assert.equal(d.isSelfWrite("claude"), true, "the echo is identified");
  assert.equal(d.isSelfWrite("claude"), false, "a SECOND claude — a real pick — is not swallowed");
});

test("#1198 a marker that is never delivered cannot eat a later real pick", () => {
  // Self-limiting. If our write produced no notification (fact (B): ComfyUI skips the
  // dispatch entirely when the value is unchanged), the FIRST notification of any kind must
  // clear the marker, or it sits there waiting to swallow a change the user really made.
  const d = marker();
  d.rollback({ outcome: BACKEND_SWITCH.INVALIDATE_FAILED, attempted: "codex", previous: "claude" });
  assert.equal(d.isSelfWrite("gemini"), false, "a different value is not ours");
  assert.equal(d.outstandingWrite(), null, "…and it ends the outstanding write");
  assert.equal(d.isSelfWrite("claude"), false, "so a later genuine pick of claude gets through");
});

test("#1198 a write that throws leaves no marker behind", () => {
  const d = marker({
    write: () => {
      throw new Error("settings store unavailable");
    },
  });
  assert.throws(() =>
    d.rollback({ outcome: BACKEND_SWITCH.INVALIDATE_FAILED, attempted: "codex", previous: "claude" }),
  );
  assert.equal(d.outstandingWrite(), null, "no notification is coming, so nothing may wait for one");
});

test("#1198 a refused rollback writes nothing and marks nothing", () => {
  const writes = [];
  const d = marker({ current: "gemini", write: (v) => writes.push(v) });
  const plan = d.rollback({ outcome: BACKEND_SWITCH.INVALIDATE_FAILED, attempted: "codex", previous: "claude" });
  assert.equal(plan.reason, SETTINGS_BACKEND_ROLLBACK.SUPERSEDED);
  assert.deepEqual(writes, []);
  assert.equal(d.outstandingWrite(), null);
});

// ---------------------------------------------------------------------------
// WIRING — the module can be right and dead
// ---------------------------------------------------------------------------

test("#1198 WIRING: the echo is identified BEFORE the suppress flag is consulted", () => {
  // Order matters and is invisible to an outcome test. ComfyUI dispatches onChange
  // synchronously from inside setSetting, so the rollback's echo arrives while
  // `suppressSettingOnChange` is still true. If the flag were checked first it would swallow
  // the notification and leave the marker outstanding — armed to eat the user's next real
  // pick of that backend.
  const code = onChangeSrc
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const self = code.indexOf("settingsBackendDefault.isSelfWrite(v)");
  const suppress = code.indexOf("suppressSettingOnChange");
  assert.ok(self > 0, "the handler must ask whether the notification is the panel's own");
  assert.ok(suppress > 0, "the best-effort flag is still there for writes that are not ours");
  assert.ok(self < suppress, "isSelfWrite must be asked FIRST, or the flag swallows the echo");
});

test("#1198 WIRING: applyBackend forwards the previous value and branches on the reason", () => {
  const code = applyBackendSrc
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.match(
    code,
    /reason === BACKEND_SWITCH\.INVALIDATE_FAILED/,
    "a boolean `switched` cannot tell an abort from a first connect — it must branch on the reason",
  );
  assert.match(
    code,
    /settingsBackendDefault\.rollback\(\{ outcome: reason, attempted: id, previous \}\)/,
    "the rollback must be handed the setting's previous value, not left to guess one",
  );
  // The announcement must sit AFTER the outcome is known. Before this fix it was the first
  // statement in the function, so an aborted switch printed a change to the durable default
  // that the panel then undid.
  const announce = code.indexOf("panel.default_backend_switched");
  const connect = code.indexOf("await connectBackend(id)");
  assert.ok(announce > 0 && connect > 0, "both must still be present");
  assert.ok(announce > connect, "the default may only be announced once the switch has actually happened");
});

test("#1198 WIRING: the Settings path is the ONLY writer of the saved default", () => {
  // #1184's FIX 1: a chip or model-popover switch is session-only and must leave the saved
  // default alone. The rollback is a new write to that setting, so pin that it did not
  // reappear inside connectBackend, where it caused the 9181 storm.
  const at = PANEL_LF.indexOf("async function connectBackend(id) {");
  assert.ok(at > 0);
  const body = PANEL_LF.slice(at, PANEL_LF.indexOf("\n  }", at))
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.doesNotMatch(
    body,
    /setSetting\(SETTING_BACKEND/,
    "writing the saved default from the switch path is the re-entrant write that stormed",
  );
});

test("#1198 WIRING: connectBackend returns the whole result, reason included", () => {
  const at = PANEL_LF.indexOf("async function connectBackend(id) {");
  const body = PANEL_LF.slice(at, PANEL_LF.indexOf("\n  }", at));
  assert.match(body, /return await runBackendSwitch\(id, \{/, "the reason must survive the call");
  assert.doesNotMatch(
    body,
    /const \{ switched \} = await runBackendSwitch/,
    "destructuring only `switched` throws away the one field that separates an abort from a connect",
  );
});
