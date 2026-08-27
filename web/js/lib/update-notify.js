/**
 * #1942 — in-app notice that a panel update exists, what it fixes, and (on a
 * local host client only) one-click install+restart.
 *
 * #1943/#1944 — host-mutating affordances are gated on client context. A remote,
 * tunnelled, or mobile client never sees the notice at all: telling someone about
 * an action they cannot take, while they are away from the machine, manufactures
 * the motivation to work around the missing button. Only the *surfacing* is
 * deferred until the next loopback desktop session.
 *
 * Pure / dependency-injected (no DOM, no ComfyUI globals) so the verdict is
 * unit-testable without a browser.
 */

import { compareVersions } from "./changelog-delta.js";

/** Comfy Registry node id this pack publishes as. */
export const PANEL_REGISTRY_ID = "comfyui-agent-panel";

export const PANEL_REGISTRY_URL = "https://api.comfy.org/nodes/comfyui-agent-panel";
export const PANEL_REGISTRY_VERSIONS_URL =
  "https://api.comfy.org/nodes/comfyui-agent-panel/versions";

/** localStorage key: last dismissed `${kind}:${version}` pair. */
export const UPDATE_NOTICE_DISMISS_KEY = "comfyui-mcp.panel.updateNoticeDismissed";

/** Registry statuses a user can actually install through Manager. */
export const INSTALLABLE_VERSION_STATUS = "NodeVersionStatusActive";

/** Hostnames that are a tunnel in front of the ComfyUI origin, not the host. */
const TUNNEL_HOST =
  /(?:^|\.)(trycloudflare\.com|cloudflareaccess\.com|ngrok(?:-free)?\.(?:app|io|dev)|loca\.lt|localtunnel\.me|tailscale\.net|ts\.net|github\.dev|gitpod\.io)$/i;

/** Phones / tablets. A desktop browser on loopback is the host session. */
const MOBILE_UA = /(?:\b(?:iphone|ipad|ipod|android|mobile|opera mini|iemobile|webos|blackberry)\b)/i;

function okVersion(v) {
  return typeof v === "string" && /^\d+\.\d+/.test(v.trim().replace(/^v/i, ""));
}

function normVersion(v) {
  return okVersion(v) ? String(v).trim().replace(/^v/i, "") : "";
}

export function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string") return false;
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function isTunnelHostname(hostname) {
  if (typeof hostname !== "string") return false;
  return TUNNEL_HOST.test(hostname.trim());
}

export function isMobileUserAgent(ua) {
  if (typeof ua !== "string") return false;
  return MOBILE_UA.test(ua);
}

/**
 * Where this tab is sitting relative to the ComfyUI host.
 *
 *   "local"  — loopback desktop panel on the host. The only context that may
 *              be offered a host-mutating action (#1942 + #1943).
 *   "remote" — non-loopback origin, tunnel hostname, or a mobile UA. The
 *              update notice is deferred entirely (#1944), not degraded.
 */
export function classifyClientContext({ hostname, userAgent } = {}) {
  if (isMobileUserAgent(userAgent)) return "remote";
  if (isTunnelHostname(hostname)) return "remote";
  if (isLoopbackHostname(hostname)) return "local";
  return "remote";
}

/**
 * #1943 — install / restart is a host mutation. Fail closed on anything that
 * is not a loopback desktop session.
 */
export function shouldOfferHostMutation(clientContext) {
  return clientContext === "local";
}

/**
 * #1944 — surfacing IS offering. A remote user is not told an update exists
 * unless they can act on it from this tab.
 */
export function shouldSurfaceUpdateNotice(clientContext) {
  return shouldOfferHostMutation(clientContext);
}

/**
 * Classify this tab from the browser globals the panel actually has.
 * Missing location / navigator is remote: fail closed.
 */
export function readBrowserClientContext({ location, navigator } = {}) {
  const hostname = typeof location?.hostname === "string" ? location.hostname : "";
  const userAgent = typeof navigator?.userAgent === "string" ? navigator.userAgent : "";
  return classifyClientContext({ hostname, userAgent });
}

