// panel#356 Bug 2 — placeholder pinning the CURRENT behaviour; the fix follows.
import test from "node:test";
import assert from "node:assert/strict";
import { composeRunCompletionFrame } from "../../web/js/lib/run-completion-frame.js";

test("#356 today: a run with no images and no videos composes NO frame at all", async () => {
  const sent = [];
  const frame = await composeRunCompletionFrame(
    { promptId: "p1", images: [], videos: [], durationMs: 3 },
    { sendFrame: (f) => (sent.push(f), true), agentReceivesImages: () => true, warn: () => {} },
  );
  // The agent was told to end its turn and wait. Nothing is ever sent.
  assert.equal(frame, null);
  assert.deepEqual(sent, []);
});
