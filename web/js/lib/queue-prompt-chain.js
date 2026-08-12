/**
 * #996 / #1088 — WHAT TO COLLECT WHEN THE RUN-TO-NODE SCOPE DOES NOT ARRIVE.
 *
 * The fallback note asked reporters for their build and ComfyUI_frontend version.
 * Two reports arrived with exactly that and neither identified the cause, because
 * the version is not what differs. Measured on a live 1.48.7:
 *
 *   * `app.queuePrompt`'s real implementation takes `(number, batchCount,
 *     queueNodeIds)` and passes the third argument to `api.queuePrompt` as
 *     `{ partialExecutionTargets }`, which the body builder emits as
 *     `partial_execution_targets`. The capability is present on that build, and
 *     `isPartialExecution` for the queue-time widget hooks derives from the same
 *     array — so the `uncovered_inputs` drift is that same fact one layer up.
 *   * BOTH links were SHADOWED by own properties on the instances (a custom node
 *     over `app.queuePrompt`, rgthree over `api.queuePrompt`), so reading them
 *     directly reports arity 0 and mentions neither `partial` nor `queueNodeIds`
 *     while the prototype does both. Reading the instance alone is how one
 *     concludes the capability is gone when it is not.
 *
 * THIS MODULE REPORTS OBSERVATIONS, NOT A DIAGNOSIS (codex review, four P1s).
 * A first version said "PATCHED by an extension" and "a wrapper that does not
 * forward its arguments is the thing to look at". Neither is established by what
 * can be seen here: an own property is SHADOWING, which a frontend could equally
 * do by binding in its constructor, and a shadowed method plus a capable prototype
 * does not establish that a wrapper ate anything — both wrappers can forward
 * perfectly while the scope is lost somewhere else entirely. Naming a suspect from
 * that is how a diagnostic sends someone down the wrong path with confidence,
 * which is the failure this whole note exists to stop repeating.
 *
 * Everything is read through guards: this runs on a failure path, and a diagnostic
 * that throws replaces a recoverable fallback with a crash.
 */

