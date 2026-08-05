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
import { withTimeout } from "./bounded-step.js";

/**
 * Build and send the single consolidated completion frame for one finished
 * prompt. Resolves to the frame that was sent (for tests), or null when the
 * batch was empty (no frame emitted).
 *
 * @param {{promptId:(string|null), images?:any[], videos?:any[], durationMs:(number|null)}} payload
 * @param {object} deps  Injected presentation helpers (see call site).
 * @returns {Promise<object|null>}
 */
export async function composeRunCompletionFrame(
  { promptId, images = [], videos = [], durationMs },
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
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (t) => clearTimeout(t),
  } = deps;

  // One clock read for the whole run so stills and videos report the SAME
  // finished time (they're one completion).
  const finishedAt = now();
  const finishedClock = formatClock(finishedAt);
  const duration = durationMs != null ? formatDuration(durationMs) : null;

  const outImages = []; // consolidated images for the single frame
  const noteSections = []; // note segments joined into the single note
  let metadata = [];

  // ── Stills segment ─────────────────────────────────────────────────────
  if (images.length) {
    const seg = await buildStillsSegment(images, {
      coerceMessageText,
      imageViewUrl,
      fetchImageBytes,
      fetchImageDimensions,
      humanizeBytes,
      duration,
      durationMs,
      finishedClock,
      finishedAt,
    });
    outImages.push(...seg.images);
    if (seg.note) noteSections.push(seg.note);
    metadata = seg.metadata;
  }

  // ── Video segments (built in PARALLEL, each bounded, then folded in order) ─
  // Parallel + per-segment timeout means neither a slow nor a permanently-
  // pending storyboard for one video can delay or suppress the single frame:
  // the worst case is ONE timeout window, and a stalled segment degrades to its
  // note-only fallback. Order is preserved (Promise.all keeps input order), so
  // the storyboards appear in video order.
  const videoSegs = await Promise.all(
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

  if (!outImages.length && !noteSections.length) return null;

  const frame = {
    type: "agent_event",
    kind: "executed",
    images: outImages,
    note: noteSections.join("\n\n"),
    metadata,
    // Machine-readable attribution: which prompt this completion belongs to, so
    // a delayed prior-run flush can never be mistaken for the current run (#224).
    ...(promptId != null ? { prompt_id: promptId } : {}),
  };
  sendFrame(frame);
  return frame;
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
  const total = finals.length;
  const finalNameSet = finalNames;
  let metadata = [];
  try {
    metadata = await Promise.all(
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
    );
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
      if (meta.duration) parts.push(`rendered in ${meta.duration}`);
      if (meta.finishedClock) parts.push(`finished ${meta.finishedClock}`);
      return `• ${meta.filename} — ${parts.join(" · ")}`;
    });
    note += `\n${lines.join("\n")}`;
  } else if (duration || finishedClock) {
    const bits = [];
    if (duration) bits.push(`rendered in ${duration}`);
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
    if (duration) parts.push(`rendered in ${duration}`);
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
  const produce = async () => {
    try {
      const blob = await buildVideoStoryboard(imageViewUrl(m));
      if (!blob) {
        warn("[cmcp] storyboard: could not sample frames from", m?.filename);
        return { ref: null, note: noteOnly("couldn't sample a storyboard from it") };
      }
      const base = (coerceMessageText(m?.filename) || "video").replace(/\.[^.]+$/, "");
      // #209 — the storyboard contact sheet is a PANEL-GENERATED preview, not a
      // real user input; upload it into ComfyUI's swept temp/ namespace (NOT
      // input/) so it never accumulates as permanent input litter. imageViewUrl
      // reads ref.type through to the /view request, so the chat preview still
      // resolves correctly.
      const ref = await uploadBlobToInput(blob, `storyboard_${base}.png`, { type: "temp" });
      if (!ref) {
        warn("[cmcp] storyboard: upload failed for", m?.filename);
        return { ref: null, note: noteOnly("couldn't upload its storyboard") };
      }
      const n = storyboardFrameCount();
      const sizeStr = humanizeBytes(await fetchImageBytes(imageViewUrl(m)));
      // Show the user the contact sheet next to the <video> player.
      paintImage(imageViewUrl(ref), `Storyboard · ${n} frames`);
      // #609 — the review request is lawful ONLY when the storyboard pixels
      // actually reach the agent. Blind mode strips them at the sendFrame gate;
      // asking for a visual verdict on a withheld sheet makes a vision-capable
      // agent confabulate one. Both note variants are built here; the COMPOSER
      // picks one per FRAME (never per segment) right before send, so parallel
      // segments can never disagree with each other or with the gate. The blind
      // variant says so AFFIRMATIVELY (an explicit prohibition is reliable; a
      // merely-absent request is not) — the sheet is still painted for the user
      // above, so only the agent is blind.
      const header = `📽️ ${n}-frame storyboard (contact sheet) of ${videoKind} — `;
      const note =
        header +
        `frames run top-left→bottom-right = start→end. ` +
        `Review motion, sharpness, and temporal consistency.` +
        metaSuffix(sizeStr, n);
      const noteWhenBlind =
        header +
        `Blind mode is ON, so the storyboard was NOT sent to you (it is shown to the user). ` +
        `Do not comment on motion, sharpness, or visual quality — acknowledge completion and the metadata below only.` +
        metaSuffix(sizeStr, n);
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
