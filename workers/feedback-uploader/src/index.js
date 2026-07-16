/**
 * comfyui-mcp feedback uploader — Cloudflare Worker.
 *
 * Receives the ComfyUI-MCP panel's "Share transcript" POST (a good/bad-rated
 * chat transcript + version info; see web/js/lib/feedback.js in this repo for
 * the exact payload and its privacy scrubbing) and writes it to S3 under a
 * random key. The stored objects are the local-model retrain dataset.
 *
 *   panel ──POST {verdict, why?, transcript, versions, …}──▶ this Worker
 *                                                              │ SigV4 PUT
 *                                                              ▼
 *                                    s3://$S3_BUCKET/feedback/YYYY/MM/DD/<verdict>-<uuid>.json
 *
 * Configuration (see README.md — nothing is hardcoded here):
 *   vars    S3_BUCKET, S3_REGION, [S3_ENDPOINT], [ALLOWED_ORIGINS]
 *   secrets AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
 *
 * The Worker never logs payload contents (transcripts are user conversations)
 * and stores exactly the validated fields plus a server-side received_at.
 */

import { signRequest } from "./sigv4.js";
import { validateFeedback, MAX_BODY_BYTES } from "./validate.js";

function corsHeaders(request, env) {
  const conf = (env.ALLOWED_ORIGINS ?? "*").trim();
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };
  if (conf === "*" || conf === "") {
    headers["access-control-allow-origin"] = "*";
    return headers;
  }
  const origin = request.headers.get("origin") ?? "";
  const allowed = conf.split(",").map((s) => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  return headers;
}

function json(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

function objectKey(verdict) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `feedback/${yyyy}/${mm}/${dd}/${verdict}-${crypto.randomUUID()}.json`;
}

function s3Url(env, key) {
  if (env.S3_ENDPOINT) {
    // Path-style — works for R2's S3-compatible endpoint, MinIO, etc.
    return `${env.S3_ENDPOINT.replace(/\/+$/, "")}/${env.S3_BUCKET}/${key}`;
  }
  return `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com/${key}`;
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "POST only" }, { ...cors, allow: "POST, OPTIONS" });
    }

    if (!env.S3_BUCKET || !env.S3_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      // Deployed but not provisioned yet — fail loudly, never half-store.
      return json(503, { ok: false, error: "collector not configured" }, cors);
    }

    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` }, cors);
    }
    const bodyText = await request.text();
    // Content-Length can lie (or be absent) — enforce on the actual bytes.
    if (new TextEncoder().encode(bodyText).length > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: `body exceeds ${MAX_BODY_BYTES} bytes` }, cors);
    }

    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return json(400, { ok: false, error: "invalid JSON" }, cors);
    }

    const result = validateFeedback(parsed);
    if (!result.ok) {
      return json(400, { ok: false, error: "invalid payload", details: result.errors }, cors);
    }

    const stored = { ...result.feedback, received_at: new Date().toISOString() };
    const key = objectKey(stored.verdict);
    const url = s3Url(env, key);
    const body = JSON.stringify(stored);

    let putRes;
    try {
      const headers = await signRequest({
        method: "PUT",
        url,
        headers: { "content-type": "application/json" },
        body,
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        region: env.S3_REGION,
        service: "s3",
      });
      putRes = await fetch(url, { method: "PUT", headers, body });
    } catch (err) {
      console.log(`feedback-uploader: PUT threw: ${err instanceof Error ? err.message : String(err)}`);
      return json(502, { ok: false, error: "storage unreachable" }, cors);
    }
    if (!putRes.ok) {
      // Log the status only — never the payload (it is a user conversation)
      // and never the S3 error body (it can echo request details).
      console.log(`feedback-uploader: S3 PUT failed with ${putRes.status}`);
      return json(502, { ok: false, error: "storage rejected the object" }, cors);
    }

    return json(200, { ok: true, id: stored.id }, cors);
  },
};
