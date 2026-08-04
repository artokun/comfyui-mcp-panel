// Pure helpers for routing custom-node installs across the three ComfyUI-Manager
// generations ("v2" = pip Manager v4 unified task queue; "v2-batch" = pip v4 in
// --enable-manager-legacy-ui mode; "legacy" = released 3.x custom-node Manager).
// Kept standalone (no browser globals) so it is unit-testable under `node --test`.
// Consumed by comfyui-mcp-panel.js nodes_install. Mirrors the mcp orchestrator's
// installCustomNode / looksLikeGitUrl / gitCheckoutDir logic
// (src/services/node-management.ts).

/** Does `s` look like a bare "author/repo" GitHub shorthand — no protocol/scp
 *  prefix, no ".git" suffix, exactly one "/", plausible path-segment chars on
 *  both sides? Distinguishes it from a slash-free registry id (e.g.
 *  "rgthree-comfy") and from anything already caught by looksLikeGitUrl's other
 *  branches (a "://" or "git@" form has more than one meaningful "/" or a colon
 *  that this pattern's char class excludes). #301. */
export function looksLikeOwnerRepoShorthand(s) {
  return typeof s === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s);
}

/** Does this identifier look like a git URL (vs a plain registry id)? Recognizes
 *  https(s)://, ssh://, git:// (and git+…), the scp-form git@host:owner/repo,
 *  any value ending in ".git", and a bare "author/repo" shorthand (#301 — the
 *  documented `id` form that a plain registry lookup can't resolve, so it must
 *  route like a git install instead of being sent verbatim to Manager). */
