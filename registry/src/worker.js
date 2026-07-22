// Apps registry worker — publish / explore / star / install for the panel's
// micro-apps. Bindings: DB (D1), BUNDLES (R2), optional ADMIN_KEY.
//
// Identity (phase-1-simple): a creator_key (64 hex, generated client-side,
// held in the panel's localStorage / mobile secure store). The DB stores only
// creator_id = sha256(key), so a database leak can't impersonate anyone.
// Real OAuth is a later upgrade; P5 monetization needs it.
//
// Bundle storage: R2 `bundles/<id>.json` (manifest + prompt [+ workflow]) and
// `thumbs/<id>.png`. D1 holds the searchable/listable metadata; the FTS5 table
// + triggers live in migrations/0001_init.sql. P5 hooks (pricing_json,
// hosted_only) exist from day one so monetization is purely additive.

import {
  buildListQuery,
  creatorIdFor,
  nextCursor,
  parseCursor,
  publicAppRow,
  shapePublish,
  slugify,
} from "./core.js";

const JSON_HEADERS = {
  "content-type": "application/json",
  // The panel fetches the registry cross-origin (ComfyUI origin → workers.dev),
  // so every response needs CORS and OPTIONS must answer preflights.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function err(status, message) {
  return json({ error: message }, status);
}

async function sha256Hex(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    // CORS preflight (the panel's POSTs carry a JSON content-type, so browsers
    // preflight them cross-origin).
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }
    try {
      // POST /v1/apps — publish (create) or update (same id, owner only).
      if (method === "POST" && path === "/v1/apps") return await publish(request, env);
      // GET /v1/apps — list/search.
      if (method === "GET" && path === "/v1/apps") return await list(url, env);

      const appMatch = path.match(/^\/v1\/apps\/([0-9a-f-]{36})(\/(star|unstar|ran|report|thumbnail|bundle))?$/);
      if (appMatch) {
        const [, id, , action] = appMatch;
        if (method === "POST" && action === "star") return await star(env, id, request, true);
        if (method === "POST" && action === "unstar") return await star(env, id, request, false);
        if (method === "POST" && action === "ran") return await ran(env, id, request);
        if (method === "POST" && action === "report") return await report(env, id, request);
        if (method === "GET" && action === "thumbnail") return await thumbnail(env, id);
        if (method === "GET" && action === "bundle") return await bundle(env, id);
        if (method === "GET" && !action) return await detail(env, id);
      }
      // GET /v1/apps/by-slug/<creator>/<name> — humans share slugs, not uuids.
      const slugMatch = path.match(/^\/v1\/apps\/by-slug\/([a-z0-9-]+(?:\/[a-z0-9-]+)?)$/);
      if (method === "GET" && slugMatch) return await detailBySlug(env, slugMatch[1]);

      return err(404, "not found");
    } catch (e) {
      if (e && e.status) return err(e.status, e.message || "error");
      return err(500, `internal: ${e && e.message ? e.message : e}`);
    }
  },
};

async function publish(request, env) {
  // Anonymous endpoint with R2 storage behind it: hard-cap the request BEFORE
  // parsing (a JSON body can declare any content-length, so check both the
  // header and the actual buffered size).
  const MAX_PUBLISH_BYTES = 16 * 1024 * 1024;
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_PUBLISH_BYTES) return err(413, "bundle too large");
  const raw = await request.text();
  if (raw.length > MAX_PUBLISH_BYTES) return err(413, "bundle too large");
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return err(400, "invalid JSON");
  }
  const { creatorKey, creatorName, app, bundle } = shapePublish(body);
  const creatorId = await creatorIdFor(creatorKey, (hex) => sha256Hex(hex));
  const now = Math.floor(Date.now() / 1000);

  const existing = await env.DB.prepare("SELECT creator_id, slug, version FROM apps WHERE id = ?")
    .bind(app.id)
    .first();
  if (existing && existing.creator_id !== creatorId) {
    return err(403, "this app id belongs to another creator");
  }
  const version = existing ? Math.max(app.version, (existing.version || 0) + 1) : app.version;
  // Slug: creator/name, unique — fall back to an id suffix on collision.
  let slug = `${slugify(creatorName)}/${slugify(app.name)}`;
  const slugOwner = await env.DB.prepare("SELECT id FROM apps WHERE slug = ?").bind(slug).first();
  if (slugOwner && slugOwner.id !== app.id) {
    slug = `${slug}-${app.id.slice(0, 8)}`;
  }

  await env.BUNDLES.put(`bundles/${app.id}.json`, JSON.stringify(bundle), {
    httpMetadata: { contentType: "application/json" },
  });
  if (typeof body.thumbnail_b64 === "string" && body.thumbnail_b64) {
    const bytes = Uint8Array.from(atob(body.thumbnail_b64), (c) => c.charCodeAt(0));
    if (bytes.length > 5 * 1024 * 1024) throw { status: 400, message: "thumbnail too large" };
    await env.BUNDLES.put(`thumbs/${app.id}.png`, bytes, {
      httpMetadata: { contentType: "image/png" },
    });
  }

  await env.DB.prepare(
    `INSERT INTO apps (id, slug, creator_id, creator_name, name, description, version,
       hide_workflow, nsfw, hosted_only, pricing_json, star_count, run_count, hidden, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       slug = excluded.slug, creator_name = excluded.creator_name, name = excluded.name,
       description = excluded.description, version = excluded.version,
       hide_workflow = excluded.hide_workflow, nsfw = excluded.nsfw,
       hosted_only = excluded.hosted_only, pricing_json = excluded.pricing_json,
       updated_at = excluded.updated_at`,
  )
    .bind(
      app.id, slug, creatorId, creatorName, app.name, app.description, version,
      app.hideWorkflow ? 1 : 0, app.nsfw ? 1 : 0, app.hostedOnly ? 1 : 0, app.pricingJson,
      existing ? null : now, now,
    )
    .run();
  return json({ ok: true, id: app.id, slug, version });
}

