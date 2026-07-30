// Pure helpers for routing custom-node installs across the three ComfyUI-Manager
// generations ("v2" = pip Manager v4 unified task queue; "v2-batch" = pip v4 in
// --enable-manager-legacy-ui mode; "legacy" = released 3.x custom-node Manager).
// Kept standalone (no browser globals) so it is unit-testable under `node --test`.
// Consumed by comfyui-mcp-panel.js nodes_install. Mirrors the mcp orchestrator's
// installCustomNode / looksLikeGitUrl / gitCheckoutDir logic
// (src/services/node-management.ts).

/** Does this identifier look like a git URL (vs a registry id)? Recognizes
 *  https(s)://, ssh://, git:// (and git+…), the scp-form git@host:owner/repo,
 *  and any value ending in ".git". */
export function looksLikeGitUrl(s) {
  return (
    typeof s === "string" &&
    (/^(https?|ssh|git):\/\//i.test(s) ||
      /^git\+/i.test(s) ||
      /^git@/i.test(s) ||
      s.endsWith(".git"))
  );
}

/** Derive the repo/pack NAME from a git URL — the Manager keys installs off this,
 *  NOT a full URL. Handles ://-form (http/ssh/git/git+), the scp-form
 *  git@host:owner/repo, query/hash suffixes, and trailing slashes; strips a
 *  trailing ".git". */
export function gitRepoName(url) {
  const pathPart =
    url.includes(":") && !url.includes("://")
      ? url.slice(url.lastIndexOf(":") + 1) // scp-style git@host:owner/repo
      : url;
  const clean = pathPart.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const base = clean.slice(clean.lastIndexOf("/") + 1);
  return base.replace(/\.git$/i, "");
}

/** Resolve the git URL for an install request, if any. A caller may pass the
 *  URL as `repository` OR directly as `id`; either counts. Returns null for a
 *  plain registry id. */
export function installGitUrl({ id, repository } = {}) {
  if (repository && looksLikeGitUrl(repository)) return repository;
  if (id && looksLikeGitUrl(id)) return id;
  return null;
}

/**
 * Build the per-dialect install request for one nodes_install call. Returns
 * either:
 *   { dialect:"v2", envelope:"task", params }        → POST /v2/manager/queue/task
 *   { dialect:"v2-batch", envelope:"batch", body }   → POST /v2/manager/queue/batch {install:[body]}
 *   { dialect:"legacy", envelope:"legacy", body }    → POST /manager/queue/install
 *
 * A git URL (via `id` OR `repository`, any recognized protocol) always routes to
 * the repo-name-as-id payload: v4 installs by {id: repoName, selected_version:
 * ref||"nightly", channel:"dev"} (no files — v4 resolves by CNR/repo name);
 * v2-batch + legacy install the URL natively via {id: repoName, version:
 * "unknown", files:[url]}. A registry id keeps the versioned body. `id` is
 * NEVER a full URL (a full URL matches nothing on v4 → silent "done"; on 3.x it
 * fails LATER while resolving, past the immediate `failed` array).
 */
export function buildInstallRequest(dialect, args = {}, ui_id) {
  const { id, version, repository, channel, mode, selected_version } = args;
  const gitUrl = installGitUrl({ id, repository });

  if (dialect === "v2") {
    if (gitUrl) {
      const selected = selected_version || version || "nightly";
      return {
        dialect,
        envelope: "task",
        params: {
          id: gitRepoName(gitUrl),
          version: selected,
          selected_version: selected,
          channel: channel || "dev",
          mode: mode || "cache",
        },
      };
    }
    const sel = selected_version || version || "latest";
    return {
      dialect,
      envelope: "task",
      params: {
        id,
        version: version || sel,
        selected_version: sel,
        mode: mode || "remote",
        channel: channel || "default",
      },
    };
  }

  // v2-batch + legacy share the 3.x body shapes.
  const envelope = dialect === "v2-batch" ? "batch" : "legacy";
  if (gitUrl) {
    return {
      dialect,
      envelope,
      body: {
        ui_id,
        id: gitRepoName(gitUrl),
        version: "unknown",
        selected_version: "unknown",
        files: [gitUrl],
        channel: channel || "default",
        mode: mode || "cache",
      },
    };
  }
  const sel = selected_version || version || "latest";
  return {
    dialect,
    envelope,
    body: {
      ui_id,
      id,
      version: version ?? sel,
      selected_version: sel,
      channel: channel || "default",
      mode: mode || "cache",
    },
  };
}

