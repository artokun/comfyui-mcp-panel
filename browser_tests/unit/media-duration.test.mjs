/**
 * #1270 — the video preview must use the SOURCE duration, not a truncated
 * default. These tests call the shipped helpers; a source pin then proves
 * the panel actually uses them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  SOURCE_END_EPSILON_S,
  bindSourcePlayback,
  durationLooksTruncated,
  seekableEnd,
  shouldContinuePastReportedEnd,
  sourceMediaDuration,
  storyboardSampleTimes,
} from "../../web/js/lib/media-duration.js";

const PANEL = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);

/** Fake media element: duration + an optional seekable range. */
function media({ duration, seekable, currentTime = 0 } = {}) {
  const end = seekable;
  return {
    duration,
    currentTime,
    ended: false,
    loop: true,
    seekable:
      Number.isFinite(end) && end > 0
        ? {
            length: 1,
            end: (i) => {
              if (i !== 0) throw new Error("out of range");
              return end;
            },
          }
        : { length: 0, end: () => 0 },
  };
}

// ── source duration ────────────────────────────────────────────────────────

test("#1270: a concat whose element reports the FIRST clip still yields the source length", () => {
  // The report: 19.56s container, Chromium `duration` = 15s (the generated
  // clip), seekable still covers the title + clip + end card.
  const el = media({ duration: 15, seekable: 19.56 });
  assert.equal(sourceMediaDuration(el), 19.56);
  assert.equal(durationLooksTruncated(el), true);
});

test("#1270: when duration and seekable agree, that number is the source", () => {
  const el = media({ duration: 19.56, seekable: 19.56 });
  assert.equal(sourceMediaDuration(el), 19.56);
  assert.equal(durationLooksTruncated(el), false);
});

test("#1270: Infinity / NaN / 0 duration fall through to the seekable range", () => {
  assert.equal(sourceMediaDuration(media({ duration: Infinity, seekable: 19.56 })), 19.56);
  assert.equal(sourceMediaDuration(media({ duration: NaN, seekable: 19.56 })), 19.56);
  assert.equal(sourceMediaDuration(media({ duration: 0, seekable: 19.56 })), 19.56);
  assert.equal(sourceMediaDuration(media({ duration: -1, seekable: 19.56 })), 19.56);
});

test("#1270: no usable number is null — never a default duration", () => {
  assert.equal(sourceMediaDuration(null), null);
  assert.equal(sourceMediaDuration(undefined), null);
  assert.equal(sourceMediaDuration(media({ duration: Infinity })), null);
  assert.equal(sourceMediaDuration(media({ duration: NaN })), null);
  assert.equal(sourceMediaDuration({}), null);
});

test("#1270: a seekable.end that throws is not a duration", () => {
  const el = {
    duration: 15,
    seekable: {
      length: 1,
      end: () => {
        throw new Error("detached");
      },
    },
  };
  assert.equal(seekableEnd(el), null);
  assert.equal(sourceMediaDuration(el), 15);
  assert.equal(durationLooksTruncated(el), false);
});

test("#1270: the longer of the two finite numbers wins", () => {
  // Duration can also be the LONGER one (a padded container); do not
  // prefer seekable just because it exists.
  assert.equal(sourceMediaDuration(media({ duration: 20, seekable: 15 })), 20);
});

// ── storyboard samples span the source, not a 5–95% default ────────────────

test("#1270: storyboard samples run from 0 to the source end", () => {
  const times = storyboardSampleTimes(19.56, 5);
  assert.equal(times.length, 5);
  assert.equal(times[0], 0);
  assert.ok(times[times.length - 1] > 19.5, "the last cell is the source tail, not 95%");
  assert.ok(times[times.length - 1] < 19.56, "seeking to exact duration often fails");
  // The previous HEAD=0.05 / TAIL=0.95 default put the first cell at 0.978s
  // and the last at 18.58s — missing the title card and most of the end card.
  assert.ok(times[0] < 0.05 * 19.56, "must not skip the first 5%");
  assert.ok(times[times.length - 1] > 0.95 * 19.56, "must not stop at 95%");
});

test("#1270: a single cell lands at the midpoint of the SOURCE duration", () => {
  assert.deepEqual(storyboardSampleTimes(19.56, 1), [9.78]);
  // Not the midpoint of a truncated 15s default.
  assert.notDeepEqual(storyboardSampleTimes(19.56, 1), [7.5]);
});

test("#1270: garbage duration / count produce no timestamps", () => {
  assert.deepEqual(storyboardSampleTimes(0, 5), []);
  assert.deepEqual(storyboardSampleTimes(NaN, 5), []);
  assert.deepEqual(storyboardSampleTimes(Infinity, 5), []);
  assert.deepEqual(storyboardSampleTimes(19.56, 0), []);
  assert.deepEqual(storyboardSampleTimes(19.56, -1), []);
  assert.deepEqual(storyboardSampleTimes(19.56, 0.4), []);
});

