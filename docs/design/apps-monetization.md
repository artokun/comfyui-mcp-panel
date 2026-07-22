# Apps monetization — design notes (P5, NOT implemented)

Status: **design-only**. Nothing in this document is built. The registry schema
already reserves the hooks (`apps.pricing_json`, `apps.hosted_only` — see
`registry/migrations/0001_init.sql`) so the build-out is purely additive.

## The idea

Creators can mark a published app **hosted-only**: the workflow/prompt is never
distributed — not even the API-format snapshot. Runs execute on OUR fleet
(RunPod and/or Vast), spun up on demand, and the runner pays per generation:

```
price_per_gen = (endpoint_cost_per_sec + our_fee_per_sec) × gen_seconds + creator_fee_per_gen
```

The runner funds a token balance; each run debits it. The creator accrues
creator_fee; we accrue the platform fee minus the pod cost.

## Why this is the ONLY real workflow protection

Local "hidden workflow" is obfuscation: anyone who runs the app locally can
sniff `/history`, and the auto-installed models/custom nodes reveal the graph's
deps. Hosted-only changes the trust boundary — the prompt never leaves our
infrastructure, so intercepting it means compromising US, not reading your own
localhost. This is the honest answer to "hide my workflow" and should be
presented that way in product copy (the local hide toggle already links here).

## Hard problems (each is a project, none is a line item)

- **Payments**: token balance means a payment processor (Stripe vs crypto),
  refunds, chargebacks, and regional tax (VAT/sales). Creator payouts add
  KYC/1099-style obligations — we become a marketplace, not a tool.
- **Fraud**: run_count and gen_seconds feed money now. Client-reported
  `ran` is fine for trending, worthless for billing — metering must come from
  the fleet (pod-side execution stats), signed and reconciled against RunPod's
  own billing API. Fake-creator self-runs to farm creator fees need velocity
  caps and payout thresholds.
- **Fleet economics**: cold-start per run (pod boot + model load) can exceed
  the run itself. Warm pools cost money while idle. Need per-model warm-pool
  policy, queueing, and honest ETA surfacing in the clients.
- **Content liability**: hosted NSFW generation on our fleet makes us the
  publisher in some jurisdictions. Needs a real content policy, automated +
  human review paths, and takedown SLAs before any hosted NSFW is allowed.
- **Identity**: the current creator key (sha256 of a local secret) is fine for
  publishing, not for money. Payouts need verified identity (OAuth + KYC).
  Plan the migration: creator_id stays, accounts get linked to it later.

## What exists TODAY that this builds on

- Registry: `hosted_only` + `pricing_json` columns (`registry/migrations/0001_init.sql`).
- RunPod pod lifecycle + honest host indicator (panel RunPod modal,
  `runpod_*` tools) — the on-demand pod control plane is proven.
- App run engine with server-side patch+queue (`py/apps_routes.py`) — the same
  route shape works behind a hosted gateway: `POST /apps/{id}/run` but the
  prompt never returns to the client, only the outputs do.
- Mobile + panel run paths both poll a status endpoint — a hosted run can
  present the identical status contract.

## Suggested build order (when picked up)

1. Hosted-run gateway (our worker in front of a warm pod pool) for OUR OWN
   apps first — no money, just the hosted_only execution path end-to-end.
2. Token balance + Stripe top-ups, runner-side only (no creator payouts).
3. Creator fees + payouts (KYC), fraud limits, content policy enforcement.
