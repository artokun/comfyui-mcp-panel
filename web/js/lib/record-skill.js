// Record a reusable skill from the open graph (#350).
//
// Smallest slice: snapshot the graph the user is looking at as a SKILL.md the
// agent can follow with existing panel_* tools. Not a recorder of action
// sequences and not a skill studio.

export const SKILL_WIDGET_VALUE_CAP = 240;
export const RECORDED_SKILL_DIR = "skills";

/** Lowercase hyphenated skill directory name. Empty / punctuation-only titles
 *  collapse to `recorded-graph` so the userdata path is always a real file. */
export function skillSlug(name) {
  const s = String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "recorded-graph";
}

/** Store path under ComfyUI userdata, e.g. `skills/portrait-look/SKILL.md`. */
export function recordedSkillUserdataPath(slug) {
  return `${RECORDED_SKILL_DIR}/${skillSlug(slug)}/SKILL.md`;
}

/** `/record-skill portrait-look` uses the typed name; bare `/record-skill` uses
 *  the open workflow title. */
export function skillNameFromSlash(raw, fallbackTitle) {
  const rest = String(raw ?? "")
    .replace(/^\/record-skill\b/i, "")
    .trim();
  return rest || String(fallbackTitle ?? "").trim() || "recorded-graph";
}

function clipSkillValue(value) {
  if (value == null) return "";
  let s;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (typeof s !== "string") return "";
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= SKILL_WIDGET_VALUE_CAP) return flat;
  return `${flat.slice(0, SKILL_WIDGET_VALUE_CAP)}…`;
}

function mdCell(value) {
  return clipSkillValue(value).replace(/\|/g, "\\|");
}

/** Nodes on the viewed graph only (not nested subgraph interiors). */
export function collectSkillNodes(graph) {
  const nodes = [];
  for (const n of graph?._nodes ?? []) {
    if (n == null || n.id == null) continue;
    const widgets = [];
    for (const w of n.widgets ?? []) {
      if (!w || typeof w.name !== "string" || !w.name) continue;
      widgets.push({ name: w.name, value: clipSkillValue(w.value) });
    }
    nodes.push({
      id: n.id,
      type: String(n.type ?? n.comfyClass ?? "Unknown"),
      title: typeof n.title === "string" && n.title && n.title !== n.type ? n.title : "",
      subgraph: Boolean(n.subgraph),
      widgets,
    });
  }
  return nodes;
}

export function collectSkillLinks(graph) {
  const links = [];
  const raw = graph?.links ?? {};
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  for (const l of list) {
    if (!l) continue;
    const originId = l.origin_id ?? l[1];
    const originSlot = l.origin_slot ?? l[2];
    const targetId = l.target_id ?? l[3];
    const targetSlot = l.target_slot ?? l[4];
    const type = l.type ?? l[5] ?? "";
    if (originId == null || targetId == null) continue;
    links.push({
      originId,
      originSlot: originSlot ?? 0,
      targetId,
      targetSlot: targetSlot ?? 0,
      type: String(type || ""),
    });
  }
  return links;
}

export function buildRecordedSkillMarkdown({ name, title, nodes, links }) {
  const slug = skillSlug(name);
  const shownTitle = String(title || slug);
  const nodeCount = nodes.length;
  const typeList = [...new Set(nodes.map((n) => n.type))].join(", ");
  const rows = nodes
    .map((n) => {
      const widgets = n.widgets.map((w) => `${w.name}=${mdCell(w.value)}`).join(", ");
      const kind = n.subgraph ? `${mdCell(n.type)} (subgraph)` : mdCell(n.type);
      return `| ${mdCell(n.id)} | ${kind} | ${mdCell(n.title)} | ${widgets} |`;
    })
    .join("\n");
  const linkLines = links.length
    ? links
        .map((l) => {
          const ty = l.type ? ` (${mdCell(l.type)})` : "";
          return `- \`#${l.originId}.${l.originSlot} → #${l.targetId}.${l.targetSlot}\`${ty}`;
        })
        .join("\n")
    : "- (none)";
  return [
    "---",
    `name: ${slug}`,
    `description: Rebuild the recorded ComfyUI graph "${mdCell(shownTitle)}" (${nodeCount} nodes). Use when asked to restore, replay, or recreate this graph.`,
    "---",
    "",
    `# ${slug}`,
    "",
    `Recorded from the open ComfyUI graph **${mdCell(shownTitle)}** (${nodeCount} nodes: ${mdCell(typeList)}).`,
    "",
    "This is a user-recorded skill, not a bundled model-family skill. Recreate the graph with panel tools; do not invent nodes that are not listed.",
    "",
    "## Nodes",
    "",
    "| id | type | title | widgets |",
    "| --- | --- | --- | --- |",
    rows,
    "",
    "## Links",
    "",
    linkLines,
    "",
    "## Rebuild",
    "",
    "1. Call `panel_add_node` for each Nodes row, in listed order. Remember the mapping from recorded id to the live id the canvas assigned.",
    "2. Call `panel_set_widget` for each listed widget using the live id.",
    "3. Call `panel_connect` for each Links row, translating recorded ids through that mapping.",
    "4. Confirm with `panel_graph_outline`.",
    "",
  ].join("\n");
}

/**
 * Snapshot `graph` as a skill document. Does not write. Returns
 * `{ ok:false, reason }` when there is nothing to record.
 */
export function recordSkillFromGraph(graph, { title, commandText } = {}) {
  if (!graph || typeof graph !== "object") {
    return { ok: false, reason: "no_graph" };
  }
  const nodes = collectSkillNodes(graph);
  if (!nodes.length) {
    return { ok: false, reason: "empty" };
  }
  const name = skillNameFromSlash(commandText, title);
  const slug = skillSlug(name);
  const links = collectSkillLinks(graph);
  const markdown = buildRecordedSkillMarkdown({ name: slug, title: name, nodes, links });
  return {
    ok: true,
    name: slug,
    title: name,
    slug,
    path: recordedSkillUserdataPath(slug),
    nodeCount: nodes.length,
    types: [...new Set(nodes.map((n) => n.type))],
    markdown,
  };
}

/** POST the skill file through ComfyUI's userdata API. `fetchApi` is `api.fetchApi`. */
export async function persistRecordedSkill({ fetchApi, path, markdown }) {
  if (typeof fetchApi !== "function") {
    return { ok: false, path, error: "userdata API is not available" };
  }
  try {
    const res = await fetchApi(`/userdata/${encodeURIComponent(path)}?overwrite=true`, {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: markdown,
    });
    if (!res || res.ok === false) {
      const status = res?.status ?? "no-response";
      return { ok: false, path, error: `userdata write failed (${status})` };
    }
    return { ok: true, path };
  } catch (err) {
    return { ok: false, path, error: String(err?.message ?? err) };
  }
}
