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
  runCompletionKeyMatchesRoute,
} from "../../web/js/lib/run-completion-persistence.js";

const row = ({
  routeId = "tab-a::wf:workflows/a.json",
  sessionId = "mount-7",
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
  const partitioned = partitionRunCompletionMetadata([foreign, active], active.routeId);
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
  assert.match(source, /partitionRunCompletionMetadata\(\s*readRunCompletionMetadata\(\),\s*completionRestoreRoute/);
  assert.match(source, /if \(panelRunOwnerRef\.current !== mountOwner\) return;/);
  assert.match(source, /mergeRunCompletionMetadata\(entries, deferredRunCompletionMetadata\)/);
  assert.match(source, /restoreRunCompletionMetadata\(runCompletion, completionRestore\.current\)/);
  assert.match(source, /if \(!runCompletionKeyMatchesRoute\(frame\.completion_key, liveRoute\)\) return false;/);
  assert.match(source, /sendFrame: sendRunCompletionFrame/);
});
