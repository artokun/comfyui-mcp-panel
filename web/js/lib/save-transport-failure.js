/**
 * #1757 — `panel_save_workflow` failed with bare "Error: Failed to fetch".
 *
 * The reporter got that string and nothing else. Everything else in the session
 * kept working: `panel_list_workflows` answered immediately, graph reads and
 * layout mutations applied, and the active workflow stayed `modified: true` with
 * no way to persist it. From the tool result there was no way to tell WHAT had
 * failed, let alone what to do about it.
 *
 * ## Why "everything else worked" is not evidence
 *
 * It is the most misleading part of the report, and it is not a coincidence.
 * `workflow_list` reads `app.extensionManager.workflow` out of memory; graph
 * reads and layout edits run against LiteGraph's in-process `app.graph`. None of
 * them issue an HTTP request. The save is the only one of the four that has to
 * reach ComfyUI's HTTP API — so it is the only one that can fail this way, and
 * the other three succeeding says nothing at all about whether ComfyUI is up.
 * (The same report's own Environment block records the ComfyUI stats route as
 * unreachable at that moment, which is the corroboration.)
 *
 * A caller that is not told this reasonably concludes the panel has come unbound
 * from its backend and starts re-opening workflows and re-fencing sessions. That
 * is why the explanation, not just the route, is the fix.
 *
 * ## Why there is no status or body to preserve
 *
 * The issue asks for the failing request's URL, status and body. The URL exists
 * and was being thrown away. The status and body do NOT exist: "Failed to fetch"
 * is what the browser throws when the request never COMPLETED — refused,
 * blocked, dropped, DNS, CORS — so no HTTP response was ever constructed.
 * Reporting a status here would mean inventing one. Saying plainly that they do
 * not exist is the honest version of the same request, and it is what stops a
 * caller hunting for a status line that was never sent.
 *
 * This is the same distinction `manager-fetch-failure.js` draws for the Manager
 * routes (comfyui-mcp#1472), and it deliberately reuses that module's
 * `isTransportFailure` rather than growing a second matcher: one classification,
 * one set of anchored patterns, so the two cannot drift.
 *
 * ## Why it PREFIXES the raw message instead of replacing it
 *
 * `isTransportFailure` and `session-rebind.js`'s `isTransientReconnectError` both
 * classify by the message TEXT, and the second is a substring test. A replacement
 * message that dropped the browser's own words would silently reclassify this
 * error for anything downstream that asks "was this transport?" — here, in the
 * orchestrator, or in a log someone greps. So the browser's string stays first
 * and verbatim, and the explanation follows it.
 *
 * ## What it must NOT say
 *
 * It must not say the file was left unwritten, and it must not say the save is
 * safe to retry. A save is a MUTATION whose response was lost. A reply blocked by
 * CORS, a connection dropped after delivery, and a proxy that failed after
 * forwarding are indistinguishable from the browser, and in each of them the
 * write may already be on disk. #1472 had this exact argument and settled it:
 * name the uncertainty and point at the one thing that resolves it (look at the
 * file), rather than prescribe a remedy that can apply the write twice.
 */

import { isTransportFailure } from "./manager-fetch-failure.js";
import { backendSocketIsDown, WS_OPEN } from "./reconnect-recovery.js";

/** The same-origin route ComfyUI's workflow files are written to and read from.
 *  Built exactly as this repo already builds it for its own /userdata reads
 *  (`workflowDiskContent`, `workflowExistsOnDisk`), so the string in the error is
 *  one a reader can match against the network panel — and it asserts nothing
 *  about the method or any query string, which this repo does not construct and
 *  therefore cannot vouch for. */
export function userDataRoute(path) {
  const raw = typeof path === "string" ? path : "";
  if (!raw) return null;
  return `/userdata/${encodeURIComponent(raw)}`;
}

