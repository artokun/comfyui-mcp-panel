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
 * ref||"nightly", channel:"dev", repository: url}. The `repository` half was missing
 * and is #920 — without it v4 has only the NAME and resolves it against the registry,
 * which is a lookup rather than a clone; Manager's own InstallPackParams documents the
 * field as "required if selected_version is nightly". v2-batch + legacy install the URL
 * natively via {id: repoName, version: "unknown", files:[url]} — a different shape whose
 * handler reads files[0], so they were never missing it. A registry id keeps the
 * versioned body and carries no `repository` at all. `id` is
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
          // #920 — SEND THE URL. Reducing it to `gitRepoName` and stopping there turned a
          // from-source install into a registry lookup, and Manager answered
          // "Node '<name>@nightly' not found in [ManagerChannel.dev,
          // ManagerDatabaseSource.cache]" — both sources being the two defaults below.
          //
          // The field is not inferred. Manager's own model declares it:
          //
          //   class InstallPackParams(ManagerPackInfo):
          //     repository: Optional[str] = Field(
          //       None, description="GitHub repository URL (required if selected_version
          //                          is nightly)")
          //
          // and "required if nightly" is exactly the reported call. `id` stays the derived
          // NAME rather than the URL: sending a URL there made v4 silently mark the
          // install done while doing nothing, which is why it was derived in the first
          // place — that behaviour is preserved, this only stops discarding the URL.
          repository: gitUrl,
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
 * #1496 — which filter a `nodes_list` command asked for.
 * `search` is the reporter's key (and the compact-mode list_tools filter).
 * `query` is the alias panel_search_nodes / panel_find_nodes already use.
 * Prefer `search` when both are non-empty.
 */
export function installedListQuery(args = {}) {
  const search = args?.search;
  const query = args?.query;
  if (typeof search === "string" && search.trim()) return { key: "search", value: search };
  if (typeof query === "string" && query.trim()) return { key: "query", value: query };
  return { key: null, value: "" };
}

function installedEntryHay(entry, mapKey) {
  if (typeof entry === "string") return entry.toLowerCase();
  if (!entry || typeof entry !== "object") return String(mapKey ?? "").toLowerCase();
  return [mapKey, entry.title, entry.module, entry.cnr_id, entry.aux_id, entry.ver]
    .filter((v) => typeof v === "string" && v)
    .join(" ")
    .toLowerCase();
}

/** Filter a raw Manager `/customnode/installed` payload, preserving map vs array shape. */
export function filterInstalledPayload(raw, query) {
  const terms = queryTerms(query);
  if (Array.isArray(raw)) {
    const total = raw.length;
    if (!terms.length) return { installed: raw, total, count: total };
    const installed = raw.filter((entry) => matchesAllTerms(installedEntryHay(entry), terms));
    return { installed, total, count: installed.length };
  }
  if (raw && typeof raw === "object") {
    const entries = Object.entries(raw);
    const total = entries.length;
    if (!terms.length) return { installed: raw, total, count: total };
    const installed = Object.create(null);
    for (const [k, v] of entries) {
      if (matchesAllTerms(installedEntryHay(v, k), terms)) installed[k] = v;
    }
    return { installed, total, count: Object.keys(installed).length };
  }
  return { installed: raw, total: 0, count: 0 };
}

/**
 * #1496 — `panel_list_nodes` result. No filter → `{installed}` as before.
 * A `search`/`query` filters the payload and discloses count/total so a miss
 * cannot be read as "nothing is installed".
 */
