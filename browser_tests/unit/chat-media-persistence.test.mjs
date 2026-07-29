import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ChatHistoryStore,
  normalizeThread,
  mergeHistorySnapshots,
} from "../../web/js/lib/chat-history-store.js";
import { mediaRecordFor, isDurableMediaUrl, createMediaRecorder } from "../../web/js/lib/chat-media.js";

// Media persistence (#177): image/video cards are recorded as role:"media"
// messages carrying a SERVABLE url + caption. These tests assert the durable
// store keeps such messages verbatim across a persist -> reload cycle, so the
// panel's paintThread() media branch can replay them (previously media painted
// to the DOM only and vanished on reload).

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

// Minimal single-record IndexedDB fake matching the store's access pattern.
function createFakeIndexedDb(initialState = null) {
  let state = initialState == null ? null : structuredClone(initialState);
  const createDb = () => ({
    objectStoreNames: { contains: (name) => name === "snapshots" },
    createObjectStore() {},
    close() {},
    transaction: (_name, mode) => {
      const tx = { oncomplete: null, onerror: null, onabort: null,
        objectStore: () => ({
          get: () => {
            const request = { result: undefined, onsuccess: null, onerror: null };
            queueMicrotask(() => {
              request.result = state == null ? undefined : structuredClone(state);
              request.onsuccess?.();
            });
            return request;
          },
          put: (value) => {
            assert.equal(mode, "readwrite");
            state = structuredClone(value);
            queueMicrotask(() => tx.oncomplete?.());
          },
        }),
      };
      return tx;
    },
  });
  return {
    open: () => {
      const request = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null };
      queueMicrotask(() => {
        request.result = createDb();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const mediaThread = () => ({
  id: "media-thread",
  ts: 1000,
  updatedAt: 1000,
  workflowKey: "panel:global",
  msgs: [
    { id: "m-user", role: "user", text: "make me a picture", createdAt: 100 },
    { id: "m-img", role: "media", mkind: "image", url: "/view?filename=out.png&type=output", caption: "output", createdAt: 200 },
    { id: "m-vid", role: "media", mkind: "video", url: "/view?filename=clip.mp4&type=output", caption: "clip", createdAt: 300 },
  ],
});

// mediaRecordFor is the exact decision recordMedia() delegates to: it decides
// whether a painted card becomes a persisted role:"media" record. These tests
// exercise the real fix (previously the suite only seeded already-correct media
// messages, so it passed even if recordMedia never ran).

test("a live /view image paints -> exactly one durable record (#177)", () => {
  const rec = mediaRecordFor("image", "/view?filename=out.png&type=output", "output");
  assert.ok(rec, "a servable /view url is recorded");
  assert.equal(rec.role, "media");
  assert.equal(rec.mkind, "image");
  assert.equal(rec.url, "/view?filename=out.png&type=output");
});

test("an absolute http(s) media url is recorded, other schemes/paths are not", () => {
  assert.ok(mediaRecordFor("video", "https://cdn.example/clip.mp4", "c"), "http(s) is durable");
  assert.ok(isDurableMediaUrl("/api/view?filename=x.png"), "/api/view is durable");
  assert.equal(isDurableMediaUrl("/not-a-view/x.png"), false, "arbitrary path rejected");
  assert.equal(isDurableMediaUrl("//evil.example/x.png"), false, "protocol-relative rejected");
});

test("data: / blob: / whitespace-prefixed data: urls are NEVER persisted (#177 P1)", () => {
  assert.equal(mediaRecordFor("image", "data:image/png;base64,AAAA", "x"), null);
  assert.equal(mediaRecordFor("image", "   data:image/png;base64,AAAA", "x"), null, "whitespace-prefixed data: rejected");
  assert.equal(mediaRecordFor("video", "blob:http://localhost/abc-123", "x"), null, "blob: rejected (dead after reload)");
  assert.equal(mediaRecordFor("image", "file:///etc/passwd", "x"), null, "file: rejected");
});

test("replay never re-records -> reload preserves media count (#177)", () => {
  // The replay guard: paintThread() repaints stored media with replaying=true,
  // which must yield NO new record (otherwise every reload would duplicate it).
  assert.equal(mediaRecordFor("image", "/view?filename=out.png", "x", { replaying: true }), null);
  assert.equal(mediaRecordFor("video", "https://cdn.example/clip.mp4", "x", { replaying: true }), null);
});

test("normalizeThread preserves role:media messages with url/caption/kind", () => {
  const thread = normalizeThread(mediaThread());
  const media = thread.msgs.filter((m) => m.role === "media");
  assert.equal(media.length, 2);
  assert.equal(media[0].mkind, "image");
  assert.equal(media[0].url, "/view?filename=out.png&type=output");
  assert.equal(media[0].caption, "output");
  assert.equal(media[1].mkind, "video");
});

test("media messages survive a merge round-trip", () => {
  const merged = mergeHistorySnapshots({ threads: [mediaThread()], meta: {} });
  const media = merged.threads[0].msgs.filter((m) => m.role === "media");
  assert.equal(media.length, 2);
  assert.deepEqual(media.map((m) => m.mkind), ["image", "video"]);
});

test("media cards persist across a reload (persist -> new store -> load) (#177)", async () => {
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const seeded = normalizeThread(mediaThread());
  store.persist([seeded], { activeByScope: { "panel:global": "media-thread" } });
  await store.flush();

  // Simulate a hard refresh: a brand-new store instance reading the same DB.
  const reloadStore = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  const reloaded = await reloadStore.load();
  const thread = reloaded.threads.find((t) => t.id === "media-thread");
  assert.ok(thread, "thread survived reload");
  const media = thread.msgs.filter((m) => m.role === "media");
  assert.equal(media.length, 2, "both media cards survived reload");
  assert.equal(media[0].url, "/view?filename=out.png&type=output");
  assert.equal(media[1].mkind, "video");
});

// Integration seam for the PRODUCTION paint -> record -> replay flow (#177).
//
// This drives the ACTUAL production module createMediaRecorder() — the panel's
// recordMedia() delegates to `mediaRecorder.record()` and paintThread() wraps
// its replay loop in `mediaRecorder.replay()`. So breaking the record decision
// or the replay guard in production FAILS this test (it is not a replica).
//
// `record` here stands in for the panel's record() (append to thread.msgs +
// persist). What this test canNOT reach is the DOM-closure WIRING — that
// paintImage/paintVideo call mediaRecorder.record and that paintThread wraps
// its loop in mediaRecorder.replay; those two bindings are covered by live-test.

function makeThreadRecorder() {
  const thread = { id: "seam-thread", ts: 1, msgs: [] };
  let idSeq = 0;
  // Stand-in for the panel's record(): assign id + append (mirrors thread.msgs.push).
  const record = (rec) => {
    rec.id = `m${(idSeq += 1)}`;
    rec.createdAt = idSeq;
    thread.msgs.push(rec);
    return rec;
  };
  return { thread, recorder: createMediaRecorder(record) };
}

test("production seam: a live /view paint records exactly ONE message; replay leaves the count unchanged (#177)", async () => {
  const { thread, recorder } = makeThreadRecorder();

  // Live turn paints one servable image → exactly one persisted record.
  recorder.record("image", "/view?filename=out.png&type=output", "output");
  assert.equal(thread.msgs.length, 1, "one media record after a live /view paint");

  // A user attachment (data:) paints live but must NOT be persisted.
  recorder.record("image", "data:image/png;base64,AAAA", "attachment");
  assert.equal(thread.msgs.length, 1, "data: paint added no record");

  // Reload → paintThread() replays stored msgs inside recorder.replay(); the
  // guard must add ZERO (otherwise every reload would duplicate the media).
  // Drive the replay exactly as paintThread does: replay each stored media msg.
  const replayStored = () =>
    recorder.replay(() => {
      for (const m of thread.msgs.slice()) {
        if (m.role === "media") recorder.record(m.mkind, m.url, m.caption);
      }
    });

  const beforeReplay = thread.msgs.length;
  replayStored();
  assert.equal(thread.msgs.length, beforeReplay, "replay did not duplicate media");
  replayStored();
  assert.equal(thread.msgs.length, beforeReplay, "repeated replay stays stable");

  // And the count round-trips through the store the production path writes to.
  const indexedDb = createFakeIndexedDb();
  const store = new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb });
  store.persist([normalizeThread(thread)], {});
  await store.flush();
  const reloaded = await new ChatHistoryStore({ storage: createMemoryStorage(), indexedDb }).load();
  const media = reloaded.threads[0].msgs.filter((m) => m.role === "media");
  assert.equal(media.length, 1, "exactly one media message persisted");
  assert.equal(media[0].url, "/view?filename=out.png&type=output");
});