// ── playback continues past a truncated `ended` ────────────────────────────

test("#1270: ended at the reported 15s is not the source end", () => {
  const el = media({ duration: 15, seekable: 19.56, currentTime: 15 });
  assert.equal(shouldContinuePastReportedEnd(el), true);
});

test("#1270: ended at the source tail is the real end", () => {
  const el = media({ duration: 15, seekable: 19.56, currentTime: 19.56 });
  assert.equal(shouldContinuePastReportedEnd(el), false);
});

test("#1270: bindSourcePlayback continues past a false ended, then loops at the source end", () => {
  const listeners = new Map();
  const plays = [];
  const el = media({ duration: 15, seekable: 19.56, currentTime: 15 });
  el.addEventListener = (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(fn);
  };
  el.removeEventListener = (name, fn) => {
    const list = listeners.get(name) || [];
    listeners.set(
      name,
      list.filter((f) => f !== fn),
    );
  };
  el.play = () => {
    plays.push(el.currentTime);
  };

  const stop = bindSourcePlayback(el, { loop: true });
  assert.equal(el.loop, false, "native loop would restart at the truncated duration");

  for (const fn of listeners.get("ended") || []) fn();
  assert.ok(el.currentTime > 15, "must nudge into the remaining source, not restart");
  assert.ok(el.currentTime < 19.56);
  assert.equal(plays.length, 1);

  // Real source end → restart from 0.
  el.currentTime = 19.56;
  for (const fn of listeners.get("ended") || []) fn();
  assert.equal(el.currentTime, 0);
  assert.equal(plays.length, 2);

  stop();
  assert.equal((listeners.get("ended") || []).length, 0, "unsubscribe must detach");
});

test("#1270: bindSourcePlayback is a no-op on something that cannot listen", () => {
  assert.equal(typeof bindSourcePlayback(null), "function");
  bindSourcePlayback(null)();
  bindSourcePlayback({})();
});

test("#1270: the epsilon the helpers share is the one they compare against", () => {
  // A currentTime inside the epsilon of the source is the end, not "more tail".
  const el = media({
    duration: 15,
    seekable: 19.56,
    currentTime: 19.56 - SOURCE_END_EPSILON_S + 0.001,
  });
  assert.equal(shouldContinuePastReportedEnd(el), false);
});

// ── the panel actually ships these helpers ─────────────────────────────────

test("#1270: the storyboard builder samples the source duration, not video.duration", () => {
  const start = PANEL.indexOf("async function buildVideoStoryboard(");
  assert.ok(start > 0, "could not locate buildVideoStoryboard");
  const body = PANEL.slice(start, start + 4500);
  assert.match(body, /sourceMediaDuration\(video\)/, "must read the source duration");
  assert.match(body, /storyboardSampleTimes\(/, "must sample across that duration");
  assert.doesNotMatch(
    body,
    /const duration = Number\(video\.duration\)/,
    "the truncated element duration is not the source",
  );
  assert.doesNotMatch(body, /STORYBOARD\.HEAD/, "the 5% head skip is the truncated default");
  assert.doesNotMatch(body, /STORYBOARD\.TAIL/, "the 95% tail cut is the truncated default");
});

test("#1270: the chat player and the lightbox bind source-duration playback", () => {
  const mountStart = PANEL.indexOf("function mountHolderVideo(holder) {");
  const mountEnd = PANEL.indexOf("function unmountHolderVideo(holder) {");
  assert.ok(mountStart > 0 && mountEnd > mountStart, "could not bound mountHolderVideo");
  const mount = PANEL.slice(mountStart, mountEnd);
  assert.match(mount, /preload = "auto"/, "metadata-only preload is what reports the first clip");
  assert.match(mount, /bindSourcePlayback\(v/, "native loop would cut the tail off");

  const unmount = PANEL.slice(mountEnd, PANEL.indexOf("function paintVideo("));
  assert.match(unmount, /_releasePlayback/, "unmount must drop the source-loop listeners");

  const lbStart = PANEL.indexOf("if (it.type === \"video\") {");
  assert.ok(lbStart > 0, "could not locate the lightbox video branch");
  const lb = PANEL.slice(lbStart, lbStart + 800);
  assert.match(lb, /bindSourcePlayback\(v/, "the lightbox is the same player");
});

test("#1270: the panel imports the shipped helpers — deleting the import cannot stay green", () => {
  assert.match(
    PANEL,
    /import \{\s*bindSourcePlayback,\s*sourceMediaDuration,\s*storyboardSampleTimes,\s*\} from "\.\/lib\/media-duration\.js";/,
  );
});
