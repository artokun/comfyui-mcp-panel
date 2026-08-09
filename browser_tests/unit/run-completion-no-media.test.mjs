// panel#356 Bug 2 — placeholder pinning the CURRENT behaviour; the fix follows.
import test from "node:test";
import assert from "node:assert/strict";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

const deps = (sent) => ({
  sendFrame: (f) => (sent.push(f), true),
  coerceMessageText: (s) => String(s ?? ""),
  formatDuration: (ms) => `${ms}ms`,
  formatClock: () => "12:00:00",
  agentReceivesImages: () => true,
  warn: () => {},
});

test("#356 today: a run with no images and no videos composes NO frame at all", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p1", images: [], videos: [], durationMs: 3 },
    deps(sent),
  );
  // The agent was told to end its turn and wait. Nothing is ever sent.
  assert.equal(frame, null);
  assert.deepEqual(sent, []);
});
