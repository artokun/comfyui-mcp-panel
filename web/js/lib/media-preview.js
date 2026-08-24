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
import {
  appendStoryboardCacheBust,
  createStoryboardIdentity,
  storyboardUploadName,
} from "./storyboard-cache-identity.js";

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

/** Bound on the browser-side /view availability check for a ComfyUI ref. */
export const MEDIA_VIEW_PROBE_TIMEOUT_MS = 4000;

/**
 * WHAT THE PANEL CAN ACTUALLY PRESENT (#710).
 *
 * The panel knew exactly two kinds, and everything that was not a video was
 * painted with `<img>`. A ComfyUI /view ref can name ANYTHING on disk, so an
 * audio output reached the image branch: the user got a broken-image icon with
 * a caption under it, and the reply still said `painted:N, unconfirmed:0`. The
 * agent then told them to listen to something nobody could hear.
 *
 * So the kinds are an ALLOWLIST per element, and "not video" is no longer a
 * synonym for "image". Each set is what that HTML element can actually play or
 * draw — the question being answered is "can the person perceive this in the
 * chat", which is a browser-decoding question, not a ComfyUI one:
 *
 *  - IMAGE  — deliberately generous, because this is the common path and a
 *             legitimate image demoted to a link card is a regression a user
 *             feels immediately. `gif` stays here (animated gifs render in
 *             `<img>`), matching the panel's own isVideoOutput.
 *  - VIDEO  — unchanged from the set this module already sampled frames from.
 *  - AUDIO  — the suite's `upload_image action:"stage"` kind:"audio" set
 *             (wav/mp3/flac/ogg/m4a/aac), PLUS oga/opus: that set governs what
 *             ComfyUI's loaders accept, whereas this one governs what an
 *             `<audio>` element decodes, and the Ogg family plays fine.
 *
 * Anything else is UNKNOWN, which is a decision and not a fallback: an unknown
 * kind is never handed to a painter that will render it wrong, and never
 * counted as painted.
 */
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".apng", ".bmp", ".tif", ".tiff",
  ".avif", ".ico", ".ppm", ".heic", ".heif", ".svg",
]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"]);
const AUDIO_EXTENSIONS = new Set([
  ".wav", ".mp3", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac",
]);

/** The filename with a `?query` / `#fragment` tail removed. */
function filenameStem(filename) {
  return String(filename).split("#")[0].split("?")[0];
}

/**
 * The filename's extension, lowercased, WITH its dot — or "" when it has none.
 *
 * Read off the stem, so `clip.mp4?download=1` is still `.mp4`: a ref whose
 * filename arrives with a query string must not be demoted to another kind,
 * which for a video would skip the storyboard and the whole sampled-preview
 * disclosure this module exists to produce.
 *
 * The dot is REQUIRED rather than implied, which is the structural version of
 * the fix that escaped it in the old `/.(mp4|webm)$/i` (where `.` matched any
 * character, so a file ending `xmp4` was painted as a video). A name with no dot
 * has no extension here, and no set can match "".
 */
function extensionOf(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filenameStem(filename));
  return m ? `.${m[1].toLowerCase()}` : "";
}

const defaultCoerce = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));

function kindForExtension(ext) {
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}

/**
 * What kind of media one resolved show_media item is: `{ kind, ext }` where
 * kind is "image" | "video" | "audio" | "unknown".
 *
 * THREE SOURCES OF TRUTH, IN THIS ORDER, because they are not equally informed:
 *
 *  1. The orchestrator's OWN `kind`. It set it from the file's extension and
 *     built the data URL's MIME from the same decision, so second-guessing it
 *     here would put two disagreeing classifiers on one item.
 *  2. A /view ref's FILENAME. The orchestrator forwards these unclassified
 *     (it never reads the bytes), so the panel is the first place that can
 *     decide — this is the path the audio in #710 arrived on.
 *  3. A data URL's declared MIME, for an item carrying neither. Nothing the
 *     orchestrator sends today lands here; it is the honest answer for a
 *     caller that hands over bytes without saying what they are.
 *
 * An item with no signal at all is UNKNOWN, never "probably an image".
 */
export function classifyShowMediaItem(item, coerce = defaultCoerce) {
  if (!item) return { kind: "unknown", ext: "" };
  const refName = item.kind === "viewRef" ? coerce(item.viewRef?.filename) : "";
  const name = refName || coerce(item.filename);
  const ext = extensionOf(name);
  if (item.kind === "image" || item.kind === "video" || item.kind === "audio") {
    return { kind: item.kind, ext };
  }
  if (name) {
    const byName = kindForExtension(ext);
    if (byName !== "unknown") return { kind: byName, ext };
  }
  if (typeof item.dataUrl === "string") {
    const m = /^data:(image|video|audio)\//i.exec(item.dataUrl);
    if (m) return { kind: m[1].toLowerCase(), ext };
  }
  return { kind: "unknown", ext };
}

