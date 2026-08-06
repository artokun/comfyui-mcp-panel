// Model-catalog presentation for the panel's model picker (issue #377).
//
// The panel does NOT hardcode the model list — the orchestrator probes the Agent
// SDK (query.supportedModels()) and pushes each model's value/displayName/
// description/resolvedModel. This module turns that raw list into the picker's
// rows and, crucially, canonicalizes each Claude FAMILY to its newest advertised
// version so the selector's labels track the authoritative advertised IDs rather
// than assuming a stale alias ("opus" == newest) is current.
//
// #377: on an orchestrator whose SDK still resolves the `opus` alias to the old
// claude-opus-4-8, the newer claude-opus-5 is advertised separately as a pinned
// id with no friendly displayName — so it rendered as a raw-id "Custom model"
// row while the stale 4.8 alias sat at the top as "Opus". Collapsing per family
// to the newest version, and deriving a clean "Opus 5" label from the pinned id,
// fixes both without any hardcoded model->label map: everything is derived from
// the advertised ids.

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable", "mythos"];
const FAMILY_LABEL = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable", mythos: "Mythos" };

/** Strip a trailing context marker (`[1m]`) so the family/version parse sees the
 *  bare model id. A `-fast` speed suffix is deliberately NOT stripped: a
 *  `claude-opus-5-fast` is a distinct selectable variant (different speed/price),
 *  so it must not parse identically to `claude-opus-5` and get collapsed away —
 *  leaving `-fast` in the id makes it fail the pinned-id regex, so it passes
 *  through the picker untouched (kept, exactly as the pre-#377 code did). */
function stripModelSuffix(id) {
  return String(id ?? "")
    .replace(/\[[^\]]*\]\s*$/, "")
    .trim();
}

/** Parse a model id (and its resolved concrete id, if any) into a Claude family
 *  + numeric version. Returns null for anything that isn't a recognized Claude
 *  model. `version` is an array of version segments ([5] for claude-opus-5,
 *  [4,8] for claude-opus-4-8), or null when only a bare family alias is known
 *  with no resolved id to read the version from. `alias` is true for the clean
 *  family aliases ("opus", "sonnet", …) as opposed to a pinned `claude-*` id. */
export function parseClaudeModel(id, resolved) {
  const pinned = (src) => {
    const m = stripModelSuffix(src).toLowerCase().match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const version = [Number(m[2])];
    if (m[3] !== undefined) version.push(Number(m[3]));
    return { family: m[1], version, alias: false };
  };
  // Classify by the ROW's own id first: a pinned `claude-*` id, then a bare
  // family alias (whose effective version is read from its resolved id).
  const own = pinned(id);
  if (own) return own;
  const bare = stripModelSuffix(id).toLowerCase();
  if (CLAUDE_FAMILIES.includes(bare)) {
    const r = resolved ? pinned(resolved) : null;
    return { family: bare, version: r ? r.version : null, alias: true };
  }
  // Id unrecognized but the resolved id is a concrete Claude model (rare).
  return resolved ? pinned(resolved) : null;
}

