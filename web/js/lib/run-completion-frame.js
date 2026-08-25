// Compose EXACTLY ONE completion agent_event per finished prompt_id.
//
// The run-completion tracker (run-completion.js) delivers ONE flush payload per
// prompt with the FULL batch (stills AND videos). This module turns that payload
// into a SINGLE `agent_event` frame: the run's still images AND every video's
// storyboard consolidated into one `images` + `note` + `metadata` turn.
//
// Why this matters (#269/#468): a mixed / multi-video run must resume the agent
// with EXACTLY ONE completion frame. The prior wiring emitted a stills frame
// PLUS one frame per video, so a run with two videos woke the agent three times
// with three fragmented, separately-attributed batches. The tracker was already
// one-flush-per-prompt; the fan-out lived here, at presentation. This composer
// awaits ALL storyboards for the prompt and sends once.
//
// The module owns ONLY presentation. All I/O (frame send, metadata HEAD/decode,
// storyboard sampling/upload, formatting) is injected via `deps` so it stays a
// pure, testable function — and so a failure inside any single output can never
// wedge the one send.

// #648 — the per-segment bound below used to be a private helper in this file.
// The oversized-media preview path runs the SAME storyboard pipeline and needs
// the SAME bound, so it now lives in one place both import. Behaviour is
// unchanged except that a throwing `onTimeout`/`clearTimer` degrades instead of
// leaving the segment pending forever.
import { duplicateCompletionNote } from "./completion-dedupe.js";
import { withTimeout } from "./bounded-step.js";
import { completionCompositionDiagnostic } from "./completion-delivery-diagnostics.js";
import {
  appendStoryboardCacheBust,
  createStoryboardIdentity,
  storyboardPosterUploadName,
  storyboardUploadName,
} from "./storyboard-cache-identity.js";

// #1610 — stills metadata (HEAD /view for size + Image() decode for pixels) is
// best-effort decoration on the completion note. It is NOT needed to attach the
// output refs the agent was promised. The helpers themselves are bounded at 8 s
// each, which is LONGER than the orchestrator's synthesis grace on 0.52.45
// (`DEFAULT_SYNTHESIS_GRACE_MS = 5_000`). A stalled HEAD against a ComfyUI busy
// with the next job is enough for the orchestrator to declare the panel silent
// and synthesise a notice ~6 s later — the reported shape, and the stills twin
// of #1485. This bound is the panel's half: wait this long for metadata, then
// send the frame with the filenames it already has. Fast localhost probes still
// enrich the note; a stall cannot beat the grace.
export const STILLS_METADATA_TIMEOUT_MS = 1000;

/**
 * Build and send the single consolidated completion frame for one finished
 * prompt. Resolves to the frame that was sent (for tests), or null when the
 * batch was empty (no frame emitted).
 *
 * @param {{promptId:(string|null), images?:any[], videos?:any[], durationMs:(number|null),
 *   finishedAt?:(number|null), reconciled?:boolean}} payload
 *   `finishedAt` is epoch ms of the run's REAL finish; `reconciled` marks a
 *   completion recovered from /history rather than observed live (#1199).
 * @param {object} deps  Injected presentation helpers (see call site).
 * @returns {Promise<object|null>}
 */
