// #640 — saved-workflow bridge routes collided across browser tabs.
//
// ui-bridge keeps exactly ONE connection per hello `tab_id`, so a second hello
// carrying an id that is already registered TAKES THE ROUTE OVER. The panel's
// saved-workflow handle is path-only (`wf:<path>`), so two browser tabs showing
// the same file helloed with the same id and the agent's commands were delivered
// to the other tab's canvas. The workflow-UUID instance fence refused the ones
// that carry a UUID — that is the LAST line of defence and it never sees a
// command that carries none.
//
// What is locked here:
//   1. Two tabs on the SAME saved file get DISTINCT routes.
//   2. An unestablished tab identity REFUSES the route — it never degrades to
//      the path, which would re-merge the tabs exactly when identity is hardest
//      to determine.
//   3. Every wire site in the shipped panel stamps the ROUTE, and refuses when
//      there is none, rather than the path-only handle.
//   4. The reply side and the dispatch side share ONE spelling of the handle
//      format, because each record's `active` flag is decided by comparing them.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  createTabRouteIdentity,
  describeRefusedRoute,
  savedWorkflowHandle,
  savedWorkflowRoute,
} from "../../web/js/lib/bridge-route.js";
import { createRestartTabIdentity, sendBridgeHello } from "../../web/js/lib/restart-tab-identity.js";
import { buildHelloPayload } from "../../web/js/lib/session-rebind.js";
import { commandTargetsActiveWorkflow } from "../../web/js/lib/workflow-chat-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** The origin-wide lock manager, shared by every tab in these tests. */
class FakeLocks {
  held = new Set();

  request(name, _options, callback) {
    if (this.held.has(name)) return Promise.resolve(callback(null));
    this.held.add(name);
    return Promise.resolve(callback({ name })).finally(() => this.held.delete(name));
  }
}

/** sessionStorage as a DUPLICATED browser tab sees it: the copy starts equal. */
function copiedStorage(value) {
  let stored = value;
  return {
    getItem: () => stored,
    setItem: (_key, next) => { stored = next; },
  };
}

/** One browser tab: its own lease resolver + its own route identity holder. */
function fakeTab({ locks, storageSeed, rotation }) {
  const restart = createRestartTabIdentity({
    storage: copiedStorage(storageSeed),
    locks,
    randomUUID: () => rotation,
  });
  const route = createTabRouteIdentity({
    locksAvailable: () => typeof locks?.request === "function",
    // Unreached whenever `locks` is present, which is the case in every test
    // using this helper — the lockless branch has its own tests below.
    mintPageInstanceId: () => `page-instance-of-${storageSeed}`,
  });
  return { restart, route };
}

// ---------------------------------------------------------------------------
// 1. Two tabs on the same saved workflow
// ---------------------------------------------------------------------------

test("#640: two browser tabs on the SAME saved workflow get DISTINCT bridge routes", async () => {
  const locks = new FakeLocks();
  const first = fakeTab({ locks, storageSeed: "tab-one", rotation: "unused-one" });
  const second = fakeTab({ locks, storageSeed: "tab-two", rotation: "unused-two" });

  first.route.adopt(await first.restart.resolve());
  second.route.adopt(await second.restart.resolve());

  const path = "workflows/shared.json";
  const routeA = savedWorkflowRoute(first.route.established()?.id, path);
  const routeB = savedWorkflowRoute(second.route.established()?.id, path);

  assert.equal(routeA, "wf:tab-one:workflows/shared.json");
  assert.equal(routeB, "wf:tab-two:workflows/shared.json");
  assert.notEqual(routeA, routeB, "the same file in two tabs must not register one route");
  // Assert the REASON, not just the difference: the tab is what separates them.
  assert.equal(savedWorkflowHandle(path), "wf:workflows/shared.json");
  assert.notEqual(routeA, savedWorkflowHandle(path), "the route must not be the path-only handle");

  first.restart.releaseForTests();
  second.restart.releaseForTests();
});