/** Compare two version arrays (null sorts lowest). >0 when a is newer than b. */
export function cmpVersion(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** A clean, id-derived label for a Claude family row: "Opus 5", "Opus 4.8",
 *  "Fable 5". Used only when the orchestrator gave no friendly displayName. */
export function deriveClaudeLabel(family, version) {
  const base = FAMILY_LABEL[family] ?? family;
  if (!version || !version.length) return base;
  return `${base} ${version.join(".")}`;
}

/** Normalize a ModelInfo list (or the fallback) to picker rows. `efforts`:
 *  an array of effort ids, or null when the model supports effort but didn't
 *  enumerate levels, or [] when it has no effort control. */
export function normalizeModels(list) {
  return (Array.isArray(list) ? list : []).map((m) => {
    let efforts;
    if (Array.isArray(m.supportedEffortLevels)) efforts = m.supportedEffortLevels;
    else if (m.supportsEffort) efforts = null; // unknown → offer the standard set
    else efforts = []; // no effort control
    const desc = typeof m.description === "string" ? m.description : "";
    return {
      id: m.value,
      label: m.displayName || m.value,
      small: desc.length > 28 ? desc.slice(0, 27) + "…" : desc,
      efforts,
      // Concrete model id behind an alias/pinned value (SDK resolvedModel) —
      // presentableModels dedupes/canonicalizes on this instead of pattern-matching ids.
      resolved: typeof m.resolvedModel === "string" ? m.resolvedModel : undefined,
    };
  });
}

/** Present the picker rows: drop the synthetic "default", collapse each Claude
 *  family to its NEWEST advertised version, and derive a clean family label for a
 *  surviving pinned `claude-*` row that the orchestrator left unlabeled.
 *
 *  Family-collapse rules (all derived from the advertised ids — no hardcoded
 *  model map):
 *   • The newest known version wins; older same-family rows are dropped (so a
 *     stale `opus`→claude-opus-4-8 alias is dropped once claude-opus-5 is
 *     advertised — #377).
 *   • When the clean family alias ("opus") already sits at the newest version,
 *     keep the alias and drop the pinned duplicate (the existing #70 behavior on
 *     an up-to-date SDK where `opus` resolves to the newest model).
 *   • A family with no version information anywhere (a bare "sonnet"/"haiku"
 *     alias and no pinned sibling) is left exactly as-is.
 *   • Fable, advertised only as a pinned `claude-fable-5[1m]` with no alias,
 *     survives as the family's newest (guards the #70 regression). */
export function presentableModels(rows) {
  const noDefault = (Array.isArray(rows) ? rows : []).filter((r) => r.id !== "default");
  const ann = noDefault.map((r) => ({ row: r, c: parseClaudeModel(r.id, r.resolved) }));

  // Newest known version per Claude family.
  const newest = new Map();
  for (const a of ann) {
    if (!a.c || !a.c.version) continue;
    const v = newest.get(a.c.family);
    if (!v || cmpVersion(a.c.version, v) > 0) newest.set(a.c.family, a.c.version);
  }
  // Families whose newest version is occupied by a clean alias (prefer the alias).
  const aliasAtNewest = new Set();
  for (const a of ann) {
    if (a.c && a.c.alias && a.c.version) {
      const v = newest.get(a.c.family);
      if (v && cmpVersion(a.c.version, v) === 0) aliasAtNewest.add(a.c.family);
    }
  }

  const kept = [];
  for (const a of ann) {
    const c = a.c;
    if (!c) {
      kept.push(a.row);
      continue;
    }
    const v = newest.get(c.family);
    // Keep when the family has no known version, or when THIS row's version is
    // unknown: a bare alias with no resolved id gives no evidence it's stale, so
    // dropping it would hide a usable selection (the prior "keep aliases"
    // behavior). Only a row with a KNOWN, strictly-older version is dropped.
    if (!v || !c.version) {
      kept.push(a.row);
      continue;
    }
    if (cmpVersion(c.version, v) < 0) continue; // strictly older than the newest → drop
    if (aliasAtNewest.has(c.family) && !c.alias) continue; // alias wins at newest → drop pinned dup
    kept.push(a.row);
  }

  const out = kept.map((r) => {
    const c = parseClaudeModel(r.id, r.resolved);
    if (!c || !c.version) return r; // bare alias / unversioned → leave the label alone
    if (r.label && r.label !== r.id) return r; // orchestrator gave a curated displayName → respect it
    const label = deriveClaudeLabel(c.family, c.version);
    // Drop a generic "Custom model" tag for a now-recognized Claude model.
    const small = /^custom model$/i.test(String(r.small ?? "")) ? "" : r.small;
    return { ...r, label, small };
  });

  if (out.length) return out;
  return noDefault.length ? noDefault : rows;
}

/** Pre-select the newest Opus when the user hasn't chosen; fall back to the
 *  first opus-ish row, then row 0. Version-aware so a stale alias never beats a
 *  newer pinned Opus (belt-and-suspenders with presentableModels' collapse). */
export function pickDefaultModel(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const opus = list
    .map((r) => ({ r, c: parseClaudeModel(r.id, r.resolved) }))
    .filter((x) => x.c && x.c.family === "opus");
  if (opus.length) {
    opus.sort((a, b) => cmpVersion(b.c.version, a.c.version));
    return opus[0].r.id;
  }
  return (list.find((r) => /opus/i.test(r.id)) ?? list[0])?.id;
}

/** The picker label for an id, from the presented catalog (falls back to the id). */
export function modelLabel(catalog, id) {
  return (Array.isArray(catalog) ? catalog : []).find((m) => m.id === id)?.label ?? id ?? "Claude";
}
