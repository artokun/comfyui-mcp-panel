/**
 * #986 — one finished clip re-announced six times in ~30s, each under a DIFFERENT
 * prompt id, with sub-second "render" times against a genuine 10m51s first render.
 *
 * The existing fence dedupes on prompt id, and these were genuinely different prompts:
 * the user re-queued from the canvas and ComfyUI served the identical output from
 * cache. Nothing keyed on prompt id can collapse them. What is the same is the OUTPUT.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  mediaSignature,
  createCompletionDeduper,
  duplicateSuppressedNote,
} from "../../web/js/lib/completion-dedupe.js";

const vid = (filename, subfolder = "", type = "output") => ({ filename, subfolder, type });

test("#986 the reported burst: six cached re-queues of one clip deliver ONCE", () => {
  const d = createCompletionDeduper();
  const media = [vid("Video_00144.mp4")];
  const ids = ["2d9d64f5", "c3e90187", "c5184f9e", "4ce0a352", "740ff0f5", "aa11bb22"];
  const delivered = ids.filter(
    (promptId) =>
      d.consider({ signature: mediaSignature([], media), panelQueued: false, promptId, durationMs: 100, durationTrusted: true }).deliver,
  );
  assert.deepEqual(delivered, ["2d9d64f5"], "only the first announcement survives");
});

test("#986 the suppressed ones name what they duplicate", () => {
  const d = createCompletionDeduper();
  const sig = mediaSignature([], [vid("Video_00144.mp4")]);
  d.consider({ signature: sig, panelQueued: false, promptId: "first" });
  const second = d.consider({ signature: sig, panelQueued: false, promptId: "second", durationMs: 100, durationTrusted: true });
  assert.equal(second.deliver, false);
  assert.equal(second.duplicateOf, "first");
});

test("#986 a PANEL-QUEUED run is NEVER suppressed — it was promised a notification", () => {
  // panel_run tells the agent "you will be notified automatically, do NOT poll, end
  // your turn now". Swallowing one wedges the agent forever, which is worse than the
  // duplicates this fixes.
  const d = createCompletionDeduper();
  const sig = mediaSignature([], [vid("same.mp4")]);
  assert.equal(d.consider({ signature: sig, panelQueued: false, promptId: "canvas", durationMs: 100, durationTrusted: true }).deliver, true);
  assert.equal(d.consider({ signature: sig, panelQueued: true, promptId: "panel" }).deliver, true);
  assert.equal(d.consider({ signature: sig, panelQueued: true, promptId: "panel2" }).deliver, true);
});

test("#986 a panel-queued delivery is RECORDED, so a later canvas replay is caught", () => {
  // Otherwise the first canvas re-queue after a panel run gets one free pass.
  const d = createCompletionDeduper();
  const sig = mediaSignature([], [vid("same.mp4")]);
  d.record({ signature: sig, promptId: "panel-run" });
  const replay = d.consider({ signature: sig, panelQueued: false, promptId: "canvas-replay", durationMs: 100, durationTrusted: true });
  assert.equal(replay.deliver, false);
  assert.equal(replay.duplicateOf, "panel-run");
});

test("#986 a DIFFERENT output is always delivered", () => {
  const d = createCompletionDeduper();
  const a = mediaSignature([], [vid("Video_00144.mp4")]);
  const b = mediaSignature([], [vid("Video_00145.mp4")]);
  assert.equal(d.consider({ signature: a, panelQueued: false, promptId: "1", durationMs: 100, durationTrusted: true }).deliver, true);
  assert.equal(d.consider({ signature: b, panelQueued: false, promptId: "2", durationMs: 100, durationTrusted: true }).deliver, true);
});

test("#986 the window EXPIRES — a deliberate re-render later is a real event", () => {
  let t = 0;
  const d = createCompletionDeduper({ ttlMs: 1000, now: () => t });
  const sig = mediaSignature([], [vid("same.mp4")]);
  assert.equal(d.consider({ signature: sig, panelQueued: false, promptId: "1", durationMs: 100, durationTrusted: true }).deliver, true);
  t = 500;
  assert.equal(d.consider({ signature: sig, panelQueued: false, promptId: "2", durationMs: 100, durationTrusted: true }).deliver, false);
  t = 2000; // past the window
  assert.equal(d.consider({ signature: sig, panelQueued: false, promptId: "3", durationMs: 100, durationTrusted: true }).deliver, true);
});

test("#986 signature ignores ORDER but not identity", () => {
  const a = mediaSignature([vid("a.png")], [vid("b.mp4")]);
  const b = mediaSignature([vid("a.png")], [vid("b.mp4")]);
  assert.equal(a, b);
  assert.notEqual(a, mediaSignature([vid("a.png")], [vid("c.mp4")]));
  // subfolder and type are part of identity — the same filename elsewhere is a
  // different file.
  assert.notEqual(
    mediaSignature([], [vid("v.mp4", "sub")]),
    mediaSignature([], [vid("v.mp4", "")]),
  );
  assert.notEqual(
    mediaSignature([], [vid("v.mp4", "", "output")]),
    mediaSignature([], [vid("v.mp4", "", "temp")]),
  );
});

test("#986 an UNIDENTIFIABLE media set yields no signature, and is therefore never suppressed", () => {
  // A completion with an unnamed output could otherwise collide with a different
  // unnamed output. Suppressing the wrong result costs the result itself; missing a
  // duplicate costs one redundant message.
  assert.equal(mediaSignature([], [{ subfolder: "x" }]), null);
  assert.equal(mediaSignature([], []), null);
  assert.equal(mediaSignature(null, null), null);
  const d = createCompletionDeduper();
  assert.equal(d.consider({ signature: null, panelQueued: false, promptId: "1", durationMs: 100, durationTrusted: true }).deliver, true);
  assert.equal(d.consider({ signature: null, panelQueued: false, promptId: "2", durationMs: 100, durationTrusted: true }).deliver, true);
});

test("#986 one unnamed item poisons the whole signature, rather than hashing the rest", () => {
  // Hashing only the named half would let two different sets share a signature.
  assert.equal(mediaSignature([vid("named.png")], [{ subfolder: "x" }]), null);
});

test("#986 the deduper is bounded in TIME, so it cannot grow without limit", () => {
  let t = 0;
  const d = createCompletionDeduper({ ttlMs: 100, now: () => t });
  for (let i = 0; i < 50; i++) {
    d.consider({ signature: `sig-${i}`, panelQueued: false, promptId: String(i), durationMs: 100, durationTrusted: true });
    t += 10;
  }
  assert.ok(d.size() < 50, "entries older than the window are pruned");
});

test("#986 the note explains the collapse and reassures about panel_run", () => {
  const note = duplicateSuppressedNote(5, "2d9d64f5");
  assert.match(note, /5 further completions/);
  assert.match(note, /2d9d64f5/);
  assert.match(note, /served from ComfyUI's cache/, "names the likely cause without asserting internals");
  assert.match(note, /queued through panel_run are never suppressed/, "the guarantee that matters");
  assert.equal(duplicateSuppressedNote(0, "x"), "", "silent when nothing was suppressed");
});

test("#986 (codex): a REAL re-render that overwrites the same filename is always delivered", () => {
  // The false positive that would make this worse than the bug. A node writing a fixed
  // name — no counter in the prefix — produces two genuine results with identical
  // signatures. Same filename is not the same result; what separates a cache replay
  // from a real render is that the replay did not render. 0.1s vs 10m51s, from the
  // report itself.
  const d = createCompletionDeduper();
  const sig = mediaSignature([], [vid("clip.mp4")]);
  assert.equal(d.consider({ signature: sig, panelQueued: false, promptId: "r1", durationMs: 651000, durationTrusted: true }).deliver, true);
  assert.equal(
    d.consider({ signature: sig, panelQueued: false, promptId: "r2", durationMs: 640000, durationTrusted: true }).deliver,
    true,
    "a 10-minute render is never a cache hit, whatever it is called",
  );
});

test("#986 (codex): an UNKNOWN duration never suppresses — null is not evidence of a cache hit", () => {
  const d = createCompletionDeduper();
  const sig = mediaSignature([], [vid("clip.mp4")]);
  d.consider({ signature: sig, panelQueued: false, promptId: "1", durationMs: 100, durationTrusted: true });
  for (const durationMs of [null, undefined, -1, Number.NaN, "100"]) {
    assert.equal(
      d.consider({ signature: sig, panelQueued: false, promptId: "x", durationMs, durationTrusted: true }).deliver,
      true,
      `durationMs=${String(durationMs)} must not be read as cached`,
    );
  }
});

test("#986 (codex): the signature is INJECTIVE — delimiters in a filename cannot forge a collision", () => {
  // The fields are producer-controlled. Concatenating them with delimiters let a name
  // containing one make two different sets share a signature, which here means a real
  // result is suppressed.
  const a = mediaSignature([], [vid('a", "b.mp4')]);
  const b = mediaSignature([], [vid("a", "b.mp4")]);
  assert.notEqual(a, b);
  const c = mediaSignature([], [{ filename: "x.mp4", subfolder: 'sub", "', type: "output" }]);
  const e = mediaSignature([], [{ filename: "x.mp4", subfolder: "sub", type: '", "output' }]);
  assert.notEqual(c, e);
});

test("#986 (codex r2): an UNTRUSTED duration never suppresses, however small", () => {
  // When execution_start and executing() are both dropped, the tracker invents a
  // start at the FINAL output event — so a genuine ten-minute render reports a
  // sub-second duration. Suppressing on that would lose a real result exactly when
  // frames are being dropped, which is when recovery matters most.
  const d = createCompletionDeduper();
  const sig = mediaSignature([], [vid("clip.mp4")]);
  d.consider({ signature: sig, panelQueued: false, promptId: "1", durationMs: 100, durationTrusted: true });
  assert.equal(
    d.consider({ signature: sig, panelQueued: false, promptId: "2", durationMs: 100 }).deliver,
    true,
    "durationTrusted defaults to false — an unproven duration is not evidence",
  );
  assert.equal(
    d.consider({ signature: sig, panelQueued: false, promptId: "3", durationMs: 100, durationTrusted: false }).deliver,
    true,
  );
});

test("#986 (codex r2): a video arriving in the RECONCILE wrapper signs the same as a live one", () => {
  // parseHistoryEntry wraps videos as { m, nodeId }. Signing those as null meant a
  // recovered video seeded nothing and its next replay was announced again.
  const live = mediaSignature([], [vid("Video_00144.mp4")]);
  const reconciled = mediaSignature([], [{ m: vid("Video_00144.mp4"), nodeId: "12" }]);
  assert.equal(reconciled, live, "the two paths must agree or the fence has a hole");
});

test("#986 (codex r2): fields cannot bleed into each other across the delimiter", () => {
  // `type:"output/foo" subfolder:"bar"` vs `type:"output" subfolder:"foo/bar"` produced
  // the same part when the fields were concatenated.
  const a = mediaSignature([], [{ filename: "x.png", type: "output/foo", subfolder: "bar" }]);
  const b = mediaSignature([], [{ filename: "x.png", type: "output", subfolder: "foo/bar" }]);
  assert.notEqual(a, b);
});
