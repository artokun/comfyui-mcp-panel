# comfyui-mcp feedback uploader

A tiny Cloudflare Worker that receives the panel's **Share transcript** feedback
(good/bad-rated chat transcripts + version info) and writes each submission to
**S3** under a random key. The stored objects are the labeled dataset for the
local-model retrain.

```
panel  ──POST JSON──▶  Worker (validate, size-cap, CORS)  ──SigV4 PUT──▶  s3://$S3_BUCKET/feedback/YYYY/MM/DD/<verdict>-<uuid>.json
```

- **Zero runtime dependencies** — SigV4 is hand-rolled on Web Crypto
  (`src/sigv4.js`, pinned to AWS's published test vector in the tests), so
  `wrangler deploy` needs no `npm install` beyond wrangler itself.
- **Write-only** — no GET/list surface; the Worker can only add objects.
- **Nothing sensitive in the repo** — bucket/region are wrangler vars, AWS
  credentials are Worker secrets. Until all four are set the Worker answers
  `503 collector not configured` and nothing is stored.

## Payload contract (`comfyui-mcp.feedback/1`)

Produced by `web/js/lib/feedback.js` (see its tests for the privacy scrubbing):

```json
{
  "schema": "comfyui-mcp.feedback/1",
  "id": "<random uuid — anonymous submission id, no account linkage>",
  "timestamp": "2026-07-15T12:00:00.000Z",
  "verdict": "good | bad",
  "why": "optional free text (≤ 2000 chars, scrubbed)",
  "versions": {
    "model": "gemma4:e4b | claude-… | null",
    "panel": "0.8.2 | null",
    "mcp": "comfyui-mcp package version | null (orchestrator doesn't report it yet)",
    "backend": "ollama | claude | codex | … | null",
    "comfyui": "frontend version | null"
  },
  "transcript": [
    { "role": "user",  "text": "…", "attachments": [ { "id": "1", "content": "…" } ] },
    { "role": "agent", "text": "…" },
    { "role": "card",  "icon": "pi-cog", "text": "graph_build", "detail": "…" }
  ]
}
```

`transcript` is the panel's full persisted thread (user + agent messages and
tool-activity cards), already scrubbed panel-side: token cards dropped, bridge
URLs and recognizable secrets redacted, home-dir usernames masked, internal
message ids removed. The Worker validates the shape, drops unknown top-level
fields, adds a server-side `received_at`, and stores the result verbatim.

Request-body cap: **1 MiB** (`413` beyond it). Invalid payloads: `400` with a
`details` array. Storage failures: `502` (status logged, payload never logged).

## What the maintainer must provision (not done by this repo)

1. **S3 bucket** (private, no public access) + an IAM user/role whose policy
   allows only `s3:PutObject` on `arn:aws:s3:::<bucket>/feedback/*`.
2. **Cloudflare account** with Workers enabled.
3. Deploy this Worker and set the secrets (below).
4. Put the deployed URL into the panel setting
   **Settings → comfyui-mcp → “Share-transcript endpoint (advanced)”**
   (`comfyui-mcp.feedbackUrl`, aka `COMFYUI_MCP_FEEDBACK_URL`). Until then the
   panel feature is completely dormant — no button, no uploads.

## Deploy

```bash
cd workers/feedback-uploader
npm install                       # installs wrangler only
# 1. fill in S3_BUCKET (and S3_REGION if not us-east-1) in wrangler.jsonc
# 2. credentials — interactive prompts, never on the command line:
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
# 3. ship it
npx wrangler deploy
```

Optionally restrict browser origins by setting `ALLOWED_ORIGINS` in
`wrangler.jsonc` (comma-separated), e.g.
`"http://127.0.0.1:8188,http://localhost:8188"`. The default `*` is acceptable
for a write-only, credential-free endpoint.

### R2 instead of AWS S3

Implemented as S3 per the spec, but R2 speaks the same protocol — point
`S3_ENDPOINT` at `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and use an R2
API token's key pair as the two secrets (region stays `auto`-compatible with
`us-east-1`). *Even simpler CF-native alternative:* delete the SigV4 path
entirely and add an R2 **binding** to `wrangler.jsonc`
(`"r2_buckets": [{ "binding": "FEEDBACK", "bucket_name": "comfyui-mcp-feedback" }]`),
then replace the signed `fetch` in `src/index.js` with one line:
`await env.FEEDBACK.put(key, body, { httpMetadata: { contentType: "application/json" } })` —
no credentials to manage at all.

## Test

```bash
npm test          # node --test — SigV4 (AWS test vector), validation, full handler
```

## Local smoke (wrangler dev)

```bash
# terminal 1 — vars come from wrangler.jsonc; fake creds via .dev.vars:
printf 'AWS_ACCESS_KEY_ID=AKIDEXAMPLE\nAWS_SECRET_ACCESS_KEY=fake\n' > .dev.vars
npx wrangler dev

# terminal 2 — a valid payload (expect 502 with fake creds and a real bucket
# name, proving validation+signing ran; expect 503 if S3_BUCKET is empty):
curl -s -X POST http://localhost:8787/ \
  -H 'content-type: application/json' \
  -d '{"schema":"comfyui-mcp.feedback/1","verdict":"good","transcript":[{"role":"user","text":"hi"}],"versions":{"panel":"0.8.2"}}'

# and a rejected one (expect 400):
curl -s -X POST http://localhost:8787/ -H 'content-type: application/json' -d '{"verdict":"meh"}'
```

## Privacy notes

- The Worker never logs request bodies (they are user conversations) and never
  echoes storage-provider error bodies to clients.
- No cookies, no auth, no per-user identifiers — submissions are linkable only
  by their own random `id`, which the panel generates fresh per share.
- Abuse consideration: the endpoint is unauthenticated by design (the panel has
  no shared secret to hold). The 1 MiB cap + strict shape validation bound the
  damage; if spam appears, add Cloudflare WAF rate-limiting on the route or a
  Turnstile check.
