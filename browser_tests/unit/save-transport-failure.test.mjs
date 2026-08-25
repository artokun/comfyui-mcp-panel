/**
 * #1757 — `panel_save_workflow` returned bare "Error: Failed to fetch".
 *
 * The reporter's session: a `panel_restart_comfyui` confirmation had timed out
 * without restarting; `panel_list_workflows` answered immediately and showed the
 * active workflow still `modified: true`; graph reads and layout mutations
 * applied; and `panel_save_workflow({})` failed twice with nothing but the
 * browser's own eight words. Their own Environment block records ComfyUI's stats
 * route as unreachable at that moment — so the save really could not reach
 * ComfyUI, and the defect is that the tool result said none of that.
 *
 * The three things exercised here, in the order they matter:
 *
 *  1. The CALL SITES. A message helper nobody reaches is the failure mode this
 *     repo has shipped before, so the primary tests drive `saveActiveWorkflow`
 *     itself with a store double whose write throws the browser's transport
 *     error, and read the message that comes out of the real save. Delete either
 *     `decorateSaveTransportFailure(...)` call in `workflow-save.js` and these go
 *     red on the bare string.
 *  2. SHAPE-SCOPING. Every non-transport failure must keep its existing message
 *     byte-for-byte — the 409 and the userdata-400 have their own carefully-worded
 *     errors and their own matchers.
 *  3. What the message may NOT claim: that nothing was written, or that a retry
 *     is safe. The write is a mutation whose response was lost.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { saveActiveWorkflow } from "../../web/js/lib/workflow-save.js";
import {
  describeSaveBackendSocket,
  decorateSaveTransportFailure,
  isSaveTransportFailure,
  markSaveTransportFailure,
  readBackendSocket,
  saveTransportFailureMessage,
  userDataRoute,
} from "../../web/js/lib/save-transport-failure.js";

/** Exactly what Chrome throws when a fetch never completes. */
const failedToFetch = () => new TypeError("Failed to fetch");

/** A minimal ComfyUI workflow STORE double. `saveWorkflow` is the write both save
 *  routes end at (`saveInPlace` for in-place, the trio's last step for a copy), so
 *  making it throw is the production shape of "ComfyUI's HTTP API did not answer". */
function makeStore({ active, disk = [], onSaveWorkflow } = {}) {
  const files = new Set(disk);
  const calls = [];
  const svc = {
    activeWorkflow: active,
    calls,
    files,
    getWorkflowByPath(path) {
      if (svc.activeWorkflow && svc.activeWorkflow.path === path) return svc.activeWorkflow;
      if (files.has(path)) return { path, isPersisted: true };
      return null;
    },
    async saveWorkflow(wf) {
      calls.push(["saveWorkflow", wf.path]);
      if (onSaveWorkflow) return onSaveWorkflow(wf);
      files.add(wf.path);
    },
    saveAs(wf, path) {
      calls.push(["saveAs", wf.path, path]);
      return {
        path,
        filename: path.split("/").pop(),
        directory: path.split("/").slice(0, -1).join("/") || "workflows",
        isPersisted: false,
        isTemporary: true,
        activeState: { nodes: [] },
        changeTracker: { prepareForSave() {} },
      };
    },
    async openWorkflow(copy) {
      calls.push(["openWorkflow", copy.path]);
      svc.activeWorkflow = copy;
    },
    closeWorkflow(wf) {
      calls.push(["closeWorkflow", wf.path]);
    },
  };
  return svc;
}

const persistedTab = () => ({
  path: "workflows/LTX EROS Extend.json",
  filename: "LTX EROS Extend.json",
  directory: "workflows",
  isPersisted: true,
  isTemporary: false,
  activeState: { nodes: [] },
  changeTracker: { prepareForSave() {} },
});

