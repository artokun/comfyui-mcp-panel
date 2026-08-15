/**
 * Classify a ComfyUI-Manager 404.
 *
 * A 404 from the Manager means one of TWO opposite things, and the panel used to
 * report both as "ComfyUI-Manager not reachable (is the built-in Manager
 * enabled?)":
 *
 *   ROUTE MISSING   — no handler exists at that path. Nothing ran. This is the
 *                     proven route-level rejection the #605 mutation self-heal
 *                     is allowed to retry on.
 *   SECURITY REFUSAL — legacy Manager 3.x answers a security-gated operation
 *                     (e.g. a git-URL install of a pack outside its registry at
 *                     the default security level) with 404 + a body reading
 *                     "A security error has occurred. Please check the terminal
 *                     logs". The route EXISTS and its handler REFUSED.
 *
 * Two separate defects came from collapsing them (#706):
 *
 *  1. WRONG ANSWER. The user was told the Manager was unreachable while
 *     `/manager/version` was answering V3.41 at that very moment, so they went
 *     looking for a disabled Manager instead of a security gate. The actionable
 *     cause was in the body we discarded.
 *
 *  2. WRONG AUTHORIZATION, which is the dangerous half. A route-missing 404 is
 *     tagged `managerRouteMissing` precisely because nothing ran, so re-sending
 *     a mutation is safe. A security refusal DID run a handler — tagging it the
 *     same way authorizes the #605 self-heal to re-send an install that the
 *     Manager already processed and rejected. "Nothing ran" and "something ran
 *     and said no" must not share a flag.
 *
 * Pure and body-only: the caller owns the fetch, so this stays unit-testable and
 * cannot itself consume a stream twice.
 */
import { tr } from "./i18n.js";

/** Manager's security refusal, matched on the stable part of its phrasing.
 *  Deliberately loose on surrounding text (the message has carried different
 *  trailing advice across 3.x builds) and anchored on the two words that have
 *  not moved. */
const SECURITY_REFUSAL_RE = /security\s+error/i;

/** An upstream body is untrusted, arbitrary-length text heading for a UI string.
 *  Cap it rather than let a stray HTML error page become the message. */
const MAX_DETAIL = 300;

/** Squeeze an upstream body into one short, single-line detail fragment. */
export function summarizeManagerBody(bodyText) {
  if (typeof bodyText !== "string") return "";
  const flat = bodyText.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…` : flat;
}

/**
 * @param {string|null|undefined} bodyText  the 404 response body, or null/"" if
 *   it could not be read. An unread body resolves to ROUTE MISSING, which is the
 *   pre-#706 behaviour — failing back to the conservative classification rather
 *   than inventing a refusal we cannot evidence.
 * @returns {{ routeMissing: boolean, message: string }}
 */
export function classifyManager404(bodyText) {
  const detail = summarizeManagerBody(bodyText);
  if (detail && SECURITY_REFUSAL_RE.test(detail)) {
    return {
      // NOT route-missing: a handler ran and refused. See (2) above — this is
      // what keeps a refusal from authorizing a mutation re-send.
      routeMissing: false,
      message:
        `ComfyUI-Manager refused the operation (security gate): ${detail} ` +
        `The Manager is running and reachable — it declined this request. ` +
        `Legacy Manager 3.x gates installs from outside its registry (e.g. a raw git URL) ` +
        `at the default security level; check the ComfyUI terminal log for the specific rule, ` +
        `and either install the pack from the registry or adjust the Manager's security level.`,
    };
  }
  return {
    routeMissing: true,
    message: tr("manager_404.comfyui_manager_not_reachable_is_the_built", "ComfyUI-Manager not reachable (is the built-in Manager enabled?)"),
  };
}