export function listedNodesResult(raw, args = {}) {
  const { key, value } = installedListQuery(args);
  if (!key) return { installed: raw };
  const filtered = filterInstalledPayload(raw, value);
  const out = {
    installed: filtered.installed,
    [key]: value,
    count: filtered.count,
    total: filtered.total,
  };
  if (filtered.count === 0) {
    out.note =
      `0 of ${filtered.total} installed packs matched ${key} "${value}". ` +
      `This filters ALREADY-INSTALLED packs, not the installable registry — ` +
      `use panel_search_nodes with query for packs you can install.`;
  }
  return out;
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

/**
 * Resolve a caller's installed directory, registry id, or repository spelling
 * to the key ComfyUI-Manager uses for `active_nodes` updates. The installed
 * endpoint is keyed by the on-disk module name, but a registry install may
 * carry a different `cnr_id`; Manager indexes that same pack by `cnr_id`.
 * Unknown git packs use the repository basename from `aux_id` before their
 * directory name.
 * Returns null when the installed list does not identify a matching pack.
 */
export function resolveInstalledUpdateId(idOrUrl, installed) {
  if (!idOrUrl) return null;
  const nodes = Array.isArray(installed) && installed.every((n) => n && "module" in n)
    ? installed
    : parseInstalled(installed);
  const wanted = String(idOrUrl).trim().toLowerCase();
  const repoName = looksLikeGitUrl(idOrUrl) ? gitRepoName(idOrUrl).toLowerCase() : wanted;
  const node = nodes.find((entry) => {
    const candidates = [];
    for (const value of [entry.module, entry.cnrId, entry.auxId]) {
      if (!value) continue;
      const normalized = String(value).trim().toLowerCase();
      candidates.push(normalized, baseName(normalized));
    }
    return candidates.includes(wanted) || candidates.includes(repoName);
  });
  if (!node) return null;
  return (
    node.cnrId ||
    (node.auxId ? baseName(node.auxId) : null) ||
    (node.module && node.module !== "unknown" ? node.module : null)
  );
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
  taskFailure = null,
}) {
  // #1539 — the Manager's OWN terminal verdict for the task we submitted (keyed
  // by our ui_id) outranks every proxy below, and is checked before the
  // not-drained early return: a terminal record is conclusive whether or not the
  // queue has drained (a neighbouring task can keep it busy indefinitely).
  //
  // Everything below is a proxy — "the queue drained and the pack is not there".
  // For a git URL those proxies can NEVER conclude failure, because renameProne
  // suppresses the queueFailureSignal branch (a git pack may install under a
  // directory the name-match cannot see, so absence is not proof). That is
  // exactly the reported bug: v4 rejects an unlisted repo by REGISTRY LOOKUP —
  // `Node '<name>@nightly' not found in [ManagerChannel.dev,
  // ManagerDatabaseSource.cache]` — records the error, drains, and the install
  // reported `queued: true, pending: true`. The record said "failed" the whole
  // time; nothing read it.
  if (taskFailure) {
    return {
      state: "failed",
      status,
      message:
        `"${target}" install FAILED: the ComfyUI-Manager task terminated with an error` +
        (dialect ? ` (dialect ${dialect})` : "") +
        `: ${taskFailure}. The install did NOT complete — check the ComfyUI server log ` +
        `for the full traceback.` +
        // The registry-miss case has a specific, verified way forward (#920), and
        // it is worth far more HERE than on a later poll: this is the reply to the
        // install call itself, so the caller learns it without having to know to
        // ask again. Empty for every other failure.
        unlistedGitUrlAdvice(taskFailure),
    };
  }

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

/** Tag an error the Manager transport could not get an answer for, so the
 *  fallback ladder can recognise it WITHOUT reading its wording (#423). */
export function markManagerUnreachable(err) {
  if (err && typeof err === "object") err.managerTransportUnreachable = true;
  return err;
}

/** #423 — does a Manager error mean "route/prefix not present on this build"
 *  (a 404 / the panel's "not reachable" throw), i.e. we should retry the
 *  absolute (no-/v2) legacy route? A legacy-UI pip build can answer the queue
 *  probe on /v2 yet NOT register the /v2 data GETs, so the dialect-routed
 *  /v2/customnode/installed 404s while /customnode/installed serves fine.
 *  Broad on purpose: it gates IDEMPOTENT GET fallbacks, where re-issuing the
 *  request after even an ambiguous transport failure is safe. Mutations must
 *  use the stricter isManagerRouteMissing instead (codex P0).
 *
 *  ## Why this asks the error, not the sentence
 *
 *  This used to decide by matching the English words "not reachable". The
 *  message it reads is composed by `classifyManager404`, which runs it through
 *  `tr()` — so on all 11 non-English locales the match failed, every rung of the
 *  ladder rethrew, and the generic error surfaced while the Manager was running
 *  and answering. The fallbacks existed and were unreachable code for anyone not
 *  using the panel in English, which is how #423 recurred on 0.14.36 with the
 *  whole ladder already shipped.
 *
 *  The facts were never in the prose: a route-missing 404 is already tagged
 *  `managerRouteMissing`, and the transports now tag their no-response throw. The
 *  wording test is kept LAST and only as a bridge for any path that throws a bare
 *  Error without passing through those — it can only add matches, never remove
 *  one, so a locale can no longer take a fallback away. */
export function isManagerUnreachable(err) {
  // #706, structurally. A security refusal means a handler RAN and declined; it is
  // not an unreachable route in any language. This used to hold only because that
  // message happens not to contain "not reachable" — but it embeds up to 300
  // characters of UPSTREAM body text, so the wording was never ours to rely on.
  if (err?.managerSecurityRefusal === true) return false;
  if (isManagerRouteMissing(err)) return true;
  if (err?.managerTransportUnreachable === true) return true;
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
 * #1088 — split a search query into lowercased TERMS, matched independently.
 *
 * The whole query used to be one contiguous substring to find, and that returned zero
 * for packs the catalogue plainly contains, because the SEPARATOR differs between the
 * two sides. Pack identity lives in the repo name and spells the same words
 * `comfyui-textoverlay` or `ComfyUI-text-overlay`; a human types `text overlay`.
 * Neither spelling contains `"text overlay"`, so all three of the reporter's packs
 * reported absent while the single token `overlay` found them. Printed next to
 * `catalogue_size: 5583`, that 0 reads as "this pack does not exist" — the #808
 * conflation, arriving through the query instead of through an empty catalogue.
 *
 * Splitting on WHITESPACE only, and never on `-` or `_`: those are real characters in
 * a pack id, and a term of `text` already matches `text-overlay` and `textoverlay`
 * alike as a substring. Splitting the HAYSTACK too would be the change that needs
 * justifying; this one only stops treating the user's spaces as literal.
 *
 * A whitespace-only query yields NO terms and therefore filters nothing — the same
 * answer `""` already gave, rather than the empty result a literal match produced for
 * a query the caller may not be able to see is padded.
 */
export function queryTerms(query) {
  return String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does `hay` contain EVERY term? AND, deliberately, not OR.
 *
 * OR would be a worse defect than the one being fixed: `impact overlay` would match
 * every pack containing either word, and a caller reading a 40-row result cannot tell
 * a real hit from noise — a search that answers everything is as useless as one that
 * answers nothing, and unlike the zero it does not announce itself.
 *
 * This is a strict SUPERSET of the contiguous match it replaces: if a haystack
 * contained the query as one substring, it contains each of the query's terms as a
 * substring too. So no search that worked before can stop working — the property that
 * makes this safe to ship, pinned by a test rather than left as an argument.
 */
export function matchesAllTerms(hay, terms) {
  for (const t of terms) {
    if (!hay.includes(t)) return false;
  }
  return true;
}

/**
 * #1287 — the most `limit` panel_search_nodes will return. The orchestrator's input
 * schema rejects anything above this (MCP -32602, `maximum: 40`) and the panel applies
 * the same bound when it slices results. A request ABOVE the cap is not an error — the
 * search itself is valid — but silently returning fewer rows than asked is how a caller
 * ends up reasoning over a truncated list as if it were the whole answer, so the result
 * DISCLOSES the clamp as `limit_cap` whenever it bit.
 */
export const SEARCH_LIMIT_CAP = 40;

/**
 * Normalize a ComfyUI-Manager `/customnode/getmappings` payload into the
 * nodes_search result shape `{ count, results:[{id,title,description}] }`,
 * filtered by `query` and capped at `limit` (default 15, max SEARCH_LIMIT_CAP —
 * a request above the cap is disclosed as `limit_cap`, never silently honored,
 * #1287). Pure so the parse/filter is unit-testable away from the browser
 * Manager client. Handles
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
  const terms = queryTerms(query);
  const out = [];
  const push = (id, title, desc) => {
    if (!id) return;
    const hay = `${id} ${title ?? ""} ${desc ?? ""}`.toLowerCase();
    if (matchesAllTerms(hay, terms)) {
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
  const requested = Number(limit) || 15;
  const max = Math.min(requested, SEARCH_LIMIT_CAP);
  // #808 — `catalogue_size` is how many packs the payload CONTAINED, before the query
  // filter. Without it, "the catalogue is empty" and "the catalogue is fine, your query
  // matched nothing" both arrive as `count: 0` — and the reader takes the first for the
  // second, concludes the pack does not exist, and goes on trying variations of a search
  // that cannot succeed. That conflation is the whole of #808.
  const result = { count: out.length, results: out.slice(0, max), catalogue_size: catalogueSize(data) };
  // #1287 — the caller asked for more than the cap; say so, or the short list reads
  // as the whole answer.
  if (requested > SEARCH_LIMIT_CAP) result.limit_cap = SEARCH_LIMIT_CAP;
  return result;
}

/**
 * #808 — how many packs a `/customnode/getmappings` payload actually carries, counted
 * RAW: before id extraction, and before the query filter.
 *
 * Raw deliberately. The question is "did Manager return any packs at all", and counting
 * only the entries that yielded an installable id would fold a PARSE fault into the
 * EMPTY-CATALOGUE answer — a different problem with a different remedy. A body that is
 * not a catalogue at all (null, a string, a proxy's sign-in HTML) contains no packs
 * either, so 0 is the correct answer for it too.
 */
export function catalogueSize(data) {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") return Object.keys(data).length;
  return 0;
}

/**
 * #426 — INSTALLED-node search over ComfyUI's core `/object_info` map, the last
 * resort when the Manager registry backend is unreachable (legacy 3.x without the
 * search endpoint, or Manager disabled). `/object_info` is keyed by node CLASS
 * name → { display_name, category, description, ... } and is ALWAYS present on any
 * running ComfyUI, so an agent can still discover the nodes it can use RIGHT NOW.
 * Filters by `query` across class name / display_name / category / description and
 * caps at `limit` (default 15, max SEARCH_LIMIT_CAP — a request above the cap is
 * disclosed as `limit_cap`, never silently honored, #1287). Pure so it is
 * unit-testable off-browser.
 * `id` is the node class name (usable directly as a node type); these are already
 * installed, so no registry install id is needed.
 */
export function parseObjectInfoSearch(objectInfo, query, limit) {
  const terms = queryTerms(query);
  const out = [];
  if (objectInfo && typeof objectInfo === "object") {
    for (const [cls, meta] of Object.entries(objectInfo)) {
      const title = meta?.display_name || cls;
      const desc = meta?.description ?? "";
      const category = meta?.category ?? "";
      const hay = `${cls} ${title} ${category} ${desc}`.toLowerCase();
      if (matchesAllTerms(hay, terms)) {
        out.push({ id: cls, title, description: String(desc).slice(0, 160), installed: true });
      }
    }
  }
  const requested = Number(limit) || 15;
  const max = Math.min(requested, SEARCH_LIMIT_CAP);
  const result = { count: out.length, results: out.slice(0, max) };
  // #1287 — same disclosure as the registry search: a clamped limit is named, not silent.
  if (requested > SEARCH_LIMIT_CAP) result.limit_cap = SEARCH_LIMIT_CAP;
  return result;
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
  const result = {
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
  // #1287 — the clamp disclosure must survive the fallback re-wrap too.
  if (parsed.limit_cap) result.limit_cap = parsed.limit_cap;
  return result;
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
 * #808 — Manager ANSWERED, and its node catalogue is EMPTY.
 *
 * `searchNodesVia` asks for `customnode/getmappings?mode=cache`, so Manager serves from
 * its own local cache. A cache it never managed to populate — because Manager itself
 * could not reach the node registry — answers HTTP 200 with `{}`. Filtered against a
 * query that produces `count: 0`, which is the SAME answer a healthy catalogue gives when
 * nothing matches. Empty and unreachable look identical, so the reader concludes their
 * query was wrong and keeps trying variations of an action that can never succeed. A
 * Chinese-speaking user reported exactly that — "我这边搜不到任何内容" — and three rounds
 * of advice were spent sending them at a door that could not open.
 *
 * Zero packs is sound evidence: any working install has thousands.
 *
 * WHAT AN EMPTY CATALOGUE ACTUALLY MEANS — read out of ComfyUI-Manager's own source
 * (`glob/manager_core.py`, `get_data_by_mode`), not assumed:
 *
 *   • A NETWORK failure does NOT produce `{}`. The `except` branch falls back to the
 *     copy of `extension-node-map.json` BUNDLED in the Manager package (2.2 MB and
 *     populated on a stock install), so a blocked channel still yields a full — if
 *     stale — catalogue. This is why the message below does NOT lead with "your
 *     network is filtered": Manager masks that case rather than emptying the list.
 *   • `{}` comes from the `network_mode == 'offline'` path when NEITHER the cache file
 *     NOR the local bundled file exists, or when the file that is found is itself empty
 *     or unreadable.
 *
 * So zero packs means Manager assembled a catalogue from NONE of its three sources —
 * channel, cache, bundled copy. That is genuinely anomalous (a working install has
 * thousands), which is what makes the branch safe from false positives.
 *
 * WHAT THIS DOES NOT CLAIM. The panel does not make the channel request — Manager does —
 * so it never observed a DNS failure, a timeout or a TLS error and must not report one.
 * It says what it saw: Manager answered, the catalogue is empty, so NOTHING WAS SEARCHED
 * and nothing follows about whether the pack exists. The host it names is the one this
 * catalogue actually comes from — Manager's `DEFAULT_CHANNEL`,
 * `raw.githubusercontent.com/ltdrdata/ComfyUI-Manager` — and NOT `api.comfy.org`, which
 * serves pack installs rather than this mapping. Naming the wrong host would send a
 * filtered user to check something irrelevant, which is the same failure as saying
 * nothing.
 *
 * KNOWN LIMITATION, deliberately not solved here: because Manager degrades to the bundled
 * copy, a genuinely blocked channel surfaces as a STALE catalogue rather than an empty
 * one, and the panel cannot currently tell stale from current. That is a separate gap
 * needing a signal Manager does not expose today; inventing a staleness claim here would
 * repeat the very fault #808 reports.
 */
/**
 * #890 — what a NO-MATCH over a populated catalogue may honestly say.
 *
 * Only two things are claimed, and the panel knows both for certain: how many packs the
 * catalogue it searched contained, and that it asked Manager for the CACHED copy. It does
 * NOT claim the cache is stale, or old, or that the registry is blocked — none of that is
 * observable from the response, and asserting it is the fault the parent issue was filed
 * about.
 *
 * `mode=cache` is read off the route actually requested rather than hardcoded, so if the
 * route changes and this text does not, the note stops claiming a mode that was not asked
 * for.
 */
export function cachedCatalogueNoMatch(query, catalogueSize, route) {
  const q = query == null ? "" : String(query);
  const mode = /[?&]mode=([^&]+)/.exec(String(route ?? ""))?.[1] ?? null;
  // STRICTLY a number. `Number.isFinite(Number(v))` accepts `null` — Number(null) is 0 —
  // and would print "(0 packs)" for an absent size, which reads as an EMPTY catalogue:
  // the one thing this branch is not about, and the case #808 answers far more strongly.
  const size = typeof catalogueSize === "number" && Number.isFinite(catalogueSize) ? catalogueSize : null;
  if (mode !== "cache") return {};
  return {
    // REQUESTED, not served (codex). Naming this `catalogue_mode` asserted where the
    // bytes came from, which is the one thing this code cannot see: the parameter is what
    // the panel ASKED for, and nothing in the answer says whether Manager honoured it.
    requested_mode: "cache",
    no_match_note:
      `No pack in the catalogue matched${q ? ` "${q}"` : ""}${
        size == null ? "" : `, out of ${size} packs searched`
      }. This request asked ComfyUI-Manager for mode=cache. What the response came FROM is ` +
      "not something the panel can tell: Manager does not report whether it honoured that " +
      "parameter, when the data was fetched, or whether it served the network, its on-disk " +
      "cache or the copy bundled with the Manager package (#890). So this result cannot " +
      "distinguish \"no such pack\" from \"a pack too recent for whatever list was " +
      "searched\". If the pack is recent, refresh Manager's cache from its UI and search " +
      "again before concluding it does not exist.",
  };
}

export function emptyCatalogueResult(query) {
  const q = query == null ? "" : String(query);
  return {
    supported: true,
    managerReachable: true,
    catalogue_empty: true,
    catalogue_size: 0,
    searched: false,
    count: 0,
    results: [],
    query: q,
    message:
      "ComfyUI-Manager answered, but its node catalogue contains ZERO packs — so " +
      `nothing was actually searched, and this result says NOTHING about whether ${
        q ? `"${q}"` : "a pack"
      } exists. (This is not "no matches": a populated catalogue has thousands of packs.) ` +
      "Manager assembles this list from its channel (by default " +
      "raw.githubusercontent.com/ltdrdata/ComfyUI-Manager), falling back to its on-disk " +
      "cache and then to the copy bundled in the Manager package — so an empty list " +
      "means NONE of those three produced data. The usual causes are Manager running " +
      "with network_mode 'offline' and no cache yet, or a Manager install whose data " +
      "files are missing or unreadable. Refresh the cache from the Manager UI and " +
      "retry; if this machine is behind corporate, campus or national network " +
      "filtering, that channel host is the one to check. Nodes already installed are " +
      "unaffected: list them with panel_list_nodes.",
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
  const parsed = parseNodeMappings(data, query, limit);
  // #808 — an EMPTY catalogue is not a no-match, and only this branch can tell the
  // caller so. Checked on `catalogue_size` (packs the payload carried) rather than
  // `count` (packs that matched), because a healthy catalogue legitimately returns
  // count 0 all the time and must keep reading as the ordinary no-match it is.
  if (parsed.catalogue_size === 0) return emptyCatalogueResult(query);
  // #890 — a NO-MATCH over a populated catalogue is the case #808 left open, and it is
  // the likelier one in the field because Manager works hard never to return empty. A
  // blocked registry yields a FULL list that may be months old, presented identically to
  // a current one, so "no matches" and "that pack does not exist" arrive as the same
  // answer. Nothing in the payload carries provenance — no fetch time, no indication of
  // network vs cache vs bundle — and the issue's own follow-up measured that a
  // "is this the bundled map" discriminator would never fire (5583 served vs 4884
  // bundled, sharing ~1800 keys), so it would ship as a check that always passes.
  //
  // What IS observable without inventing anything: this search asked for `mode=cache`.
  // That is the panel's own request, not an inference about the payload, and it is
  // exactly the fact a reader needs before concluding a pack does not exist.
  return parsed.count === 0 ? { ...parsed, ...cachedCatalogueNoMatch(query, parsed.catalogue_size, route) } : parsed;
}

/**
 * #1645 — reconstruct installed custom-node PACKS from ComfyUI's `/object_info`
 * map. Each loaded class carries `python_module` (`custom_nodes.<folder>` or
 * `custom_nodes.<folder>.<sub>`); the folder is the on-disk pack name Manager
 * would have listed. Core modules (`nodes`, `comfy_extras.*`) are not packs.
 */
export function installedPacksFromObjectInfo(objectInfo) {
  // Pack names come from the connected ComfyUI's untrusted /object_info
  // response. A null-prototype map keeps names such as __proto__, constructor,
  // and toString as ordinary pack keys instead of inherited properties.
  const installed = Object.create(null);
  if (!objectInfo || typeof objectInfo !== "object") return installed;
  for (const [cls, meta] of Object.entries(objectInfo)) {
    const pythonModule = meta && typeof meta === "object" ? meta.python_module : "";
    const s = String(pythonModule || "").trim();
    const m = /^(?:custom_nodes)[./]([^./\\]+)/i.exec(s);
    if (!m) continue;
    const pack = m[1];
    if (!installed[pack]) {
      installed[pack] = { python_module: s, classes: [] };
    }
    installed[pack].classes.push(cls);
  }
  return installed;
}

const LIST_OBJECT_INFO_NOTE =
  "ComfyUI-Manager is unreachable; these packs were reconstructed from the connected " +
  "ComfyUI's /object_info (loaded custom-node python_module folders). Manager metadata " +
  "(version, cnr_id, enabled) is not available. Enable the built-in Manager for the " +
  "full installed-pack inventory.";

/**
 * #1645 — when BOTH Manager installed-list routes are unreachable, try the
 * loaded `/object_info` registry before giving up. On a readable map, return
 * an inspectable pack inventory (possibly empty — core-only is still an
 * inventory). Any `/object_info` failure degrades to managerListUnavailableResult
 * rather than throwing.
 */
export async function objectInfoListFallback(objectInfoGet, args, err) {
  if (typeof objectInfoGet !== "function") return managerListUnavailableResult(err);
  let info;
  try {
    info = await objectInfoGet();
  } catch {
    return managerListUnavailableResult(err);
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    return managerListUnavailableResult(err);
  }
  const hasNodeDefinition = Object.values(info).some((meta) => {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
    return ["python_module", "input", "output", "display_name", "category", "description"]
      .some((key) => Object.prototype.hasOwnProperty.call(meta, key));
  });
  if (Object.keys(info).length === 0 || !hasNodeDefinition) {
    return managerListUnavailableResult(err);
  }
  const listed = listedNodesResult(installedPacksFromObjectInfo(info), args);
  return {
    ...listed,
    managerReachable: false,
    source: "object_info",
    note: listed.note ? `${listed.note} ${LIST_OBJECT_INFO_NOTE}` : LIST_OBJECT_INFO_NOTE,
  };
}

/**
 * #1645 — structured unavailable result for panel_list_nodes when Manager AND
 * `/object_info` cannot inventory packs. Inspectable (never a raw throw) so a
 * connected canvas is not blocked by a missing Manager.
 */
export function managerListUnavailableResult(err) {
  return {
    supported: false,
    managerReachable: false,
    installed: {},
    reason: String(err?.message ?? err ?? "ComfyUI-Manager not reachable"),
    message:
      "Installed custom-node pack inventory from ComfyUI-Manager is unavailable: " +
      "the built-in Manager could not be reached on this ComfyUI (it may be disabled, " +
      "or a legacy/partial build without /customnode/installed). The live canvas is " +
      "still usable — inspect the current graph with panel_graph_outline / " +
      "panel_query_graph. Enable the built-in Manager for the full pack list " +
      "(version, cnr_id, enabled).",
  };
}

/**
 * Run the nodes_list flow with graceful degradation against an unreachable
 * ComfyUI-Manager (#1645). Same ladder as searchNodesVia: dialect-routed GET,
 * absolute legacy retry on unreachable/404, then `/object_info` pack
 * reconstruction, then a structured unavailable result. Never throws on
 * unreachable. Genuine server errors (500/403) still propagate.
 */
export async function listNodesVia(
  managerGet,
  managerCall,
  { args = {}, objectInfoGet } = {},
) {
  const route = installedListRoute();
  let raw;
  try {
    raw = await managerGet(route);
  } catch (err) {
    if (!isManagerUnreachable(err)) throw err;
    try {
      raw = await managerCall(route);
    } catch (err2) {
      if (isManagerUnreachable(err2))
        return objectInfoListFallback(objectInfoGet, args, err2);
      throw err2;
    }
  }
  return listedNodesResult(raw, args);
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
/**
 * #920 — does this Manager failure mean "that pack is not in the registry"?
 *
 * v4 resolves an install from its OWN database — `get_custom_nodes(channel, mode)`,
 * falling back to `cnr_map[node_id]` — and when neither has the pack it answers
 *
 *   Node '<id>@<version>' not found in [ManagerChannel.<ch>, ManagerDatabaseSource.<mode>]
 *
 * Matched on the STABLE part ("not found in" + a bracketed source list) rather than
 * the enum spellings, which vary with channel/mode. Deliberately narrow: only a
 * message we positively recognise is reshaped, everything else passes through.
 */
export function isRegistryLookupMiss(text) {
  return typeof text === "string" && /Node\s+'[^']*@[^']*'\s+not found in\s*\[[^\]]*\]/i.test(text);
}

/**
 * #920 — what to add when a GIT URL install hits that miss.
 *
 * The reporter passed a repository URL and got a registry-lookup failure naming a
 * pack id they never supplied. That reads like a lookup bug and sends people to
 * re-check spelling, channel and mode; none of it is the problem.
 *
 * Both facts below are read from ComfyUI-Manager's SOURCE, not its schema — the
 * schema is what misled two separate attempts at this issue (`InstallPackParams`
 * declares `repository` "required if selected_version is nightly", and `do_install`
 * reads only id/selected_version/channel/mode/skip_post_install):
 *
 *   1. the pack is not in the registry — that IS what the lookup missed;
 *   2. a stock v4 has NO route that installs an arbitrary git URL. The legacy
 *      `/manager/queue/install` route does (`@unknown` + `files:[url]`), but
 *      `comfyui_manager/__init__.py` registers the legacy server only under
 *      `--enable-manager-legacy-ui`.
 *
 * Returns "" when there is nothing extra to say, so callers may append blindly.
 */
export function unlistedGitUrlAdvice(failureText) {
  if (!isRegistryLookupMiss(failureText)) return "";
  // Phrased for BOTH readers, because the surface that shows this failure
  // (panel_node_queue_status) does not carry the original request and plumbing it
  // through for a message is not worth the coupling. Someone who mistyped a
  // registry id needs the first sentence; someone who passed a git URL needs the
  // rest, and the conditional wording keeps it from asserting which they did.
  return (
    ` — NOTE: that is a NODE REGISTRY lookup. The pack is not in the registry under that` +
    ` name. IF YOU PASSED A GIT URL: this ComfyUI-Manager cannot install one. It resolves` +
    ` installs from its own database, and the parameter that would carry a URL (repository)` +
    ` is accepted and then IGNORED by its install handler — so no argument to this tool will` +
    ` make it clone your URL. USE install_custom_node INSTEAD: that tool runs on the` +
    ` machine rather than in this browser, and when the Manager cannot resolve a pack it` +
    ` clones the repository into custom_nodes/ itself. It is the one path that installs an` +
    ` unlisted URL — so this tool's usual "prefer me over the headless install_custom_node"` +
    ` guidance does NOT hold for this case. Restart ComfyUI afterwards to load it.` +
    ` If that is not available (a REMOTE target has no local tree to clone into, and it` +
    ` keeps the Manager's error for that reason), the remaining options are to clone into` +
    ` custom_nodes/ by hand, or ask the pack author to publish to the registry. A legacy` +
    ` git-URL route also exists but needs TWO steps — --enable-manager-legacy-ui (which` +
    ` REPLACES the v2 Manager API) AND allow_git_url_install = true in ComfyUI-Manager's` +
    ` config.ini, without which an unlisted pack is rated "high+" risk and it answers 404.` +
    ` IF YOU MEANT A REGISTRY PACK: check the id and the channel/mode named in the brackets.`
  );
}

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

// ---------------------------------------------------------------------------
// #1480 — a silent in_progress is not progress
// ---------------------------------------------------------------------------
//
// /v2/manager/queue/status is an aggregate of counts. A wedged Manager worker
// keeps answering the same `{total_count:1, in_progress_count:1, is_processing:true}`
// forever, with no per-task terminal record and no install log. The panel was
// forwarding that payload as-is — which is the right status, and the wrong
// conclusion: a poll that never times a silent in_progress reads as "still
// working, wait longer" for as long as the caller is willing to wait.
//
// These helpers do not rewrite Manager's counts and do not manufacture a
// failure. They measure whether the SAME processing fingerprint has been
// repeating, and after QUEUE_SILENT_STALL_MS they name that as a stall.

/** Status strings that mean the task has not reached a terminal yet. Narrow
 *  on purpose: only spellings Manager actually writes for a live task. */
const TASK_IN_PROGRESS_STATUS = new Set(["in_progress", "running", "pending"]);

/** How long the same processing counts may repeat before a poll names a stall.
 *  Matches the reported wait (over two minutes of unchanged in_progress). A
 *  slow-but-alive clone can outlive this; the stall note is a visibility
 *  warning, never a failure verdict. */
export const QUEUE_SILENT_STALL_MS = 120_000;

/** Is Manager currently claiming the queue is working? True only on an explicit
 *  processing flag or a positive in-progress/pending count — a malformed or
 *  idle status is not processing. */
export function queueIsProcessing(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return false;
  if (status.is_processing === true) return true;
  if (typeof status.in_progress_count === "number" && status.in_progress_count > 0) return true;
  if (typeof status.pending_count === "number" && status.pending_count > 0) return true;
  return false;
}

/** A fingerprint of the processing counts so "the same in_progress repeating"
 *  is distinguishable from a count that actually moved. Idle/malformed → null. */
export function queueProgressFingerprint(status) {
  if (!queueIsProcessing(status)) return null;
  return [
    status.is_processing === true ? "1" : "0",
    Number(status.total_count) || 0,
    Number(status.done_count) || 0,
    Number(status.in_progress_count) || 0,
    Number(status.pending_count) || 0,
  ].join(":");
}

/**
 * Collect the still-running tasks from a /v2/manager/queue/history response.
 * Only explicit in_progress/running/pending status_str values — never inferred
 * from a missing terminal, so an unrecognized shape cannot become a live task.
 */
export function collectInProgressTasks(resp, { limit = 20 } = {}) {
  const history =
    resp && typeof resp === "object" && "history" in resp ? resp.history : resp;
  if (!history || typeof history !== "object") return [];
  const items = Array.isArray(history) ? history : Object.values(history);
  const out = [];
  for (const item of items) {
    if (!isTaskHistoryItem(item)) continue;
    const str = taskStatusStr(item);
    if (!str) continue;
    const lower = str.toLowerCase();
    if (!TASK_IN_PROGRESS_STATUS.has(lower)) continue;
    if (TASK_SUCCESS_STATUS.has(lower) || TASK_FAILURE_STATUS.has(lower)) continue;
    out.push({
      ui_id: typeof item.ui_id === "string" ? item.ui_id : undefined,
      kind: typeof item.kind === "string" ? item.kind : undefined,
      id: taskParamId(item),
    });
  }
  return out.slice(-limit);
}

/**
 * What to tell a poll whose Manager counts have not moved for stallMs.
 * Says the in_progress is Manager's own repeating status, not panel-invented
 * progress, and does NOT claim the task failed — absence of a log is not a
 * terminal record.
 */
export function silentQueueStallNote({ silent_ms, silentMs } = {}) {
  const ms = typeof silent_ms === "number" ? silent_ms : silentMs;
  const secs = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return (
    `NOTE — the Manager queue has reported the SAME in_progress counts for ${secs}s with no change. ` +
    `That is Manager's own status, forwarded as-is — it is NOT panel-invented progress, and it is NOT a completion. ` +
    `A silent in_progress is not proof the install is running. VERIFY with panel_list_nodes; if the pack is still ` +
    `absent, check the ComfyUI server log for clone/pip activity. Do not restart solely because the queue is still ` +
    `in_progress — a restart will not finish a wedged clone. If the log is also silent, the Manager worker is stuck.`
  );
}

/**
 * Observes successive /queue/status payloads and times how long the SAME
 * processing fingerprint has been repeating.
 *
 * @param {{stallMs?: number, now?: () => number}} [opts]
 */
export function createManagerQueueWatch({ stallMs = QUEUE_SILENT_STALL_MS, now = () => Date.now() } = {}) {
  let fingerprint = null;
  let since = 0;
  return {
    /**
     * @param {unknown} status
     * @returns {{processing: boolean, stalled: boolean, silent_ms: number, fingerprint: string|null}}
     */
    observe(status) {
      const t = now();
      if (!queueIsProcessing(status)) {
        fingerprint = null;
        since = 0;
        return { processing: false, stalled: false, silent_ms: 0, fingerprint: null };
      }
      const fp = queueProgressFingerprint(status);
      if (fingerprint !== fp) {
        fingerprint = fp;
        since = t;
      }
      const silentMs = Math.max(0, t - since);
      return {
        processing: true,
        stalled: silentMs >= stallMs,
        silent_ms: silentMs,
        fingerprint: fp,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// comfyui-mcp#1606 — a per-task result on the build that keeps NO task history
// ---------------------------------------------------------------------------
//
// #1539 gave install the Manager's own terminal verdict by reading
// /v2/manager/queue/history?ui_id=. Released 3.x ("legacy") registers no such
// route, so there it reads nothing and the install falls back to the drain +
// name-presence proxies. The reporter's install drained and left no trace at
// all: panel_node_queue_status showed an idle queue with NOTHING in it, and the
// pack was absent.
//
// The record is not missing — it is DELETED. Read out of ComfyUI-Manager 3.41's
// glob/manager_server.py: `task_worker` accumulates every task's outcome in
// `nodepack_result[ui_id]` (do_install returns the literal string 'success', or
// the error text — "Cannot resolve install target: …", the failed
// `install_by_id` res.msg, a traceback summary). When the queue empties it
// broadcasts that whole map and then throws it away:
//
//     PromptServer.instance.send_sync("cm-queue-status",
//         {'status': 'done', 'nodepack_result': nodepack_result, …})
//     nodepack_result = {}
//     task_queue = queue.Queue()
//
// `queue/status` derives done_count from `len(nodepack_result)`, so the line
// after the broadcast is what makes total/done/in_progress all read 0 — the
// reporter's "empty idle queue", produced BY the task finishing. `queue/start`
// clears the map too. No later HTTP read can recover the outcome.
//
// So the broadcast is the only place 3.x ever states it — and a panel living in
// the ComfyUI page is already a client of it. `send_sync` with no sid goes to
// every connected client, and ComfyUI-Manager's own UI reads it exactly this
// way (`api.addEventListener("cm-queue-status", …)` in js/custom-nodes-manager.js).
// The helpers below turn that frame into records the same shape the history
// reader produces, so the verdict path above needs no new branch: a captured
// failure is fed in as `taskFailure` and classifies identically.

/**
 * The per-task outcomes carried by ONE `cm-queue-status` payload.
 *
 * Only the DRAIN frame ('done') carries outcomes. The per-task 'in_progress'
 * frame names the task that just finished (`target`) but never says how it went,
 * so reading it as a result would record every task as an unknown one — and an
 * unknown result is indistinguishable from a failure string here.
 *
 * Unknown/foreign shapes yield []: this is additive evidence, so a payload we do
 * not recognise must add nothing rather than guess. That is also what keeps it
 * safe on a Manager generation that emits a same-named event of its own.
 *
 * @returns {{ui_id: string, result: string}[]}
 */
export function queueEventTaskResults(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return [];
  if (detail.status !== "done") return [];
  const out = [];
  for (const key of ["nodepack_result", "model_result"]) {
    const map = detail[key];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [ui_id, raw] of Object.entries(map)) {
      const result = taskResultText(raw);
      if (ui_id && result !== undefined) out.push({ ui_id, result });
    }
  }
  return out;
}

/** A `nodepack_result` value as the 3.41 worker writes it: the worker's return
 *  value, which is a STRING for install/uninstall/disable/fix and for 'update'
 *  (it stores `msg['msg']`), but the whole `{msg, url, title}` record for
 *  'update-main'. Anything else is not a result this can read. */
function taskResultText(raw) {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (raw && typeof raw === "object" && typeof raw.msg === "string") return raw.msg.trim() || undefined;
  return undefined;
}

/**
 * Is a captured result a FAILURE, and what did the Manager say?
 *
 * The 3.x worker writes a fixed success vocabulary and returns the ERROR TEXT
 * itself for everything else, so "not one of the success words" is the failure
 * test and the value IS the reason. The Manager's ComfyUI self-update task also
 * answers "success-stable-<tag>", hence the prefix arm — a version-tagged
 * success is still a success.
 *
 * Returns null for a success and for anything unreadable: this may only ever ADD
 * a positive failure verdict, never manufacture one.
 */
export function queueEventFailureReason(result) {
  if (typeof result !== "string") return null;
  const v = result.trim();
  if (!v) return null;
  const lower = v.toLowerCase();
  if (TASK_SUCCESS_STATUS.has(lower)) return null;
  if (/^success[-:\s]/.test(lower)) return null;
  return v;
}

/** How many captured task records to keep. Bounds the log in a tab that stays
 *  open for days; the reads below are all "the recent ones" anyway. */
const TASK_RESULT_LOG_LIMIT = 50;

/**
 * A bounded log of Manager task outcomes captured from `cm-queue-status`.
 *
 * Kept in this module rather than the panel so it is unit-testable without a
 * browser: the panel owns the subscription (one `api.addEventListener`), this
 * owns what the frames MEAN.
 *
 * Insertion-ordered by ui_id, so eviction is oldest-first and re-recording a
 * ui_id moves it to the newest position.
 *
 * @param {{limit?: number, now?: () => number}} [opts]
 */
export function createManagerTaskResultLog({ limit = TASK_RESULT_LOG_LIMIT, now = () => Date.now() } = {}) {
  /** @type {Map<string, {ui_id: string, target?: string, kind?: string, result?: string, at?: number}>} */
  const byUiId = new Map();

  const touch = (ui_id, patch) => {
    const prev = byUiId.get(ui_id);
    byUiId.delete(ui_id); // re-insert so Map order stays newest-last
    byUiId.set(ui_id, { ...(prev ?? {}), ui_id, ...patch });
    while (byUiId.size > limit) byUiId.delete(byUiId.keys().next().value);
  };

  return {
    /** Correlate a ui_id we are about to submit with WHAT it acts on. The
     *  broadcast carries only ui_id → result, so without this a captured
     *  failure could name no pack. Optional: an uncorrelated failure is still
     *  reported, just without an `id`. */
    note(ui_id, { target, kind } = {}) {
      if (typeof ui_id !== "string" || !ui_id) return;
      touch(ui_id, { target, kind });
    },

    /** Ingest one `cm-queue-status` payload. Returns how many outcomes it carried. */
    record(detail) {
      const results = queueEventTaskResults(detail);
      for (const { ui_id, result } of results) {
        touch(ui_id, { result, at: now() });
        // A later SUCCESS retires an earlier failure for the SAME pack. Without
        // this, a reinstall that worked leaves the original failure sitting in
        // the log, and the next queue poll reports a defeat that has already
        // been undone — the stale-verdict failure mode this whole area is about.
        const rec = byUiId.get(ui_id);
        if (rec && rec.target && !queueEventFailureReason(rec.result)) {
          for (const [key, other] of byUiId) {
            if (key !== ui_id && other.target === rec.target && queueEventFailureReason(other.result)) {
              byUiId.delete(key);
            }
          }
        }
      }
      return results.length;
    },

    /** The Manager's own failure text for THIS ui_id, or null. Correlated by the
     *  id we submitted, so a neighbouring task's failure is never attributed to
     *  it — the same rule the history read follows. */
    failureFor(ui_id) {
      const rec = typeof ui_id === "string" ? byUiId.get(ui_id) : undefined;
      return rec ? queueEventFailureReason(rec.result) : null;
    },

    /**
     * Captured FAILURES, in the `{ui_id, kind, id, result}` shape
     * collectRecentTaskFailures produces so both sources merge without a second
     * format.
     *
     * `maxAgeMs` bounds how long a capture stays reportable. A failure from
     * hours ago is not what a poll is asking about, and re-reporting it reads as
     * a fresh one; a record with no timestamp (noted but never resolved) is not
     * a failure and never appears here anyway.
     */
    recentFailures({ limit: cap = 20, maxAgeMs } = {}) {
      const cutoff = typeof maxAgeMs === "number" ? now() - maxAgeMs : undefined;
      const out = [];
      for (const rec of byUiId.values()) {
        const reason = queueEventFailureReason(rec.result);
        if (!reason) continue;
        if (cutoff !== undefined && !(typeof rec.at === "number" && rec.at >= cutoff)) continue;
        out.push({ ui_id: rec.ui_id, kind: rec.kind, id: rec.target, result: reason });
      }
      return out.slice(-cap);
    },

    /** Records held, for tests and for bounding assertions. */
    size() {
      return byUiId.size;
    },
  };
}

/**
 * Did a history fetch POSITIVELY return a task-history document?
 *
 * A missing history route does not reliably THROW: ComfyUI answers an
 * UNREGISTERED GET with its SPA index, and an empty body parses to null — the
 * same trap looksLikeQueueStatus guards dialect detection against. Both would
 * otherwise traverse to zero failures and be reported as "nothing failed".
 *
 * Accepts the `{history: …}` envelope in item, map or array form, and a bare
 * array/map. An empty ARRAY or an empty envelope is a real answer ("no tasks");
 * a bare `{}` is not — it says nothing about any queue.
 */
export function looksLikeTaskHistory(resp) {
  if (!resp || typeof resp !== "object") return false;
  const hasKey = !Array.isArray(resp) && "history" in resp;
  const history = hasKey ? resp.history : resp;
  if (!history || typeof history !== "object") return false;
  const items = Array.isArray(history) ? history : Object.values(history);
  if (items.length === 0) return hasKey || Array.isArray(history);
  if (items.every((v) => !!v && typeof v === "object")) return true;
  // The single-record (ui_id-queried) shape: the task's own fields, so its
  // values are strings rather than records.
  return isTaskHistoryItem(history);
}

/**
 * Does this Manager dialect serve a PER-TASK terminal record over HTTP?
 *
 * Established by #364 and already relied on by the update path: released 3.x
 * ("legacy") has no per-task history route, and the bundled 3.x server behind
 * --enable-manager-legacy-ui ("v2-batch") serves only BATCH history keyed by
 * `id` and rejects a ui_id query. Only the pip Manager v4 ("v2") records a
 * task's outcome where a later read can find it.
 *
 * This is what `nodes_queue_status` was missing: on the other two builds it asked
 * for a history that cannot exist, got nothing, and returned a bare status —
 * byte-identical to a v4 that served its history and had nothing to report.
 */
export function dialectServesTaskHistory(dialect) {
  return dialect === "v2";
}

/**
 * What to tell a queue poll that could not read per-task outcomes over HTTP.
 *
 * Says only what is known, and does NOT claim anything failed — the point is
 * that on this build silence is not evidence either way. The live capture is
 * named because it is the one thing that CAN answer here, and its limit stated:
 * it only sees tasks that finished while this browser tab was open.
 *
 * THREE causes, not two. An UNKNOWN dialect (detection failed) must not borrow
 * 3.x's explanation: "this build keeps no history" is a claim about a build we
 * did not identify, and asserting the mechanism we happen to have written about
 * is how a plausible sentence becomes a false one. It gets its own arm.
 */
export function taskHistoryBlindNote(dialect) {
  const cause =
    dialect === undefined || dialect === null || dialect === ""
      ? "this panel could not determine which ComfyUI-Manager generation is running, so it " +
        "cannot say whether a per-task record even exists here"
      : dialectServesTaskHistory(dialect)
        ? "this Manager's per-task history could not be read just now (a transient error, or a " +
          "response this panel did not recognise)"
        : "this ComfyUI-Manager build keeps NO readable per-task history (released 3.x deletes " +
          "each task's result the moment the queue drains)";
  return (
    `NOTE — A FAILED TASK MAY NOT BE VISIBLE HERE: ${cause}. Any failure listed above was ` +
    `captured live from the Manager's completion broadcast, which this panel only hears for ` +
    `tasks that finish while this browser tab is open — so an EMPTY list is not proof that ` +
    `nothing failed. A drained/idle queue is not proof either: the Manager counts a task it ` +
    `aborted as "done" exactly like one it completed. VERIFY the pack with panel_list_nodes ` +
    `before restarting or reporting success; if it is absent, the reason is in the ComfyUI ` +
    `server log (security_level gating is a common cause).`
  );
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
 * @param {{ item?:unknown, status?:unknown, target:string, dialect?:string, traceback?:string }} input
 */
export function classifyUpdateOutcome({ item, status, target, dialect, traceback } = {}) {
  const reason = taskFailureReason(item);
  if (reason) {
    // #1320 — Manager's do_update stores only "An error occurred while updating
    // 'X'." and prints the real traceback to the server log. When the caller
    // managed to read that log, the tool result IS the traceback; do not also
    // send the reader to the log they can no longer see from here.
    const tb = typeof traceback === "string" && traceback.trim() ? traceback.trim() : "";
    return {
      state: "failed",
      status,
      message:
        `Update of "${target}" FAILED: the ComfyUI-Manager task terminated with an ` +
        `error` +
        (dialect ? ` (dialect ${dialect})` : "") +
        `: ${reason}. The pack was NOT updated` +
        (tb
          ? `. Manager traceback:\n${tb}`
          : ` — check the ComfyUI server log for the full traceback.`),
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

/** Throw if a /v2/manager/queue/batch response reported the target id as failed.
 *  The batch runs synchronously and surfaces failures as {failed:[id,...]} — a
 *  silent success on a failed op is exactly the #184 no-op bug.
 *
 *  Lives HERE rather than in the panel (#367): the unit harness injects the panel's
 *  mutation deps by name from this module, and it was destructuring an `assertBatchOk`
 *  this module never exported — so every batch-path test would have crashed on
 *  `assertBatchOk is not a function`. None did, because none reached the batch branch.
 *  Exporting it is what makes that branch testable at all.
 */
export function assertBatchOk(res, id, op) {
  const failed = Array.isArray(res?.failed) ? res.failed : [];
  if (failed.length && (id === undefined || failed.includes(id))) {
    throw new Error(
      `ComfyUI-Manager batch reported the ${op} of "${String(id ?? "?")}" as failed ` +
        "(check the ComfyUI server log for the underlying error — security_level " +
        "gating is a common cause). The pack was NOT installed.",
    );
  }
}