async function saveAndCatch(svc, name, opts) {
  try {
    await saveActiveWorkflow(svc, name, opts);
  } catch (err) {
    return err;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. The call sites — the real save, the real thrown error.
// ---------------------------------------------------------------------------

test("#1757 an IN-PLACE save whose write never completes reports the route, not just 'Failed to fetch'", async () => {
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: () => {
      throw failedToFetch();
    },
  });

  const err = await saveAndCatch(svc, undefined, { existsOnDisk: async () => true });

  assert.ok(err, "the save must still fail — this fix explains a failure, it does not swallow one");
  // The browser's own words stay at the FRONT: `isTransportFailure` and
  // `isTransientReconnectError` both classify on the message text, and a
  // replacement message would silently reclassify this error downstream.
  assert.ok(
    err.message.startsWith("Failed to fetch"),
    `the raw transport string must lead the message, got: ${err.message}`,
  );
  assert.ok(err instanceof TypeError, "the error TYPE and stack survive (decorated in place, not wrapped)");
  // The bare message is what the reporter got. Anything past it is the fix.
  assert.notEqual(err.message, "Failed to fetch", "#1757: the bare browser string is the defect");
  assert.match(err.message, /in-place save/, "which write was attempted");
  assert.match(
    err.message,
    /\/userdata\/workflows%20EROS|\/userdata\/workflows%2FLTX%20EROS%20Extend\.json/,
    "the same-origin route the write went to",
  );
  assert.match(err.message, /workflows\/LTX EROS Extend\.json/, "and the file it was writing");
});

test("#1757 the in-place message states that no status or body EXISTS, rather than inventing one", async () => {
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: () => {
      throw failedToFetch();
    },
  });

  const err = await saveAndCatch(svc, undefined, { existsOnDisk: async () => true });

  assert.match(err.message, /NO HTTP response/, "the request never completed");
  assert.match(
    err.message,
    /no status code and no response body to report — they do not exist/,
    "the issue asked for status+body; the honest answer is that they were never produced",
  );
  assert.match(err.message, /received NO HTTP response from/, "reports the observed response gap");
  assert.ok(!/never reached ComfyUI/.test(err.message), "no response does not prove the request was never delivered");
});

test("#1757 the message refuses to claim the file was left unwritten, and never says 'safe to retry'", async () => {
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: () => {
      throw failedToFetch();
    },
  });

  const err = await saveAndCatch(svc, undefined, { existsOnDisk: async () => true });

  // A save is a MUTATION whose response was lost. A CORS-blocked reply, a
  // connection dropped after delivery and a proxy that failed after forwarding are
  // indistinguishable from the browser, and in each the write may be on disk.
  assert.match(err.message, /does NOT establish that nothing was written/i);
  assert.ok(
    !/safe to retry|retry the save|just retry/i.test(err.message),
    "a blind retry of a mutation whose response was lost can apply it twice",
  );
  assert.match(err.message, /read the file back before retrying/i, "the one thing that actually settles it");
});

test("#1757 the message explains why list/reads kept working — the reporter's own misleading evidence", async () => {
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: () => {
      throw failedToFetch();
    },
  });

  const err = await saveAndCatch(svc, undefined, { existsOnDisk: async () => true });

  assert.match(
    err.message,
    /issue no HTTP at all — their success is not evidence that ComfyUI is up/,
    "the save is the only one of the four that has to reach ComfyUI's HTTP API",
  );
  assert.match(err.message, /panel_list_workflows/, "named, because it is what the reporter checked");
});

test("#1757 the panel's socket observation reaches the message THROUGH saveActiveWorkflow", async () => {
  // The wiring test for `describeBackendSocket`: it is threaded panel →
  // saveActiveWorkflow → saveInPlace, and a break anywhere on that path drops the
  // one fact only the panel holds. Asserted on the message the real save throws.
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: () => {
      throw failedToFetch();
    },
  });

  const down = await saveAndCatch(svc, undefined, {
    existsOnDisk: async () => true,
    describeBackendSocket: () => "down",
  });
  assert.match(down.message, /backend websocket is down too/, "ComfyUI itself is gone");

  const open = await saveAndCatch(svc, undefined, {
    existsOnDisk: async () => true,
    describeBackendSocket: () => "open",
  });
  assert.match(open.message, /backend websocket is still OPEN/, "the server is there; this request did not complete");
  assert.notEqual(down.message, open.message, "the two observations must not collapse to one message");

  // No observer ⇒ SILENCE about the socket. Never a guess.
  const silent = await saveAndCatch(svc, undefined, { existsOnDisk: async () => true });
  assert.ok(!/websocket/i.test(silent.message), "an unobserved socket is reported as nothing at all");
});

test("#1757 an observer that THROWS cannot replace the save's real error", async () => {
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: () => {
      throw failedToFetch();
    },
  });

  const err = await saveAndCatch(svc, undefined, {
    existsOnDisk: async () => true,
    describeBackendSocket: () => {
      throw new Error("api.socket is not readable");
    },
  });

  assert.ok(err.message.startsWith("Failed to fetch"), "still the save's failure");
  assert.ok(!/api\.socket is not readable/.test(err.message), "the diagnostic must not become the error");
  assert.ok(!/websocket/i.test(err.message), "a failed observation is silence, like an absent one");
});