/**
 * What the panel KNOWS about ComfyUI's socket at the moment the write failed, as
 * a tri-state: `"down"`, `"open"`, or `undefined` (nothing observed).
 *
 * This matters because the two knowable cases point at different causes. A socket
 * that is also down means ComfyUI itself is gone or restarting. A socket that is
 * still OPEN while a same-origin HTTP write gets no response means the server is
 * there and something about that REQUEST did not complete — a proxy, an
 * extension, a blocked request, or an HTTP layer that has stopped answering while
 * the websocket stays up.
 *
 * `undefined` is a real answer and is reported as silence: rule 3 of
 * `http-failure.js` — never assert a cause the observation does not carry.
 * Derived THROUGH `backendSocketIsDown` rather than beside it, so this can never
 * call "down" a socket the graph-mutation gate calls up.
 */
export function describeSaveBackendSocket({ flaggedDown, socketReadyState } = {}) {
  if (backendSocketIsDown({ flaggedDown, socketReadyState })) return "down";
  if (socketReadyState === WS_OPEN) return "open";
  return undefined;
}

/** The socket sentence, or "" when nothing was observed. */
function socketNote(backendSocket) {
  if (backendSocket === "down") {
    return (
      ` ComfyUI's backend websocket is down too, so this is the whole server being ` +
      `unreachable from this tab (a restart, a crash, or a lost connection) rather than ` +
      `one bad request.`
    );
  }
  if (backendSocket === "open") {
    return (
      ` ComfyUI's backend websocket is still OPEN, so the server is reachable and it is ` +
      `this same-origin HTTP request that did not complete — look at a proxy, a browser ` +
      `extension, or an HTTP layer that has stopped answering while the websocket stays up.`
    );
  }
  return "";
}

/** How the write was being performed, and what is TRUE about local state
 *  afterwards. The two routes leave the tab in genuinely different places, and a
 *  shared sentence would be wrong for one of them:
 *
 *   - in-place: nothing was rolled back because nothing local changed. The tab
 *     still holds the edits and is still flagged modified.
 *   - save-as: the copy route removes its in-memory copy and restores the
 *     previously-active tab before this message is built (see the call site), so
 *     the honest statement is about the SOURCE — untouched throughout — plus the
 *     retry hazard the in-place route does not have: if the write did land, the
 *     target now exists on disk and a retry under the same name will 409.
 */
const OPERATIONS = {
  "in-place": {
    verb: "the in-place save of",
    state:
      ` Your edits are not lost — this tab still holds them and is still marked modified.`,
  },
  "save-as": {
    verb: "the save-as (copy) write of",
    // WORDED AROUND `workflow-save.js`'s `isConflictError`, which classifies by
    // substring on "409" / "conflict" / "already exists". An earlier draft ended
    // this sentence with "will report a 409 conflict" and the relocating save's
    // rollback wrapper duly reclassified this transport failure as a filename
    // collision and replaced the whole message with one. The marker below is the
    // structural guard; keeping the wording clear of those tokens means the
    // message is not the only thing standing between the two classifications.
    state:
      ` Your edits are not lost — the SOURCE workflow was never written to on this route, and the ` +
      `in-memory copy has been removed and the previously-active tab restored. One consequence of ` +
      `the uncertainty above is worth planning for: if the write did land, that target file now ` +
      `exists, and a repeat save under the same name will be refused as a name collision.`,
  },
};

/**
 * The message for a workflow save whose /userdata write never got a response, or
 * `null` when `err` is not a transport failure.
 *
 * `null` is the important half of the contract: an unrecognised error must be
 * rethrown BYTE-IDENTICAL, exactly as #771's userdata-400 augmentation does, so
 * no existing message and no existing matcher changes. Only the shape this file
 * can positively identify is touched.
 *
 * @param {unknown} err          the thrown error
 * @param {object}  ctx
 * @param {"in-place"|"save-as"} ctx.operation  which write was attempted
 * @param {string}  ctx.path     the workflow's store path ("workflows/Foo.json")
 * @param {"down"|"open"|undefined} ctx.backendSocket  see describeSaveBackendSocket
 */
