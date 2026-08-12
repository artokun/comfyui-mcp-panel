/**
 * #996 / #1088 — WHAT ACTUALLY DIFFERS WHEN THE RUN-TO-NODE SCOPE DOES NOT ARRIVE.
 *
 * The fallback note asked reporters for their build and ComfyUI_frontend version.
 * Two reports arrived with exactly that, and neither identified the cause, because
 * the frontend version is not what discriminates. Measured on 1.48.7:
 *
 *   * `app.queuePrompt`'s real signature is `(number, batchCount, queueNodeIds)`,
 *     and the third positional argument reaches `/prompt` as
 *     `partial_execution_targets`. The capability is present.
 *   * BOTH links in that chain are routinely PATCHED by extensions. On the machine
 *     this was measured on, `app.queuePrompt` is wrapped by a custom node and
 *     `api.queuePrompt` by rgthree — so reading `app.queuePrompt` reports arity 0
 *     and mentions neither `partial` nor `queueNodeIds`, while the real
 *     implementation sits on the prototype and does both.
 *
 * A wrapper that forwards its arguments (rgthree's does: `apply(app, [index,
 * prompt, ...args])`) is harmless. A wrapper that does not is exactly how the scope
 * disappears with no error anywhere. That distinction is invisible in a version
 * number and visible here, so the note carries this instead of asking for one.
 *
 * Everything is read defensively: this runs on a failure path, and a diagnostic
 * that throws replaces a recoverable fallback with a crash.
 */

/** Is `name` an OWN property of `obj` — i.e. patched onto the instance, shadowing
 *  the prototype implementation the frontend ships? */
function patchedOnInstance(obj, name) {
  try {
    return Boolean(obj && Object.prototype.hasOwnProperty.call(obj, name));
  } catch {
    return false;
  }
}

/** Read a possibly-accessor property without letting it throw. */
function readFn(obj, name) {
  try {
    return obj ? obj[name] : undefined;
  } catch {
    return undefined;
  }
}

function arityOf(fn) {
  return typeof fn === "function" && Number.isInteger(fn.length) ? fn.length : -1;
}

/** Does the frontend's OWN api.queuePrompt understand the options shape at all?
 *  This is the one fact that separates "this build cannot do it" from "something
 *  in the chain dropped it" — the distinction both reports were missing. */
function protoSupportsOptions(api) {
  try {
    const proto = api ? Object.getPrototypeOf(api) : null;
    return /partialExecutionTargets/.test(String(proto?.queuePrompt ?? ""));
  } catch {
    return false;
  }
}

/**
 * A one-line description of the app→api chain a scoped run travels through.
 *
 * @param {object} deps `{ app, api }` — passed in rather than read from globals so
 *   this is testable without a browser, which is the whole reason it is a module.
 * @returns {{appPatched: boolean, appArity: number, apiPatched: boolean,
 *   apiArity: number, frontendSupportsOptions: boolean, summary: string}}
 */
export function describeQueuePromptChain({ app, api } = {}) {
  // Read through a guard: `api.queuePrompt` can be an accessor, and a getter that
  // throws would turn this diagnostic into the failure it is describing. Caught by
  // its own test, which is the point of running it on hostile input.
  const appFn = readFn(app, "queuePrompt");
  const apiFn = readFn(api, "queuePrompt");
  const appPatched = patchedOnInstance(app, "queuePrompt");
  const apiPatched = patchedOnInstance(api, "queuePrompt");
  const appArity = arityOf(appFn);
  const apiArity = arityOf(apiFn);
  const frontendSupportsOptions = protoSupportsOptions(api);

  const parts = [
    `app.queuePrompt ${appPatched ? "PATCHED by an extension" : "unpatched"} (arity ${appArity})`,
    `api.queuePrompt ${apiPatched ? "PATCHED by an extension" : "unpatched"} (arity ${apiArity})`,
    frontendSupportsOptions
      ? "the frontend's own api.queuePrompt DOES accept partialExecutionTargets"
      : "the frontend's own api.queuePrompt does NOT mention partialExecutionTargets",
  ];
  return {
    appPatched,
    appArity,
    apiPatched,
    apiArity,
    frontendSupportsOptions,
    summary: parts.join("; "),
  };
}

/**
 * What to say about that chain in the fallback note.
 *
 * The ASK is the point. "Report your build and frontend version" was answered
 * twice and identified nothing; this names the two links that can silently drop an
 * argument, and says which one to look at first.
 */
export function describeQueuePromptChainForReport(chain) {
  if (!chain) return "";
  const suspect =
    chain.frontendSupportsOptions && (chain.appPatched || chain.apiPatched)
      ? ` The frontend itself supports the scope here, so a wrapper that does not forward its ` +
        `arguments is the thing to look at — an extension patch that calls through as ` +
        `\`fn(index, prompt)\` instead of \`fn(index, prompt, ...args)\` drops the scope with no ` +
        `error anywhere.`
      : !chain.frontendSupportsOptions
        ? ` The frontend's own api.queuePrompt does not mention partialExecutionTargets at all, ` +
          `which points at the build rather than at an extension.`
        : "";
  return (
    ` QUEUE CHAIN: ${chain.summary}.${suspect} Please include THIS line if you report it — the ` +
    `ComfyUI_frontend version alone has already been reported twice without identifying the cause.`
  );
}
