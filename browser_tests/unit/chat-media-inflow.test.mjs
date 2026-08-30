// #2034 — "Generated media in chat" (default ON): off skips the executed
// handler's image/video/audio cards so a long video session can stay text-only.
//
// Two things are pinned here:
//
//  1. THE DECISION (lib/chat-media-inflow.js) — only an explicit stored `false`
//     hides cards. A missing or unreadable settings store answers `undefined`;
//     treating that as "off" would silently hide every returning user's output.
//
//  2. THE GATE (shipped onExecuted) — the DOM closure is not importable, so
//     these tests instantiate the production handler and assert what the
//     painters actually receive. Skipping paint skips recordMedia (the painters
//     record as they paint). Agent-visible inlineImages/videos still buffer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chatMediaEnabled } from "../../web/js/lib/chat-media-inflow.js";
import { appendImageCacheBust, appendStoryboardCacheBust, createStoryboardIdentity } from "../../web/js/lib/storyboard-cache-identity.js";
import { NO_PROMPT_KEY } from "../../web/js/lib/run-completion.js";
import { collectNodeOutputMedia } from "../../web/js/lib/node-output-media.js";

const panelSrc = readFileSync(
  new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const enSettings = JSON.parse(
  readFileSync(new URL("../../locales/en/settings.json", import.meta.url), "utf8"),
);

function onExecutedSource() {
  const start = panelSrc.indexOf("  function onExecuted(ev) {");
  const end = panelSrc.indexOf("\n  function onExecError(ev)", start);
  assert.ok(start >= 0 && end > start, "could not isolate production onExecuted");
  return panelSrc.slice(start, end);
}

/** Instantiate the production `onExecuted` with injected panel helpers. */
function productionOnExecuted({
  chatMediaSetting = undefined,
  isVideoOutput = () => false,
  isAudioOutput = () => false,
} = {}) {
  const painted = { image: [], video: [], audio: [] };
  const buffered = [];
  let settingReads = 0;
  const onExecuted = new Function(
    "imageViewUrl",
    "isVideoOutput",
    "isAudioOutput",
    "paintVideo",
    "paintAudio",
    "paintImage",
    "runCompletion",
    "stripMisattachedExecutionPreviews",
    "app",
    "createStoryboardIdentity",
    "appendStoryboardCacheBust",
    "appendImageCacheBust",
    "NO_PROMPT_KEY",
    "collectNodeOutputMedia",
    "chatMediaEnabled",
    "getSetting",
    "SETTING_CHAT_MEDIA",
    `return (${onExecutedSource().trim()});`,
  )(
    (m) =>
      `/view?filename=${m.filename}&subfolder=${m.subfolder ?? ""}&type=${m.type || "output"}`,
    isVideoOutput,
    isAudioOutput,
    (url, name) => painted.video.push({ url, name }),
    (url, name) => painted.audio.push({ url, name }),
    (url, name) => painted.image.push({ url, name }),
    { onExecuted: (promptId, output) => buffered.push({ promptId, output }) },
    () => {},
    {},
    createStoryboardIdentity,
    appendStoryboardCacheBust,
    appendImageCacheBust,
    NO_PROMPT_KEY,
    collectNodeOutputMedia,
    chatMediaEnabled,
    (id) => {
      if (id === "comfyui-mcp.chatMedia") {
        settingReads += 1;
        return typeof chatMediaSetting === "function" ? chatMediaSetting() : chatMediaSetting;
      }
      return undefined;
    },
    "comfyui-mcp.chatMedia",
  );
  return { onExecuted, painted, buffered, reads: () => settingReads };
}

test("#2034: generated media in chat is ON unless the stored value is explicitly false", () => {
  assert.equal(chatMediaEnabled(true), true);
  assert.equal(chatMediaEnabled(undefined), true);
  assert.equal(chatMediaEnabled(null), true);
  assert.equal(chatMediaEnabled(false), false);
});

test("#2034: the setting is registered as a boolean defaulting ON", () => {
  const block = panelSrc.slice(
    panelSrc.indexOf("id: SETTING_CHAT_MEDIA"),
    panelSrc.indexOf("id: SETTING_VIDEO_PREVIEWS"),
  );
  assert.ok(block.length > 0, "Generated media in chat must be registered");
  assert.match(block, /id: SETTING_CHAT_MEDIA/);
  assert.match(block, /name: "Generated media in chat"/);
  assert.match(block, /type: "boolean"/);
  assert.match(block, /defaultValue: true/);
  assert.match(
    panelSrc,
    /const SETTING_CHAT_MEDIA = "comfyui-mcp\.chatMedia"/,
    "the setting id is comfyui-mcp.chatMedia",
  );
});

test("#2034: locale names the inflow switch and no longer presents videoPreviews as that switch", () => {
  const chat = enSettings["comfyui-mcp_chatMedia"];
  assert.equal(chat.name, "Generated media in chat");
  assert.match(chat.tooltip, /text-only/);
  assert.match(chat.tooltip, /agent still receives/i);
  const previews = enSettings["comfyui-mcp_videoPreviews"];
  assert.equal(previews.name, "Inline video playback in chat");
  assert.notEqual(previews.name, "Video previews in chat");
  assert.match(previews.tooltip, /Generated media in chat/);
});

test("#2034: onExecuted consults the setting once per completion, not at mount", () => {
  const src = onExecutedSource();
  assert.match(
    src,
    /chatMediaEnabled\(getSetting\(SETTING_CHAT_MEDIA\)\)/,
    "the executed handler must ask the setting before painting cards",
  );
  assert.doesNotMatch(src, /recordMedia\(/, "skipping paint is what skips recordMedia");
  const next = [false, true];
  const { onExecuted, painted, reads } = productionOnExecuted({
    chatMediaSetting: () => next.shift(),
  });
  onExecuted({ detail: { prompt_id: "off", output: { images: [{ filename: "a.png", type: "output" }] } } });
  onExecuted({ detail: { prompt_id: "on", output: { images: [{ filename: "b.png", type: "output" }] } } });
  assert.equal(reads(), 2, "each completion re-reads the store");
  assert.equal(painted.image.length, 1, "the first completion was suppressed, the second painted");
  assert.equal(painted.image[0].name, "b.png");
});

test("#2034: an unreadable store still paints — only explicit false hides cards", () => {
  for (const setting of [undefined, null, true]) {
    const { onExecuted, painted } = productionOnExecuted({ chatMediaSetting: setting });
    onExecuted({
      detail: { prompt_id: "p", output: { images: [{ filename: "keep.png", type: "output" }] } },
    });
    assert.equal(painted.image.length, 1, `setting ${setting} must still paint`);
  }
});

test("#2034: explicit false skips image/video/audio cards but still buffers agent media", () => {
  const stills = productionOnExecuted({ chatMediaSetting: false });
  stills.onExecuted({
    detail: {
      prompt_id: "img",
      node: "save",
      output: { images: [{ filename: "out.png", type: "output" }] },
    },
  });
  assert.equal(stills.painted.image.length, 0, "the image card must not land in the transcript");
  assert.equal(stills.buffered.length, 1, "the agent still receives the still");
  assert.equal(stills.buffered[0].output.images[0].filename, "out.png");

  const videos = productionOnExecuted({
    chatMediaSetting: false,
    isVideoOutput: () => true,
  });
  videos.onExecuted({
    detail: {
      prompt_id: "vid",
      node: "vhs",
      output: { videos: [{ filename: "clip.mp4", type: "output" }] },
    },
  });
  assert.equal(videos.painted.video.length, 0, "the video card must not land in the transcript");
  assert.equal(videos.buffered.length, 1, "the agent still receives the video for storyboard/completion");
  assert.equal(videos.buffered[0].output.videos[0].m.filename, "clip.mp4");
  assert.ok(videos.buffered[0].output.videos[0].storyboardIdentity, "storyboard identity is still minted");

  const audio = productionOnExecuted({
    chatMediaSetting: false,
    isAudioOutput: () => true,
  });
  audio.onExecuted({
    detail: {
      prompt_id: "aud",
      output: { images: [{ filename: "line.wav", type: "output" }] },
    },
  });
  assert.equal(audio.painted.audio.length, 0, "the audio card must not land in the transcript");
  assert.equal(audio.buffered.length, 0, "audio still does not join the agent's inline-image delivery");
});

test("#2034: default ON still paints every kind", () => {
  const stills = productionOnExecuted();
  stills.onExecuted({
    detail: { prompt_id: "img", output: { images: [{ filename: "out.png", type: "output" }] } },
  });
  assert.equal(stills.painted.image.length, 1);

  const videos = productionOnExecuted({ isVideoOutput: () => true });
  videos.onExecuted({
    detail: { prompt_id: "vid", output: { videos: [{ filename: "clip.mp4", type: "output" }] } },
  });
  assert.equal(videos.painted.video.length, 1);

  const audio = productionOnExecuted({ isAudioOutput: () => true });
  audio.onExecuted({
    detail: { prompt_id: "aud", output: { images: [{ filename: "line.wav", type: "output" }] } },
  });
  assert.equal(audio.painted.audio.length, 1);
  assert.equal(audio.buffered.length, 0);
});

test("#2034: replay of already-recorded cards is not gated — only new executed paints are", () => {
  const replay = panelSrc.slice(
    panelSrc.indexOf('if (m.mkind === "video") paintVideo(m.url, m.caption);'),
    panelSrc.indexOf('if (m.mkind === "video") paintVideo(m.url, m.caption);') + 400,
  );
  assert.match(replay, /paintVideo\(m\.url, m\.caption\)/);
  assert.match(replay, /paintAudio\(m\.url, m\.caption\)/);
  assert.match(replay, /paintImage\(m\.url, m\.caption\)/);
  assert.doesNotMatch(replay, /chatMediaEnabled/, "stored cards still replay when the inflow switch is off");
});
