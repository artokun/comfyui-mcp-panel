// #1994 — a Codex generatedImage result must become a chat attachment.
//
// The backend already wrote the PNG and emitted generatedImage(result). The
// panel kept the text half of that payload and never handed the bytes to the
// media painter, so the sidebar stayed empty until a manual show-media call.
// These tests drive the shipped converter and the shipped message-handler
// handoff: a completed result must paint; a missing result must not.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  generatedImageDataUrl,
  generatedImageMediaItems,
  generatedImageRemainderText,
  isGeneratedImagePayload,
  presentGeneratedImage,
} from "../../web/js/lib/generated-image.js";
import { composeShowMediaReply } from "../../web/js/lib/media-preview.js";
import { coerceMessageText } from "../../web/js/lib/chat-serialize.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSrc = readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

// 1×1 PNG. Magic prefix is what the converter uses to pick image/png.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function paintHarness() {
  const painted = [];
  const showMedia = (items) =>
    composeShowMediaReply(items, {
      paintImage: (url, caption) => painted.push({ url, caption }),
      paintVideo: () => {},
      paintAudio: () => {},
      paintFileLink: () => {},
      imageViewUrl: () => null,
      coerceMessageText,
    });
  return { painted, showMedia };
}

function shippedHandoffSource() {
  const start = panelSrc.indexOf("const generatedItems = generatedImageMediaItems(msg);");
  assert.ok(start > 0, "the shipped message handler must call generatedImageMediaItems");
  const end = panelSrc.indexOf('if (msg && msg.type === "stream" && typeof msg.id === "string")', start);
  assert.ok(end > start, "could not bound the generated-image say handoff");
  return panelSrc.slice(start, end);
}

function shippedHandoffRunner() {
  const slice = shippedHandoffSource();
  return new Function(
    "generatedImageMediaItems",
    "generatedImageRemainderText",
    "coerceMessageText",
    "onShowMedia",
    "onSay",
    "msg",
    `return (async () => {\n${slice}\n})();`,
  );
}

test("#1994: a completed generatedImage result becomes a show-media image item", () => {
  const items = generatedImageMediaItems({
    type: "generatedImage",
    result: PNG_B64,
    savedPath: "C:\\\\Users\\\\x\\\\.codex\\\\generated_images\\\\ig_1.png",
  });
  assert.equal(items.length, 1, "a completed result must produce an attachment");
  assert.equal(items[0].kind, "image");
  assert.equal(items[0].dataUrl, `data:image/png;base64,${PNG_B64}`);
  assert.equal(items[0].filename, "ig_1.png");
});

test("#1994: imageGeneration with a data URL result is accepted as-is", () => {
  const dataUrl = `data:image/png;base64,${PNG_B64}`;
  const items = generatedImageMediaItems({
    type: "imageGeneration",
    status: "completed",
    result: dataUrl,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].dataUrl, dataUrl);
});

test("#1994: in-progress or result-less payloads produce no attachment", () => {
  assert.deepEqual(
    generatedImageMediaItems({ type: "generatedImage", status: "in_progress" }),
    [],
  );
  assert.deepEqual(generatedImageMediaItems({ type: "generatedImage", result: "" }), []);
  assert.deepEqual(generatedImageMediaItems({ type: "say", text: "hello" }), []);
  assert.deepEqual(generatedImageMediaItems({ result: "ok" }), []);
});

test("#1994: presentGeneratedImage paints through the shipped media renderer", async () => {
  const { painted, showMedia } = paintHarness();
  const out = await presentGeneratedImage(
    { type: "generatedImage", result: PNG_B64, savedPath: "/tmp/ig_1.png" },
    showMedia,
  );
  assert.equal(out.painted, 1, "a successful generate must report a painted card");
  assert.equal(painted.length, 1, "the chat painter must receive the attachment");
  assert.equal(painted[0].url, `data:image/png;base64,${PNG_B64}`);
  assert.equal(painted[0].caption, "ig_1.png");
});

test("#1994: a missing result fails closed — zero painted cards", async () => {
  const { painted, showMedia } = paintHarness();
  const out = await presentGeneratedImage({ type: "generatedImage" }, showMedia);
  assert.equal(out.painted, 0);
  assert.equal(painted.length, 0, "no bytes means no attachment");
});

test("#1994: image-only remainder is empty so the bubble does not dump base64", () => {
  const payload = { type: "generatedImage", result: PNG_B64 };
  assert.equal(isGeneratedImagePayload(payload), true);
  assert.equal(generatedImageRemainderText(payload), "");
  const dumped = coerceMessageText(payload);
  assert.ok(dumped.includes(PNG_B64.slice(0, 12)), "the old text path would have dumped the bytes");
});

test("#1994: a say wrapping prose plus a generated image keeps the prose", () => {
  const msg = {
    type: "say",
    text: "here is the edit",
    generatedImage: { type: "generatedImage", result: PNG_B64 },
  };
  const items = generatedImageMediaItems(msg);
  assert.equal(items.length, 1);
  assert.equal(generatedImageRemainderText(msg, items), "here is the edit");
});

test("#1994: generatedImage(result) as a raw string field still paints", async () => {
  const { painted, showMedia } = paintHarness();
  const out = await presentGeneratedImage({ generatedImage: PNG_B64 }, showMedia);
  assert.equal(out.painted, 1);
  assert.equal(painted.length, 1);
  assert.equal(painted[0].url, generatedImageDataUrl(PNG_B64));
});

test("#1994: the shipped dispatcher imports and runs the generated-image handoff", async () => {
  assert.match(
    panelSrc,
    /import \{ generatedImageMediaItems, generatedImageRemainderText \} from "\.\/lib\/generated-image\.js";/,
    "the panel must import the converter, not a replica",
  );
  const slice = shippedHandoffSource();
  assert.match(slice, /await onShowMedia\(generatedItems\)/, "the handoff must paint through onShowMedia");
  assert.match(slice, /generatedImageRemainderText\(msg, generatedItems\)/, "prose must come from the remainder helper");

  const { painted, showMedia } = paintHarness();
  const said = [];
  const run = shippedHandoffRunner();
  await run(
    generatedImageMediaItems,
    generatedImageRemainderText,
    coerceMessageText,
    showMedia,
    (text) => said.push(text),
    { type: "generatedImage", result: PNG_B64, savedPath: "out.png" },
  );
  assert.equal(painted.length, 1, "the shipped handler must hand the result to the painter");
  assert.equal(painted[0].url, generatedImageDataUrl(PNG_B64));
  assert.equal(painted[0].caption, "out.png");
  assert.deepEqual(said, [], "an image-only frame must not also emit a JSON bubble");
});

test("#1994: the shipped say path paints the attachment and keeps leftover text", async () => {
  const { painted, showMedia } = paintHarness();
  const said = [];
  const run = shippedHandoffRunner();
  await run(
    generatedImageMediaItems,
    generatedImageRemainderText,
    coerceMessageText,
    showMedia,
    (text, meta) => said.push({ text, meta }),
    {
      type: "say",
      id: "m-img",
      streamed: true,
      text: "done",
      item: { type: "imageGeneration", status: "completed", result: PNG_B64, savedPath: "edit.png" },
    },
  );
  assert.equal(painted.length, 1, "the say frame must still surface the generated attachment");
  assert.equal(painted[0].url, generatedImageDataUrl(PNG_B64));
  assert.equal(painted[0].caption, "edit.png");
  assert.equal(said.length, 1);
  assert.equal(said[0].text, "done");
  assert.equal(said[0].meta.id, "m-img");
});
