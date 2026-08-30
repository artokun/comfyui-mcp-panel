/**
 * #1757 recurrence — a timed-out restart confirmation does not reboot ComfyUI,
 * but the next in-place userdata write can still throw the browser's bare
 * "Failed to fetch" while in-memory graph reads keep working.
 *
 * PR #1769 explained that transport failure. It did not rebind the same-origin
 * userdata route or retry the write, so a dirty tab stayed unpersistable.
 *
 * In-place overwrite of the SAME graph bytes is idempotent, so one retry after
 * a lost response cannot duplicate a distinct mutation. Save-as is not: the
 * copy is created with overwrite:false, and a second attempt can 409. Callers
 * set `allowUnknownRetry` only on the in-place path.
 *
 * A write is retried only when a read-back says it missed, or when the probe
 * is unknown AND this is the in-place / restart-timeout path. Blind save-as
 * retries are refused.
 */

import { isTransportFailure } from "./manager-fetch-failure.js";
import { userDataRoute } from "./save-transport-failure.js";
import { diskBytesEqualText } from "./workflow-open-staleness.js";

let restartConfirmTimedOut = false;

/** Record that a restart confirmation expired without rebooting. */
export function noteRestartConfirmTimeout() {
  restartConfirmTimedOut = true;
}

/** True if a restart confirmation has expired and has not yet been consumed. */
export function restartConfirmTimeoutPending() {
  return restartConfirmTimedOut === true;
}

/** Read-and-clear the restart-confirmation timeout flag. */
export function consumeRestartConfirmTimeout() {
  const was = restartConfirmTimedOut === true;
  restartConfirmTimedOut = false;
  return was;
}

/** Test hook: drop a leftover flag so cases cannot leak into each other. */
export function clearRestartConfirmTimeout() {
  restartConfirmTimedOut = false;
}

export function pageOrigin(locationLike = globalThis.location) {
  const origin = locationLike?.origin;
  if (typeof origin !== "string" || !origin || origin === "null") return null;
  return origin;
}

/**
 * Point ComfyUI's API host back at the page origin. A drifted `api_host` is
 * how a same-origin userdata write starts targeting a host that will not
 * answer while the in-memory graph is still live.
 */
export function rebindSameOriginSaveRoute({ api, origin } = {}) {
  const raw = typeof origin === "string" && origin ? origin : pageOrigin();
  if (!raw || raw === "null") return { rebound: false, origin: null, host: null };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { rebound: false, origin: null, host: null };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { rebound: false, origin: null, host: null };
  }
  if (!parsed.host) return { rebound: false, origin: null, host: null };
  if (api && typeof api === "object") {
    try {
      api.api_host = parsed.host;
    } catch {
      /* frozen host — the write still goes out, just without a rebind */
    }
  }
  return { rebound: true, origin: parsed.origin, host: parsed.host };
}

/** Absolute userdata URL a reader can match against the network panel. */
export function resolveSameOriginUserDataUrl(path, { origin, apiUrl } = {}) {
  const route = userDataRoute(path);
  if (!route) return null;
  if (typeof apiUrl === "function") {
    try {
      const resolved = apiUrl(route);
      if (typeof resolved === "string" && resolved) return resolved;
    } catch {
      /* fall through to origin+route */
    }
  }
  const base = typeof origin === "string" && origin && origin !== "null" ? origin : pageOrigin();
  if (!base) return route;
  try {
    return new URL(route, base.endsWith("/") ? base : `${base}/`).href;
  } catch {
    return route;
  }
}

/**
 * Did the userdata write land despite a lost HTTP response?
 * `"landed"` / `"missed"` / `"unknown"` — never a guess presented as fact.
 */
export async function classifySaveWriteLanded({
  path,
  expectedText,
  existsOnDisk,
  readDiskBytes,
} = {}) {
  if (typeof path !== "string" || !path) return "unknown";
  if (typeof existsOnDisk === "function") {
    let exists;
    try {
      exists = await existsOnDisk(path);
    } catch {
      return "unknown";
    }
    if (exists === false) return "missed";
    if (exists !== true) return "unknown";
  }
  if (typeof readDiskBytes !== "function") return "unknown";
  if (typeof expectedText !== "string") return "unknown";
  let disk;
  try {
    disk = await readDiskBytes(path);
  } catch {
    return "unknown";
  }
  if (disk == null) return "unknown";
  if (typeof disk === "string") return disk === expectedText ? "landed" : "missed";
  return diskBytesEqualText(disk, expectedText) ? "landed" : "missed";
}

function attachUrl(err, url) {
  if (!(err instanceof Error) || typeof url !== "string" || !url) return;
  if (typeof err.url === "string" && err.url) return;
  try {
    err.url = url;
  } catch {
    /* frozen error */
  }
}

async function safeRebind(rebind) {
  if (typeof rebind !== "function") return;
  try {
    await rebind();
  } catch {
    /* rebind is best-effort; the write's own error is the one that matters */
  }
}

async function classifyProbe(probe) {
  if (typeof probe !== "function") return "unknown";
  try {
    const result = await probe();
    if (result === true || result === "landed") return "landed";
    if (result === false || result === "missed") return "missed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Run `write` once. On a transport failure, probe whether it landed, rebind
 * the same-origin userdata route, and retry at most once when that is safe.
 *
 * @param {() => Promise<unknown>} write
 * @param {object} [opts]
 * @param {() => unknown} [opts.rebind]
 * @param {() => Promise<unknown>} [opts.probe]
 * @param {unknown} [opts.recoveredValue] returned when the probe says the write landed
 * @param {boolean} [opts.allowUnknownRetry] in-place only: overwrite of the same bytes
 * @param {boolean} [opts.afterRestartConfirmTimeout] skip the module flag; tests inject this
 * @param {() => boolean} [opts.consumeTimeout]
 * @param {string} [opts.url] userdata URL attached to a final transport error
 */
export async function writeWithSameOriginRetry(write, opts = {}) {
  const rebind = opts.rebind;
  const probe = opts.probe;
  const recoveredValue = opts.recoveredValue;
  const allowUnknownRetry = opts.allowUnknownRetry === true;
  const url = typeof opts.url === "string" && opts.url ? opts.url : null;
  const consumeTimeout =
    typeof opts.consumeTimeout === "function" ? opts.consumeTimeout : consumeRestartConfirmTimeout;
  const timedOut =
    opts.afterRestartConfirmTimeout === true ||
    (opts.afterRestartConfirmTimeout !== false && consumeTimeout());

  if (timedOut) await safeRebind(rebind);

  try {
    return await write();
  } catch (err) {
    if (!isTransportFailure(err)) throw err;
    attachUrl(err, url);

    const landed = await classifyProbe(probe);
    if (landed === "landed") return recoveredValue;

    const retryUnknown = landed === "unknown" && (timedOut || allowUnknownRetry);
    if (landed !== "missed" && !retryUnknown) throw err;

    await safeRebind(rebind);

    if (landed === "unknown") {
      const landedAgain = await classifyProbe(probe);
      if (landedAgain === "landed") return recoveredValue;
      if (landedAgain === "missed") {
        try {
          return await write();
        } catch (err2) {
          attachUrl(err2, url);
          throw err2;
        }
      }
      if (!timedOut && !allowUnknownRetry) throw err;
    }

    try {
      return await write();
    } catch (err2) {
      attachUrl(err2, url);
      throw err2;
    }
  }
}