/** True when a resolved show_media item should be treated as a video. */
export function isVideoShowMediaItem(item, coerce = defaultCoerce) {
  return classifyShowMediaItem(item, coerce).kind === "video";
}

/**
 * Exact byte length of a base64 data URL payload, or null when the payload is
 * not one this function can measure EXACTLY. Computed rather than probed — the
 * bytes are already in hand, so there is no reason to call this size unknown.
 *
 * The payload is validated before it is measured, because the arithmetic is
 * happy to measure nonsense: `…;base64,A` is not a legal base64 body but
 * `floor(1*3/4)` is 0, and `…;base64,!!!!` is not base64 at all but measures 3.
 * Both would have told the agent the source file was a few bytes — an invented
 * size, and precisely the "unknown reported as a value" failure this module
 * exists to avoid. Anything that does not decode cleanly is null, i.e. unknown.
 *
 * NOTHING IS NORMALISED THAT THE DECODER WOULD NOT NORMALISE. An earlier version
 * stripped `\s+`, which in JavaScript includes U+00A0, U+2028 and friends — so
 * `…;base64,AA==<NBSP>` was scrubbed until it parsed and reported ONE BYTE for a
 * payload no browser will decode. A validator that cleans its input until it
 * passes certifies something the real consumer rejects. Only the five ASCII
 * whitespace characters are removed, which is exactly what the forgiving-base64
 * algorithm behind `atob`/`data:` ignores; every other character has to be in
 * the alphabet or the answer is unknown.
 */
const BASE64_ASCII_WHITESPACE = /[\t\n\f\r ]/g;

export function dataUrlByteLength(dataUrl) {
  if (typeof dataUrl !== "string") return null;
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const head = dataUrl.slice(0, comma);
  if (!/^data:/i.test(head) || !/;base64$/i.test(head)) return null;
  const body = dataUrl.slice(comma + 1).replace(BASE64_ASCII_WHITESPACE, "");
  if (!body) return 0;
  // Standard base64: the alphabet, and padding only at the end. Padding is
  // OPTIONAL — browsers decode an unpadded data URL body happily, so requiring
  // a multiple of four would call a perfectly measurable payload unknown.
  // base64url (-_) is deliberately unknown rather than decoded by a rule this
  // function has not verified.
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(body);
  if (!m) return null;
  const chars = m[1].length;
  const pad = m[2].length;
  // A trailing group of one character encodes nothing; padding must complete a
  // group, and a complete group needs none.
  if (chars % 4 === 1) return null;
  if (pad > 0 && ((chars + pad) % 4 !== 0 || chars % 4 === 0)) return null;
  return Math.floor((chars * 3) / 4);
}

/** "72.1 MB" when known; an explicit statement of ignorance when not. */
function sizeClause(sizeBytes, humanizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    return "source file size UNKNOWN (it could not be read — that is not the same as knowing it is small)";
  }
  let human = null;
  try {
    human = humanizeBytes(sizeBytes);
  } catch {
    human = null;
  }
  return `source file ${human || `${sizeBytes} bytes`}`;
}

/**
 * How to describe the sheet's cells truthfully.
 *
 * `cells` is the grid's capacity; `frames` is how many of them a frame was
 * actually drawn into. They differ whenever a cell could not be filled, and
 * reporting the capacity as the sample count is a fabricated observation of
 * exactly the kind this module exists to prevent — so when they differ, both
 * are stated.
 *
 * The REASON a cell is blank is deliberately not named. The builder skips a
 * cell when a seek fails AND when the draw fails after a successful seek, and
 * it does not distinguish the two — so "could not be seeked" would be a
 * fabricated diagnosis in the second case, handed to an agent that will repeat
 * it. "Could not be captured" is what is actually known.
 */
function sheetClause(frames, cells) {
  if (Number.isFinite(cells) && cells > frames) {
    const blank = cells - frames;
    return (
      `a contact sheet of ${cells} cells, ${frames} of which hold a sampled frame ` +
      `(the other ${blank} could not be captured and are blank — judge nothing from them)`
    );
  }
  return `a ${frames}-frame contact sheet`;
}

/**
 * Whether the surviving frames are actually spread across the video.
 *
 * The builder aims at evenly-spaced timestamps but SKIPS the ones it cannot
 * seek, so a sheet missing cells is not a sample of the whole video — the
 * frames it does hold may all sit near the start. Calling those "evenly-spaced
 * samples across the video" claims coverage that was not observed, which is the
 * same fabrication as calling the sheet the video, one level down. Only a sheet
 * whose every planned cell was filled may claim even spacing.
 */
