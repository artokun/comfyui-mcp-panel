// What `panel_show_media` tells the agent it did — and did NOT — hand it.
//
// THE DEFECT (#648). An agent asked to inspect a local reference video hits a
// dead end. Over the orchestrator's inline ceiling the call is refused outright,
// and even when a video DOES reach the panel (as a ComfyUI /view ref, which has
// no such ceiling) the reply is `{ok:true,count:1}`: the USER gets a player, the
// agent gets a success acknowledgement for something it cannot see and no next
// step. Both readings are "this is impossible".
//
// A refusal that names no next step is the same failure as a ceiling with no way
// past it. So this module composes the reply, and every branch of it ends
// somewhere the caller can actually go from where it is.
//
// THE PREVIEW IS THE ONE THE PANEL ALREADY BUILDS. Videos route through the SAME
// pipeline the run-completion frame uses — `buildVideoStoryboard` samples frames
// off a hidden <video> into a canvas contact sheet, `uploadBlobToInput` puts the
// sheet in ComfyUI's swept temp/ namespace, `storyboardFrameCount` says how many
// cells it has. Nothing here re-implements any of that; a second storyboard
// builder that drifts from the first is a bug generator.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
//  1. BOUNDED. The pipeline contains steps that can fail to settle: a decode
//     that never fires `loadedmetadata`, an `/upload/image` with no timeout of
//     its own. `show_media` is answered under a wall clock on the orchestrator
//     side, so every preview is bounded and degrades to a note rather than
//     eating the reply.
//
//  2. NEVER PRESENT THE PREVIEW AS THE MEDIA. A contact sheet described as the
//     video is a fabricated observation — an agent that reads "20 frames" as the
//     video's length will tell the user something false about their file. Every
//     reply that carries a storyboard states, in the same breath, that the video
//     itself was not sent, that the sheet is N evenly-spaced SAMPLES, and how
//     big the source file is. This is the single most important thing here.
//
//  3. UNKNOWN IS NOT A VALUE. If the source size cannot be read, the reply says
//     it could not be read. It never omits it (an omitted size reads as "small")
//     and never guesses one.
//
// WHY THE REMEDY IS `get_image` AND NOT `panel_show_media`. `panel_show_media`
// paints into the human's chat; its reply to the agent is text. `get_image`
// returns an inline image block the agent can actually look at, and it accepts
// exactly the `{filename, type, subfolder}` shape `uploadBlobToInput` returns —
// so the sheet this module uploads is reachable in one call from the reply that
// names it. That is what makes the remedy actionable rather than decorative.

import { withTimeout } from "./bounded-step.js";

/**
 * Whole wall-clock bound for ONE video's preview (size probe + sample + upload).
 * Previews run in parallel, so a batch costs at most one of these. Deliberately
 * well under the orchestrator's 60 s `show_media` deadline: the reply must come
 * back as a degraded note, never as a transport timeout the agent cannot read.
 */
export const MEDIA_PREVIEW_TIMEOUT_MS = 20000;

/** Bound on the size probe alone, so a hanging HEAD cannot consume the budget
 *  the storyboard needs. Unknown size still produces a preview. */
export const MEDIA_SIZE_PROBE_TIMEOUT_MS = 8000;

/**
 * Filenames the panel plays as video.
 *
 * The dot is escaped, unlike the inline test this replaces (`/.(mp4|webm)$/i`),
 * where `.` matched any character — so a file ending `xmp4` was painted as a
 * video. Widened past mp4/webm because a ComfyUI /view ref can name anything on
 * disk; the orchestrator's own inline path is stricter, which is fine, this only
 * has to decide "try to sample frames from it".
 */
const VIDEO_FILENAME = /\.(?:mp4|webm|mov|m4v|mkv|avi)$/i;

const defaultCoerce = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** True when a resolved show_media item should be treated as a video. */
export function isVideoShowMediaItem(item, coerce = defaultCoerce) {
  if (!item) return false;
  if (item.kind === "video") return true;
  if (item.kind === "viewRef" && item.viewRef) {
    return VIDEO_FILENAME.test(coerce(item.viewRef.filename));
  }
  return false;
}

/**
 * Exact byte length of a base64 data URL payload, or null when it is not one.
 * Computed rather than probed — the bytes are already in hand, so there is no
 * reason to report this size as unknown.
 */
