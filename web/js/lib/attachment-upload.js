/**
 * #756 — a chat attachment upload that fails must say WHAT was observed.
 *
 * Both upload paths (`handleImageFile`, `handleMediaUpload`) POST to
 * `/upload/image` and then threw the outcome away twice over: a non-200 had no
 * `else` at all, and the `catch` was bare. The agent received the string
 * `upload failed` and nothing else — no status, no size, no MIME type, no
 * exception. Two .mp4 attachments failed while a 1.5 MB .png had succeeded
 * minutes earlier in the same session, and neither the reporter nor anyone
 * reading the report could tell whether to retry, shrink, re-encode, or use a
 * different path. The cause was discarded at both points where it was known.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: name a cause. A 413 is evidence about
 * size, a 400 usually carries ComfyUI's own explanation in the body, and a
 * TypeError is a transport failure — but "the file is too big" is an inference,
 * and inferring one from a status is the same defect as the workflow fence
 * asserting "the workflow was switched" for every mismatch (#750). Report the
 * status, the server's own words when it sent any, and the file's measurements.
 * The reader can then reason from facts rather than from our guess.
 */

/** ComfyUI answers a rejected upload with a JSON or text body that usually names
 *  the real reason; it is the single most useful thing here and was never read.
 *  Bounded because it lands in an agent's context, and a server that answers with
 *  an HTML error page would otherwise paste the whole document into the chat. */
const MAX_BODY_CHARS = 400;