/**
 * The whole update-notify UX for this tab, as one verdict.
 *
 * Remote / tunnel / mobile: notice, install, and restart are all false — the
 * #1944 correction. A local host session still gets the #1942 prompt:
 * update → notice + install + restart; restart-only → notice + restart.
 * There is no `{ surfaceNotice: true, offerInstall: false, offerRestart: false }`
 * row; that is the "inform but hide the button" half-measure.
 */
export function decideUpdateNoticeAffordance({ hostname, userAgent, kind } = {}) {
  const clientContext = classifyClientContext({ hostname, userAgent });
  const hostOk = shouldOfferHostMutation(clientContext);
  if (!hostOk || (kind !== "update" && kind !== "restart")) {
    return {
      clientContext,
      surfaceNotice: false,
      offerInstall: false,
      offerRestart: false,
    };
  }
  return {
    clientContext,
    surfaceNotice: true,
    offerInstall: kind === "update",
    offerRestart: true,
  };
}

export function isInstallableStatus(status) {
  return status === INSTALLABLE_VERSION_STATUS;
}

/**
 * Latest Registry version a Manager install can actually pull.
 *
 * Pending / flagged cuts are published-but-not-live; offering them as
 * one-click install would queue a version Manager will not serve. Newer-than-
 * running is the caller's question — this only picks the installable tip.
 */
export function pickInstallableLatest(versions) {
  if (!Array.isArray(versions)) return null;
  const installable = versions.filter(
    (v) => v && okVersion(v.version) && isInstallableStatus(v.status),
  );
  if (!installable.length) return null;
  installable.sort((a, b) => compareVersions(b.version, a.version));
  return installable[0];
}

export function parseRegistryNode(body) {
  const lv = body && typeof body === "object" ? body.latest_version : null;
  if (!lv || typeof lv !== "object") return { latest: null };
  const version = normVersion(lv.version);
  if (!version) return { latest: null };
  return {
    latest: {
      version,
      status: typeof lv.status === "string" ? lv.status : "",
      changelog: typeof lv.changelog === "string" ? lv.changelog : "",
    },
  };
}

export function parseRegistryVersions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const version = normVersion(row.version);
    if (!version) continue;
    out.push({
      version,
      status: typeof row.status === "string" ? row.status : "",
      changelog: typeof row.changelog === "string" ? row.changelog : "",
    });
  }
  return out;
}

/**
 * What (if anything) the local host session should be offered.
 *
 *   "update"  — a newer installable Registry version than both running and
 *               on-disk. One-click is install+restart.
 *   "restart" — on-disk pyproject (or an already-installed latest) differs
 *               from the running PANEL_VERSION. One-click is restart only.
 *   "none"    — current, unknown, or a downgrade. Never offer to move backwards.
 */
export function resolveUpdateState({ running, installed, latest } = {}) {
  const run = normVersion(running);
  const disk = normVersion(installed);
  const pub = normVersion(latest);
  if (!run) return { kind: "none", targetVersion: "", running: run, installed: disk, latest: pub };

  const aheadOfRun = (v) => v && compareVersions(v, run) > 0;

  if (pub && aheadOfRun(pub) && (!disk || compareVersions(pub, disk) > 0)) {
    return { kind: "update", targetVersion: pub, running: run, installed: disk, latest: pub };
  }
  if (disk && disk !== run) {
    const target = pub && aheadOfRun(pub) ? pub : disk;
    return { kind: "restart", targetVersion: target, running: run, installed: disk, latest: pub };
  }
  if (pub && aheadOfRun(pub) && disk === pub) {
    return { kind: "restart", targetVersion: pub, running: run, installed: disk, latest: pub };
  }
  return { kind: "none", targetVersion: "", running: run, installed: disk, latest: pub };
}

export function dismissToken(kind, version) {
  if (kind !== "update" && kind !== "restart") return "";
  const v = normVersion(version);
  return v ? `${kind}:${v}` : "";
}

export function isDismissed(stored, kind, version) {
  const token = dismissToken(kind, version);
  return !!token && stored === token;
}