export function dataUrlByteLength(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const head = dataUrl.slice(0, comma);
  if (!/^data:/i.test(head) || !/;base64$/i.test(head)) return null;
  const body = dataUrl.slice(comma + 1).replace(/\s+/g, "");
  if (!body) return 0;
  let pad = 0;
  if (body.endsWith("==")) pad = 2;
  else if (body.endsWith("=")) pad = 1;
  const n = Math.floor((body.length * 3) / 4) - pad;
  return n >= 0 ? n : null;
}

/** "72.1 MB" when known; an explicit statement of ignorance when not. */
function sizeClause(sizeBytes, humanizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "source file size UNKNOWN (it could not be read — that is not the same as knowing it is small)";
  }
  const human = humanizeBytes(sizeBytes);
  return `source file ${human || `${sizeBytes} bytes`}`;
}

/** A ComfyUI ref written the way `get_image` takes its arguments. */
function refClause(ref, coerce) {
  const filename = coerce(ref?.filename);
  const type = coerce(ref?.type) || "output";
  const subfolder = coerce(ref?.subfolder);
  const parts = [`filename "${filename}"`, `type "${type}"`];
  if (subfolder) parts.push(`subfolder "${subfolder}"`);
  return parts.join(", ");
}

/**
 * Compose the panel's reply to one `show_media` command: paint every item for
 * the user, build a bounded sampled preview of every video, and return a reply
 * that states what the agent was and was not given.
 *
 * Resolves to `{ ok, count, painted, previews, note }`. Never rejects — a reply
 * the agent cannot read is the failure this exists to remove.
 *
 * @param {Array<object>} items resolved show_media items from the orchestrator
 * @param {object} deps injected panel helpers (see the call site)
 */
export async function composeShowMediaReply(items, deps = {}) {
  const {
    paintImage,
    paintVideo,
    imageViewUrl,
    coerceMessageText = defaultCoerce,
    buildVideoStoryboard,
    uploadBlobToInput,
    storyboardFrameCount,
    humanizeBytes = () => null,
    fetchMediaBytes = async () => null,
    videoStoryboardEnabled = true,
    warn = () => {},
    timeoutMs = MEDIA_PREVIEW_TIMEOUT_MS,
    sizeProbeTimeoutMs = MEDIA_SIZE_PROBE_TIMEOUT_MS,
    setTimer,
    clearTimer,
  } = deps;

  const list = Array.isArray(items) ? items : [];
  const jobs = [];
  let painted = 0;
  let unrendered = 0;

  // ── Paint pass ──────────────────────────────────────────────────────────
  // One item's painter throwing must not cost the whole batch its reply, and
  // must not be counted as painted — an item silently dropped is exactly the
  // kind of thing the reply has to be honest about.
  for (const item of list) {
    const caption =
      coerceMessageText(item?.caption) || coerceMessageText(item?.filename) || "";
    const isVideo = isVideoShowMediaItem(item, coerceMessageText);
    let url = null;
    let ref = null;
    let name = coerceMessageText(item?.filename);
    if (item?.kind === "viewRef" && item?.viewRef) {
      ref = item.viewRef;
      name = coerceMessageText(ref.filename) || name;
      try {
        url = imageViewUrl(ref);
      } catch (err) {
        warn("[cmcp] show_media: could not build a view URL for", name, err);
        url = null;
      }
    } else if (typeof item?.dataUrl === "string" && item.dataUrl) {
      url = item.dataUrl;
    }
    if (!url) {
      unrendered += 1;
      continue;
    }
    try {
      if (isVideo) paintVideo(url, caption);
      else paintImage(url, caption);
      painted += 1;
    } catch (err) {
      warn("[cmcp] show_media: painting failed for", name, err);
      unrendered += 1;
      continue;
    }
    if (isVideo) {
      jobs.push({
        url,
        name: name || "video",
        ref,
        // A data URL carries its own exact length; a /view ref has to be probed.
        knownBytes: ref ? null : dataUrlByteLength(url),
      });
    }
  }

  // ── Preview pass ────────────────────────────────────────────────────────
  // Parallel, each independently bounded: the batch costs one timeout window at
  // worst, and one wedged video cannot suppress another's preview.
  const segments = await Promise.all(
    jobs.map((job) =>
      buildSampledPreview(job, {
        buildVideoStoryboard,
        uploadBlobToInput,
        storyboardFrameCount,
        imageViewUrl,
        paintImage,
        humanizeBytes,
        fetchMediaBytes,
        coerceMessageText,
        videoStoryboardEnabled,
        warn,
        timeoutMs,
        sizeProbeTimeoutMs,
        setTimer,
        clearTimer,
      }).catch((err) => {
        // buildSampledPreview swallows its own failures; this is the last guard
        // so one video can never reject the batch.
        warn("[cmcp] show_media preview segment failed:", err);
        return {
          note: `${job.name} — no sampled preview could be built and the panel could not say why. Ask the user how the video looks; they can see it playing in the chat.`,
          preview: null,
        };
      }),
    ),
  );

  const previews = [];
  const noteSections = [];

  // The batch headline. It leads with the thing an agent most easily gets wrong
  // about this tool: panel_show_media paints for the HUMAN and returns text, so
  // nothing here was shown to the caller.
  const shown =
    painted === 1 ? "1 item was displayed" : `${painted} items were displayed`;
  const headline =
    `${shown} to the USER in the panel chat. You were NOT sent ` +
    (painted === 1 ? "this file" : "these files") +
    ` — this tool renders media for the person, not for you.`;
  noteSections.push(headline);

  if (unrendered > 0) {
    noteSections.push(
      `${unrendered} of the ${list.length} requested item(s) could not be rendered at all ` +
        `(no usable source), so the user did not see ${unrendered === 1 ? "it" : "them"} either. ` +
        `Re-send ${unrendered === 1 ? "it" : "them"} as an absolute path or as a ComfyUI reference with a filename.`,
    );
  }

  for (const seg of segments) {
    if (!seg) continue;
    if (seg.preview) previews.push(seg.preview);
    if (seg.note) noteSections.push(seg.note);
  }

  return {
    ok: true,
    count: list.length,
    painted,
    previews,
    note: noteSections.join("\n\n"),
  };
}