function spacingClause(frames, cells) {
  if (Number.isFinite(cells) && frames === cells) {
    return `Those ${frames} frames are evenly-spaced SAMPLES across the video`;
  }
  return (
    `Those ${frames} frames are SAMPLES taken at whichever of the planned, evenly-spaced ` +
    `positions could be captured — the ones that survived may be CLUSTERED rather than spread ` +
    `across the video, so do not assume they cover it`
  );
}

/**
 * Call a painter without letting it throw OR reject.
 *
 * Returns "shown", "failed", or "unconfirmed". A painter that settles later
 * cannot be confirmed from here, so it is neither counted as shown nor left to
 * surface as an unhandled rejection. Both painting sites go through this — the
 * batch pass and the storyboard sheet — because a second, hand-rolled copy is
 * how the sheet's painter ended up unguarded in the first place.
 */
function safePaint(paint, url, caption, warn, what) {
  let outcome;
  try {
    outcome = paint(url, caption);
  } catch (err) {
    warn("[cmcp] show_media: painting failed for", what, err);
    return "failed";
  }
  // Reading and calling `.then` are themselves operations that can fail — a
  // getter that throws, or a thenable whose `then` throws — and doing either
  // outside the guard rejected the whole reply, which is the failure this
  // helper exists to prevent.
  let deferred = false;
  try {
    deferred = !!outcome && typeof outcome.then === "function";
    if (deferred) {
      outcome.then(null, (err) =>
        warn("[cmcp] show_media: a deferred painter rejected for", what, err),
      );
    }
  } catch (err) {
    warn("[cmcp] show_media: a painter's own thenable threw for", what, err);
    return "unconfirmed";
  }
  return deferred ? "unconfirmed" : "shown";
}