export function clipUploadBody(text, max = MAX_BODY_CHARS) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max)}… [${t.length} chars total]`;
}

/** Bytes → a short human size. Kept local and dependency-free: this string is
 *  read by a human and by an agent deciding whether to shrink the file. */
export function describeSize(bytes) {
  // null/undefined/"" must be ABSENT, not zero. Number(null) is 0 and Number("")
  // is 0, so a coerce-first check renders an unknown size as a confident "0 B" —
  // a fabricated measurement in a message whose whole purpose is to report only
  // what was observed.
  if (bytes === null || bytes === undefined || bytes === "") return null;
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The one description both upload paths use.
 *
 * `status` present  → the server answered and refused; `body` is its own words.
 * `error` present   → the request never completed (network/CORS/abort).
 * Neither           → we genuinely do not know, and say exactly that rather than
 *                     picking whichever half sounds more likely.
 */
export function describeUploadFailure({ status, statusText, body, error, name, size, mediaType } = {}) {
  const facts = [];
  if (name) facts.push(`file "${name}"`);
  const sz = describeSize(size);
  if (sz) facts.push(sz);
  if (mediaType) facts.push(mediaType);
  const measured = facts.length ? ` (${facts.join(", ")})` : "";

  const clipped = clipUploadBody(body);

  if (Number.isFinite(Number(status))) {
    const st = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
    // The server's own words go LAST and are labelled, so a body that itself
    // contains advice cannot be mistaken for ours.
    return (
      `upload REFUSED by ComfyUI — ${st}${measured}. Nothing was written to input/.` +
      (clipped ? ` Server said: ${clipped}` : ` The server sent no body explaining it.`)
    );
  }

  if (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return (
      `upload did not COMPLETE — the request to /upload/image threw${measured}: ${msg}. ` +
      `Whether any bytes reached the server is unknown, but no usable input/ reference came back.`
    );
  }

  return (
    `upload failed for an unobserved reason${measured} — no HTTP status and no exception were ` +
    `captured, so nothing about the cause is known. Nothing usable came back.`
  );
}

/**
 * #1188 — the bound for a POST to `/upload/image`, and why it is sized by payload.
 *
 * Same failure as #1161/#1180: after a ComfyUI restart the tab can hold a half-open
 * connection where a request neither answers nor fails, so there is nothing for the
 * existing `try/catch` to catch. Here it wedges the UI rather than a command. The panel
 * awaits `Promise.all(pending.map((a) => a.ready))` before sending a message
 * (`comfyui-mcp-panel.js:31607`), and `att.ready` catches everything internally, so it
 * never rejects — it simply never settles. The composer is then unable to send, forever.
 * The training wizard hit the same await from the other side and worked around it locally
 * (`cmcp-training-ui.js:704-719`): "ONE hung upload left uploadsPending > 0 permanently and
 * deadlocked wizard navigation".
 *
 * WHY NOT A FLAT BOUND. The other #1188 sites carry a fixed number because their payload is
 * a token or a small JSON body. This endpoint takes whatever the user dropped on it —
 * `handleMediaUpload` exists specifically for video — so any flat number both cuts off
 * legitimate large uploads and waits absurdly long for small ones. The bound is therefore a
 * floor plus an allowance derived from the payload, which fires only when throughput falls
 * below `UPLOAD_MIN_BYTES_PER_MS`, i.e. far below any link that is actually moving bytes.
 *
 * WHAT THIS IS NOT. It is a DURATION bound, not a STALL bound, and the difference matters
 * for the honest case: a transfer that dies halfway through a 2 GB file still waits out the
 * whole allowance. Detecting that needs upload progress events, which `fetch` does not
 * emit — it would mean moving this path to `XMLHttpRequest` (`upload.onprogress`). That is
 * a larger change than #1188's scope and is NOT done here. What this does guarantee is that
 * the wedge is finite, which is the property the composer's `Promise.all` needs.
 */
export const UPLOAD_STALL_FLOOR_MS = 30000;

/** ~50 KB/s. A floor, not an expectation: any working link clears it by orders of
 *  magnitude, so the bound cannot fire on a transfer that is genuinely progressing. */
export const UPLOAD_MIN_BYTES_PER_MS = 50;

/**
 * The largest delay `setTimeout` can actually hold.
 *
 * Above 2^31-1 ms the delay overflows a 32-bit signed int and is coerced to **1ms** — so an
 * allowance so generous it should never fire becomes a bound that fires immediately and
 * refuses every upload. A bound that big is unreachable in practice (it needs a ~107 GB
 * payload), but the failure direction is the dangerous one: not "waits too long" but
 * "refuses instantly", and it would arrive through the mechanism meant to prevent refusals.
 * Clamping also absorbs an `Infinity` reachable through the options object, which no
 * production caller passes but which the exported signature permits.
 */
export const MAX_TIMER_MS = 2147483647;

/**
 * How long an upload of `size` bytes may take before the caller stops waiting.
 *
 * ALWAYS returns a delay a timer can actually hold: finite, and within [1, MAX_TIMER_MS].
 * Both ends matter, and they fail in opposite directions. Below 1, `withTimeout` treats the
 * value as NO BOUND (see `bounded-step.js:20`) and silently restores the very hang this
 * exists to prevent — the trap `nodeDefsBudgetLeft` guards against the same way. Above
 * `MAX_TIMER_MS`, `setTimeout` coerces the delay to 1ms and the bound refuses every upload
 * instantly. An unknown or unusable size yields the floor rather than a fabricated
 * allowance, matching `describeSize`'s rule that an unmeasured value must be absent, not zero.
 */
export function uploadBoundMs(size, {
  floorMs = UPLOAD_STALL_FLOOR_MS,
  bytesPerMs = UPLOAD_MIN_BYTES_PER_MS,
} = {}) {
  const floor = Number.isFinite(floorMs) && floorMs > 0 ? Math.ceil(floorMs) : UPLOAD_STALL_FLOOR_MS;
  const rate = Number.isFinite(bytesPerMs) && bytesPerMs > 0 ? bytesPerMs : UPLOAD_MIN_BYTES_PER_MS;
  const clamp = (ms) => Math.min(MAX_TIMER_MS, Math.max(1, ms));
  if (size === null || size === undefined || size === "") return clamp(floor);
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return clamp(floor);
  return clamp(floor + Math.ceil(n / rate));
}

/**
 * A file's measurements, read ONCE and defensively.
 *
 * A `File`/`Blob` whose `size` or `type` is a throwing getter (or a revoked Proxy) makes the
 * bare reads throw at the top of the upload path — and then throw AGAIN inside the `catch`
 * that reports the failure, because that catch reads the same properties to describe the
 * file. The exception escapes the handler entirely and `att.ready` REJECTS, which the send
 * path is not built for: it awaits `Promise.all(pending.map((a) => a.ready))`, so one
 * unreadable file would break sending rather than mark that attachment failed.
 *
 * The unbounded original had this trap only on the non-200 branch. Passing the size to the
 * bound would have widened it to EVERY upload, so the read is hoisted here instead. An
 * unreadable measurement is reported as absent — `describeSize`'s rule — never as zero.
 */
export function readFileFacts(file) {
  const facts = { size: undefined, mediaType: "" };
  try {
    facts.size = file?.size;
  } catch {
    /* unreadable — stays absent rather than becoming a fabricated 0 */
  }
  try {
    facts.mediaType = file?.type;
  } catch {
    /* unreadable — an absent MIME type simply drops out of the description */
  }
  return facts;
}

/** How long ComfyUI's own explanation of a refusal may take to arrive. Short, because the
 *  status is ALREADY in hand by this point and is worth reporting without it. */
export const UPLOAD_ERROR_BODY_MS = 5000;

/**
 * Read a refusal's body without letting it cost us the status.
 *
 * #756's whole point was that "the status was in hand and thrown away". A body read that
 * stalls inside the outer upload bound would do exactly that again by a new route: the
 * outer bound fires, the sentinel is returned, and a KNOWN `HTTP 413` is reported to the
 * user as "no response". Bounding the body separately and shorter means a stalled
 * explanation costs only the explanation — the status still gets reported, with the same
 * "the server sent no body explaining it" wording a body-less refusal already produces.
 */
export async function readErrorBody(res, withTimeout, ms = UPLOAD_ERROR_BODY_MS) {
  if (typeof withTimeout !== "function") return null;
  try {
    return await withTimeout(
      Promise.resolve().then(() => res.text()).then((t) => t, () => null),
      ms,
      () => null,
    );
  } catch {
    return null;
  }
}

/** Sentinel: the upload did not answer, as distinct from anything it could return. */
export const UPLOAD_NO_ANSWER = Symbol("cmcp-upload-timeout");

/**
 * Run one `/upload/image` exchange under a payload-sized bound.
 *
 * BOTH HALVES. `run` is the caller's whole exchange — the request AND whichever body read
 * it performs — because `fetch` resolves as soon as the response head arrives and the bytes
 * stream afterwards inside `json()`/`text()`. Bounding the request alone leaves the part
 * that actually waits unbounded, which is exactly what shipped in #1180's first attempt at
 * the log read and passed review because the test stalled the handshake rather than the body.
 *
 * REIFY BEFORE BOUNDING. `withTimeout` never rejects by contract — it degrades a rejection
 * through `onTimeout()` exactly as it does a timeout — so handing it `run()` directly would
 * collapse "it threw" into "it never answered" and lose the error. Both upload paths render
 * a throw through `describeUploadFailure({ error })` with its detail, and #756's tests pin
 * that wording. Settling into `{ value }`/`{ err }` first keeps the two apart, so a real
 * transport failure propagates exactly as it did before this bound existed.
 *
 * DOES NOT CANCEL, by inheritance from `withTimeout`. An abandoned upload keeps running and
 * may still land in ComfyUI's `input/`. The caller has stopped waiting; it has not undone
 * the write. No caller here retries, so abandoned attempts cannot stack.
 *
 * @returns {Promise<any>} whatever `run` resolved, or `UPLOAD_NO_ANSWER` at the bound
 */
export async function boundedUpload(run, { size, withTimeout, boundMs } = {}) {
  const ms = Number.isFinite(boundMs) && boundMs > 0 ? boundMs : uploadBoundMs(size);
  // A missing helper must not silently REMOVE the bound. Running unbounded is the one
  // outcome this exists to prevent, so an unusable `withTimeout` is a programming error
  // worth failing loudly on rather than a condition to degrade through.
  if (typeof withTimeout !== "function") throw new TypeError("boundedUpload requires withTimeout");
  const settled = await withTimeout(
    Promise.resolve()
      .then(() => run())
      .then((value) => ({ value }), (err) => ({ err })),
    ms,
    () => UPLOAD_NO_ANSWER,
  );
  if (settled === UPLOAD_NO_ANSWER) return UPLOAD_NO_ANSWER;
  if ("err" in settled) throw settled.err;
  return settled.value;
}

/**
 * The failure text for an upload that never answered.
 *
 * Routed through `describeUploadFailure`'s `error` branch rather than a new sentence of its
 * own, so a timeout reads with the same shape as the transport failure it is a species of —
 * "the request to /upload/image threw … Whether any bytes reached the server is unknown",
 * which is precisely true here: the bound does not cancel, so the write may yet land.
 * Not a `tr()` key: the English catalog is frozen (#1135) and is GENERATED from the code, so
 * one key means a pass over eleven locale files, and this string reaches the agent and the
 * chip through the same untranslated path #756 already established.
 */
/**
 * Is this a status a server could actually have answered with?
 *
 * Deliberately stricter than "coerces to a number". A status is an integer in the range HTTP
 * defines; `0`, `false`, `[]` and `""` are not, however cleanly they coerce. Strings are
 * accepted because a status arriving as `"413"` is the same observation as `413` — but a
 * string that merely starts with digits is not, which `Number()` handles correctly (it
 * yields NaN for `"413 Payload Too Large"`, unlike `parseInt`).
 */
function isHttpStatus(value) {
  if (typeof value !== "number" && typeof value !== "string") return false;
  if (typeof value === "string" && value.trim() === "") return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n <= 599;
}

/**
 * What to report when the OUTER upload bound fires.
 *
 * Giving the refusal body its own shorter bound was not enough on its own. The inner bound
 * runs *inside* the outer one, so a response head that arrives near the outer deadline — say
 * at 29.9s of a 30s allowance — with a body that then stalls lets the OUTER bound fire
 * first. The upload was answered and refused, we hold the status, and it was still about to
 * be reported as "no response". That is #756's defect ("the status was in hand and thrown
 * away") surviving the first attempt to fix it.
 *
 * So the status is recorded the instant it is known, and a timeout consults that record
 * before falling back to the transport wording. Evidence already gathered outranks the
 * bound's own verdict: the bound knows only that IT stopped waiting, which is not the same
 * as nothing having been observed.
 *
 * `observed.body` is deliberately optional. If the outer bound fired while the body was
 * still arriving, there is no body — and `describeUploadFailure` already has wording for a
 * refusal that came without one.
 */
export function describeTimedOutUpload({ observed, name, size, mediaType, boundMs } = {}) {
  // ABSENT before COERCED, exactly as `describeSize` insists — and then narrower still.
  //
  // `Number(null)` and `Number("")` are both 0, which is finite, so a coerce-first check
  // turns "no status was ever observed" into a confident `HTTP null`: a fabricated server
  // answer produced by the one function whose whole job is to tell an answer from silence.
  // A first version of this did exactly that.
  //
  // Excluding the absent values alone is still not enough. `0`, `false` and `[]` all coerce
  // to a finite number and would render as `HTTP 0`, `HTTP false` and a blank status. None
  // is a thing a server can answer, so the test is not "does it look like a number" but
  // "is it a status": an integer in the range HTTP defines. A real `Response.status` always
  // is, so nothing legitimate is turned away, and every non-status degrades to the truthful
  // timeout wording rather than to an invented refusal.
  // …and a status is not automatically a REFUSAL. `describeUploadFailure`'s status branch
  // words its answer as "upload REFUSED by ComfyUI … Nothing was written to input/", which is
  // a lie about a 2xx. Only a status that actually denotes failure may be reported that way;
  // anything else falls back to the timeout wording, which is what a 200 whose body never
  // finished streaming genuinely is. Unreachable from the composers today — they record only
  // non-200 — but this function is exported and must not depend on its callers' discipline.
  if (isHttpStatus(observed?.status) && Number(observed.status) >= 400) {
    return describeUploadFailure({
      status: observed.status,
      statusText: observed.statusText,
      body: observed.body ?? null,
      name,
      size,
      mediaType,
    });
  }
  return describeUploadTimeout({ name, size, mediaType, boundMs });
}

export function describeUploadTimeout({ name, size, mediaType, boundMs } = {}) {
  const secs = Math.round((Number(boundMs) || uploadBoundMs(size)) / 1000);
  return describeUploadFailure({
    error: new Error(`no response within ${secs}s — the upload neither completed nor failed`),
    name,
    size,
    mediaType,
  });
}

/** The chip/agent line for one attachment. Success keeps its existing shape so a
 *  reader (and the transcript) sees no change on the happy path. */
export function attachmentSummaryLine(att) {
  const token = att?.token ?? "";
  if (att?.inputRef) return `${token} → input/${att.inputRef}`;
  const why = att?.uploadError ? att.uploadError : `${att?.name ?? "attachment"} — upload failed`;
  return `${token} (${why})`;
}
