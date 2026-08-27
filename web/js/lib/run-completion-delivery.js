// Production delivery boundary for a completed run.
//
// The lifecycle tracker owns WHEN a prompt is complete. This seam owns the
// completion callback that composes the agent-facing frame, records whether
// the transport accepted it, and updates the tracker's delivery ledger.

import { classifyCompletionDelivery } from "./completion-delivery-diagnostics.js";
import { composeRunCompletionFrame } from "./run-completion-frame.js";

/**
 * Build the production completion callback used by createRunCompletionTracker.
 *
 * The dependencies are the panel's live helpers/state so this is the same
 * delivery path as the mounted panel, while the boundary remains directly
 * invocable by focused tests.
 */
export function createRunCompletionFlushHandler({
  sendFrame,
  markDelivered,
  markUndelivered,
  pruneRebootMarker,
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
  agentReceivesImages = () => true,
  isAgentMuted = () => false,
  warn = (...args) => console.warn(...args),
  now = () => Date.now(),
} = {}) {
  const readVideoStoryboardEnabled =
    typeof videoStoryboardEnabled === "function"
      ? videoStoryboardEnabled
      : () => videoStoryboardEnabled;

  return ({
    promptId,
    images: flImages,
    videos: flVideos,
    completionKey,
    awaitingCompletionKey,
    durationMs,
    noMedia,
    duplicateOf,
    looksCached,
    finishedAt,
    reconciled,
    withheld,
  }) => {
    // #370/#1824: track whether the composed completion frame reached the
    // orchestrator. A route-scoped completion key means sendFrame returning true
    // only proves the browser write; the tracker remains pending until the
    // orchestrator's matching receipt arrives. Legacy/canvas completions without
    // a key retain the existing transport-confirmation behavior.
    const awaitsReceipt = typeof completionKey === "string" && completionKey.length > 0;
    // A timeout fallback may be sent before delayed /prompt identity arrives.
    // It remains recoverable until the tracker can replay it with a key.
    const awaitsCompletionKey = awaitingCompletionKey === true;
    let framePushed = false;
    let sendAttempted = false;
    const compositionStartedAt = now();
    // A completed prompt delivers its FULL batch here, exactly once. Compose
    // ONE consolidated agent_event for the whole run — stills AND every video's
    // storyboard folded into a single images+note+metadata turn — so a mixed /
    // multi-video run resumes the agent with EXACTLY ONE completion frame, never
    // a stills frame plus one frame per video (#269/#468). The composer awaits
    // ALL storyboards for this prompt before its single send. Fire-and-forget:
    // it's async (metadata HEADs / frame sampling), but the batch is already
    // captured — a failure inside must never wedge the lifecycle.
    composeRunCompletionFrame(
      // #356 Bug 2 — `noMedia` marks a panel-queued run that finished producing
      // no image or video. Without it the composer returns null, the call site
      // below reads that as "empty batch ⇒ already delivered", and the agent that
      // panel_run told to end your turn and wait is never told anything.
      {
        promptId,
        images: flImages,
        videos: flVideos,
        durationMs,
        noMedia,
        duplicateOf,
        looksCached,
        finishedAt,
        reconciled,
        withheld,
      },
      {
        sendFrame: (frame) => {
          sendAttempted = true;
          const ok = sendFrame(
            awaitsReceipt ? { ...frame, completion_key: completionKey } : frame,
          );
          if (ok) framePushed = true;
          return ok;
        },
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
        // The card is already in the log by the time the storyboard resolves,
        // so the poster it produced is handed back by video URL rather than
        // passed down at paint time.
        applyVideoPoster,
        videoStoryboardEnabled: readVideoStoryboardEnabled(),
        // #609 — Blind mode strips images at the sendFrame gate below; the
        // storyboard note must not ask for a visual review of pixels the
        // agent never received. A function, so the composer makes its single
        // per-frame decision after the storyboards resolve, near send time.
        agentReceivesImages,
        warn,
      },
    )
      .then((frame) => {
        const deliveryStage = classifyCompletionDelivery({
          sendAttempted,
          transportAccepted: framePushed,
          frameEmitted: frame != null,
          compositionMs: now() - compositionStartedAt,
        });
        if (
          deliveryStage !== "transport-accepted" &&
          deliveryStage !== "empty-no-frame" &&
          !isAgentMuted()
        ) {
          warn("[cmcp] completion delivery diagnostic", {
            prompt_id: promptId,
            stage: deliveryStage,
          });
        }
        // frame===null ⇒ empty batch (nothing to deliver) ⇒ delivered. A keyed
        // frame that was pushed stays pending until acknowledgeDelivery(). An
        // unkeyed frame that was pushed retains the legacy behavior. A frame
        // that FAILED to push ⇒ re-pend —
        // UNLESS it failed because agents are MUTED, which is intentional,
        // permanent suppression (sendFrame returns false for both a down socket
        // AND AGENT_MUTED): a muted completion must NOT be recovered/replayed on
        // a later unmute+reconnect, so treat it as delivered (codex P1).
        if (frame == null && !awaitsCompletionKey) markDelivered(promptId, completionKey);
        else if (framePushed && !awaitsReceipt && !awaitsCompletionKey) markDelivered(promptId, completionKey);
        else if (framePushed && (awaitsReceipt || awaitsCompletionKey)) {
          // A receipt retires keyed delivery; a delayed prompt identity retires
          // the recoverable unkeyed fallback by replaying it keyed.
        } else if (isAgentMuted()) markDelivered(promptId, completionKey);
        else markUndelivered(promptId, completionKey);
        // #585: for legacy/unkeyed frames this is the moment "the agent was
        // told" becomes true (or is re-pended). Keyed panel_run frames update
        // the marker from the orchestrator acknowledgement callback instead.
        if ((frame == null && !awaitsCompletionKey) || (!awaitsReceipt && !awaitsCompletionKey) || isAgentMuted()) {
          pruneRebootMarker();
        }
      })
      .catch((err) => {
        if (!isAgentMuted()) {
          warn("[cmcp] completion delivery diagnostic", {
            prompt_id: promptId,
            stage: classifyCompletionDelivery({
              sendAttempted,
              transportAccepted: framePushed,
              compositionMs: now() - compositionStartedAt,
            }),
          });
        }
        warn("[cmcp] composeRunCompletionFrame failed:", err);
        // Composition threw before/around the send — treat as undelivered so a
        // reconnect can recover the outcome from /history rather than lose it
        // (but respect an intentional mute, as above).
        if ((framePushed && !awaitsReceipt && !awaitsCompletionKey) || isAgentMuted()) markDelivered(promptId, completionKey);
        else if (framePushed && (awaitsReceipt || awaitsCompletionKey)) {
          // The already-pushed frame remains recoverable until its key/receipt.
        } else markUndelivered(promptId, completionKey);
        if ((!awaitsReceipt && !awaitsCompletionKey) || isAgentMuted()) {
          pruneRebootMarker(); // #585 — see the .then branch above
        }
      });
  };
}