export function saveTransportFailureMessage(err, { operation, path, backendSocket } = {}) {
  if (!isTransportFailure(err)) return null;
  const raw = (err instanceof Error ? err.message : String(err ?? "")).trim();
  const op = OPERATIONS[operation] || { verb: "the save of", state: "" };
  const target = path ? `"${path}"` : "this workflow";
  const route = userDataRoute(path);
  const where = route
    ? `ComfyUI's same-origin userdata route (${route})`
    : `ComfyUI's same-origin userdata route`;
  return (
    `${raw || "the request failed"} — ${op.verb} ${target} received NO HTTP response from ` +
    `${where}, so there is no status code and no response body to ` +
    `report — they do not exist (#1757).${socketNote(backendSocket)} This does NOT establish ` +
    `that nothing was written: a reply lost after the request was delivered looks exactly like ` +
    `this from the browser, so read the file back before retrying rather than assuming either ` +
    `outcome.${op.state} Finally: graph reads, layout edits and panel_list_workflows keep ` +
    `succeeding right through this, because they run against the in-memory graph and issue no ` +
    `HTTP at all — their success is not evidence that ComfyUI is up.`
  );
}

/**
 * Apply the message to `err` in place. Returns TRUE only when it actually
 * rewrote the message, so a call site reads `if (decorate…) throw err` and every
 * other shape keeps falling through to whatever handling already owned it.
 *
 * Mutating `err.message` (rather than wrapping) is the idiom `saveInPlace`
 * already uses for #771: it keeps the error's TYPE and STACK, which a wrapper
 * would throw away. The browser's own words stay at the FRONT of the message, so
 * the type is not the only thing a classifier can still recognise it by.
 *
 * A thrown non-Error (a bare string) is left alone and reported as NOT decorated:
 * there is no `.message` to carry the explanation, and claiming otherwise would
 * make the call site skip the handling that shape still needs.
 */
export function decorateSaveTransportFailure(err, ctx) {
  if (!(err instanceof Error)) return false;
  const message = saveTransportFailureMessage(err, ctx);
  if (!message) return false;
  err.message = message;
  markSaveTransportFailure(err);
  return true;
}

/** Non-enumerable brand recording that this error's failure mode is TRANSPORT —
 *  no HTTP response was ever produced.
 *
 *  It exists because the explanation is long prose and the module it flows
 *  through classifies by substring. `isConflictError` matches "409" / "conflict" /
 *  "already exists" anywhere in a message, so a decorated error that so much as
 *  MENTIONS a name collision (in advice about retrying, say) was reclassified by
 *  the relocating save's rollback wrapper into a filename conflict, and the real
 *  failure was replaced wholesale. The wording avoids those tokens now, but a
 *  message that must never contain three particular words is a trap set for the
 *  next person; the brand is the answer that does not depend on prose.
 *
 *  Marked with `defineProperty` and read via `hasOwnProperty` for the same reason
 *  `markPreCommit` is: an INHERITED or accidentally-assigned flag must not be able
 *  to suppress a genuine conflict. */
export function markSaveTransportFailure(err) {
  try {
    Object.defineProperty(err, "cmcpSaveTransport", {
      value: true,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    /* frozen error ⇒ unbranded; the wording is then the only guard, as it was */
  }
  return err;
}

/** True only for an error this module positively branded. A transport failure got
 *  no HTTP response at all, so it can never be a 409 — reading the brand is how a
 *  downstream classifier knows that without parsing the sentence. */
export function isSaveTransportFailure(err) {
  if (!err || typeof err !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(err, "cmcpSaveTransport")) return false;
  return err.cmcpSaveTransport === true;
}

/** Read an injected socket observer WITHOUT letting it break the error path.
 *  The observer reaches into live panel state (`api.socket.readyState`), and this
 *  runs while something is already failing — a throw from the diagnostic would
 *  replace the save's real error with an unrelated one. Absent/failed ⇒
 *  `undefined`, which the message reports as silence. */
export function readBackendSocket(describeBackendSocket) {
  if (typeof describeBackendSocket !== "function") return undefined;
  try {
    const state = describeBackendSocket();
    return state === "down" || state === "open" ? state : undefined;
  } catch {
    return undefined;
  }
}
