import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_HISTORY_SCHEMA,
  mergeHistorySnapshots,
  normalizeThread,
  parseHistoryImport,
} from "../../web/js/lib/chat-history-store.js";

// Regression guard for panel issue #177: image/video cards are recorded as
// `role: "media"` messages so they survive a reload / thread switch. The store
// must preserve those records intact through normalization, merge, and the
// portable export/import path — otherwise media would silently vanish again.

const mediaThread = () => ({
  id: "t-media",
  schemaVersion: CHAT_HISTORY_SCHEMA,
  createdAt: 1000,
  updatedAt: 3000,
  ts: 3000,
  workflowKey: "panel:global",
  msgs: [
    { id: "m1", role: "user", text: "make me a cat", createdAt: 1000 },
    { id: "m2", role: "agent", text: "here you go", createdAt: 2000 },
    {
      id: "m3",
      role: "media",
      kind: "image",
      url: "/view?filename=cat_00001_.png&type=output",
      caption: "cat",
      createdAt: 2500,
    },
    {
      id: "m4",
      role: "media",
      kind: "video",
      url: "http://127.0.0.1:8188/view?filename=clip.mp4&type=output",
      caption: "clip",
      createdAt: 3000,
    },
  ],
});

test("normalizeThread preserves media records (url/kind/caption) so reload can replay them", () => {
  const t = normalizeThread(mediaThread());
  const media = t.msgs.filter((m) => m.role === "media");
  assert.equal(media.length, 2);
  const img = media.find((m) => m.kind === "image");
  const vid = media.find((m) => m.kind === "video");
  assert.equal(img.url, "/view?filename=cat_00001_.png&type=output");
  assert.equal(img.caption, "cat");
  assert.equal(vid.url, "http://127.0.0.1:8188/view?filename=clip.mp4&type=output");
  assert.equal(vid.caption, "clip");
});

test("media records survive a snapshot merge (the reload/restore path)", () => {
  const merged = mergeHistorySnapshots({
    schemaVersion: CHAT_HISTORY_SCHEMA,
    updatedAt: 3000,
    threads: [mediaThread()],
    meta: {},
  });
  const restored = merged.threads.find((t) => t.id === "t-media");
  const media = restored.msgs.filter((m) => m.role === "media");
  assert.equal(media.length, 2);
  assert.deepEqual(
    media.map((m) => `${m.kind}:${m.url}`).sort(),
    [
      "image:/view?filename=cat_00001_.png&type=output",
      "video:http://127.0.0.1:8188/view?filename=clip.mp4&type=output",
    ],
  );
});

test("media records round-trip through the portable export/import path", () => {
  const imported = parseHistoryImport({
    format: "comfyui-agent-panel-chat-history",
    schemaVersion: CHAT_HISTORY_SCHEMA,
    threads: [mediaThread()],
    meta: {},
  });
  const restored = imported.threads.find((t) => t.id === "t-media");
  const media = restored.msgs.filter((m) => m.role === "media");
  assert.equal(media.length, 2);
  assert.ok(media.every((m) => typeof m.url === "string" && m.url));
});