export async function composeRunCompletionFrame(
  {
    promptId,
    images = [],
    videos = [],
    durationMs,
    noMedia = false,
    duplicateOf = null,
    looksCached = false,
    finishedAt: finishedAtMs = null,
    reconciled = false,
  },
  deps,
) {
  const {
    sendFrame,
    coerceMessageText,
    formatDuration,
    formatClock,
    imageViewUrl,
    fetchImageBytes,
    fetchImageDimensions,
    humanizeBytes,
    buildVideoStoryboard,
    uploadBlobToInput,
    storyboardFrameCount,
    paintImage,
    applyVideoPoster,
    videoStoryboardEnabled = true,
    // Will the agent actually RECEIVE the pixels on this frame? Blind mode
    // (#90/#174) strips `images` at the sendFrame gate — the note must not
    // request a visual review of a storyboard that was withheld, or a
    // vision-capable agent will confabulate a verdict (#609). Evaluated ONCE,
    // after every segment has resolved (see the video fold below): a per-segment
    // read would let two videos of the SAME frame disagree when the toggle
    // flips mid-composition, and a flush-start snapshot would decide on a stale
    // flag. One decision per frame, taken at the last moment before send.
    agentReceivesImages = () => true,
    now = () => new Date(),
    warn = () => {},
    // Per-video wall-clock cap. The single completion frame awaits every video
    // segment before it sends, so an UNBOUNDED storyboard step (e.g. an
    // /upload/image that never settles) would otherwise suppress the ENTIRE
    // completion — stills and all other videos included. Each segment is bounded
    // and, on timeout, degrades to its note-only fallback so the one frame always
    // sends. Injectable for tests.
    videoStoryboardTimeoutMs = 25000,
    // #1610 — same shape as the video bound, for the stills metadata probes.
    // Injectable so a test can prove a hung HEAD cannot delay sendFrame past it.
    stillsMetadataTimeoutMs = STILLS_METADATA_TIMEOUT_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = deps;

  // One clock read for the whole run so stills and videos report the SAME
  // finished time (they're one completion).
  const composedAt = now();
  // #1199 — report when the run REALLY finished whenever the tracker knows it.
  // A reconciled completion is delivered minutes-to-DAYS after it rendered, so
  // stamping the compose clock presented seven two-day-old videos as "finished
  // 7:45:29 AM" — the same second, all of them. Only a plausible epoch is
  // honoured (the tracker's live paths pass Date.now(); a relative test counter
  // is not a wall clock), otherwise the compose clock still stands.
  const realFinishedAt = epochToDate(finishedAtMs);
  const finishedAt = realFinishedAt ?? composedAt;
  // A bare time-of-day is half of why the #1199 burst read as fresh: every
  // metaSuffix line ends "finished 7:45:29 AM", which for a render from two days
  // earlier looks like this morning. When the completion is a RECOVERY, the
  // bullets carry the full local date and time so the file's real age is legible
  // on the line that names the file.
  const finishedClock =
    reconciled && realFinishedAt ? formatStamp(realFinishedAt) : formatClock(finishedAt);
  // This is the execution_start → execution_success span for the whole prompt.
  // ComfyUI may satisfy part of that prompt from its execution cache, and this
  // panel does not consume execution_cached provenance, so it is workflow time,
  // not a render benchmark.
  const duration = durationMs != null ? formatDuration(durationMs) : null;
  // Age of the completion at the moment we present it. Known ONLY when the real
  // finish time is — with an unknown finish time the age is unknown too, and is
  // said to be rather than computed as zero (which would read as "just now", the
  // very claim this fix exists to stop making).
  const recoveredAgeMs = realFinishedAt ? msBetween(realFinishedAt, composedAt) : null;
  // Machine-readable twin of the banner below, so a consumer can key the wording
  // on a FIELD instead of matching prose (#1199 asked for the flag to reach the
  // agent notification). The note states the same facts, because the note is the
  // part guaranteed to reach the agent whatever the orchestrator does with
  // metadata — the flag is the durable seam, the prose is the delivery.
  const recoveryMetadata = () =>
    reconciled
      ? {
          reconciled: true,
          finishedAt: realFinishedAt ? realFinishedAt.toISOString() : null,
          recoveredAgeMs,
        }
      : {};
  const completionDiagnostics = () =>
    completionCompositionDiagnostic({ compositionMs: msBetween(composedAt, now()) });

  const outImages = []; // consolidated images for the single frame
  const noteSections = []; // note segments joined into the single note
  // #1199 — FIRST section, ahead of even the duplicate notice, because it reframes
  // the entire completion: this run did NOT just finish. Everything below (including
  // "tell the user it's ready") has to be read as a late recovery, or the agent
  // announces files that may have been moved, renamed or overwritten days ago.
  if (reconciled) noteSections.push(recoveredCompletionNote(realFinishedAt, recoveredAgeMs));
  // #986 — this exact output has already been delivered under another prompt id. It is
  // never a reason to withhold the completion (see completion-dedupe.js), only to say so.
  if (duplicateOf) noteSections.push(duplicateCompletionNote(duplicateOf, looksCached));
  // Sections pushed ABOVE are framing, not content: they say how to read a
  // completion, never that one happened. The media-less check below must measure
  // only what the segments contribute, or a banner alone would count as "something
  // to say" and swallow the #356 no-media report — reachable for real, since the
  // reconcile path sets `noMedia` and `reconciled` on the SAME payload.
  const leadingSectionCount = noteSections.length;
  let metadata = [];

  // ── Stills + video segments in PARALLEL ────────────────────────────────
  // #1610 — these used to be sequential: stills metadata (HEAD + Image decode,
  // each bounded at 8 s inside the helpers) ran to completion BEFORE the
  // storyboard even started. A stalled /view against a busy ComfyUI therefore
  // delayed EVERYTHING, including a mixed run's sheet, past the orchestrator's
  // 5 s synthesis grace. They share no data, so they overlap; the stills
  // metadata gather is itself bounded (see buildStillsSegment) so a hang
  // cannot serialise in front of the sheet OR hold the one send. Video
  // segments stay parallel with each other, same as before. Fold order is
  // stills then videos, unchanged.
  const stillsP = images.length
    ? buildStillsSegment(images, {
        coerceMessageText,
        imageViewUrl,
        fetchImageBytes,
        fetchImageDimensions,
        humanizeBytes,
        duration,
        durationMs,
        finishedClock,
        finishedAt,
        stillsMetadataTimeoutMs,
        setTimer,
        clearTimer,
      })
    : Promise.resolve({ images: [], note: "", metadata: [] });
  const videosP = Promise.all(
    videos.map((v) =>
      buildVideoSegment(v, {
        coerceMessageText,
        formatClock,
        imageViewUrl,
        fetchImageBytes,
        humanizeBytes,
        buildVideoStoryboard,
        uploadBlobToInput,
        storyboardFrameCount,
        paintImage,
        applyVideoPoster,
        videoStoryboardEnabled,
        duration,
        finishedClock,
        warn,
        videoStoryboardTimeoutMs,
        setTimer,
        clearTimer,
      }).catch((err) => {
        // buildVideoSegment already swallows its own errors; this is a final
        // belt-and-braces guard so one video can never reject the whole batch.
        warn("[cmcp] storyboard segment failed:", err);
        return null;
      }),
    ),
  );
  const [stillsSeg, videoSegs] = await Promise.all([stillsP, videosP]);
  outImages.push(...stillsSeg.images);
  if (stillsSeg.note) noteSections.push(stillsSeg.note);
  metadata = stillsSeg.metadata;
  // #609 — ONE sighted/blind decision for the whole frame, made HERE: after the
  // slowest segment resolved and immediately before send (nothing below awaits
  // until sendFrame, so the toggle cannot interleave). A per-segment read would
  // let a fast storyboard say "Review…" while a slow one says "NOT sent" when
  // Blind flips mid-composition — and both could contradict the sendFrame gate.
  const sighted = agentReceivesImages();
  for (const seg of videoSegs) {
    if (!seg) continue;
    if (seg.ref) outImages.push(seg.ref);
    const note = sighted ? seg.note : (seg.noteWhenBlind ?? seg.note);
    if (note) noteSections.push(note);
  }

  // #356 Bug 2 — a run that finished with no image and no video still has to be
  // REPORTED when the agent was told to wait for it. panel_run's reply says "you
  // will be notified automatically — do NOT poll — end your turn now and wait", so
  // composing nothing here does not mean "nothing worth saying": it means the agent
  // waits forever and the user has to prompt again to break the stall. The promise
  // is what makes silence a defect rather than an omission.
  //
  // Only a flush that DECLARES itself media-less gets this note. An empty compose
  // arriving any other way still returns null, so the call site's existing
  // "empty batch ⇒ treat as delivered" contract is unchanged for every path that
  // relied on it.
  if (!outImages.length && noteSections.length <= leadingSectionCount) {
    if (!noMedia) return null;
    const took = durationMs != null ? ` in ${formatDuration(durationMs)}` : "";
    const frame = {
      type: "agent_event",
      kind: "executed",
      images: [],
      // Keep the framing banners (recovery / duplicate) ahead of the report —
      // a recovered media-less run is still a recovered run.
      note: [
        ...noteSections,
        `The run you queued finished successfully${took}, and produced no image or ` +
          "video output. This IS the completion you were told to wait for — nothing " +
          "further is coming, so do not keep waiting for media. If this workflow was " +
          "meant to save a file, no output node produced one; if its results are text " +
          "or other non-media outputs, read them from the run's history entry.",
      ].join("\n\n"),
      metadata: [{ outputs: "none", reason: "no_media", ...recoveryMetadata() }],
      completion_diagnostics: completionDiagnostics(),
      ...(promptId != null ? { prompt_id: promptId } : {}),
    };
    sendFrame(frame);
    return frame;
  }

  const frame = {
    type: "agent_event",
    kind: "executed",
    images: outImages,
    note: noteSections.join("\n\n"),
    metadata,
    completion_diagnostics: completionDiagnostics(),
    // Machine-readable attribution: which prompt this completion belongs to, so
    // a delayed prior-run flush can never be mistaken for the current run (#224).
    ...(promptId != null ? { prompt_id: promptId } : {}),
    // #1199 — top level, not only inside `metadata`: a video-only run produces NO
    // per-output metadata entries (those are built from stills), and that is
    // exactly the shape the reported burst arrived in. A marker that vanishes on
    // the one path the bug was reported from is not a marker.
    ...recoveryMetadata(),
  };
  sendFrame(frame);
  return frame;
}

// An epoch below this is not a wall clock — it is a relative counter (a test
// harness clock, a duration, 0). Sep 2001; every real Date.now() clears it.
const MIN_PLAUSIBLE_EPOCH_MS = 1_000_000_000_000;

/** Epoch ms → Date, or null when the value isn't a plausible wall clock (#1199). */
function epochToDate(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < MIN_PLAUSIBLE_EPOCH_MS) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Non-negative ms between two Dates, or null if either can't be read. */
function msBetween(from, to) {
  const a = from?.getTime?.();
  const b = to?.getTime?.();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/**
 * Coarse age of a recovered completion, e.g. "2 days", "6 hours", "under a minute".
 * Deliberately coarse: the point is the ORDER OF MAGNITUDE (is this minutes old or
 * days old), and false precision on a recovered run would invite the agent to
 * reason about a delay it cannot actually resolve that finely.
 */
function humanizeAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** Absolute local date AND time — a bare time-of-day is what let a two-day-old
 *  render read as "this morning" (#1199). */
function formatStamp(date) {
  try {
    return date.toLocaleString();
  } catch {
    return null;
  }
}

/**
 * The leading note for a completion recovered from /history rather than observed
 * live (#1199).
 *
 * The panel's "never lose a completion" reconcile is by design: a run whose
 * terminal event was missed (tab asleep, bridge down, WS dropped) is replayed
 * from ComfyUI's `/history` on the next reconcile edge. What was NOT by design is
 * that the replay was indistinguishable from a fresh render — so a sweep that
 * found seven prompts still pending from two nights earlier woke the agent seven
 * times, each announcing a video "ready" whose file the user had long since moved
 * out of the output directory.
 *
 * The note therefore leads with the recovery, states the real age, and explicitly
 * withdraws the freshness claim the rest of the completion text still makes.
 */
function recoveredCompletionNote(realFinishedAt, ageMs) {
  const age = humanizeAge(ageMs);
  const stamp = realFinishedAt ? formatStamp(realFinishedAt) : null;
  const when =
    age && stamp
      ? `It finished about ${age} ago (${stamp})`
      : stamp
        ? `It finished at ${stamp}`
        : `The panel could not recover when it finished, so treat its age as unknown — possibly days`;
  return (
    `⏳ RECOVERED FROM HISTORY — this run did NOT just finish. ${when}, and the ` +
    `completion is only reaching you now because the panel could not deliver it at ` +
    `the time (tab asleep, bridge down, or the connection dropped). Do not announce ` +
    `it as a fresh render: the output below may since have been moved, renamed, or ` +
    `overwritten, and a file that no longer exists will still be named here. Say ` +
    `plainly that this is a late completion for an earlier run, and confirm the file ` +
    `is still there before telling the user it is ready.`
  );
}

/**
 * Still-image portion: classify final-vs-preview, compose the note, and gather
 * per-final metadata. Returns { images, note, metadata } — never sends a frame.
 */
async function buildStillsSegment(bufImages, deps) {
  const {
    coerceMessageText,
    imageViewUrl,
    fetchImageBytes,
    fetchImageDimensions,
    humanizeBytes,
    duration,
    durationMs,
    finishedClock,
    finishedAt,
    stillsMetadataTimeoutMs = STILLS_METADATA_TIMEOUT_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = deps;

  if (!bufImages.length) return { images: [], note: "", metadata: [] };

  // Classify by ComfyUI's output type: SaveImage writes `type:"output"` with a
  // real filename = the FINAL saved result; PreviewImage writes `type:"temp"` =
  // a preview frame. Be conservative — only explicit "output" counts as final.
  const finals = [];
  const previews = [];
  for (const m of bufImages) {
    if (m && m.type === "output") finals.push(m);
    else previews.push(m);
  }
  // Send EVERYTHING for vision (the agent should see previews too), finals-first
  // so the primary result is unambiguous as image #1.
  const images = [...finals, ...previews];
  const finalNames = finals.map((m) => coerceMessageText(m?.filename)).filter(Boolean);
  const previewCount = previews.length;
  let note;
  if (finalNames.length) {
    const list = finalNames.join(", ");
    const fileWord = finalNames.length === 1 ? "output" : "outputs";
    note =
      `Run finished. FINAL ${fileWord}: ${list} ` +
      `(this is the saved result — reference THIS filename` +
      (finalNames.length === 1 ? "" : "s") +
      `).`;
    if (previewCount) {
      const frameWord = previewCount === 1 ? "preview frame" : "preview frames";
      note += ` Also shown: ${previewCount} ${frameWord} (temporary, not the final file).`;
    }
  } else {
    const previewClause =
      previewCount === 1
        ? `this image is a preview (temporary, not a final file)`
        : `these ${previewCount} images are previews (temporary, not a final file)`;
    note =
      `Run finished, but no saved output node ran — ${previewClause}. ` +
      `Add a SaveImage node to persist the result, or treat the preview as the result if that's intended.`;
  }

  // ── Rich per-output metadata (parallel, bounded, never drops the note) ──
  // #1610 — the helpers' own 8 s AbortController / Image() timeouts are NOT
  // this bound. Those stop a hang from lasting forever; this one stops a hang
  // from lasting past the orchestrator's grace. On timeout the filename note
  // still sends; size/pixels are omitted the same way a thrown gather is.
  const total = finals.length;
  const finalNameSet = finalNames;
  let metadata = [];
  try {
    const gathered = await withTimeout(
      Promise.all(
        finals.map(async (m, idx) => {
          const filename = coerceMessageText(m?.filename) || "(unknown)";
          const subfolder = coerceMessageText(m?.subfolder);
          const path = subfolder ? `${subfolder}/${filename}` : filename;
          const url = imageViewUrl(m);
          const [sizeRes, dimRes] = await Promise.allSettled([
            fetchImageBytes(url),
            fetchImageDimensions(url),
          ]);
          const sizeBytes = sizeRes.status === "fulfilled" ? sizeRes.value : null;
          const dim = dimRes.status === "fulfilled" ? dimRes.value : null;
          const siblings = finalNameSet.filter((n) => n !== filename);
          return {
            filename,
            path,
            subfolder,
            sizeBytes,
            size: humanizeBytes(sizeBytes),
            width: dim?.w ?? null,
            height: dim?.h ?? null,
            dimensions: dim ? `${dim.w}×${dim.h}` : null,
            index: idx + 1,
            total,
            siblings,
            durationMs,
            duration,
            finishedAt: finishedAt.toISOString?.() ?? null,
            finishedClock,
          };
        }),
      ),
      stillsMetadataTimeoutMs,
      () => [],
      { setTimer, clearTimer },
    );
    metadata = Array.isArray(gathered) ? gathered : [];
  } catch {
    metadata = [];
  }

  // Append the readable metadata block (one bullet per final output).
  if (metadata.length) {
    const lines = metadata.map((meta) => {
      const parts = [`path: ${meta.path}`];
      if (meta.size) parts.push(meta.size);
      if (meta.dimensions) parts.push(meta.dimensions);
      parts.push(
        meta.total === 1
          ? "single output"
          : `output ${meta.index} of ${meta.total} from this run`,
      );
      if (meta.siblings.length) parts.push(`alongside: ${meta.siblings.join(", ")}`);
      if (meta.duration) parts.push(`workflow completed in ${meta.duration}`);
      if (meta.finishedClock) parts.push(`finished ${meta.finishedClock}`);
      return `• ${meta.filename} — ${parts.join(" · ")}`;
    });
    note += `\n${lines.join("\n")}`;
  } else if (duration || finishedClock) {
    const bits = [];
    if (duration) bits.push(`workflow completed in ${duration}`);
    if (finishedClock) bits.push(`finished ${finishedClock}`);
    if (bits.length) note += `\n• ${bits.join(" · ")}`;
  }

  return { images, note, metadata };
}

/**
 * One video's portion: build a storyboard contact sheet (or a note-only fallback
 * when the storyboard can't be produced) and return { ref, note, noteWhenBlind? }.
 * `ref` is the uploaded storyboard ImageRef (or null); it never sends a frame
 * itself. `noteWhenBlind` is set only on the storyboard-success path (#609): the
 * sighted note requests a visual review, which is lawful only if the pixels ride
 * the frame — the composer picks the variant ONCE per frame, right before send.
 */
async function buildVideoSegment(v, deps) {
  const {
    coerceMessageText,
    imageViewUrl,
    fetchImageBytes,
    humanizeBytes,
    buildVideoStoryboard,
    uploadBlobToInput,
    storyboardFrameCount,
    paintImage,
    applyVideoPoster,
    videoStoryboardEnabled,
    duration,
    finishedClock,
    warn,
  } = deps;

  const {
    videoStoryboardTimeoutMs = 25000,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = deps;
  const m = v?.m;
  const isFinalVideo = m && m.type === "output";
  const fileName = coerceMessageText(m?.filename) || "video";
  const videoKind = isFinalVideo
    ? `the FINAL saved video (file ${fileName} — reference THIS filename)`
    : `a PREVIEW video (file ${fileName}, temporary — not a saved file; add/enable a save to persist it)`;
  const subfolder = coerceMessageText(m?.subfolder);
  const path = subfolder ? `${subfolder}/${fileName}` : fileName;
  const realFrames = m?.frame_count ?? m?.frameCount ?? m?.frames ?? null;
  const realFps = m?.frame_rate ?? m?.frameRate ?? m?.fps ?? null;
  const format = coerceMessageText(m?.format) || null;

  const metaSuffix = (sizeStr, storyboardN) => {
    const parts = [`path: ${path}`];
    if (format) parts.push(format);
    if (Number.isFinite(realFrames)) {
      parts.push(
        `${realFrames} frames` + (Number.isFinite(realFps) ? ` @ ${realFps} fps` : ""),
      );
    } else if (storyboardN) {
      parts.push(`${storyboardN}-frame storyboard`);
    }
    if (sizeStr) parts.push(sizeStr);
    if (duration) parts.push(`workflow completed in ${duration}`);
    if (finishedClock) parts.push(`finished ${finishedClock}`);
    return parts.length ? `\n• ${fileName} — ${parts.join(" · ")}` : "";
  };

  const noteOnly = (why) =>
    `🎬 A video rendered — ${videoKind}. You can't view it directly` +
    (why ? ` — ${why}` : "") +
    `; tell the user it's ready and ask how it looks if you need to judge it.` +
    metaSuffix(null, null);

  if (!videoStoryboardEnabled) {
    return { ref: null, note: noteOnly("storyboard preview is turned off in panel settings") };
  }
  // The storyboard pipeline (sample → upload → HEAD) contains at least one
  // UNBOUNDED step (uploadBlobToInput does a fetch with no timeout). Bound the
  // whole pipeline: on timeout, degrade to the note-only fallback so a stalled
  // upload can never suppress the run's single completion frame.
  //
  // #1485 — AND KEEP THE PIPELINE SHORT, because everything on it is time the
  // agent spends being told nothing. The run's single completion frame is not
  // sent until this resolves, and the orchestrator now gives the panel a 5 s
  // grace before it synthesises a completion of its own from ComfyUI history
  // (comfyui-mcp `DEFAULT_SYNTHESIS_GRACE_MS`, cut from 45 s on the stated
  // assumption that "the normal path lands within a second or two"). For a
  // VIDEO that assumption does not hold: measured on this repo's rig, sampling
  // alone is ~1–2 s for a 5–20 s 960×544 h264 clip, and the two PNG encodes
  // stall into the seconds often enough to have been caught in a three-run
  // sample. When the orchestrator wins that race the notice it synthesises
  // CANNOT carry the video — an .mp4 is deliberately named-but-not-attached
  // (comfyui-mcp#1861) — so the storyboard is the only thing that ever shows
  // the agent this render, and it arrives late or not at all. Hence: nothing
  // that only the USER's card needs may be awaited here, and every round trip
  // that can overlap the decode does.
  const produce = async () => {
    try {
      // #1718 — a rerender can overwrite a temp video under the same filename.
      // Give the source fetch and every derived artifact one attempt identity so
      // neither the browser nor ComfyUI's filename-based temp ref can return the
      // previous run's pixels.
      const storyboardIdentity = v?.storyboardIdentity || createStoryboardIdentity();
      const sourceUrl =
        v?.videoUrl || appendStoryboardCacheBust(imageViewUrl(m), storyboardIdentity);
      // The video's own byte size is wanted only for the note's metadata line.
      // Start its HEAD (bounded at 8 s inside fetchImageBytes) BEFORE the
      // sampling pass so the round trip overlaps the decode instead of being
      // serialised behind the sheet upload. On a remote target (a pod) that is a
      // whole network round trip taken off the completion's critical path; the
      // note is identical either way.
      // Called directly, not behind a `Promise.resolve().then(…)` hop: the point
      // is that the request is IN FLIGHT while the decode runs, and a microtask
      // hop would let the sampling pass start first. The try/catch covers a
      // helper that throws synchronously; the `.catch` covers a rejection, which
      // must cost the note its size line and nothing else — inline, the same
      // rejection fell into the segment's catch and cost the agent the sheet.
      let sizeBytes;
      try {
        sizeBytes = Promise.resolve(fetchImageBytes(sourceUrl)).catch(() => null);
      } catch {
        sizeBytes = Promise.resolve(null);
      }
      const produced = await buildVideoStoryboard(sourceUrl);
      // #1493 — the builder hands back `storyboardFailure({reason})` when it
      // could not sample the video, and that object is TRUTHY: a bare `!blob`
      // test sails straight past it and hands a plain object to
      // uploadBlobToInput, which appends it to a FormData as the string
      // "[object Object]" and uploads THAT as `storyboard_<name>.png`. The agent
      // is then shown a "20-frame storyboard" that is not an image and asked to
      // review its motion and sharpness.
      //
      // The builder's own comment says "produceSheet is the only consumer and
      // does exactly that". It was not the only consumer — this is the second
      // one, and it was the one that did not check, which is why the warning was
      // worth nothing here. Recognise SUCCESS positively, on the same test
      // produceSheet uses: a sheet is the thing with a numeric `size`. Anything
      // else — `{reason}`, `{}`, `[]`, a string — is a failure, and the reason it
      // carries is said out loud instead of being thrown away for the second
      // time.
      const asObject = produced != null && typeof produced === "object" ? produced : null;
      const named = asObject && typeof asObject.reason === "string" ? asObject.reason : null;
      const blob = asObject && typeof asObject.size === "number" && !named ? produced : null;
      if (!blob) {
        warn("[cmcp] storyboard: could not sample frames from", m?.filename, named ?? "");
        return {
          ref: null,
          note: noteOnly(
            named
              ? `couldn't sample a storyboard from it: ${named}`
              : "couldn't sample a storyboard from it",
          ),
        };
      }
      const base = (coerceMessageText(m?.filename) || "video").replace(/\.[^.]+$/, "");
      // #209 — the storyboard contact sheet is a PANEL-GENERATED preview, not a
      // real user input; upload it into ComfyUI's swept temp/ namespace (NOT
      // input/) so it never accumulates as permanent input litter. imageViewUrl
      // reads ref.type through to the /view request, so the chat preview still
      // resolves correctly.
      const ref = await uploadBlobToInput(blob, storyboardUploadName(base, storyboardIdentity), { type: "temp" });
      if (!ref) {
        warn("[cmcp] storyboard: upload failed for", m?.filename);
        return { ref: null, note: noteOnly("couldn't upload its storyboard") };
      }
      // THE GRID'S CAPACITY, which is NOT the number of frames that were
      // sampled. #648 put the real count on the blob and said, in the builder,
      // that "callers that describe the sheet must use THIS" — and then this
      // caller described the sheet with `storyboardFrameCount()` anyway. A video
      // whose frames refuse to seek paints fewer and leaves the rest BLANK, so
      // the agent was told it was looking at 20 samples while it was looking at
      // one sample and nineteen empty cells, and asked to judge motion and
      // temporal consistency across them.
      const cells = storyboardFrameCount();
      const drawn = Number.isFinite(blob.paintedFrames) ? blob.paintedFrames : null;
      const frames = drawn != null && drawn > 0 ? Math.min(drawn, cells) : null;
      // Unlike show_media's produceSheet, an unknown count does NOT withhold the
      // sheet here: this is the run's ONE completion, and dropping the only
      // viewable representation of the video to avoid an imprecise sentence would
      // cost the agent far more than the imprecision does. It is described
      // without a count instead — never with the capacity, which is the claim
      // that was actually false.
      // The head names the sheet; the disclosure is a SEPARATE sentence. Folding
      // the blank-cell caveat into the head produced "…spread across the video of
      // the FINAL saved video (file x.mp4…)", because the head is followed by
      // `of ${videoKind}` — a garbled sentence in the one place this change exists
      // to make legible (gate non-finding, fixed rather than shipped).
      const sheetHead =
        frames == null
          ? "storyboard (contact sheet)"
          : frames < cells
            ? `${cells}-cell storyboard (contact sheet)`
            : `${frames}-frame storyboard (contact sheet)`;
      const blanks = frames == null ? 0 : cells - frames;
      const blankClause =
        blanks > 0
          ? `Only ${frames} of its ${cells} cells hold a sampled frame — the other ${blanks} ` +
            `${blanks === 1 ? "is" : "are"} BLANK, so judge nothing from ${blanks === 1 ? "it" : "them"}, ` +
            `and the frames that did survive may be CLUSTERED rather than spread across the video. `
          : "";
      // THE POSTER rides along on the sheet blob (see buildVideoStoryboard), from
      // the same decode. Upload it beside the sheet and hand it back to the card,
      // which has already been painted by the time we get here — the card cannot
      // receive it as an argument, so this is a back-fill by video URL.
      //
      // Entirely best-effort: a card with no poster keeps the metadata
      // placeholder and the guessed ratio, which is exactly the behaviour before
      // this existed. Nothing below may fail the storyboard for it.
      //
      // #1485 — AND IT IS DETACHED, deliberately. The poster is for the USER's
      // video card; the agent never receives it and no part of this note depends
      // on it. Awaiting it put a full-resolution PNG encode and a second
      // `POST /upload/image` (718 KB on the clip measured here, against the
      // sheet's own 1.7 MB) between the run finishing and the agent being told
      // it finished. The card is back-filled BY URL — that is the whole reason
      // this is a back-fill and not an argument — so it lands exactly as it does
      // today, just without the completion frame waiting behind it. The catch is
      // what keeps a detached rejection from surfacing as an unhandled one.
      if (blob.posterBlob && typeof applyVideoPoster === "function") {
        void Promise.resolve()
          .then(async () => {
            const posterRef = await uploadBlobToInput(
              blob.posterBlob,
              storyboardPosterUploadName(base, storyboardIdentity),
              { type: "temp" },
            );
            if (posterRef) applyVideoPoster(sourceUrl, imageViewUrl(posterRef));
          })
          .catch((err) => {
            warn("[cmcp] storyboard: poster upload failed:", err);
          });
      }
      const sizeStr = humanizeBytes(await sizeBytes);
      // Show the user the contact sheet next to the <video> player.
      paintImage(
        imageViewUrl(ref),
        frames == null ? "Storyboard" : `Storyboard · ${frames} frames`,
      );
      // #609 — the review request is lawful ONLY when the storyboard pixels
      // actually reach the agent. Blind mode strips them at the sendFrame gate;
      // asking for a visual verdict on a withheld sheet makes a vision-capable
      // agent confabulate one. Both note variants are built here; the COMPOSER
      // picks one per FRAME (never per segment) right before send, so parallel
      // segments can never disagree with each other or with the gate. The blind
      // variant says so AFFIRMATIVELY (an explicit prohibition is reliable; a
      // merely-absent request is not) — the sheet is still painted for the user
      // above, so only the agent is blind.
      const header = `📽️ ${sheetHead} of ${videoKind} — `;
      const note =
        header +
        `frames run top-left→bottom-right = start→end. ` +
        blankClause +
        `Review motion, sharpness, and temporal consistency.` +
        metaSuffix(sizeStr, frames);
      const noteWhenBlind =
        header +
        `Blind mode is ON, so the storyboard was NOT sent to you (it is shown to the user). ` +
        `Do not comment on motion, sharpness, or visual quality — acknowledge completion and the metadata below only.` +
        metaSuffix(sizeStr, frames);
      return { ref, note, noteWhenBlind };
    } catch (err) {
      warn("[cmcp] storyboard pipeline failed:", err);
      return { ref: null, note: noteOnly("its storyboard preview failed to build") };
    }
  };
  return withTimeout(
    produce(),
    videoStoryboardTimeoutMs,
    () => {
      warn("[cmcp] storyboard: timed out for", m?.filename);
      return { ref: null, note: noteOnly("its storyboard preview timed out") };
    },
    { setTimer, clearTimer },
  );
}