/**
 * One video's sampled preview. Returns `{ note, preview }` — `preview` is the
 * uploaded contact sheet's ref, or null when none could be produced. Never
 * throws, never rejects, and never returns a note that could be read as "here is
 * the video".
 */
async function buildSampledPreview(job, deps) {
  const {
    buildVideoStoryboard,
    uploadBlobToInput,
    storyboardFrameCount,
    imageViewUrl,
    paintImage,
    humanizeBytes,
    fetchMediaBytes,
    coerceMessageText,
    videoStoryboardEnabled,
    warn,
    timeoutMs,
    sizeProbeTimeoutMs,
    setTimer,
    clearTimer,
  } = deps;

  const timers = { setTimer, clearTimer };

  // The size probe runs alongside the storyboard and is separately bounded, so a
  // HEAD that never answers costs the reply a size — not a preview.
  const sizePromise = withTimeout(
    resolveSourceBytes(job, fetchMediaBytes, warn),
    sizeProbeTimeoutMs,
    () => null,
    timers,
  );

  const canSample =
    videoStoryboardEnabled &&
    typeof buildVideoStoryboard === "function" &&
    typeof uploadBlobToInput === "function" &&
    typeof storyboardFrameCount === "function";

  const sheetPromise = canSample
    ? withTimeout(
        produceSheet(job, {
          buildVideoStoryboard,
          uploadBlobToInput,
          storyboardFrameCount,
          warn,
        }),
        timeoutMs,
        () => {
          warn("[cmcp] show_media: sampled preview timed out for", job.name);
          return {
            ref: null,
            frames: null,
            why: `sampling it took longer than ${Math.round(timeoutMs / 1000)}s and was abandoned`,
          };
        },
        timers,
      )
    : Promise.resolve({
        ref: null,
        frames: null,
        why: videoStoryboardEnabled
          ? "this panel build cannot sample video frames"
          : "storyboard previews are turned off in the panel's settings",
      });

  const [sizeBytes, sheet] = await Promise.all([sizePromise, sheetPromise]);
  const size = sizeClause(sizeBytes, humanizeBytes);
  const outcome = sheet ?? { ref: null, frames: null, why: "the panel could not say why" };

  if (!outcome.ref) {
    return {
      note:
        `🎬 ${job.name} — you were NOT shown this video, and no sampled preview could be built ` +
        `(${outcome.why}). Its ${size}. ` +
        remedyWithoutPreview(job, coerceMessageText),
      preview: null,
    };
  }

  const n = outcome.frames;
  // Show the human the same sheet the agent is being pointed at, so what the
  // agent is judging from is visible in the chat next to the player.
  try {
    paintImage(imageViewUrl(outcome.ref), `Storyboard · ${n} frames`);
  } catch (err) {
    warn("[cmcp] show_media: could not paint the storyboard sheet", err);
  }

  return {
    preview: {
      of: job.name,
      frames: n,
      sourceBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      filename: coerceMessageText(outcome.ref.filename),
      subfolder: coerceMessageText(outcome.ref.subfolder),
      type: coerceMessageText(outcome.ref.type) || "temp",
      sampled: true,
    },
    note:
      `📽️ ${job.name} — you were NOT shown this video. What exists for you is a SAMPLED PREVIEW of it: ` +
      `a ${n}-frame contact sheet built in the browser (its ${size}). ` +
      `Those ${n} frames are evenly-spaced SAMPLES across the video — they are NOT its frame count, ` +
      `its duration, or its frame rate, so do not describe the video as ${n} frames long, and do not ` +
      `report anything about it that a ${n}-frame sample cannot show (audio, timing, brief events). ` +
      `Cells read left to right, top to bottom = start to end. ` +
      `To actually look at the sheet, call get_image with ${refClause(outcome.ref, coerceMessageText)}.`,
  };
}

