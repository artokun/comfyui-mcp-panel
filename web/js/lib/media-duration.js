// How long a video the panel is about to preview actually is (#1270).
//
// THE DEFECT. panel_show_media paints a native <video> and the storyboard
// samples timestamps off `video.duration`. For a concat / edit-list MP4
// (title card + generated clip + end card is the report) Chromium often
// reports the FIRST clip's duration — 15s — while the container and the
// seekable range still cover the whole source (~19.5s). Native `loop` and
// `ended` then fire at that truncated number, so the tail never plays and
// the storyboard never samples it. ffprobe on the same file is fine; the
// panel was trusting the element's first answer.
//
// THE SOURCE DURATION is the longer of a finite `duration` and the last
// seekable end. A truncated default is not a duration. Sampling and looping
// both have to use this number, or the preview is a different video from
// the file the caller handed over.
//
// Kept standalone (no DOM construction) so node --test can drive the
// decisions the player and the storyboard actually ship.

/** Epsilon (seconds) for "are we at the end?" — seeking to exact duration
 *  often fails, and a 50 fps frame is 0.02s. */
export const SOURCE_END_EPSILON_S = 0.05;

function finitePositive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Last seekable end, or null when the element has no usable range. */
export function seekableEnd(media) {
  try {
    const ranges = media?.seekable;
    if (!ranges || !ranges.length) return null;
    return finitePositive(ranges.end(ranges.length - 1));
  } catch {
    return null;
  }
}

/**
 * The duration the SOURCE can actually play, not the first number the
 * element reports.
 *
 * A concat / edit-list file can report a truncated `duration` (often the
 * first clip) while remaining seekable past it. Infinity / NaN / 0 are not
 * durations. When both numbers exist, the longer one is the source.
 *
 * @param {{duration?:unknown, seekable?:{length:number, end:(i:number)=>number}}} media
 * @returns {number|null}
 */
export function sourceMediaDuration(media) {
  if (!media) return null;
  const reported = finitePositive(media.duration);
  const seekable = seekableEnd(media);
  if (reported == null) return seekable;
  if (seekable == null) return reported;
  return Math.max(reported, seekable);
}

/**
 * True when `duration` is a finite number SHORTER than the source we can
 * still seek. Callers that loop or sample on `duration` alone will cut the
 * tail off (#1270).
 */
export function durationLooksTruncated(media) {
  const reported = finitePositive(media?.duration);
  const source = sourceMediaDuration(media);
  return reported != null && source != null && source > reported + SOURCE_END_EPSILON_S;
}

/**
 * Timestamps for an N-cell storyboard across the FULL source duration.
 *
 * The previous default skipped the first 5% and last 5% ("likely black").
 * That is a truncated default: a 1.5s title card and a 3s end card on a
 * ~19.5s concat sit in those bands and never appear on the sheet. Samples
 * run 0 .. duration, with the last cell a hair before the end so a seek
 * to exact duration does not fail.
 *
 * @param {number} duration source duration in seconds
 * @param {number} n cell count
 * @returns {number[]}
 */
export function storyboardSampleTimes(duration, n) {
  const d = finitePositive(duration);
  const count = Number.isFinite(n) ? Math.trunc(n) : 0;
  if (d == null || count < 1) return [];
  if (count === 1) return [d / 2];
  const last = Math.max(0, d - 0.01);
  const times = [];
  for (let i = 0; i < count; i += 1) {
    times.push((last * i) / (count - 1));
  }
  return times;
}

/**
 * `ended` (or a native loop) fired, but the source still has tail left —
 * continue from here rather than restarting or stopping.
 */
export function shouldContinuePastReportedEnd(media) {
  const end = sourceMediaDuration(media);
  const t = Number(media?.currentTime);
  if (end == null || !Number.isFinite(t)) return false;
  return t < end - SOURCE_END_EPSILON_S;
}

/**
 * Bind a <video> so playback and looping follow the SOURCE duration.
 *
 * Native `loop` uses the (possibly truncated) `duration`. When the source
 * is longer we turn that off and:
 *   - on `ended` while the tail remains: nudge past the false end and play
 *   - on a real source end, with loop: restart from 0
 *
 * Returns an unsubscribe. No-ops on a media object that cannot listen.
 *
 * @param {{loop?:boolean, currentTime?:number, ended?:boolean, play?:()=>unknown, addEventListener?:Function, removeEventListener?:Function, duration?:unknown, seekable?:unknown}} video
 * @param {{loop?:boolean}} [opts]
 */
export function bindSourcePlayback(video, { loop = true } = {}) {
  if (!video || typeof video.addEventListener !== "function") return () => {};

  const adopt = () => {
    if (durationLooksTruncated(video)) video.loop = false;
    else if (loop) video.loop = true;
  };

  const onEnded = () => {
    const end = sourceMediaDuration(video);
    if (end == null) return;
    if (shouldContinuePastReportedEnd(video)) {
      // False `ended` at the truncated duration. Nudge into the remaining
      // source and keep playing so the tail is not dropped.
      video.currentTime = Math.min(end - 0.01, Number(video.currentTime) + 0.01);
      try {
        video.play?.();
      } catch {
        /* blocked autoplay is not a duration failure */
      }
      return;
    }
    if (loop) {
      video.currentTime = 0;
      try {
        video.play?.();
      } catch {
        /* same */
      }
    }
  };

  video.addEventListener("loadedmetadata", adopt);
  video.addEventListener("durationchange", adopt);
  // Seekable grows as the source buffers; durationchange does not always fire
  // for that, and the first clip's duration is what loadedmetadata saw.
  video.addEventListener("progress", adopt);
  video.addEventListener("ended", onEnded);
  adopt();

  return () => {
    try {
      video.removeEventListener("loadedmetadata", adopt);
      video.removeEventListener("durationchange", adopt);
      video.removeEventListener("progress", adopt);
      video.removeEventListener("ended", onEnded);
    } catch {
      /* a detached node may refuse */
    }
  };
}