/** Last path segment of a slash- or backslash-separated name, lowercased input
 *  assumed. Mirrors the orchestrator's basename() use in nodeInstalledMatches. */
function baseName(s) {
  const clean = String(s).replace(/[/\\]+$/, "");
  const cut = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return cut >= 0 ? clean.slice(cut + 1) : clean;
}

/**
 * Normalize the Manager's /customnode/installed response into a flat array of
 * { module, cnrId, auxId }. Manager v4 returns an object keyed by module name
 * (manager_core get_installed_node_packs), each value carrying
 * { ver, cnr_id, aux_id, enabled }; older/legacy builds return an array of
 * objects. Handles both, plus a bare array of strings. Mirrors the mcp
 * orchestrator's parseInstalled (src/services/node-management.ts).
 */
export function parseInstalled(raw) {
  if (!raw || typeof raw !== "object") return [];
  const pick = (v, ...keys) => {
    for (const k of keys) {
      if (typeof v?.[k] === "string" && v[k].length > 0) return v[k];
    }
    return undefined;
  };
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => {
        if (typeof entry === "string") return { module: entry };
        if (!entry || typeof entry !== "object") return null;
        return {
          module: pick(entry, "title", "module", "cnr_id") || "unknown",
          cnrId: pick(entry, "cnr_id"),
          auxId: pick(entry, "aux_id"),
        };
      })
      .filter(Boolean);
  }
  return Object.entries(raw)
    .filter(([, v]) => Boolean(v && typeof v === "object"))
    .map(([module, v]) => ({
      module,
      cnrId: pick(v, "cnr_id"),
      auxId: pick(v, "aux_id"),
    }));
}

/**
 * Does the installed-nodes list contain the pack we just tried to install?
 * `idOrUrl` is the install target — a registry id (author/pack or CNR id) or a
 * git URL. For a git URL we match on the derived repo name. Compares against
 * each installed node's module / cnr_id / aux_id and their basenames. Mirrors
 * the orchestrator's nodeInstalledMatches (src/services/node-management.ts).
 * `installed` may be a raw Manager payload or an already-parsed array.
 */
export function nodeInstalledMatches(idOrUrl, installed) {
  if (!idOrUrl) return false;
  const nodes = Array.isArray(installed) && installed.every((n) => n && "module" in n)
    ? installed
    : parseInstalled(installed);
  const wanted = String(idOrUrl).trim().toLowerCase();
  const repoName = looksLikeGitUrl(idOrUrl) ? gitRepoName(idOrUrl).toLowerCase() : wanted;
  return nodes.some((node) => {
    const candidates = [];
    for (const v of [node.module, node.cnrId, node.auxId]) {
      if (!v) continue;
      const norm = String(v).trim().toLowerCase();
      candidates.push(norm, baseName(norm));
    }
    return candidates.includes(wanted) || candidates.includes(repoName);
  });
}

/** Has the Manager queue POSITIVELY drained? True ONLY for a well-formed status
 *  object that says it stopped AND accounts for every task with coherent counts
 *  (is_processing===false, numeric done_count/total_count, done>=total). A null,
 *  empty, or malformed status is NOT drained — absence of evidence is not
 *  evidence of a drain (codex round 2 #1). */
export function queueDrained(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  if (status.is_processing !== false) return false;
  const done = status.done_count;
  const total = status.total_count;
  if (typeof done !== "number" || typeof total !== "number") return false;
  return done >= total;
}

