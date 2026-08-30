// #390 — the 18+ consent card must not hold the enclosing tools/call until
// the transport kills it.
//
// The card is painted by the same `ask_user` path as any other question, and
// that path blocks until a human clicks. An idle user therefore leaves the
// command in flight until the ~300s tools/call deadline (and nested MCP SDK
// clients often die at the 60s default), which surfaces as a transport error
// even though nothing failed. The original orchestrator clamp still waits
// hundreds of seconds; this bound lives on the card the panel owns.
//
// Detection is option-identity plus the card header the orchestrator sends,
// never a loose heuristic: a restart confirm must keep waiting on a person.
// On timeout the command resolves with a structured result that does NOT
// grant adult mode. Persistent consent is unchanged and remains queryable.

import { withTimeout } from "./bounded-step.js";

/** Exact affirmative option the orchestrator paints on the consent card. */
export const CONSENT_YES_LABEL = "Yes — I'm 18+ and it's legal in my region";
/** Exact decline option the orchestrator paints on the consent card. */
export const CONSENT_NO_LABEL = "No — keep it SFW";
/** Header the orchestrator stamps on the consent card. */
export const CONSENT_HEADER = "18+ consent";

/**
 * How long the consent card may block the command.
 *
 * Must finish well inside both the 60s nested-SDK default (the recurrence
 * died after ~50s) and the 300s tools/call kill. An attentive click still
 * wins this race; an idle user gets a structured timeout, not a hang.
 */
export const CONSENT_WAIT_MS = 20_000;

/** Enclosing tools/call budget this wait must beat. */
export const CONSENT_TRANSPORT_DEADLINE_MS = 300_000;

/** Nested MCP SDK default that killed the recurrence's nested call. */
export const CONSENT_NESTED_CALL_BUDGET_MS = 60_000;

/**
 * Structured command result when the card is not answered in time.
 * Does not grant adult mode. `request_id` is the card's ask_id when present
 * so a later content-mode read can be correlated with this gate.
 *
 * @param {string} [askId]
 */
export function adultConsentTimeoutResult(askId) {
  const result = { nsfw_allowed: false, timed_out: true };
  if (typeof askId === "string" && askId) result.request_id = askId;
  return result;
}

function optionLabel(opt) {
  if (typeof opt === "string") return opt;
  if (opt && typeof opt === "object" && typeof opt.label === "string") return opt.label;
  return "";
}

/**
 * True only for the 18+ consent card. Other question cards (restart confirm,
 * generic asks) must keep blocking on a person.
 *
 * @param {any} msg
 */
export function isAdultConsentCard(msg) {
  if (!msg || typeof msg !== "object") return false;
  if (msg.header === CONSENT_HEADER) return true;
  const opts = Array.isArray(msg.options) ? msg.options : [];
  const labels = opts.map(optionLabel);
  return labels.includes(CONSENT_YES_LABEL) && labels.includes(CONSENT_NO_LABEL);
}

/**
 * Bound the consent-card wait. Non-consent questions are returned unchanged.
 *
 * Uses the repo's one `withTimeout` primitive — a second timer helper is how
 * this class of hang keeps coming back.
 *
 * @param {any} msg
 * @param {Promise<any>} answerPromise
 * @param {{
 *   waitMs?: number,
 *   onTimeout?: () => void,
 *   timers?: { setTimer?: Function, clearTimer?: Function },
 * }} [opts]
 * @returns {Promise<any>}
 */
export function waitForAdultConsentAnswer(msg, answerPromise, opts = {}) {
  if (!isAdultConsentCard(msg)) return answerPromise;
  const waitMs = Number.isFinite(opts.waitMs) && opts.waitMs > 0 ? opts.waitMs : CONSENT_WAIT_MS;
  const askId = typeof msg.ask_id === "string" ? msg.ask_id : "";
  return withTimeout(
    answerPromise,
    waitMs,
    () => {
      try {
        opts.onTimeout?.();
      } catch {
        /* card presentation is best-effort; the command still has to settle */
      }
      return adultConsentTimeoutResult(askId);
    },
    opts.timers,
  );
}
