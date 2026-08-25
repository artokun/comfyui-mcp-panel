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
    durationMs,
    noMedia,
    duplicateOf,
    looksCached,
    finishedAt,
    reconciled,
  }) => {
    // #370: track whether the composed completion frame actually reached the
    // agent. sendFrame returns false when the bridge socket is down — in that
    // case the completion is LOST, so we re-pend the prompt (markUndelivered) so
    // the next reconnect recovers it via /history. A confirmed send (or an empty
    // batch that emits no frame) retires it from pending.
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
      },
      {
        sendFrame: (frame) => {
          sendAttempted = true;
          const ok = sendFrame(frame);
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
        // frame===null ⇒ empty batch (nothing to deliver) ⇒ delivered. A frame
        // that was pushed ⇒ delivered. A frame that FAILED to push ⇒ re-pend —
        // UNLESS it failed because agents are MUTED, which is intentional,
        // permanent suppression (sendFrame returns false for both a down socket
        // AND AGENT_MUTED): a muted completion must NOT be recovered/replayed on
        // a later unmute+reconnect, so treat it as delivered (codex P1).
        if (frame == null || framePushed) markDelivered(promptId);
        else if (isAgentMuted()) markDelivered(promptId);
        else markUndelivered(promptId);
        // #585: this is the moment "the agent was told" becomes true (or is
        // re-pended). Refresh the persisted reboot marker now so a reload in the
        // gap before the next watch tick can't re-adopt an already-delivered run
        // and have /history deliver its completion a second time.
        pruneRebootMarker();
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
        if (framePushed || isAgentMuted()) markDelivered(promptId);
        else markUndelivered(promptId);
        pruneRebootMarker(); // #585 — see the .then branch above
      });
  };
}
