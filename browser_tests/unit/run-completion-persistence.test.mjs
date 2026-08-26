import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mergeRunCompletionMetadata,
  normalizeRunCompletionMetadata,
  parseRunCompletionIdentity,
  partitionRunCompletionMetadata,
  runCompletionKeyMatchesContext,
  runCompletionKeyMatchesRoute,
} from "../../web/js/lib/run-completion-persistence.js";

const row = ({
  routeId = "tab-a::wf:workflows/a.json",
  sessionId = "agent-session-7",
  promptId = "prompt-a",
  nonce = "queue-a",
} = {}) => ({
  routeId,
  sessionId,
  promptId,
  completionKey: JSON.stringify([routeId, sessionId, promptId, nonce]),
});

test("#1830 persisted completion identity requires matching route/session/prompt and nonce", () => {
  const valid = row();
  assert.deepEqual(parseRunCompletionIdentity(valid.completionKey), {
    completionKey: valid.completionKey,
    routeId: valid.routeId,
    sessionId: valid.sessionId,
    promptId: valid.promptId,
    nonce: "queue-a",
  });
  assert.deepEqual(normalizeRunCompletionMetadata([valid]), [valid]);

  assert.deepEqual(normalizeRunCompletionMetadata([{ ...valid, routeId: "foreign-route" }]), []);
  assert.deepEqual(normalizeRunCompletionMetadata([{ ...valid, sessionId: "foreign-session" }]), []);
  assert.deepEqual(normalizeRunCompletionMetadata([{ ...valid, promptId: "foreign-prompt" }]), []);
  assert.equal(parseRunCompletionIdentity(JSON.stringify([valid.routeId, valid.sessionId, valid.promptId])), null);
});

test("#1830 remount restores only the active route and retains foreign routes", () => {
  const active = row();
  const foreign = row({
    routeId: "tab-b::wf:workflows/b.json",
    promptId: "prompt-b",
    nonce: "queue-b",
  });
  const partitioned = partitionRunCompletionMetadata([foreign, active], active.routeId, active.sessionId);
  assert.deepEqual(partitioned.current, [active]);
  assert.deepEqual(partitioned.deferred, [foreign]);

  assert.deepEqual(
    mergeRunCompletionMetadata([], partitioned.deferred),
    [foreign],
    "acknowledging the active-route completion must not erase another route's pending row",
  );
});

test("#1830 reused prompt ids remain distinct by completion nonce", () => {
  const first = row({ nonce: "queue-a" });
  const second = row({ nonce: "queue-b" });
  assert.deepEqual(normalizeRunCompletionMetadata([first, second]), [first, second]);
});

test("#1830 keyed completion cannot leave on a replacement workflow route", () => {
  const completion = row();
  assert.equal(runCompletionKeyMatchesRoute(completion.completionKey, completion.routeId), true);
  assert.equal(runCompletionKeyMatchesRoute(completion.completionKey, "replacement-route"), false);
  assert.equal(runCompletionKeyMatchesRoute("malformed", completion.routeId), false);
  assert.equal(runCompletionKeyMatchesContext(completion.completionKey, completion.routeId, completion.sessionId), true);
  assert.equal(runCompletionKeyMatchesContext(completion.completionKey, completion.routeId, "replacement-session"), false);
});

test("#1830 id-less events never become persisted completion identities", () => {
  const invalid = row({ promptId: "" });
  assert.equal(parseRunCompletionIdentity(invalid.completionKey), null);
  assert.deepEqual(normalizeRunCompletionMetadata([invalid]), []);
});

test("#1830 production wiring owner-gates stale mount persistence and restores by route", () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../web/js/comfyui-mcp-panel.js"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // #1839 P1(b) — still partitioned by the mount's route/session, but read
  // through readRunCompletionMetadataOrUnknown so an UNREADABLE store is not
  // mistaken for an empty one (adoption is irreversible; see the route-rehydrate
  // suite).
  assert.match(source, /const completionRestoreStored = readRunCompletionMetadataOrUnknown\(\);/);
  assert.match(source, /partitionRunCompletionMetadata\(\s*completionRestoreStored \?\? \[\],\s*completionRestoreRoute,\s*completionRestoreSession/);
  assert.match(source, /if \(panelRunOwnerRef\.current !== mountOwner\) return;/);
  // #1839 P1(b) — the foreign set merged back on every write is RE-READ from the
  // ledger and filtered by the contexts this mount has adopted. It used to be the
  // mount-time `completionRestore.deferred` snapshot, which the route-change
  // rehydrate leaves stale (see run-completion-route-rehydrate.test.mjs).
  assert.match(
    source,
    /mergeRunCompletionMetadata\(\s*entries,\s*selectDeferredRunCompletionMetadata\(stored, adoptedRunCompletionContexts\),\s*\),\s*\);/,
  );
  assert.match(source, /restoreRunCompletionMetadata\(runCompletion, completionRestore\.current\)/);
  assert.match(source, /if \(!runCompletionKeyMatchesContext\(frame\.completion_key, liveRoute, liveSession\)\) return false;/);
  assert.match(source, /sendFrame: sendRunCompletionFrame/);
});