/** Sample + upload. Resolves `{ref, frames, why}`; never throws. */
async function produceSheet(job, deps) {
  const { buildVideoStoryboard, uploadBlobToInput, storyboardFrameCount, warn } = deps;
  try {
    const blob = await buildVideoStoryboard(job.url);
    if (!blob) {
      warn("[cmcp] show_media: could not sample frames from", job.name);
      return {
        ref: null,
        frames: null,
        why: "its frames could not be decoded or seeked in this browser",
      };
    }
    const base = job.name.replace(/\.[^.]+$/, "") || "video";
    // #209 — a panel-generated sheet is not a user input: it goes to ComfyUI's
    // swept temp/ namespace so it cannot accumulate as permanent input litter.
    const ref = await uploadBlobToInput(blob, `storyboard_${base}.png`, { type: "temp" });
    if (!ref) {
      warn("[cmcp] show_media: storyboard upload failed for", job.name);
      return { ref: null, frames: null, why: "its contact sheet could not be uploaded to ComfyUI" };
    }
    let frames = null;
    try {
      frames = storyboardFrameCount();
    } catch {
      frames = null;
    }
    if (!Number.isFinite(frames) || frames <= 0) {
      // A sheet whose cell count is unknown cannot be described honestly, and
      // "some frames" is not a disclosure. Degrade rather than hand-wave.
      return {
        ref: null,
        frames: null,
        why: "its contact sheet was built but the panel could not say how many frames it holds",
      };
    }
    return { ref, frames, why: null };
  } catch (err) {
    warn("[cmcp] show_media: sampled preview pipeline failed:", err);
    return { ref: null, frames: null, why: "the sampling pipeline failed" };
  }
}

/** Exact length for an inlined data URL, a bounded HEAD for a /view ref. */
async function resolveSourceBytes(job, fetchMediaBytes, warn) {
  if (Number.isFinite(job.knownBytes)) return job.knownBytes;
  if (typeof fetchMediaBytes !== "function") return null;
  try {
    const n = await fetchMediaBytes(job.url);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    warn("[cmcp] show_media: could not read the source size for", job.name, err);
    return null;
  }
}

/**
 * What the caller can do when no sampled preview exists. Never "you cannot" —
 * a refusal that names no next step is the defect this whole module is fixing.
 */
function remedyWithoutPreview(job, coerce) {
  const human =
    "Ask the user how it looks — they can see it playing in the chat and can answer for the parts you cannot.";
  if (job.ref) {
    return (
      `The video is still reachable: call get_image with ${refClause(job.ref, coerce)} to save it to disk ` +
      `(a video is saved, not rendered inline, so you get a path rather than a picture — but a path is ` +
      `something a local tool can open). ` +
      human
    );
  }
  return (
    `The file is named ${job.name} and the panel has no ComfyUI reference for it, so there is nothing ` +
    `for you to re-fetch. Render or export a single still from it and show that image instead. ` +
    human
  );
}