async function list(url, env) {
  const sort = url.searchParams.get("sort") || "new";
  const q = url.searchParams.get("q") || "";
  const creator = url.searchParams.get("creator") || "";
  const includeNsfw = url.searchParams.get("nsfw") === "1";
  const limit = Number(url.searchParams.get("limit") || 24);
  const cursor = parseCursor(url.searchParams.get("cursor"));
  const query = buildListQuery({ sort, q, creator, includeNsfw, limit, cursor });
  const { results } = await env.DB.prepare(query.sql).bind(...query.params).all();
  const rows = (results || []).slice(0, query.limit);
  return json({
    apps: rows.map(publicAppRow),
    next_cursor: nextCursor(results || [], query.limit, query.sort),
  });
}

async function detailRow(env, by, value) {
  const row = await env.DB.prepare(`SELECT a.*, 0 AS score FROM apps a WHERE ${by} = ? AND hidden = 0`)
    .bind(value)
    .first();
  if (!row) throw { status: 404, message: "app not found" };
  return row;
}

async function detail(env, id) {
  return json({ app: publicAppRow(await detailRow(env, "a.id", id)) });
}

async function detailBySlug(env, slug) {
  return json({ app: publicAppRow(await detailRow(env, "a.slug", slug)) });
}

async function bundle(env, id) {
  const row = await detailRow(env, "a.id", id);
  const obj = await env.BUNDLES.get(`bundles/${row.id}.json`);
  if (!obj) throw { status: 404, message: "bundle missing" };
  // Hidden apps must report a run: the registry counts it so trending works
  // even where the panel never phones home. (Client-reported; not billing.)
  return new Response(obj.body, {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

async function thumbnail(env, id) {
  const obj = await env.BUNDLES.get(`thumbs/${id}.png`);
  if (!obj) return err(404, "no thumbnail");
  return new Response(obj.body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600",
      "access-control-allow-origin": "*",
    },
  });
}

async function star(env, id, request, on) {
  const body = await request.json().catch(() => null);
  const key = body && typeof body.star_key === "string" ? body.star_key : "";
  if (!/^[0-9a-zA-Z-]{4,64}$/.test(key)) return err(400, "star_key required");
  const keyHash = await sha256Hex(key);
  const exists = await env.DB.prepare("SELECT id FROM apps WHERE id = ? AND hidden = 0").bind(id).first();
  if (!exists) return err(404, "app not found");
  if (on) {
    // INSERT OR IGNORE + conditional count bump keeps one star per key.
    const res = await env.DB.prepare("INSERT OR IGNORE INTO stars (app_id, user_key, created_at) VALUES (?, ?, unixepoch())")
      .bind(id, keyHash)
      .run();
    if (res.meta.changes > 0) {
      await env.DB.prepare("UPDATE apps SET star_count = star_count + 1 WHERE id = ?").bind(id).run();
    }
  } else {
    const res = await env.DB.prepare("DELETE FROM stars WHERE app_id = ? AND user_key = ?")
      .bind(id, keyHash)
      .run();
    if (res.meta.changes > 0) {
      await env.DB.prepare("UPDATE apps SET star_count = MAX(star_count - 1, 0) WHERE id = ?").bind(id).run();
    }
  }
  return json({ ok: true, starred: on });
}

async function ran(env, id, request) {
  const body = await request.json().catch(() => null);
  const key = body && typeof body.star_key === "string" ? body.star_key : "";
  const marker = key ? await sha256Hex(key) : await sha256Hex(request.headers.get("CF-Connecting-IP") || "anon");
  const day = new Date().toISOString().slice(0, 10);
  // One counted run per app per marker per day — run_count feeds trending and
  // is a popularity signal, NOT billing, so this light throttle is enough.
  const res = await env.DB.prepare("INSERT OR IGNORE INTO run_marks (app_id, marker, day) VALUES (?, ?, ?)")
    .bind(id, marker, day)
    .run();
  if (res.meta.changes > 0) {
    await env.DB.prepare("UPDATE apps SET run_count = run_count + 1 WHERE id = ?").bind(id).run();
  }
  return json({ ok: true });
}

async function report(env, id, request) {
  const body = await request.json().catch(() => null);
  const reason = body && typeof body.reason === "string" ? body.reason.slice(0, 500) : "";
  await env.DB.prepare("INSERT INTO reports (app_id, reason, created_at) VALUES (?, ?, unixepoch())")
    .bind(id, reason)
    .run();
  return json({ ok: true });
}