test("#640: a DUPLICATED tab (copied sessionStorage) is rotated apart, not merged", async () => {
  const locks = new FakeLocks();
  const original = fakeTab({ locks, storageSeed: "copied-tab", rotation: "original-rotation" });
  const duplicate = fakeTab({ locks, storageSeed: "copied-tab", rotation: "duplicate-rotation" });

  const [a, b] = await Promise.all([original.restart.resolve(), duplicate.restart.resolve()]);
  original.route.adopt(a);
  duplicate.route.adopt(b);

  const path = "workflows/shared.json";
  const routeA = savedWorkflowRoute(original.route.established()?.id, path);
  const routeB = savedWorkflowRoute(duplicate.route.established()?.id, path);
  assert.equal(routeA, "wf:copied-tab:workflows/shared.json");
  assert.equal(routeB, "wf:duplicate-rotation:workflows/shared.json");
  assert.notEqual(routeA, routeB);

  original.restart.releaseForTests();
  duplicate.restart.releaseForTests();
});

test("#640: the SAME file after a rename, and two UNSAVED tabs, also route apart", () => {
  const tab = "one-tab";
  assert.notEqual(
    savedWorkflowRoute(tab, "workflows/before.json"),
    savedWorkflowRoute(tab, "workflows/after.json"),
    "a rename changes the path half of the route",
  );
  // Unsaved tabs never reach savedWorkflowRoute: they keep the per-object
  // `tmp:<uuid>`, which the shipped bridgeRouteId() returns unchanged so the
  // orchestrator's tmp:-gated stable-resume index still recognizes them.
  const routeSource = namedFunctionSource(readFileSync(PANEL_JS, "utf8"), "bridgeRouteId");
  assert.match(routeSource, /return workflowTabId\(wf\);/);
  assert.match(routeSource, /tmp:/, "the unsaved branch must say why it is already tab-unique");
});

// ---------------------------------------------------------------------------
// 2. Refusal — never the path
// ---------------------------------------------------------------------------

test("#640: an UNIDENTIFIABLE tab is REFUSED, never merged onto the path", () => {
  const path = "workflows/shared.json";
  for (const unestablished of [null, undefined, "", "   "]) {
    const route = savedWorkflowRoute(unestablished, path);
    assert.equal(route, null, `an unestablished id (${JSON.stringify(unestablished)}) must refuse`);
    assert.notEqual(route, savedWorkflowHandle(path), "refusal must not become the path handle");
    assert.notEqual(route, path);
  }
});

test("#640: live lock CONTENTION establishes nothing — 'could not determine' is not 'no other tab'", () => {
  const identity = createTabRouteIdentity({
    locksAvailable: () => true,
    mintPageInstanceId: () => "never-reached",
  });
  // The lease resolver returned undefined WITH a lock manager present: another
  // live tab in this origin holds every candidate. The copyable sessionStorage
  // id is exactly what must NOT be adopted here.
  assert.equal(identity.adopt(undefined), null);
  assert.equal(identity.established(), null, "nothing may be recorded for a failed establishment");
  assert.equal(savedWorkflowRoute(identity.established()?.id, "workflows/a.json"), null);
});

test("#640: a THROWING capability probe refuses too — an unreadable probe is not an absent API", () => {
  const identity = createTabRouteIdentity({
    locksAvailable: () => { throw new Error("probe exploded"); },
    mintPageInstanceId: () => "never-reached",
  });
  assert.equal(identity.adopt(undefined), null);
  assert.equal(identity.established(), null);
});

test("#640: Web Locks ABSENT (plain-http LAN) mints a PAGE-INSTANCE id and says so", () => {
  const identity = createTabRouteIdentity({
    locksAvailable: () => false,
    mintPageInstanceId: () => "page-instance-1",
  });
  assert.deepEqual(identity.adopt(undefined), { id: "page-instance-1", proof: "page-instance" });
  assert.equal(identity.proof(), "page-instance", "the narrower backing must be reported, not hidden");
});