test("#1757 a SAVE-AS copy whose write never completes is explained too, and the source is untouched", async () => {
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: (wf) => {
      // The source's own file is never written on this route; only the copy is.
      if (wf.path === active.path) throw new Error("the copy route must never write the source");
      throw failedToFetch();
    },
  });

  const err = await saveAndCatch(svc, "LTX EROS Extend v2", {
    existsOnDisk: async (p) => svc.files.has(p),
    // Reading the target back is itself an HTTP round-trip, so a server that
    // answers nothing yields "unknown" — which is exactly why this reaches the
    // bare-rethrow that #1757 is about.
    reconcileSavedCopy: async () => "unknown",
  });

  assert.ok(err, "the save-as still fails");
  assert.ok(err.message.startsWith("Failed to fetch"), `raw string leads, got: ${err.message}`);
  assert.notEqual(err.message, "Failed to fetch", "#1757 on the copy route as well");
  assert.match(err.message, /save-as \(copy\) write/, "which write was attempted");
  assert.match(err.message, /workflows\/LTX EROS Extend v2\.json/, "and its target");
  // The claims the copy route may make that the in-place route may not.
  assert.match(err.message, /SOURCE workflow was never written to/);
  assert.match(err.message, /refused as a name collision/, "if the write DID land, a same-name retry collides");
  assert.ok(svc.files.has(active.path), "the original file survives (#226 unchanged)");
});

test("#1757 a save-as transport failure is NOT reclassified into a filename conflict", async () => {
  // Found by this test, not by review. `isConflictError` matches "409"/"conflict"/
  // "already exists" ANYWHERE in a message, and the relocating save's rollback
  // wrapper runs it on whatever the trio throws. The first draft of the message
  // ended with "will report a 409 conflict" — so the wrapper decided this transport
  // failure WAS a filename collision and replaced the entire explanation with
  // `a workflow named "…" already exists (409 Conflict) — choose a different name`,
  // which is both wrong and un-actionable. Two guards now: the wording avoids those
  // tokens, and the error carries a brand `isConflictError` honours.
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: (wf) => {
      if (wf.path === active.path) throw new Error("the copy route must never write the source");
      throw failedToFetch();
    },
  });

  const err = await saveAndCatch(svc, "LTX EROS Extend v2", {
    existsOnDisk: async (p) => svc.files.has(p),
    reconcileSavedCopy: async () => "unknown",
  });

  assert.ok(
    !/choose a different name/.test(err.message),
    `a lost response is not a name collision, got: ${err.message}`,
  );
  assert.ok(err.message.startsWith("Failed to fetch"), "the real failure survives the rollback wrapper");
  // The brand, not the prose, is what makes that hold. Prove it does the work by
  // asserting the classifier's own answer for a branded error whose message DOES
  // carry every token it matches on.
  const branded = markSaveTransportFailure(new Error("409 Conflict: already exists"));
  assert.equal(isSaveTransportFailure(branded), true);
  assert.equal(isSaveTransportFailure(new Error("409 Conflict: already exists")), false);
  // An INHERITED flag must not be able to suppress a genuine conflict.
  const inherited = Object.create({ cmcpSaveTransport: true });
  assert.equal(isSaveTransportFailure(inherited), false, "own-property only, like markPreCommit");
});

// ---------------------------------------------------------------------------
// 2. Shape-scoping — everything else keeps its own message, byte for byte.
// ---------------------------------------------------------------------------