/** Is a /customnode/installed payload well-formed enough to trust its ABSENCE of
 *  a pack? Only a real array or a plain object (the map shape) counts. null, a
 *  JSON primitive, or anything else ⇒ NOT readable ⇒ inconclusive (codex #3). */
export function isReadableInstalledList(raw) {
  return Array.isArray(raw) || (!!raw && typeof raw === "object");
}

/** Positive evidence that the run actually FAILED — an explicit error/failed
 *  count or array on the queue status, OR the synchronous batch `failed[]`
 *  naming our target. NEVER inferred from a missing pack (inconclusive; #232). */
export function queueFailureSignal(status, batchFailed, target) {
  if (Array.isArray(batchFailed) && batchFailed.length > 0) {
    if (target === undefined || batchFailed.includes(target)) return true;
  }
  if (!status || typeof status !== "object") return false;
  for (const k of ["error_count", "failed_count", "fail_count"]) {
    if (typeof status[k] === "number" && status[k] > 0) return true;
  }
  if (Array.isArray(status.failed) && status.failed.length > 0) return true;
  return false;
}

/**
 * Decide the TRUE outcome of an install after it was queued+started (#232 /
 * codex rounds 1-2). Pure so it is unit-testable without the browser Manager
 * client. DRAINED IS CHECKED FIRST — nothing is "installed" or "failed" until
 * the queue positively drained. Three states, never a false success and never a
 * false failure:
 *   - "installed":  queue drained AND list readable AND pack positively present.
 *   - "failed":     queue drained AND list readable AND pack absent AND explicit
 *                   failure evidence (queue error/failed count, or the batch
 *                   `failed[]`). Only then is absence proof.
 *   - "unverified": everything else — not drained (still processing / no
 *                   positive drain evidence), status/list unreadable or
 *                   malformed, or drained-but-absent with no failure signal
 *                   (e.g. a renamed install dir the name-match can't confirm).
 * @param {{ target:string, dialect?:string, status:unknown, installed:unknown,
 *           listError?:boolean, batchFailed?:unknown }} input
 */
export function classifyInstallOutcome({
  target,
  dialect,
  status,
  installed,
  listError = false,
  batchFailed,
}) {
  const drained = queueDrained(status);
  const listReadable = !listError && isReadableInstalledList(installed);

  // Not drained ⇒ inconclusive REGARDLESS of pack presence — the queue may
  // still be cloning; a pack seen now could be a stale/partial dir (codex #2).
  if (!drained) {
    return {
      state: "unverified",
      status,
      message: unverifiedMessage(
        target,
        "the install is still in progress (the Manager queue has not positively drained)",
      ),
    };
  }

  if (listReadable && nodeInstalledMatches(target, installed)) {
    return { state: "installed", status };
  }

  if (listReadable && queueFailureSignal(status, batchFailed, target)) {
    return {
      state: "failed",
      status,
      message:
        `"${target}" install FAILED: the ComfyUI-Manager queue finished and reported ` +
        `a failure, and the pack is not present in custom_nodes` +
        (dialect ? ` (dialect ${dialect})` : "") +
        `. Check the pack id / git URL and the ComfyUI server log (security_level ` +
        `gating is a common cause).`,
    };
  }

  return {
    state: "unverified",
    status,
    message: unverifiedMessage(
      target,
      !listReadable
        ? "the installed-nodes list could not be read"
        : "the pack was not found by name (its install directory may differ from the repo name)",
    ),
  };
}

function unverifiedMessage(target, why) {
  return (
    `"${target}" was queued but could NOT be confirmed installed — ${why}. This is ` +
    `not a reported failure. Poll panel_node_queue_status and VERIFY with ` +
    `panel_list_nodes; a ComfyUI restart (comfy_reboot) is usually required to load ` +
    `new nodes. If it still does not appear, check the ComfyUI server log.`
  );
}