test("#640 REGRESSION: the lockless fallback must NOT read copyable per-tab storage", () => {
  // Browser tab duplication copies sessionStorage verbatim, so the stored
  // per-tab id is precisely the value two duplicated tabs would SHARE. Reading
  // it in the lockless branch re-created the #640 collision in the one mode
  // that has no lock manager to detect it. Model the duplicate: identical
  // storage, no locks — the two routes must still differ.
  const copiedStorageId = "copied-per-tab-id";
  const mint = (() => { let n = 0; return () => `page-instance-${++n}`; })();
  const original = createTabRouteIdentity({ locksAvailable: () => false, mintPageInstanceId: mint });
  const duplicate = createTabRouteIdentity({ locksAvailable: () => false, mintPageInstanceId: mint });
  original.adopt(undefined);
  duplicate.adopt(undefined);

  const path = "workflows/shared.json";
  const routeA = savedWorkflowRoute(original.established().id, path);
  const routeB = savedWorkflowRoute(duplicate.established().id, path);
  assert.notEqual(routeA, routeB, "two duplicated tabs must not share one lockless route");
  for (const route of [routeA, routeB]) {
    assert.ok(
      !route.includes(copiedStorageId),
      "the lockless id must never be sourced from storage a duplicate can copy",
    );
  }

  // ...and the shipped panel must not wire storage in either.
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /mintPageInstanceId: \(\) => crypto\.randomUUID\(\)/);
  assert.doesNotMatch(src, /tabStorageId:/, "getTabId() is copyable and must not back the route");
});

test("#640: a lease wins over the storage fallback, and the established id is then FROZEN", () => {
  const identity = createTabRouteIdentity({
    locksAvailable: () => true,
    mintPageInstanceId: () => "never-reached",
  });
  assert.deepEqual(identity.adopt("leased-id"), { id: "leased-id", proof: "exclusive" });
  // A later re-hello must not re-key the route: the route is this tab's agent
  // session key on the orchestrator, and silently changing it strands it.
  assert.deepEqual(identity.adopt("some-other-id"), { id: "leased-id", proof: "exclusive" });
});

test("#640: a tab id containing ':' is refused so <tab>:<path> can never be read two ways", () => {
  assert.equal(savedWorkflowRoute("tab:with:colons", "workflows/a.json"), null);
});

// ---------------------------------------------------------------------------
// 3. Refusal happens BEFORE dispatch (hello is what registers the route)
// ---------------------------------------------------------------------------

test("#640: a refused route means NO hello is sent — the route is never registered", async () => {
  const sent = [];
  const result = await sendBridgeHello({
    socket: { send: (frame) => sent.push(JSON.parse(frame)) },
    isCurrent: () => true,
    resolveTabIdentity: async () => undefined,
    // The panel's makePayload returns null when bridgeRouteId() refuses.
    makePayload: () => null,
  });
  assert.equal(sent.length, 0, "refusing must happen before dispatch, not be disclosed after it");
  assert.equal(result, false, "a hello that never left must not report itself as sent");
});

test("#640: an ESTABLISHED route is what actually reaches the wire", async () => {
  const locks = new FakeLocks();
  const tab = fakeTab({ locks, storageSeed: "lock-proven-tab", rotation: "unused" });
  const sent = [];
  const result = await sendBridgeHello({
    socket: { send: (frame) => sent.push(JSON.parse(frame)) },
    isCurrent: () => true,
    resolveTabIdentity: () => tab.restart.resolve(),
    makePayload: (tabSessionId) => {
      tab.route.adopt(tabSessionId);
      const routeId = savedWorkflowRoute(tab.route.established()?.id, "workflows/shared.json");
      return routeId ? buildHelloPayload({ tabId: routeId, tabSessionId }) : null;
    },
  });
  assert.equal(result, true);
  assert.equal(sent[0].tab_id, "wf:lock-proven-tab:workflows/shared.json");
  tab.restart.releaseForTests();
});