export function looksLikeGitUrl(s) {
  return (
    typeof s === "string" &&
    (/^(https?|ssh|git):\/\//i.test(s) ||
      /^git\+/i.test(s) ||
      /^git@/i.test(s) ||
      s.endsWith(".git") ||
      looksLikeOwnerRepoShorthand(s))
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
 *  URL as `repository` OR directly as `id`; either counts. A bare "author/repo"
 *  shorthand is expanded to a real, clonable GitHub URL (#301) — v4 only ever
 *  uses the repo NAME (gitRepoName strips the expansion right back off), but
 *  the v2-batch/legacy dialects put this value straight into Manager's `files`
 *  clone list, where the bare shorthand alone is not a fetchable URL. Returns
 *  null for a plain registry id. */
export function installGitUrl({ id, repository } = {}) {
  const candidate =
    repository && looksLikeGitUrl(repository) ? repository : id && looksLikeGitUrl(id) ? id : null;
  if (!candidate) return null;
  return looksLikeOwnerRepoShorthand(candidate) ? `https://github.com/${candidate}` : candidate;
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
    `panel_list_nodes; a ComfyUI restart (panel_restart_comfyui) is usually required to load ` +
    `new nodes. If it still does not appear, check the ComfyUI server log.`
  );
}

// ---------------------------------------------------------------------------
// 3.x-LEGACY dialect completeness (#423 list / #424 update-self / #425 restart)
// #230 routed install/update/status by dialect but left three legacy-branch
// gaps. These pure helpers keep the per-dialect route/method choices testable
// under `node --test`, away from the browser Manager client.
// ---------------------------------------------------------------------------

/** #423 — the installed-node list route, WITHOUT the /v2 prefix (managerV2 adds
 *  it for the pip dialects; managerCall hits it absolutely for legacy). The
 *  released 3.x `/customnode/installed` handler reads `mode` (defaulting to
 *  'default'); passing it explicitly matches the live-tested orchestrator
 *  (listInstalledNodes) and keeps the legacy + pip shapes identical. */
export function installedListRoute() {
  return "customnode/installed?mode=default";
}

/** #423 — does a Manager error mean "route/prefix not present on this build"
 *  (a 404 / the panel's "not reachable" throw), i.e. we should retry the
 *  absolute (no-/v2) legacy route? A legacy-UI pip build can answer the queue
 *  probe on /v2 yet NOT register the /v2 data GETs, so the dialect-routed
 *  /v2/customnode/installed 404s while /customnode/installed serves fine.
 *  Broad on purpose: it gates IDEMPOTENT GET fallbacks, where re-issuing the
 *  request after even an ambiguous transport failure is safe. Mutations must
 *  use the stricter isManagerRouteMissing instead (codex P0). */
export function isManagerUnreachable(err) {
  const msg = String(err?.message ?? err ?? "");
  return /not reachable/i.test(msg) || /HTTP\s*404\b/.test(msg);
}

/** #605 / codex P0 — is this error a PROVEN route-level rejection (an HTTP 404
 *  surfaced by managerCall/managerV2, tagged with `managerRouteMissing`)? Only
 *  a 404 proves no handler ran, so ONLY this predicate may authorize re-sending
 *  a MUTATION on another dialect. The broader isManagerUnreachable also matches
 *  the transports' no-response "not reachable" throw — a lost response says
 *  nothing about whether the POST landed, so gating a mutation retry on it
 *  could double-fire the install/update. */
export function isManagerRouteMissing(err) {
  return !!err && err.managerRouteMissing === true;
}

/** #424 — did the Manager reject the method (HTTP 405)? Updating ComfyUI-Manager
 *  ITSELF through a /v2 task/batch envelope 405s on a legacy Manager (the /v2
 *  POST route is a frontend catchall); the fix is to retry the absolute legacy
 *  `/manager/queue/update` self-update route. */
export function isMethodNotAllowed(err) {
  const msg = String(err?.message ?? err ?? "");
  return /HTTP\s*405\b/.test(msg) || /method not allowed/i.test(msg);
}

/** #424 — the released-3.x `/manager/queue/update` body. The handler keys the
 *  update off `id` when `version` !== 'unknown' (node_name = id), so a plain
 *  installed pack name — including 'comfyui-manager' for a Manager self-update —
 *  resolves via unified_update. Mirrors graph_update_node's legacy body. */
export function legacyUpdateBody({ ui_id, id, version } = {}) {
  return { ui_id, id, version: version === "nightly" ? "nightly" : "latest" };
}

/**
 * #605 — after a dialect-routed call failed "unreachable" (a route-level
 * rejection: no handler ran, so re-issuing it cannot double-execute anything),
 * which dialect should the retry speak? `failed` is the dialect that just
 * 404'd; `fresh` is the result of re-probing the LIVE backend (null = the
 * Manager currently answers no dialect at all — mid-restart or disabled).
 *
 *   - A fresh verdict that DIFFERS from the failed one wins: the cached dialect
 *     outlived a backend restart that swapped Manager generations (the #605
 *     report — a stale "legacy" cache aiming at routes a v4 backend no longer
 *     serves), and the live probe is the ground truth.
 *   - Otherwise (the re-probe agrees, or the Manager answers nothing right now)
 *     the legacy absolute routes remain the last resort for a non-legacy
 *     dialect (#485 — a hybrid build can answer the /v2 probe yet not register
 *     the /v2 data/mutation routes).
 *   - A legacy-on-legacy failure has no fallback left: return null so the
 *     caller surfaces its ORIGINAL error, which carries the real context.
 */
export function dialectRetryTarget(failed, fresh) {
  if (fresh && fresh !== failed) return fresh;
  return failed === "legacy" ? null : "legacy";
}

/**
 * Normalize a ComfyUI-Manager `/customnode/getmappings` payload into the
 * nodes_search result shape `{ count, results:[{id,title,description}] }`,
 * filtered by `query` and capped at `limit` (default 15, max 40). Pure so the
 * parse/filter is unit-testable away from the browser Manager client. Handles
 * both wire shapes: an ARRAY of pack objects, or the documented MAP keyed by
 * repo/url → [ [classNames…], { title, description, … } ]. Issues #251/#255.
 *
 * The `id` MUST be a value panel_install_node can actually consume (#394): a
 * cnr/registry id or a git-routable repo URL. In the MAP shape the meta object
 * carries only { title, description } — NO installable id — while the object KEY
 * is the pack's repo URL (git-routable via buildInstallRequest). Deriving the id
 * from the human `title` (e.g. "Impact Pack") produced a display name with a
 * space and no slash/protocol that looksLikeGitUrl rejects → it was sent verbatim
 * to Manager, which silently no-ops on v4 (queue drains "done", nothing installs).
 * So the id is taken from an explicit cnr/reference id when present, else the
 * repo-URL KEY — NEVER the title. The title is still returned separately for
 * display.
 */
export function parseNodeMappings(data, query, limit) {
  const q = String(query ?? "").toLowerCase();
  const out = [];
  const push = (id, title, desc) => {
    if (!id) return;
    const hay = `${id} ${title ?? ""} ${desc ?? ""}`.toLowerCase();
    if (!q || hay.includes(q)) {
      out.push({ id, title: title ?? id, description: String(desc ?? "").slice(0, 160) });
    }
  };
  if (Array.isArray(data)) {
    // Array shape: an explicit cnr `id` or a repo-URL `reference` are both
    // installable; only fall back to `title` when neither is present (#394).
    for (const p of data) push(p?.id ?? p?.reference ?? p?.title, p?.title, p?.description);
  } else if (data && typeof data === "object") {
    for (const [key, val] of Object.entries(data)) {
      const meta = Array.isArray(val) ? val[1] : val;
      // #394: prefer an installable id (cnr/reference), else the repo-URL KEY.
      // NEVER the display title — that is not resolvable by panel_install_node.
      push(meta?.id ?? meta?.reference ?? key, meta?.title, meta?.description);
    }
  }
  const max = Math.min(Number(limit) || 15, 40);
  return { count: out.length, results: out.slice(0, max) };
}

/**
 * #426 — INSTALLED-node search over ComfyUI's core `/object_info` map, the last
 * resort when the Manager registry backend is unreachable (legacy 3.x without the
 * search endpoint, or Manager disabled). `/object_info` is keyed by node CLASS
 * name → { display_name, category, description, ... } and is ALWAYS present on any
 * running ComfyUI, so an agent can still discover the nodes it can use RIGHT NOW.
 * Filters by `query` across class name / display_name / category / description and
 * caps at `limit` (default 15, max 40). Pure so it is unit-testable off-browser.
 * `id` is the node class name (usable directly as a node type); these are already
 * installed, so no registry install id is needed.
 */
export function parseObjectInfoSearch(objectInfo, query, limit) {
  const q = String(query ?? "").toLowerCase();
  const out = [];
  if (objectInfo && typeof objectInfo === "object") {
    for (const [cls, meta] of Object.entries(objectInfo)) {
      const title = meta?.display_name || cls;
      const desc = meta?.description ?? "";
      const category = meta?.category ?? "";
      const hay = `${cls} ${title} ${category} ${desc}`.toLowerCase();
      if (!q || hay.includes(q)) {
        out.push({ id: cls, title, description: String(desc).slice(0, 160), installed: true });
      }
    }
  }
  const max = Math.min(Number(limit) || 15, 40);
  return { count: out.length, results: out.slice(0, max) };
}

/**
 * #426 — when BOTH Manager registry routes are unreachable, try the installed-node
 * `/object_info` search before giving up. On a hit, return a supported result the
 * agent can act on (installed-only); otherwise fall through to the structured
 * "Manager unavailable" capability result. `objectInfoGet` is dependency-injected
 * (the panel wires the live /object_info fetch) so this stays unit-testable, and
 * NEVER throws — any /object_info failure degrades to managerUnavailableResult.
 */
export async function objectInfoSearchFallback(objectInfoGet, query, limit, err) {
  if (typeof objectInfoGet !== "function") return managerUnavailableResult(query, err);
  let info;
  try {
    info = await objectInfoGet();
  } catch {
    return managerUnavailableResult(query, err);
  }
  const parsed = parseObjectInfoSearch(info, query, limit);
  if (!parsed.count) return managerUnavailableResult(query, err);
  return {
    supported: true,
    managerReachable: false,
    source: "object_info",
    installedOnly: true,
    count: parsed.count,
    results: parsed.results,
    query: query == null ? "" : String(query),
    message:
      "ComfyUI-Manager's registry search is unavailable (the built-in Manager is " +
      "disabled, or a legacy/partial build without the search endpoint), so these are " +
      "INSTALLED nodes matching your query from the connected ComfyUI's /object_info — " +
      "already available to use directly (add with panel_add_node). Searching/installing " +
      "NEW packs from the registry needs the built-in Manager (v4+) enabled.",
  };
}

/**
 * Graceful-degradation result for nodes_search when the ComfyUI-Manager search
 * backend can NOT be reached on ANY route (dialect-routed /v2 AND the absolute
 * legacy route both threw "not reachable"). Instead of surfacing a raw throw —
 * which blocks the whole install-discovery flow even though the agent can keep
 * using already-registered nodes — return a STRUCTURED, actionable capability
 * result the caller can branch on. Issues #251/#255.
 */
export function managerUnavailableResult(query, err) {
  return {
    supported: false,
    managerReachable: false,
    count: 0,
    results: [],
    query: query == null ? "" : String(query),
    reason: String(err?.message ?? err ?? "ComfyUI-Manager not reachable"),
    message:
      "Node-registry search is unavailable: the built-in ComfyUI-Manager could not " +
      "be reached on this ComfyUI (it may be disabled, or a legacy/partial Manager " +
      "build without the search endpoint). Enable the built-in Manager to search the " +
      "registry, or continue with the nodes already installed — inspect them with " +
      "panel_list_nodes and the current graph with panel_query_graph.",
  };
}

/**
 * Run the nodes_search flow with graceful degradation against an unreachable /
 * legacy ComfyUI-Manager (#251/#255). Dependency-injected `managerGet` (dialect-
 * routed; adds /v2 for pip builds, strips it for legacy) and `managerCall`
 * (absolute, no-/v2) so the whole decision path is unit-testable away from the
 * browser Manager client. Order:
 *   1. dialect-routed GET;
 *   2. on an unreachable/404 signal, retry the ABSOLUTE legacy route (a legacy-
 *      UI pip build or real 3.x Manager can serve /customnode/getmappings while
 *      the /v2 route 404s, or detectManagerDialect's /v2 probe fails);
 *   3. if the absolute route is ALSO unreachable, try the installed-node
 *      /object_info search (#426) via the injected `objectInfoGet`; on a miss,
 *      return the structured {supported:false,…} capability result instead of
 *      throwing.
 * Any non-"unreachable" error still propagates.
 */
export async function searchNodesVia(
  managerGet,
  managerCall,
  { query, limit, objectInfoGet } = {},
) {
  const route = "customnode/getmappings?mode=cache";
  let data;
  try {
    data = await managerGet(route);
  } catch (err) {
    if (!isManagerUnreachable(err)) throw err;
    try {
      data = await managerCall(route);
    } catch (err2) {
      if (isManagerUnreachable(err2))
        return objectInfoSearchFallback(objectInfoGet, query, limit, err2);
      throw err2;
    }
  }
  return parseNodeMappings(data, query, limit);
}

/** #425 — ordered reboot {route, method} candidates for the detected dialect.
 *  The released 3.x Manager serves ONLY `POST /manager/reboot` (the pre-#230
 *  panel tried `GET /manager/reboot` → 404, after `POST /v2/manager/reboot` →
 *  405, leaving a legacy Manager unrestartable — issue #214). pip builds keep
 *  `POST /v2/manager/reboot` first; a very old `GET /manager/reboot` stays last
 *  as a final fallback. Every candidate is a real, method-correct route so the
 *  bridge from a legacy Manager to a freshly-staged v4 install works either way. */
export function rebootCandidates(dialect) {
  const v2 = { route: "/v2/manager/reboot", method: "POST" };
  const legacyPost = { route: "/manager/reboot", method: "POST" };
  const legacyGet = { route: "/manager/reboot", method: "GET" };
  return dialect === "legacy"
    ? [legacyPost, v2, legacyGet]
    : [v2, legacyPost, legacyGet];
}

// ---------------------------------------------------------------------------
// Per-task terminal-status interpretation (#364)
//
// The aggregate /v2/manager/queue/status endpoint CANNOT reveal a failed task:
// a task that crashed (e.g. `do_update` raising AttributeError) is still moved
// into history and still counts toward `done_count` — so the queue reports
// `done_count:1 / is_processing:false` and looks exactly like a success. The
// AUTHORITATIVE per-task verdict lives in the Manager task history
// (/v2/manager/queue/history), where each task carries a
// `status: { status_str, completed, messages }` and a `result` string. On a
// crash the worker records `status.status_str = "error"` (or `"failed"`) with
// the exception text in `messages`/`result`. These pure helpers interpret that
// record so `graph_update_node` can report a REAL failure instead of a blind
// `queued:true`, and so `nodes_queue_status` can surface recent task failures.
// Kept standalone (no browser globals) for `node --test`.
// ---------------------------------------------------------------------------

/** Manager OperationResult values (data_models/generated_models.py):
 *  success | failed | skipped | error | skip. "success"/"skip"/"skipped" are
 *  non-failure terminals; "error"/"failed" are failures. */
const TASK_SUCCESS_STATUS = new Set(["success", "skip", "skipped"]);
const TASK_FAILURE_STATUS = new Set(["error", "failed"]);

/** Is `v` a plausible Manager task-history ENTRY — a plain object carrying at
 *  least one recognizable task field? Guards map/array traversal and the
 *  single-item (ui_id-queried) shape against error envelopes and junk. */
function isTaskHistoryItem(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return "status" in v || "result" in v || "kind" in v || "ui_id" in v;
}

/** The task's `status.status_str` (an OperationResult value) if present. */
function taskStatusStr(item) {
  const status = item && typeof item === "object" ? item.status : undefined;
  const s = status && typeof status === "object" ? status.status_str : undefined;
  return typeof s === "string" ? s : undefined;
}

/**
 * POSITIVE failure reason for a Manager task-history item, or null when the item
 * is NOT a definitive failure. A failure is asserted ONLY on an explicit failure
 * terminal (`status.status_str` ∈ {error, failed}) — never inferred from a
 * missing/unknown status (that stays inconclusive, so a task still running or a
 * shape we don't recognize can never become a FALSE failure). Prefers the
 * `status.messages` (the crash/exception text) for the reason, then `result`.
 */
export function taskFailureReason(item) {
  if (!isTaskHistoryItem(item)) return null;
  if (!TASK_FAILURE_STATUS.has(taskStatusStr(item))) return null;
  const status = item.status;
  const messages =
    status && Array.isArray(status.messages)
      ? status.messages.filter((m) => typeof m === "string" && m.trim())
      : [];
  if (messages.length) return messages.join("; ");
  if (typeof item.result === "string" && item.result.trim() && item.result !== "success") {
    return item.result;
  }
  return "the Manager reported the task as failed (no detail provided)";
}

/** POSITIVE success terminal — an explicit success/skip status. A skip ("already
 *  up to date") is a legitimate no-op success for an update. */
export function taskSucceeded(item) {
  return isTaskHistoryItem(item) && TASK_SUCCESS_STATUS.has(taskStatusStr(item));
}

/**
 * Extract the single task-history item for `ui_id` from a /v2/manager/queue/history
 * response. Handles BOTH server shapes:
 *   - ui_id-queried: `{ history: <item> }` (the item itself), and
 *   - unfiltered/map: `{ history: { <ui_id>: <item>, … } }`.
 * A bare item (already unwrapped) is accepted too. Returns null when absent
 * (task not yet recorded) or malformed — the caller then stays "unverified".
 */
export function parseTaskHistoryItem(resp, ui_id) {
  const history =
    resp && typeof resp === "object" && "history" in resp ? resp.history : resp;
  if (!history || typeof history !== "object") return null;
  // Single-item (ui_id-queried) shape: the item carries task fields directly.
  if (isTaskHistoryItem(history)) {
    const own = typeof history.ui_id === "string" ? history.ui_id : undefined;
    if (ui_id && own && own !== ui_id) return null;
    return history;
  }
  // Map keyed by ui_id.
  if (ui_id && isTaskHistoryItem(history[ui_id])) return history[ui_id];
  return null;
}

/** The pack id a task acted on, for correlation in surfaced failures. */
function taskParamId(item) {
  const p = item && typeof item === "object" ? item.params : undefined;
  if (p && typeof p === "object") {
    for (const k of ["node_name", "id", "cnr_id", "aux_id"]) {
      if (typeof p[k] === "string" && p[k].trim()) return p[k];
    }
  }
  return undefined;
}

/**
 * Collect the FAILED tasks from a /v2/manager/queue/history response (map or
 * array form) as compact `{ ui_id, kind, id, result }` records. Used by
 * nodes_queue_status so a post-hoc poll of an idle queue does not read a silent
 * "done" over a task that actually errored (#364). Only positive failures
 * (taskFailureReason) are included; capped to the most recent `limit`.
 */
export function collectRecentTaskFailures(resp, { limit = 20 } = {}) {
  const history =
    resp && typeof resp === "object" && "history" in resp ? resp.history : resp;
  if (!history || typeof history !== "object") return [];
  const items = Array.isArray(history) ? history : Object.values(history);
  const out = [];
  for (const item of items) {
    const reason = taskFailureReason(item);
    if (!reason) continue;
    out.push({
      ui_id: typeof item.ui_id === "string" ? item.ui_id : undefined,
      kind: typeof item.kind === "string" ? item.kind : undefined,
      id: taskParamId(item),
      result: reason,
    });
  }
  return out.slice(-limit);
}

/**
 * Decide the TRUE outcome of an UPDATE after it was queued+started (#364). Pure,
 * unit-testable. Precedence guarantees neither a false success nor a false
 * failure:
 *   1. "failed"    — the per-task history item is an explicit failure terminal
 *                    (status_str error/failed). Surfaces the Manager reason.
 *   2. "updated"   — the per-task item is an explicit success/skip terminal.
 *   3. "unverified"— no terminal task record yet (still running, history not
 *                    served by a legacy Manager, or a shape we don't recognize).
 *                    Honest "queued, could not confirm" — NEVER a failure.
 * @param {{ item?:unknown, status?:unknown, target:string, dialect?:string }} input
 */
export function classifyUpdateOutcome({ item, status, target, dialect } = {}) {
  const reason = taskFailureReason(item);
  if (reason) {
    return {
      state: "failed",
      status,
      message:
        `Update of "${target}" FAILED: the ComfyUI-Manager task terminated with an ` +
        `error` +
        (dialect ? ` (dialect ${dialect})` : "") +
        `: ${reason}. The pack was NOT updated — check the ComfyUI server log for the ` +
        `full traceback.`,
    };
  }
  if (taskSucceeded(item)) {
    return { state: "updated", status };
  }
  return {
    state: "unverified",
    status,
    message:
      `Update of "${target}" was queued but its outcome could NOT be confirmed` +
      (dialect ? ` (dialect ${dialect})` : "") +
      ` — the Manager task has not reported a terminal result. This is NOT a reported ` +
      `failure. Poll panel_node_queue_status; a ComfyUI restart (panel_restart_comfyui) is ` +
      `usually required to load an updated node. If it still misbehaves, check the ` +
      `ComfyUI server log.`,
  };
}
