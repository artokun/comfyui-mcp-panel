/**
 * The identity of the tool vocabulary THIS panel build vendored (#236).
 *
 * The panel calls MCP tool names as bare string literals and validates them against
 * `vendor/tool-vocabulary.json`. That is a self-consistency check: it proves the
 * literals match the vendored copy, never that the copy matches the SERVER being
 * talked to. When the two disagree, the failure surfaced at CALL time as "unknown
 * tool" — which reads to a user as a broken panel and gives an agent nothing to act
 * on (panel #236, and #683 in the other direction).
 *
 * Advertising this in the hello lets the orchestrator compare the two AT CONNECT and
 * say so once, in a sentence that names the remedy, instead of leaving it to be
 * discovered one failed tool call at a time.
 *
 * ## Why it is a baked constant and not a read of the artefact
 *
 * `vendor/` is not served to the browser — the pack's WEB_DIRECTORY is `./web`, so
 * nothing under the pack root is fetchable from panel JS. A copy under `web/` would
 * be a second artefact free to drift from the first.
 *
 * So the value is duplicated here deliberately, and `scripts/check-tool-vocabulary.mjs`
 * FAILS when it stops matching `vendor/tool-vocabulary.json` — the same gate that
 * already runs in CI and already refuses a hand-edited artefact. A duplicated constant
 * with a gate is honest; one without a gate is the drift this whole handshake exists
 * to catch, reproduced inside the thing catching it.
 *
 * GENERATED VALUE — do not hand-edit. Re-vendor and run `npm run check:tool-vocabulary`,
 * which prints the replacement line when this goes stale.
 */
export const VENDORED_VOCABULARY_HASH = "23ca43f48ed05fe2e611d6ba1a6c522ca93410667d8e09ad90bf5c79d0f6c6ec";