/** Versions newer than `from`, up to and including `to`. */
export function versionsBetween(versions, { from, to, max = 12 } = {}) {
  if (!Array.isArray(versions)) return [];
  const lo = normVersion(from);
  const hi = normVersion(to);
  const picked = versions.filter((r) => {
    if (!r || !okVersion(r.version)) return false;
    const v = normVersion(r.version);
    if (lo && compareVersions(v, lo) <= 0) return false;
    if (hi && compareVersions(v, hi) > 0) return false;
    return true;
  });
  picked.sort((a, b) => compareVersions(b.version, a.version));
  return Number.isFinite(max) && max > 0 ? picked.slice(0, max) : picked;
}

/**
 * Flatten a Registry changelog markdown blob into {section, text} lines.
 *
 * The Registry stores each version's CHANGELOG.md section (via
 * `comfy node publish --changelog-file`). First sentence only — same unit the
 * in-panel what's-new surface uses — so a pending update can answer "what am
 * I getting?" from the published notes, not from the running pack's
 * changelog.json (which cannot contain versions it does not yet include).
 */
export function summarizeChangelogMarkdown(markdown, { version = "", maxEntries = 12 } = {}) {
  const out = [];
  if (typeof markdown !== "string" || !markdown.trim()) return out;
  let section = "Fixed";
  for (const rawLine of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    const heading = /^#{2,3}\s+(Added|Changed|Fixed|Removed|Deprecated|Security)\b/i.exec(line);
    if (heading) {
      section = heading[1][0].toUpperCase() + heading[1].slice(1).toLowerCase();
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (!bullet) continue;
    const text = headlineOf(stripInlineMarkdown(bullet[1]));
    if (text) out.push({ version, section, text });
  }
  return Number.isFinite(maxEntries) && maxEntries > 0 ? out.slice(0, maxEntries) : out;
}

export function summarizePendingVersions(versions, { from, to, maxEntries = 12 } = {}) {
  const out = [];
  for (const row of versionsBetween(versions, { from, to })) {
    out.push(...summarizeChangelogMarkdown(row.changelog, { version: row.version, maxEntries: 40 }));
  }
  return Number.isFinite(maxEntries) && maxEntries > 0 ? out.slice(0, maxEntries) : out;
}

function stripInlineMarkdown(s) {
  return String(s ?? "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function headlineOf(s) {
  const text = String(s ?? "").trim();
  if (!text) return "";
  const m = text.match(/^[\s\S]{1,240}?(?:[.!?](?=\s+[A-Z0-9"“(])|[.!?] *$)/);
  const cut = (m ? m[0] : text).trim();
  return cut.length > 240 ? `${cut.slice(0, 237).trimEnd()}…` : cut;
}

/**
 * Fetch the published version list. Injected `fetchImpl` so unit tests never
 * touch the network. A failure is `{ versions: [], latest: null }` — unknown,
 * never a guessed "you are behind".
 */
export async function fetchPublishedPanelVersions({
  fetchImpl,
  nodeUrl = PANEL_REGISTRY_URL,
  versionsUrl = PANEL_REGISTRY_VERSIONS_URL,
  timeoutMs = 4000,
} = {}) {
  const empty = { versions: [], latest: null };
  if (typeof fetchImpl !== "function") return empty;
  const getJson = async (url) => {
    const ac = typeof AbortController === "function" ? new AbortController() : null;
    const timer =
      ac && timeoutMs > 0 ? setTimeout(() => { try { ac.abort(); } catch {} }, timeoutMs) : null;
    try {
      const res = await fetchImpl(url, {
        cache: "no-cache",
        signal: ac?.signal,
      });
      if (!res || res.ok === false || typeof res.json !== "function") return null;
      return await res.json();
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const [nodeBody, versionsBody] = await Promise.all([getJson(nodeUrl), getJson(versionsUrl)]);
  const versions = parseRegistryVersions(versionsBody);
  const fromNode = parseRegistryNode(nodeBody).latest;
  const tip = pickInstallableLatest(versions);
  const latest = tip || (fromNode && isInstallableStatus(fromNode.status) ? fromNode : null);
  return { versions: versions.length ? versions : fromNode ? [fromNode] : [], latest };
}