test("#640: the refusal is DISCLOSED in terms of the harm, not as a generic failure", () => {
  const text = describeRefusedRoute();
  assert.match(text, /did NOT register/, "must say the panel did not register, not that it is retrying");
  assert.match(text, /another browser tab/i);
  assert.match(text, /other\s+tab's canvas/i, "must name the actual harm being refused");
});

test("#640: a refusal while the lease is STILL PENDING does not claim contention", () => {
  const identity = createTabRouteIdentity({ locksAvailable: () => true, mintPageInstanceId: () => "x" });
  assert.equal(identity.settled(), false, "no lease attempt has completed yet");
  const pending = describeRefusedRoute({ settled: identity.settled() });
  // "Could not determine which tab holds this" is not "another tab holds this".
  assert.doesNotMatch(pending, /Another browser tab .* is holding/);
  assert.match(pending, /still establishing/i);
  assert.match(pending, /nothing ran/i, "a pre-dispatch refusal must say nothing ran");

  // Once an attempt completes, the settled wording names the likely cause —
  // "most often" another tab — without asserting it as determined.
  identity.adopt(undefined);
  assert.equal(identity.settled(), true);
  assert.match(describeRefusedRoute({ settled: identity.settled() }), /Most often another browser tab/);
});

test("#640 wiring: every refusal message is told whether the lease has settled", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const calls = src.match(/describeRefusedRoute\([^)]*\)/g) ?? [];
  assert.ok(calls.length >= 3, "hello, callTool and uploadMedia must all disclose");
  for (const call of calls) {
    assert.match(
      call,
      /settled: tabRouteIdentity\.settled\(\)/,
      `${call} must not assert contention it has not determined`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3b. Delivery — WHICH tab receives the command, and which tab's reply comes back
// ---------------------------------------------------------------------------

/**
 * The orchestrator's ui-bridge, reduced to the property that produced #640:
 * `conns` is a Map keyed by the hello `tab_id`, so a hello for an id that is
 * already registered REPLACES the connection under it. Dispatch and reply are
 * modelled separately, because a correctly-dispatched command whose reply lands
 * in another tab is the same bug.
 */
function fakeBridge() {
  const conns = new Map();
  const pending = new Map();
  return {
    hello(tabId, tab) { conns.set(tabId, tab); },
    tabCount: () => conns.size,
    /** Dispatch to a route; returns the tab that actually received it. */
    dispatch(tabId, rid) {
      const tab = conns.get(tabId);
      if (!tab) return null;
      pending.set(rid, { tabId });
      tab.inbox.push({ rid });
      return tab;
    },
    /** A tab replies on ITS OWN socket; the bridge correlates by rid. */
    reply(tab, rid, value) {
      const p = pending.get(rid);
      if (!p) return { delivered: false, reason: "no such in-flight command" };
      pending.delete(rid);
      // The bridge stamps the replying SOCKET's bound tab id, never a
      // client-supplied one — so the reply's origin is whichever tab sent it.
      return { delivered: true, from: tab.name, value };
    },
  };
}

test("#640: with path-only ids the SECOND tab steals the route and receives the first tab's command", () => {
  const bridge = fakeBridge();
  const tabA = { name: "A", inbox: [] };
  const tabB = { name: "B", inbox: [] };
  // Pre-fix: both tabs hello with `wf:<path>` because both show the same file.
  const legacyId = savedWorkflowHandle("workflows/shared.json");
  bridge.hello(legacyId, tabA);
  bridge.hello(legacyId, tabB);

  assert.equal(bridge.tabCount(), 1, "two tabs collapsed onto ONE bridge route");
  const receiver = bridge.dispatch(legacyId, "rid-1");
  // Assert WHICH tab received it — "it was delivered" passes either way.
  assert.equal(receiver.name, "B", "tab A's agent command was delivered to tab B's canvas");
  assert.deepEqual(tabA.inbox, [], "the tab that owns the session got nothing");
});

test("#640: with tab-scoped routes the command reaches the issuing tab, and so does its reply", async () => {
  const locks = new FakeLocks();
  const first = fakeTab({ locks, storageSeed: "tab-A", rotation: "unused-a" });
  const second = fakeTab({ locks, storageSeed: "tab-B", rotation: "unused-b" });
  first.route.adopt(await first.restart.resolve());
  second.route.adopt(await second.restart.resolve());

  const path = "workflows/shared.json";
  const routeA = savedWorkflowRoute(first.route.established().id, path);
  const routeB = savedWorkflowRoute(second.route.established().id, path);

  const bridge = fakeBridge();
  const tabA = { name: "A", inbox: [] };
  const tabB = { name: "B", inbox: [] };
  bridge.hello(routeA, tabA);
  bridge.hello(routeB, tabB);
  assert.equal(bridge.tabCount(), 2, "the same file in two tabs must keep two routes");

  // Dispatch path.
  const receiver = bridge.dispatch(routeA, "rid-1");
  assert.equal(receiver.name, "A", "the command must reach the tab whose route was addressed");
  assert.deepEqual(tabB.inbox, [], "the other tab must not see it at all");

  // Reply path, checked independently: the tab that DID NOT receive the command
  // cannot answer for it, and the answer that lands is stamped with its origin.
  const answer = bridge.reply(tabA, "rid-1", "outline-of-A");
  assert.deepEqual(answer, { delivered: true, from: "A", value: "outline-of-A" });
  assert.deepEqual(
    bridge.reply(tabB, "rid-1", "outline-of-B"),
    { delivered: false, reason: "no such in-flight command" },
    "a reply from the tab that never got the command must not settle it",
  );

  first.restart.releaseForTests();
  second.restart.releaseForTests();
});

test("#640: the workflow-UUID instance fence is UNCHANGED and still refuses a cross-tab command", () => {
  const tabAUuid = "11111111-1111-4111-8111-111111111111";
  const tabBUuid = "22222222-2222-4222-8222-222222222222";
  // A command stamped for tab A's workflow instance, arriving at tab B's canvas
  // (the survivable-by-luck case the routing fix removes) must still be refused.
  assert.equal(
    commandTargetsActiveWorkflow({ cmd: "set_widget", commandUuid: tabAUuid, activeUuid: tabBUuid }),
    false,
    "the last line of defence must not have been relaxed to make the symptom go away",
  );
  // ...and it still fails CLOSED for an unstamped protected command.
  assert.equal(
    commandTargetsActiveWorkflow({ cmd: "set_widget", commandUuid: undefined, activeUuid: tabBUuid }),
    false,
  );
  // The matching case still passes, so the assertion above is about the mismatch.
  assert.equal(
    commandTargetsActiveWorkflow({ cmd: "set_widget", commandUuid: tabBUuid, activeUuid: tabBUuid }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 4. Shipped-panel wiring — every wire site stamps the route
// ---------------------------------------------------------------------------

/** Source of a top-level `function name(...) { ... }` from the panel bundle. */
function namedFunctionSource(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} must exist in the shipped panel`);
  let depth = 0;
  let seen = false;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; }
    else if (src[i] === "}") { depth--; }
    if (seen && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test("#640 wiring: NO frame stamps tab_id from the path-only workflow handle", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // This is the defect in one line: any `tab_id`/`tabId` fed by workflowTabId()
  // is a wire route keyed on the FILE, which two tabs share.
  assert.doesNotMatch(
    src,
    /tab_?[Ii]d:\s*workflowTabId\(/,
    "a wire tab_id must come from bridgeRouteId(), which is tab-scoped and refusable",
  );
});

test("#640 wiring: every outbound frame site reads bridgeRouteId() and refuses on null", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // hello — the registration itself.
  assert.match(src, /tabRouteIdentity\.adopt\(tabSessionId\)/, "the route must be adopted from the COMPLETED lease");
  assert.match(src, /const liveRouteId = bridgeRouteId\(\);\s*\n\s*if \(!liveRouteId\) \{/);
  assert.match(src, /tabId: routeId,/, "the hello payload must carry the established route");
  // sendFrame — every control/agent frame.
  assert.match(src, /const routeId = bridgeRouteId\(\);\s*\n\s*if \(!routeId\) return false;/);
  assert.match(src, /sock\["send"\]\(JSON\.stringify\(\{ tab_id: routeId, \.\.\.frame \}\)\);/);
  // callTool / uploadMedia — refuse before dispatch, with the reason.
  assert.match(src, /const callRouteId = bridgeRouteId\(\);\s*\n\s*if \(!callRouteId\) \{\s*\n\s*return Promise\.reject\(new Error\(describeRefusedRoute\(/);
  assert.match(src, /const uploadRouteId = bridgeRouteId\(\);\s*\n\s*if \(!uploadRouteId\) throw new Error\(describeRefusedRoute\(/);
  assert.match(src, /tab_id: callRouteId,/);
  assert.match(src, /tab_id: uploadRouteId,/);
  // title — recorded as sent only once it ACTUALLY was: the assignment stands
  // AFTER the send inside the try, so a refused route AND a throwing send both
  // leave it unrecorded and the next title mutation retries.
  assert.match(
    src,
    /const routeId = bridgeRouteId\(\);\s*\n\s*if \(!routeId\) return;\s*\n\s*try \{(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*sock\["send"\]\(JSON\.stringify\(\{ type: "title", tab_id: routeId, title: t \}\)\);\s*\n\s*lastSentTitle = t;/,
    "a title frame must be recorded as sent only once it actually left — recording earlier suppresses the retry",
  );
  // lost_replies — advisory: omit the field rather than name an unestablished route.
  assert.match(src, /const lostRepliesRouteId = bridgeRouteId\(\);/);
  assert.match(src, /\.\.\.\(lostRepliesRouteId \? \{ tab_id: lostRepliesRouteId \} : \{\}\)/);
});

test("#640 wiring: the Blind frame no longer overrides sendFrame's route stamp", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // sendFrame spreads `...frame` AFTER tab_id, so an explicit tab_id on the
  // frame WINS. This one carried the path-only handle and silently defeated the
  // stamp for that frame alone.
  assert.match(src, /type: "set_content_mode", blind: AGENT_BLIND/);
  assert.doesNotMatch(src, /set_content_mode", tab_id:/);
});

test("#640 wiring: bridgeRouteId REFUSES rather than returning the path", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const body = namedFunctionSource(src, "bridgeRouteId");
  assert.match(body, /savedWorkflowRoute\(tabRoute, saved\)/, "the saved branch must compose the tab id in");
  assert.doesNotMatch(body, /return\s+saved\s*;/, "there must be no path fallback");
  assert.doesNotMatch(body, /savedWorkflowHandle\(/, "the route must never be the path-only handle");
  // Deleting the tab half must break the test above, not just this one.
  assert.match(body, /tabRouteIdentity\.established\(\)/);
});

test("#640 wiring: dispatch and reply share ONE spelling of the saved handle", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const handle = namedFunctionSource(src, "workflowTabId");
  const reply = namedFunctionSource(src, "establishedWorkflowReplyIdentity");
  assert.match(handle, /savedWorkflowHandle\(saved\)/);
  assert.match(reply, /savedWorkflowHandle\(savedPath\)/);
  // A second literal spelling on either side is what would silently flip every
  // workflow_list record's `active` flag to false.
  assert.doesNotMatch(reply, /`wf:\$\{/, "the reply side must not re-derive the format");
  assert.doesNotMatch(handle, /"wf:" \+/, "the dispatch side must not re-derive the format");
});

test("#640 wiring: the workflow_list `active` flag still compares like with like", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // routingKey comes from workflowTabId(w); activeRoutingKey comes from
  // establishedWorkflowReplyIdentity. Both now resolve through
  // savedWorkflowHandle, so the comparison is meaningful — assert the
  // comparison is still the one being made.
  assert.match(src, /const routingKey = workflowTabId\(w\);/);
  assert.match(src, /active: !!active && \(w === active \|\| routingKey === activeRoutingKey\)/);
});

test("#640 wiring: routing_key stays the path-only HANDLE the orchestrator corroborates", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // The orchestrator's post-open command-fence refresh accepts a saved identity
  // ONLY when routing_key === "wf:" + path (canonicalSavedRecordIdentity). The
  // recovery path in #640 depends on that refresh, so the ADVERTISED handle must
  // not become the tab-scoped route — the route belongs on the wire's tab_id.
  assert.match(src, /routing_key: routingKey,/);
  assert.doesNotMatch(src, /routing_key: bridgeRouteId\(/);
  assert.doesNotMatch(src, /routing_key: savedWorkflowRoute\(/);
});