test("#1757 a 409 filename conflict is NOT relabelled as a transport failure", async () => {
  const active = persistedTab();
  const svc = makeStore({
    active,
    disk: [active.path],
    onSaveWorkflow: () => {
      const err = new Error("Error storing user data file: 409 Conflict");
      err.status = 409;
      throw err;
    },
  });

  const err = await saveAndCatch(svc, undefined, { existsOnDisk: async () => true });

  assert.ok(err, "still fails");
  assert.ok(!/#1757/.test(err.message), "an error that DID get an HTTP response is not this fix's business");
  assert.match(err.message, /409/);
});

test("#1757 a Manager-style rejection that merely MENTIONS a transport phrase is left alone", () => {
  // The dangerous direction: attaching "no response arrived" advice to a request
  // the server considered and refused. `isTransportFailure` is start-anchored for
  // exactly this, and reusing it is why this file grows no second matcher.
  assert.equal(
    saveTransportFailureMessage(new Error("Save rejected: NetworkError in dependency metadata"), {
      operation: "in-place",
      path: "workflows/Foo.json",
    }),
    null,
  );
  assert.equal(
    saveTransportFailureMessage(new Error("refusing to save: the active workflow changed"), {
      operation: "in-place",
      path: "workflows/Foo.json",
    }),
    null,
  );
});

test("#1757 decorateSaveTransportFailure reports whether it acted, and leaves non-Errors alone", () => {
  const err = failedToFetch();
  assert.equal(decorateSaveTransportFailure(err, { operation: "in-place", path: "workflows/Foo.json" }), true);
  assert.notEqual(err.message, "Failed to fetch");

  const other = new Error("boom");
  assert.equal(decorateSaveTransportFailure(other, { operation: "in-place", path: "workflows/Foo.json" }), false);
  assert.equal(other.message, "boom", "byte-identical");

  // A thrown string has no `.message` to carry the explanation, so reporting
  // "decorated" would make the call site skip the handling that shape still needs.
  assert.equal(decorateSaveTransportFailure("Failed to fetch", { operation: "in-place" }), false);
});

// ---------------------------------------------------------------------------
// 3. The helpers, on their own.
// ---------------------------------------------------------------------------

test("#1757 the route is built exactly as this repo builds its own /userdata reads", () => {
  assert.equal(userDataRoute("workflows/Foo.json"), "/userdata/workflows%2FFoo.json");
  assert.equal(userDataRoute(""), null);
  assert.equal(userDataRoute(undefined), null);
  // …and a path-less failure still explains itself, naming no route it cannot name.
  const message = saveTransportFailureMessage(failedToFetch(), { operation: "in-place" });
  assert.match(message, /same-origin userdata route/);
  assert.ok(!/\(\/userdata\//.test(message), "no fabricated route for a workflow with no path");
});

test("#1757 describeSaveBackendSocket agrees with the graph-mutation gate about 'down'", () => {
  // WS_OPEN is 1. Derived THROUGH backendSocketIsDown so the two cannot disagree:
  // flagged-down-but-OPEN is NOT down there, and must not be down here either.
  assert.equal(describeSaveBackendSocket({ flaggedDown: true, socketReadyState: 3 }), "down");
  assert.equal(describeSaveBackendSocket({ flaggedDown: true, socketReadyState: undefined }), "down");
  assert.equal(describeSaveBackendSocket({ flaggedDown: true, socketReadyState: 1 }), "open");
  assert.equal(describeSaveBackendSocket({ flaggedDown: false, socketReadyState: 1 }), "open");
  // Not flagged down and not observably open ⇒ nothing is known ⇒ say nothing.
  assert.equal(describeSaveBackendSocket({ flaggedDown: false, socketReadyState: 0 }), undefined);
  assert.equal(describeSaveBackendSocket({}), undefined);
  assert.equal(describeSaveBackendSocket(), undefined);
});

test("#1757 readBackendSocket admits only the two states it can vouch for", () => {
  assert.equal(readBackendSocket(() => "down"), "down");
  assert.equal(readBackendSocket(() => "open"), "open");
  assert.equal(readBackendSocket(() => "probably fine"), undefined, "an unrecognised state is not repeated");
  assert.equal(readBackendSocket(undefined), undefined);
  assert.equal(
    readBackendSocket(() => {
      throw new Error("nope");
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// 4. The panel's own wiring, which no helper-level test can see.
// ---------------------------------------------------------------------------

test("#1757 programmaticSave hands saveActiveWorkflow a LIVE socket observer", () => {
  const panel = readFileSync(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url), "utf8");
  const start = panel.indexOf("const saved = await saveActiveWorkflow(svc, name, {");
  assert.ok(start > 0, "programmaticSave's saveActiveWorkflow call is where the observer is installed");
  const call = panel.slice(start, panel.indexOf("\n  });", start));

  assert.match(call, /describeBackendSocket: \(\) =>/, "installed, and LAZY — it must describe the failure, not the entry");
  assert.match(
    call,
    /describeSaveBackendSocket\(\{[\s\S]*flaggedDown: comfyBackendSocketDown[\s\S]*socketReadyState: comfyBackendSocketReadyState\(\)/,
    "reading the same two observations the graph-mutation gate reads",
  );
});
