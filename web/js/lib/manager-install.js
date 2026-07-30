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

/** Keys a genuine installed-node entry object carries (manager_core
 *  get_installed_node_packs + array/variant shapes). One is enough. */
const NODE_ENTRY_KEYS = ["module", "cnr_id", "cnrId", "aux_id", "auxId", "name", "title", "ver", "version"];

/** Is `v` a plausible installed-node ENTRY — a plain object with at least one
 *  expected key? Guards against error envelopes and junk. */
function isNodeEntry(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return NODE_ENTRY_KEYS.some((k) => k in v);
}

/** Is a /customnode/installed payload well-formed enough to TRUST its absence of
 *  a pack? Validates SHAPE, not just container type (codex round 4). Readable
 *  ONLY when it is:
 *    - an EMPTY array or map (legitimately "nothing installed"), OR
 *    - an ARRAY whose every element is a node-entry object, OR
 *    - a plain object (MAP) whose every value is a node-entry object.
 *  An error envelope ({error|detail|message:…} with no entries), an array
 *  containing null/primitives/non-entry items, a no-entry-shape object, null, or
 *  a JSON primitive ⇒ NOT readable ⇒ inconclusive (stays unverified). */
export function isReadableInstalledList(raw) {
  if (Array.isArray(raw)) {
    // Bare-string arrays are a documented legacy shape (parseInstalled handles
    // them); accept an array whose every element is a non-empty string OR a
    // node-entry object. Mixed/primitive/null elements ⇒ not readable.
    return raw.every(
      (el) => (typeof el === "string" && el.length > 0) || isNodeEntry(el),
    );
  }
  if (!raw || typeof raw !== "object") return false;
  const values = Object.values(raw);
  if (values.length === 0) return true; // empty map — nothing installed
  return values.every((v) => isNodeEntry(v));
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
 * codex rounds 1-3). Pure so it is unit-testable without the browser Manager
 * client. Precedence — never a false success and never a false failure:
 *   1. present pack ⇒ "installed"  (gated: queue must have positively drained).
 *   2. "failed" ONLY when: drained AND list readable AND explicit failure
 *      evidence (queue error/failed count, or the batch `failed[]`) AND the
 *      pack is DEFINITIVELY ABSENT — meaning the target is IDENTIFIABLE (a
 *      claimed registry id whose cnr_id/aux_id the matcher would recognize if
 *      present), not a rename-prone git/owner-repo install whose on-disk dir may
 *      differ from its name. "Not name-matched" alone is NOT absence.
 *   3. everything else ⇒ "unverified": not drained, unreadable/malformed list,
 *      absent-but-no-failure-evidence, OR presence INCONCLUSIVE (a rename-prone
 *      install we can neither confirm nor rule out) — even with a failure
 *      signal / stale batchFailed. A genuine renamed-dir install (codex round 3)
 *      lands here, never "failed".
 * @param {{ target:string, dialect?:string, status:unknown, installed:unknown,
 *           listError?:boolean, batchFailed?:unknown, renameProne?:boolean }} input
 */
export function classifyInstallOutcome({
  target,
  dialect,
  status,
  installed,
  listError = false,
  batchFailed,
  renameProne = false,
}) {
  const drained = queueDrained(status);
  const listReadable = !listError && isReadableInstalledList(installed);

  // Not drained ⇒ inconclusive REGARDLESS of pack presence — the queue may
  // still be cloning; a pack seen now could be a stale/partial dir (codex r2 #2).
  if (!drained) {
    return unverified(
      target,
      status,
      "the install is still in progress (the Manager queue has not positively drained)",
    );
  }

  // Positive presence wins outright.
  if (listReadable && nodeInstalledMatches(target, installed)) {
    return { state: "installed", status };
  }

  // Absence is only PROOF when the target is identifiable — otherwise a
  // rename-prone pack (git URL / owner-repo) may have installed under a dir the
  // name-match can't see. Presence is then INCONCLUSIVE, never "failed" (codex r3).
  const definitivelyAbsent = listReadable && !renameProne;
  if (definitivelyAbsent && queueFailureSignal(status, batchFailed, target)) {
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

  const why = !listReadable
    ? "the installed-nodes list could not be read"
    : renameProne
      ? "its presence could not be confirmed — a git/owner-repo pack can install " +
        "under a directory name that differs from the repo name, so the name-match " +
        "can neither confirm nor rule it out"
      : "the pack was not found by name and no failure was reported";
  return unverified(target, status, why);
}

function unverified(target, status, why) {
  return { state: "unverified", status, message: unverifiedMessage(target, why) };
}

function unverifiedMessage(target, why) {
  return (
    `"${target}" was queued but could NOT be confirmed installed — ${why}. This is ` +
    `not a reported failure. Poll panel_node_queue_status and VERIFY with ` +
    `panel_list_nodes; a ComfyUI restart (comfy_reboot) is usually required to load ` +
    `new nodes. If it still does not appear, check the ComfyUI server log.`
  );
}
