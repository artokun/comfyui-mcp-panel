// Apps registry — pure logic (no Worker APIs), unit-tested with node:test.
// The fetch handler in worker.js binds these to D1/R2.

/** slugify a name for URLs: lowercase, alnum runs → dashes. */
export function slugify(s) {
  const slug = String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "app";
}

/** Validate + shape a publish payload. Returns { app, bundle } or throws
 *  { status, message }. The bundle is what goes to R2 (and back to installers);
 *  `app` is the D1 row. hide_workflow strips the UI graph from the bundle —
 *  the registry NEVER receives it for hidden apps (client enforces too). */
export function shapePublish(body) {
  if (!body || typeof body !== "object") throw { status: 400, message: "body must be an object" };
  const creatorKey = String(body.creator_key || "");
  if (!/^[0-9a-f]{64}$/.test(creatorKey)) {
    throw { status: 401, message: "creator_key must be 64 lowercase hex chars" };
  }
  const a = body.app;
  if (!a || typeof a !== "object") throw { status: 400, message: "app must be an object" };
  const id = String(a.id || "");
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) throw { status: 400, message: "app.id must be a uuid" };
  const name = String(a.name || "").trim();
  if (!name) throw { status: 400, message: "app.name required" };
  const description = String(a.description || "").slice(0, 4000);
  const hideWorkflow = a.hide_workflow === true;
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) {
    throw { status: 400, message: "prompt (API format) required" };
  }
  if (hideWorkflow && body.workflow != null) {
    throw { status: 400, message: "hidden apps must not upload a workflow" };
  }
  if (!hideWorkflow && (body.workflow == null || typeof body.workflow !== "object")) {
    throw { status: 400, message: "workflow (UI format) required unless hidden" };
  }
  const appMode = a.app_mode && typeof a.app_mode === "object" ? a.app_mode : { inputs: [], outputs: [] };
  const deps = a.deps && typeof a.deps === "object" ? a.deps : {};
  const creatorName = String(body.creator_name || "anonymous").trim().slice(0, 60) || "anonymous";

  return {
    creatorKey,
    creatorName,
    app: {
      id: id.toLowerCase(),
      name: name.slice(0, 120),
      description,
      hideWorkflow,
      nsfw: a.nsfw === true,
      version: Number.isInteger(a.version) && a.version > 0 ? a.version : 1,
      appMode,
      deps,
      // P5 (monetization) hooks — reserved from day one, unused for now.
      pricingJson: typeof a.pricing_json === "string" ? a.pricing_json : null,
      hostedOnly: a.hosted_only === true,
    },
    bundle: {
      format: 1,
      manifest: {
        id: id.toLowerCase(),
        name: name.slice(0, 120),
        description,
        hideWorkflow,
        appMode,
        deps,
      },
      prompt,
      ...(hideWorkflow ? {} : { workflow: body.workflow }),
    },
  };
}

/** Deterministic creator id from the creator key (the key itself never hits
 *  the DB — only its hash, so a DB leak can't impersonate). sha256 hex. */
export async function creatorIdFor(keyHex, digest) {
  // `digest` is injectable for tests; in the Worker it's crypto.subtle.
  if (digest) return digest(keyHex);
  const bytes = new Uint8Array(keyHex.match(/../g).map((h) => parseInt(h, 16)));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SORTS = new Set(["new", "stars", "trending"]);

/** Build the list query. trending = (stars last 7d)*3 + (runs last 7d).
 *  Keyset-paginated by (score|star_count|created_at, id) so pages are stable.
 *  The score expression lives in a subquery so the cursor can reference it in
 *  WHERE (SQLite forbids SELECT aliases there). */
export function buildListQuery({ sort, q, creator, includeNsfw, limit, cursor }) {
  if (!SORTS.has(sort)) sort = "new";
  const where = ["a.hidden = 0"];
  const params = [];
  if (!includeNsfw) where.push("a.nsfw = 0");
  if (creator) {
    where.push("a.creator_name = ? COLLATE NOCASE");
    params.push(creator);
  }
  if (q) {
    // Registry scale doesn't need FTS — a substring match over name +
    // description + creator is honest and exact. Multi-word = AND.
    const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
    for (const w of words) {
      where.push("(a.name LIKE ? OR a.description LIKE ? OR a.creator_name LIKE ?)");
      const like = `%${w.replace(/[%_]/g, "")}%`;
      params.push(like, like, like);
    }
  }
  const lim = Math.min(Math.max(Number(limit) || 24, 1), 100);
  const scoreExpr =
    `(SELECT COUNT(*) FROM stars s WHERE s.app_id = a.id AND s.created_at > unixepoch() - 604800) * 3 ` +
    `+ (SELECT COUNT(*) FROM run_marks r WHERE r.app_id = a.id AND r.day > strftime('%Y-%m-%d', 'now', '-7 days'))`;
  const cursorCol = sort === "stars" ? "star_count" : sort === "trending" ? "score" : "created_at";
  const orderDir = cursorCol === "created_at" ? "DESC" : "DESC";
  const inner = `SELECT a.*, ${scoreExpr} AS score FROM apps a WHERE ${where.join(" AND ")}`;

  let outerWhere = "";
  if (cursor && cursor.v != null && cursor.id) {
    // Keyset: strictly worse rank, or equal rank and id tiebreak forward.
    outerWhere = `WHERE (${cursorCol} < ? OR (${cursorCol} = ? AND id > ?))`;
    params.push(cursor.v, cursor.v, cursor.id);
  }
  const sql = `SELECT * FROM (${inner}) ${outerWhere} ORDER BY ${cursorCol} ${orderDir}, id LIMIT ?`;
  params.push(lim + 1); // one extra row = has-more probe
  return { sql, params, limit: lim, sort };
}

/** Shape a D1 apps row for the public API. */
export function publicAppRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    creator: row.creator_name,
    version: row.version,
    hide_workflow: !!row.hide_workflow,
    nsfw: !!row.nsfw,
    hosted_only: !!row.hosted_only,
    pricing: row.pricing_json ? JSON.parse(row.pricing_json) : null,
    stars: row.star_count,
    runs: row.run_count,
    score: row.score || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** The cursor for the NEXT page from the last row of THIS one (null when the
 *  page was short = no more). Rows arrive as fetched (limit+1 max). */
export function nextCursor(rows, limit, sort) {
  if (rows.length <= limit) return null;
  const last = rows[limit - 1];
  const v = sort === "stars" ? last.star_count : sort === "trending" ? last.score : last.created_at;
  return btoa(JSON.stringify({ v, id: last.id }));
}

export function parseCursor(raw) {
  if (!raw) return null;
  try {
    const c = JSON.parse(atob(String(raw)));
    return c && c.id && c.v != null ? c : null;
  } catch {
    return null;
  }
}