/** A failed browser-side /view check, or null when the check passed. */
function viewProbeFailure(result) {
  try {
    if (result === true || (result && result.ok === true)) return null;
    if (result && typeof result.reason === "string" && result.reason.trim()) {
      return result.reason.trim();
    }
  } catch {
    // A malformed probe result must still become an honest delivery failure.
  }
  return "the panel could not verify that the requested /view media was served";
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
 * Compose the panel's reply to one `show_media` command: present every item to
 * the user with the element its KIND actually needs, build a bounded sampled
 * preview of every video, and return a reply that states what the agent was and
 * was not given.
 *
 * Resolves to `{ ok, count, painted, unconfirmed, unrenderable, previews, note }`.
 * Never rejects — a reply the agent cannot read is the failure this exists to
 * remove.
 *
 * `painted` counts ONLY items the person can now see or hear. An item whose kind
 * the panel cannot present is reported in `unrenderable` instead (#710): it is
 * the difference between "the user can hear this" and "I was handed something I
 * could not present", and an agent that cannot tell them apart will confidently
 * ask about a file nobody perceived.
 *
 * @param {Array<object>} items resolved show_media items from the orchestrator
 * @param {object} deps injected panel helpers (see the call site)
 */
export async function composeShowMediaReply(items, deps = {}) {
  const {
    paintImage,
    paintVideo,
    paintAudio,
    paintFileLink,
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
    viewProbeTimeoutMs = MEDIA_VIEW_PROBE_TIMEOUT_MS,
    probeMedia,
    setTimer,
    clearTimer,
  } = deps;

  // EVERY injected helper is an operation that can fail, including the trivial
  // ones. A throwing `coerceMessageText` or `warn` used to reject this function
  // before it composed anything — i.e. the agent got a transport error instead
  // of a reply, which is the dead end this module exists to remove. Text
  // helpers are wrapped once here; the I/O helpers are guarded at their sites.
  const text = (v) => {
    try {
      return coerceMessageText(v) ?? "";
    } catch {
      return "";
    }
  };
  const note = (...a) => {
    try {
      warn(...a);
    } catch {
      /* a logger that throws must not become the failure it was logging */
    }
  };

  const list = Array.isArray(items) ? items : [];
  const jobs = [];
  let painted = 0;
  let unconfirmed = 0;
  /** How many of `painted` the user can SEE vs HEAR — the headline must not
   *  call an audio player a display, and must not leave the agent to guess
   *  which sense it is talking about. */
  const paintedByKind = { image: 0, video: 0, audio: 0 };
  /** Items the user cannot see, each with the REASON it is missing. */
  const dropped = [];
  /** Items of a kind the panel cannot present at all (#710). Reported apart
   *  from `painted` because a link the user has to open is not a rendering,
   *  and apart from `dropped` because the user was still given SOMETHING. */
  const unrenderable = [];
  /** Audio the user can play. Each gets its own disclosure below, because an
   *  audio card is the one thing here an agent is most likely to narrate
   *  without having heard it. */
  const audible = [];

  const painterFor = { image: paintImage, video: paintVideo, audio: paintAudio };

  // ── Paint pass ──────────────────────────────────────────────────────────
  // One item's painter throwing must not cost the whole batch its reply, and
  // must not be counted as painted — an item silently dropped is exactly the
  // kind of thing the reply has to be honest about. Each drop carries its own
  // reason: "no usable source" is one specific cause, and using it for every
  // cause sends the caller to re-send a file that was perfectly resolvable.
  for (const item of list) {
    const caption = text(item?.caption) || text(item?.filename) || "";
    const { kind, ext } = classifyShowMediaItem(item, text);
    const isVideo = kind === "video";
    const storyboardIdentity = isVideo ? createStoryboardIdentity() : null;
    let url = null;
    let ref = null;
    let why = null;
    let name = text(item?.filename);
    if (item?.kind === "viewRef" && item?.viewRef) {
      ref = item.viewRef;
      name = text(ref.filename) || name;
      try {
        url = imageViewUrl(ref);
      } catch (err) {
        note("[cmcp] show_media: could not build a view URL for", name, err);
        url = null;
      }
      // Keyed on the OUTCOME, not on whether it threw. A URL builder that
      // returns null instead of throwing is the same failure, and reporting it
      // as "carried neither inline data nor a ComfyUI reference" is false — the
      // reference is right there, and the caller would be told to re-send
      // something it already sent correctly.
      if (!url) why = "the panel could not build a view URL for its ComfyUI reference";
      // #1718 — a temp video can be rerendered in place. The stable /view URL
      // otherwise lets the browser sample the previous video's bytes.
      if (isVideo && url) url = appendStoryboardCacheBust(url, storyboardIdentity);
    } else if (typeof item?.dataUrl === "string" && item.dataUrl) {
      url = item.dataUrl;
    }
    if (!url) {
      dropped.push({
        name,
        why:
          why ??
          "no usable source — it carried neither inline data nor a ComfyUI reference with a filename",
        // A failed URL build is NOT a dead end: the reference itself is right
        // here, and get_image resolves it without going through the panel's URL
        // builder at all.
        remedy: ref
          ? `The reference itself is intact — call get_image with ${refClause(ref, text)}, ` +
            `which fetches it without the panel's URL builder (an image comes back inline; a video is ` +
            `saved to disk and you get a path).`
          : `Re-send it as an absolute path on the orchestrator host, or as a ComfyUI reference with a ` +
            `filename.`,
      });
      continue;
    }
    // A kind with no painter here is NOT painted as an image. That fallback is
    // the whole of #710: an `<img>` pointed at an audio file is a broken-image
    // icon, and the reply counted it as a success. The user still gets a link
    // card — the person can open the file themselves, which is exactly the
    // workaround the reporter ended up performing by hand — but a link is not a
    // rendering, so it is reported as unrenderable rather than as painted.
    const painter = painterFor[kind];
    if (typeof painter !== "function") {
      const linkState =
        typeof paintFileLink === "function"
          ? safePaint(paintFileLink, url, caption, note, name)
          : "failed";
      unrenderable.push({
        name,
        ext,
        kind,
        shown: linkState === "shown" ? "link" : linkState === "unconfirmed" ? "unconfirmed" : "nothing",
        // The two ways to land here are genuinely different diagnoses, and one
        // of them is a panel wiring bug the agent should not describe as a
        // property of the user's file.
        why:
          kind === "unknown"
            ? `the panel has no viewer or player for ${ext ? `"${ext}" files` : "a file with no extension"}`
            : `this panel build has no ${kind} player wired, so it could not present a ${kind} file`,
        // get_image is only a remedy when it will actually answer. It returns
        // image/video/audio payloads and REFUSES anything else, so offering it
        // for an unknown kind would be a next step that cannot be taken — the
        // exact defect the rest of this module exists to remove.
        remedy:
          kind === "unknown"
            ? `get_image returns only image/video/audio payloads and refuses anything else, so do not ` +
              `assume you can fetch it either. Ask the user what they need from the file, or re-send it ` +
              `as an image, video or audio file.`
            : ref
              ? `The file itself is fine — call get_image with ${refClause(ref, text)} to save it to disk ` +
                `and get a path a local tool can open, and tell the user their player did not appear.`
              : `The file itself is fine; this tool never sends it to you either. Tell the user their ` +
                `player did not appear.`,
      });
      continue;
    }
    // A viewRef is fetched by the browser AFTER this handler returns. A card
    // created before that request answers is not evidence that the requested
    // media can be served — especially on a remote/authenticated /view route.
    // Probe the same URL in the panel's browser session first, and fail closed
    // when it is unavailable or the probe is inconclusive. Inline data URLs do
    // not take this branch: their bytes are already in the panel.
    if (ref && typeof probeMedia === "function") {
      const probe = await withTimeout(
        Promise.resolve().then(() => probeMedia(url, ref)),
        viewProbeTimeoutMs,
        () => ({
          ok: false,
          reason: "the panel's /view availability probe timed out before it answered",
        }),
        { setTimer, clearTimer },
      );
      const probeWhy = viewProbeFailure(probe);
      if (probeWhy) {
        dropped.push({
          name,
          why: `the panel could not serve its ComfyUI /view reference: ${probeWhy}`,
          remedy:
            `The reference itself is intact — call get_image with ${refClause(ref, text)} ` +
            `to fetch it without relying on this panel's browser /view session, then fix the ` +
            `remote /view authorization or target and retry panel_show_media.`,
        });
        continue;
      }
    }
    const shownState = safePaint(painter, url, caption, note, name);
    if (shownState === "failed") {
      dropped.push({
        name,
        why: "the panel's own painter failed while putting it in the chat",
        // "Re-sending will not help" is true and is not a next step. What the
        // caller can still do depends on what it has: a video always gets its
        // own sampled-preview note below, and anything with a ComfyUI reference
        // can be fetched directly.
        remedy: isVideo
          ? `The file itself resolved fine, so re-sending it unchanged will not help — see this video's ` +
            `sampled-preview note below for what you can still do with it, and tell the user their ` +
            `player did not appear.`
          : (ref
              ? `The file itself resolved fine, so re-sending it unchanged will not help. To ` +
                (kind === "audio"
                  ? // An audio file is NOT returned inline, so "it returns the
                    // image inline" would promise the agent a perception it
                    // cannot have.
                    `get the file YOURSELF, call get_image with ${refClause(ref, text)} — audio is saved ` +
                    `to disk rather than returned to you, so you get a path a local tool can open, and ` +
                    `you still cannot hear it. `
                  : `see it YOURSELF, call get_image with ${refClause(ref, text)} — it returns the image inline. `)
              : `The file itself resolved fine, so re-sending it unchanged will not help; this tool never ` +
                `sends it to you either. Put it somewhere ComfyUI serves and call get_image on it if you ` +
                `need to look at it. `) +
            `To get it in front of the USER, ask them to reload the panel and try again.`,
      });
    } else if (shownState === "unconfirmed") {
      unconfirmed += 1;
    } else {
      painted += 1;
      paintedByKind[kind] += 1;
    }
    // Audio that reached a painter — confirmed or not — gets its own disclosure.
    // A player in the chat is the user's to hear and NOT the agent's, and that
    // asymmetry is what an agent narrating a voice line gets wrong.
    if (kind === "audio" && shownState !== "failed") {
      audible.push({ name: name || "audio", ref, shown: shownState });
    }
    // A video's sampled preview needs only the URL — not the chat player — so a
    // painter failure must NOT also cost the agent its preview.
    if (isVideo) {
      jobs.push({
        url,
        name: name || "video",
        ref,
        storyboardIdentity,
        // Whether the USER got a player. The no-preview remedy leans on "ask
        // the user"; telling the agent to ask about something the user cannot
        // see is a remedy that does not work from where the caller is.
        shown: shownState,
        // A data URL carries its own exact length; a /view ref has to be probed.
        inline: !ref,
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
        coerceMessageText: text,
        videoStoryboardEnabled,
        warn: note,
        timeoutMs,
        sizeProbeTimeoutMs,
        setTimer,
        clearTimer,
      }).catch((err) => {
        // buildSampledPreview swallows its own failures; this is the last guard
        // so one video can never reject the batch.
        note("[cmcp] show_media preview segment failed:", err);
        return {
          note:
            `${job.name} — you were NOT shown this video, no sampled preview could be built, and the ` +
            `panel could not say why. ` +
            remedyWithoutPreview(job, text),
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
  //
  // Seen and heard are counted APART. "3 items were displayed" over a batch that
  // was two pictures and a voice line is the same class of error as the broken
  // <img> it replaces: it tells the agent something about the user's senses that
  // did not happen.
  const seen = paintedByKind.image + paintedByKind.video;
  const heard = paintedByKind.audio;
  const shown = seen === 1 ? "1 item was displayed" : `${seen} items were displayed`;
  const players =
    heard === 1 ? "1 audio player was placed" : `${heard} audio players were placed`;
  const clauses = [];
  // A batch that presented nothing still needs the "0 items were displayed"
  // clause — the reply must state the outcome, not omit it.
  if (seen > 0 || heard === 0) clauses.push(`${shown} to the USER in the panel chat`);
  if (heard > 0) {
    clauses.push(seen > 0 ? `${players} there too` : `${players} in the panel chat for the USER`);
  }
  const headline =
    `${clauses.join(", and ")}. You were NOT sent ` +
    (painted === 1 ? "this file" : "these files") +
    ` — this tool renders media for the person, not for you.` +
    (heard > 0 ? ` You cannot hear the audio.` : "");
  noteSections.push(headline);

  if (dropped.length > 0) {
    noteSections.push(
      `${dropped.length} of the ${list.length} requested item(s) were NOT displayed, so the user ` +
        `cannot see or hear ${dropped.length === 1 ? "it" : "them"} either:\n` +
        dropped
          .map((d) => `• ${d.name || "(unnamed item)"} — ${d.why}. ${d.remedy}`)
          .join("\n"),
    );
  }

  // Items of a kind this panel cannot present. Kept SEPARATE from both painted
  // and dropped: the user got a link, which is real and actionable, and is also
  // not a rendering. An agent that reads this must come away unable to say the
  // person saw or heard the content.
  if (unrenderable.length > 0) {
    const kinds = [...new Set(unrenderable.map((u) => u.ext || "no extension"))].join(", ");
    noteSections.push(
      `${unrenderable.length} of the ${list.length} requested item(s) are of a kind the panel cannot ` +
        `present (${kinds}) — the USER has NOT seen or heard the content, so do not tell them to look ` +
        `at or listen to ${unrenderable.length === 1 ? "it" : "them"}:\n` +
        unrenderable
          .map((u) => {
            const got =
              u.shown === "link"
                ? `An open/download LINK is in the chat, so the user can open it themselves.`
                : u.shown === "unconfirmed"
                  ? `Whether even a link reached the chat is UNKNOWN.`
                  : `The panel could not put even a link in the chat, so the user got nothing at all.`;
            return `• ${u.name || "(unnamed item)"} — ${u.why}. ${got} ${u.remedy}`;
          })
          .join("\n"),
    );
  }

  // One disclosure per audio file. The video branch already learned this lesson
  // the expensive way (#648): the agent must be told, in the same breath as the
  // good news, exactly which observations it is NOT entitled to make.
  //
  // WHAT `painted` CLAIMS, EXACTLY. Every painter here is synchronous: it puts
  // an element in the chat, and returns before the browser has fetched or
  // decoded a single byte. So `painted` means "a player for it is in the chat",
  // never "the bytes decoded" — the same limit the image and video branches have
  // always had. Rather than pretend otherwise (a `canPlayType` probe answers
  // about the TYPE, not about this file, and would still miss a corrupt or
  // missing one), the disclosure says what was observed and hands the one check
  // that actually settles it to the person who can hear the result. The video
  // branch's remedy already ends the same way, deliberately.
  for (const a of audible) {
    const human =
      a.shown === "unconfirmed"
        ? `Whether its player reached the chat is UNKNOWN, so ask the user whether they can play it before ` +
          `asking them about it.`
        : `Its player is in the chat — that is a player, NOT proof the browser could decode the file, so ` +
          `ask the user whether it actually plays before you rely on it (and how it sounds, if you need ` +
          `to know).`;
    const fetchIt = a.ref
      ? `To get the file itself, call get_image with ${refClause(a.ref, text)} — audio is SAVED TO DISK ` +
        `rather than returned to you inline, so what you get is a path a local tool can open (you still ` +
        `cannot hear it). `
      : `The panel has no ComfyUI reference for it, so there is nothing for you to re-fetch. `;
    noteSections.push(
      `🔊 ${a.name} — you were NOT sent this audio and there is no way for you to hear it, so do not ` +
        `describe how it sounds, how long it is, or what is said in it. ` +
        fetchIt +
        human,
    );
  }

  if (unconfirmed > 0) {
    noteSections.push(
      // "see or hear", because this count spans kinds: an audio player that did
      // not settle is not something the user can SEE, and describing it that way
      // is the same conflation the kind split exists to end (#710).
      `${unconfirmed} of the ${list.length} requested item(s) were handed to a painter that had not ` +
        `finished when this reply was composed, so whether the user can see or hear ` +
        `${unconfirmed === 1 ? "it" : "them"} is UNKNOWN — do not assume ` +
        `${unconfirmed === 1 ? "it was" : "they were"} presented.`,
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
    // Only what the person can SEE or HEAR. painted + unconfirmed +
    // unrenderable.length + (dropped) === count, so a caller that reads nothing
    // but the numbers still cannot mistake a link card for a rendering.
    painted,
    unconfirmed,
    /** Structured twin of the note's unrenderable section, so the honesty does
     *  not depend on an agent parsing prose (#710). */
    unrenderable: unrenderable.map((u) => ({
      name: u.name,
      ext: u.ext,
      kind: u.kind,
      shown: u.shown,
    })),
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
            cells: null,
            why: `sampling it took longer than ${Math.round(timeoutMs / 1000)}s and was abandoned`,
          };
        },
        timers,
      )
    : Promise.resolve({
        ref: null,
        frames: null,
        cells: null,
        why: videoStoryboardEnabled
          ? "this panel build cannot sample video frames"
          : "storyboard previews are turned off in the panel's settings",
      });

  const [sizeBytes, sheet] = await Promise.all([sizePromise, sheetPromise]);
  const size = sizeClause(sizeBytes, humanizeBytes);
  const outcome = sheet ?? {
    ref: null,
    frames: null,
    cells: null,
    why: "the panel could not say why",
  };

  if (!outcome.ref) {
    return {
      note:
        `🎬 ${job.name} — you were NOT shown this video, and no sampled preview could be built ` +
        `(${outcome.why}). Its ${size}. ` +
        remedyWithoutPreview(job, coerceMessageText),
      preview: null,
    };
  }

  // `frames` is how many cells actually hold a sampled frame; `cells` is the
  // grid's capacity. They are the same for a healthy video and differ when a
  // seek failed — and the note must never quote the capacity as the sample
  // count, which would invent observations out of blank cells.
  const n = outcome.frames;
  const cells = outcome.cells;
  // Show the human the same sheet the agent is being pointed at, so what the
  // agent is judging from is visible in the chat next to the player. This
  // painter is guarded exactly like the batch pass's: it can throw, and it can
  // return a promise that rejects later.
  let sheetShown;
  try {
    sheetShown = safePaint(
      paintImage,
      imageViewUrl(outcome.ref),
      `Storyboard · ${n} sampled frames`,
      warn,
      `the storyboard sheet for ${job.name}`,
    );
  } catch (err) {
    // imageViewUrl itself can throw; the sheet is still reachable via get_image.
    warn("[cmcp] show_media: could not build a view URL for the storyboard sheet", err);
    sheetShown = "failed";
  }
  const sheetVisibility =
    sheetShown === "shown"
      ? ""
      : ` (The sheet could not be ${sheetShown === "failed" ? "shown" : "confirmed as shown"} ` +
        `in the chat, so the user may not be able to see what you are judging from — say so if you ` +
        `discuss it. Your own copy, below, is unaffected.)`;

  return {
    preview: {
      of: job.name,
      frames: n,
      cells: Number.isFinite(cells) ? cells : null,
      sourceBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      filename: coerceMessageText(outcome.ref.filename),
      subfolder: coerceMessageText(outcome.ref.subfolder),
      type: coerceMessageText(outcome.ref.type) || "temp",
      sampled: true,
    },
    note:
      `📽️ ${job.name} — you were NOT shown this video. What exists for you is a SAMPLED PREVIEW of it: ` +
      `${sheetClause(n, cells)}, built in the browser (its ${size}). ` +
      `${spacingClause(n, cells)} — they are NOT its frame count, ` +
      `its duration, or its frame rate, so do not describe the video as ${n} frames long, and do not ` +
      `report anything about it that a ${n}-frame sample cannot show (audio, timing, brief events). ` +
      `Cells read left to right, top to bottom = start to end. ` +
      `To actually look at the sheet, call get_image with ${refClause(outcome.ref, coerceMessageText)}.` +
      sheetVisibility,
  };
}

/** Sample + upload. Resolves `{ref, frames, cells, why}`; never throws. */
async function produceSheet(job, deps) {
  const { buildVideoStoryboard, uploadBlobToInput, storyboardFrameCount, warn } = deps;
  try {
    const produced = await buildVideoStoryboard(job.url);
    // #1493 — the builder may hand back `{reason}` instead of a sheet. That is
    // TRUTHY, so it has to be recognised before the `!blob` check below, or an
    // explanation would be uploaded to ComfyUI as if it were a PNG.
    // Recognise SUCCESS positively; treat everything else as a failure.
    //
    // Two earlier versions inferred failure instead, and both were wrong in the
    // direction that uploads garbage: keying on the reason's TYPE let a
    // malformed `{reason:{…}}` through as a sheet, and keying on the PRESENCE of
    // `reason` still uploaded any other truthy value — `[]`, `{}`, a string
    // (review finding). A sheet is the thing with a numeric `size`, which is
    // what a Blob has and what every test double models; nothing else may reach
    // `uploadBlobToInput`.
    //
    // A hypothetical Blob carrying its own string `reason` is therefore read as
    // a failure. That is a shape the builder never produces, and preferring the
    // explanation over a silent upload is the safe way to be wrong about it.
    const asObject = produced != null && typeof produced === "object" ? produced : null;
    const named = asObject && typeof asObject.reason === "string" ? asObject.reason : null;
    const looksLikeSheet = asObject != null && typeof asObject.size === "number";
    const blob = looksLikeSheet && !named ? produced : null;
    if (!blob) {
      warn("[cmcp] show_media: could not sample frames from", job.name);
      return {
        ref: null,
        frames: null,
        cells: null,
        // Name the cause ONLY when the builder supplied one. A sampler that
        // returns a bare `null` still reports nothing, and inventing a diagnosis
        // for it would hand the agent a cause nothing observed — the rule the
        // "NO invented cause" test exists to hold, and which still holds.
        why: named
          ? `the sampler could not build a contact sheet: ${named}`
          : "the sampler returned no contact sheet (its metadata, its frames or the sheet's own encoding failed — the panel is not told which)",
      };
    }
    const base = job.name.replace(/\.[^.]+$/, "") || "video";
    // #209 — a panel-generated sheet is not a user input: it goes to ComfyUI's
    // swept temp/ namespace so it cannot accumulate as permanent input litter.
    const identity = job.storyboardIdentity || createStoryboardIdentity();
    const ref = await uploadBlobToInput(blob, storyboardUploadName(base, identity), { type: "temp" });
    if (!ref) {
      warn("[cmcp] show_media: storyboard upload failed for", job.name);
      return {
        ref: null,
        frames: null,
        cells: null,
        why: "its contact sheet could not be uploaded to ComfyUI",
      };
    }
    // A truthy ref is not a RETRIEVABLE ref. `uploadBlobToInput` builds
    // `{filename: info.name, …}` from whatever `/upload/image` returned, so a
    // response without `name` yields a perfectly truthy object whose filename is
    // undefined — and the reply would then announce that a sampled preview
    // exists and tell the agent to fetch `filename ""`, which resolves to
    // nothing. A remedy that cannot be followed is the defect this module
    // exists to remove, so an unusable ref degrades like any other failure.
    if (!String(ref.filename ?? "").trim()) {
      warn("[cmcp] show_media: storyboard upload returned no filename for", job.name);
      return {
        ref: null,
        frames: null,
        cells: null,
        why: "its contact sheet uploaded but came back with no filename, so nothing can point you at it",
      };
    }
    // The GRID's capacity. It is NOT the number of frames sampled: a video whose
    // seeks fail leaves cells blank, and the builder still returns a sheet.
    let cells = null;
    try {
      const c = storyboardFrameCount();
      cells = Number.isFinite(c) && c > 0 ? c : null;
    } catch {
      cells = null;
    }
    // The count actually DRAWN, carried on the blob by buildVideoStoryboard.
    const drawn = blob.paintedFrames;
    const frames = Number.isFinite(drawn) && drawn > 0 ? Math.min(drawn, cells ?? drawn) : null;
    if (frames == null) {
      // A sheet whose sample count is unknown cannot be described honestly, and
      // "some frames" is not a disclosure. Quoting the grid capacity instead
      // would invent observations out of blank cells. Degrade rather than guess.
      return {
        ref: null,
        frames: null,
        cells,
        why: "its contact sheet was built but the panel could not say how many frames it actually sampled",
      };
    }
    return { ref, frames, cells, why: null };
  } catch (err) {
    warn("[cmcp] show_media: sampled preview pipeline failed:", err);
    return { ref: null, frames: null, cells: null, why: "the sampling pipeline failed" };
  }
}

/** Exact length for an inlined data URL, a bounded HEAD for a /view ref. */
async function resolveSourceBytes(job, fetchMediaBytes, warn) {
  if (Number.isFinite(job.knownBytes)) return job.knownBytes;
  // An inline payload whose length could not be computed stays UNKNOWN: there
  // is no origin to probe, and a HEAD against a data: URL would answer nothing.
  if (job.inline) return null;
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
  // "Ask the user" is only a remedy when the user has something to look at.
  // Asserting they can see it playing when its player never made it into the
  // chat sends the caller to a person who is as blind to it as they are.
  let human;
  if (job.shown === "failed") {
    human =
      "The user cannot see it either — its player could not be put in the chat — so asking them how it " +
      "looks will not help; say plainly that the video could not be inspected.";
  } else if (job.shown === "unconfirmed") {
    human =
      "Whether the user can see it in the chat is UNKNOWN, so ask whether they can see it before asking " +
      "them to describe it.";
  } else {
    human =
      "Its player is in the chat, so ask the user how it looks — they can answer for the parts you cannot " +
      "(and will tell you if it does not play).";
  }
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