/** Read a possibly-accessor property without letting it throw. */
function readProp(obj, name) {
  try {
    return obj ? obj[name] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Does `obj` carry its OWN `name`, shadowing the prototype's?
 *
 * THREE states, not two (codex round 3). A probe that FAILS — a callable Proxy
 * whose `getOwnPropertyDescriptor` throws is exactly the case the hostile-input
 * test installs — must not be reported as "no". Neither must an object that has no
 * such method at all: "comes from the prototype" would describe a method that is
 * not there. Collapsing either into a confident negative is the same defect this
 * whole diagnostic exists to stop making.
 *
 * @returns {true|false|undefined} undefined = could not be determined, or absent.
 */
function shadowsPrototype(obj, name) {
  try {
    if (!obj) return undefined;
    if (typeof readProp(obj, name) !== "function") return undefined;
    return Boolean(Object.prototype.hasOwnProperty.call(obj, name));
  } catch {
    return undefined;
  }
}

/**
 * Does the PROTOTYPE's queuePrompt source mention `partialExecutionTargets`?
 *
 * Reported as what it is — a source-text observation, never as a capability
 * verdict. A build can support the option through a helper, a differently named
 * internal, or a minified identifier, so a "no" here is a reason to look, not a
 * finding about the build (codex review).
 *
 * @returns {true|false|undefined} undefined when the source could not be read.
 */
function prototypeMentionsOption(api) {
  try {
    const proto = api ? Object.getPrototypeOf(api) : null;
    const fn = readProp(proto, "queuePrompt");
    if (typeof fn !== "function") return undefined;
    const src = String(fn);
    return src.length > 0 ? /partialExecutionTargets/.test(src) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The observable state of the app→api chain a scoped run travels through.
 *
 * @param {object} deps `{ app, api }` — passed in rather than read from globals so
 *   this is testable without a browser, and so the CALLER's property access is not
 *   this module's failure mode.
 */
export function describeQueuePromptChain(deps) {
  // Destructuring in the signature throws on an explicit `null` — which a
  // failure-path helper must not do, whatever its current callers pass (codex).
  const app = readProp(deps, "app");
  const api = readProp(deps, "api");
  const appShadowed = shadowsPrototype(app, "queuePrompt");
  const apiShadowed = shadowsPrototype(api, "queuePrompt");
  const protoMentionsOption = prototypeMentionsOption(api);

  const where = (state, what) =>
    state === undefined
      ? `${what} could not be read, or is not there`
      : state
        ? `${what} is shadowed by an own property`
        : `${what} comes from the prototype`;
  const parts = [
    where(appShadowed, "app.queuePrompt"),
    where(apiShadowed, "api.queuePrompt"),
    protoMentionsOption === undefined
      ? "the prototype's api.queuePrompt source could not be read"
      : protoMentionsOption
        ? "its prototype's source mentions partialExecutionTargets"
        : "its prototype's source does not mention partialExecutionTargets",
  ];
  return { appShadowed, apiShadowed, protoMentionsOption, summary: parts.join("; ") };
}

/**
 * What to put in the fallback note.
 *
 * Deliberately arrives at no conclusion. It states what was observed and what
 * would settle it, because the observations available here cannot distinguish a
 * wrapper that dropped the argument from a build that never carried it — and a
 * confident wrong suspect is worse than the version request it replaces.
 *
 * Arity is deliberately NOT reported: a default parameter truncates
 * Function.length, so the known-good implementation reports 1 while a correct
 * forwarding wrapper reports 0. It reads like a signal and is noise.
 */
export function describeQueuePromptChainForReport(chain) {
  if (!chain) return "";
  const shadowed = chain.appShadowed === true || chain.apiShadowed === true;
  const anyUnknown = chain.appShadowed === undefined || chain.apiShadowed === undefined;
  const next = shadowed
    ? // NOT "something replaced it": an own property is shadowing, and a frontend
      // that binds its own method in a constructor looks identical (codex round 2).
      ` An own property shadowing the prototype is ordinary — a frontend may bind its own, and ` +
      `many extensions wrap these — so this is where to look, not who to blame. What would ` +
      `settle it is whether whatever is installed passes its THIRD argument through.`
    : anyUnknown
      ? // Unknown is unknown: it must not fall into the "nothing shadows" branch,
        // which would assert something about a method we could not even read.
        ` One of those methods could not be read, so where it comes from is unknown here.`
      : // NOT "so it reached the frontend's own code": a wrapper installed ON THE
      // PROTOTYPE leaves no own property, so absence of shadowing rules out one
      // placement, not interception (codex round 2).
      ` Nothing shadows either method at the instance level. That rules out one placement only — ` +
      `a wrapper installed on the PROTOTYPE leaves no own property and looks exactly like this — ` +
      `so it does not establish that the argument reached the frontend's own code.`;
  return (
    ` QUEUE CHAIN (observed, not a diagnosis): ${chain.summary}.${next} Please include THIS line ` +
    `if you report it, together with the body keys above — the ComfyUI_frontend version alone has ` +
    `now been reported twice without identifying the cause.`
  );
}

/**
 * Read the two globals the probe describes, defensively (#996, codex P1).
 *
 * The probe guards its own property reads, but the CALLER's `app?.api` sits
 * outside it, and an extension-installed throwing getter there would crash the
 * note instead of being described by it. `root` is injectable so that guarantee
 * is testable rather than asserted.
 */
export function queuePromptChainDeps(root = globalThis) {
  let app;
  let api;
  try {
    app = root?.app ?? root?.comfyAPI?.app?.app;
  } catch {
    app = undefined;
  }
  try {
    api = app?.api ?? root?.comfyAPI?.api?.api;
  } catch {
    api = undefined;
  }
  return { app, api };
}
