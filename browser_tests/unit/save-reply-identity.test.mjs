// panel#747 — a Save-As fenced the session that performed it, unrecoverably.
//
// `panel_save_workflow({name})` doing a Save-As switches the active canvas to the
// newly created workflow, so the calling session is left fenced to the instance it
// held BEFORE its own save. Every following panel_* call is refused with
// `workflow instance mismatch`.
//
// The mismatch alone would be recoverable. What made it a dead end is that the
// reply was `{saved: true, workflow: "<name>"}` and nothing else — no identity to
// re-fence to, and every call that could supply one is itself fenced. The reporter
// watched a single stale uuid survive seven set_workflow_target calls, an
// orchestrator update, several reconnects, and a browser hard reset.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { saveReplyIdentity } from "../../web/js/lib/save-reply-identity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

const IDENTITY = { routingKey: "wf:workflows/new.json", uuid: "8c778b58-c38f-4bce-b975-b0981456c230" };

test("#747 a Save-As reply carries the identity the caller must re-fence to", () => {
  const r = saveReplyIdentity(IDENTITY, { savedAs: true });
  assert.equal(r.workflow_uuid, IDENTITY.uuid);
  assert.equal(r.routing_key, IDENTITY.routingKey);
  assert.equal(r.workflow_instance_changed, true);
  assert.match(r.workflow_instance_note, /re-fence it to the workflow_uuid reported here/);
});

test("#747 an in-place save reports identity but does NOT claim the instance changed", () => {
  // Saving in place leaves the same workflow active. Flagging a change here would
  // send a caller to re-fence for no reason, and train it to ignore the flag.
  const r = saveReplyIdentity(IDENTITY, { savedAs: false });
  assert.equal(r.workflow_uuid, IDENTITY.uuid);
  assert.equal(r.workflow_instance_changed, undefined);
  assert.equal(r.workflow_instance_note, undefined);
});

test("#747 an UNESTABLISHED identity is declared absent, never guessed", () => {
  // The reply must not mint an identity — a read that could establish one lets the
  // fence agree with itself instead of observing anything (#716). But silence would
  // read as "identity unchanged", which is the assumption that stranded the
  // reporter, so the absence is stated.
  for (const empty of [null, undefined, {}, { uuid: "" }, { routingKey: "" }]) {
    const r = saveReplyIdentity(empty, { savedAs: true });
    assert.equal(r.workflow_uuid, undefined);
    assert.equal(r.routing_key, undefined);
    assert.equal(r.workflow_identity_unavailable, true);
    assert.match(r.workflow_identity_note, /fenced to the workflow that was active BEFORE this save/);
  }
});

test("#747 a partial identity reports what it has and omits what it lacks", () => {
  const onlyUuid = saveReplyIdentity({ uuid: IDENTITY.uuid }, { savedAs: true });
  assert.equal(onlyUuid.workflow_uuid, IDENTITY.uuid);
  assert.equal(onlyUuid.routing_key, undefined);
  assert.equal(onlyUuid.workflow_identity_unavailable, undefined);

  const onlyKey = saveReplyIdentity({ routingKey: IDENTITY.routingKey }, { savedAs: false });
  assert.equal(onlyKey.routing_key, IDENTITY.routingKey);
  assert.equal(onlyKey.workflow_uuid, undefined);
});

test("#747 non-string identity fields are rejected, not stringified into the fence", () => {
  // A number or object reaching workflow_uuid would be compared against a real
  // uuid and never match — an unrecoverable fence built out of garbage input.
  const r = saveReplyIdentity({ uuid: 12345, routingKey: { k: 1 } }, { savedAs: true });
  assert.equal(r.workflow_uuid, undefined);
  assert.equal(r.routing_key, undefined);
  assert.equal(r.workflow_identity_unavailable, true);
});

test("#747 WIRING: BOTH save handlers report the identity, and the FLAG follows the outcome", () => {
  // A green helper proves nothing about the reply the agent receives (#792).
  const src = readFileSync(PANEL_JS, "utf8");
  // The SYMBOL is imported from that module — not the exact import line. Pinning the whole
  // line broke the moment #941 added a second export beside it, which says nothing about
  // whether the reply is wired up.
  assert.match(src, /import \{[^}]*saveReplyIdentity[^}]*\} from "\.\/lib\/save-reply-identity\.js"/);

  const saveIdx = src.search(/async workflow_save\(\{ name(?:, rid)? \} = \{\}\)/);
  const saveAsIdx = src.search(/async workflow_save_as\(\{ name(?:, rid)? \}\)/);
  assert.ok(saveIdx > 0 && saveAsIdx > saveIdx);

  const saveBlock = src.slice(saveIdx, saveAsIdx);
  const saveAsBlock = src.slice(saveAsIdx, saveAsIdx + 2200);

  // workflow_save is only a Save-As when the outcome says so…
  assert.match(saveBlock, /saveReplyIdentity\(outcome\.saved_as \? replyIdentity : replyIdentity \?\? liveWorkflowListActive\(\)\.activeIdentity, \{ savedAs: !!outcome\.saved_as \}\)/);
  // …and #978 — so does workflow_save_as, whose NAME is not the fact. Asked to save an
  // unsaved tab, the adapter classifies it `first_save`: the successor is
  // identity-CONTINUOUS with the temporary predecessor, so nothing about which workflow
  // is active changed and the Save-As disclosure would send that caller re-fencing and
  // re-opening for a problem they do not have. The IDENTITY is still always established
  // from the produced record (asserted below); only the disclosure follows the outcome.
  assert.match(saveAsBlock, /saveReplyIdentity\(replyIdentity, \{ savedAs: !!outcome\.saved_as \}\)/);
  // #941 — and a Save-As must NOT fall back to the live active canvas. Absence stays
  // absence; substituting whatever is active can name a foreign canvas (codex).
  assert.doesNotMatch(saveAsBlock, /savedAs: true[\s\S]{0,80}liveWorkflowListActive/);

  // #941 — and BOTH must establish the identity first, or the read above finds nothing for
  // a Save-As's brand-new object and reports `workflow_identity_unavailable` while the
  // fence, whose own read mints, refuses the next call with the identity it just declined
  // to publish. #978 recurrence — the same holds for a FIRST save, whose successor is just
  // as brand-new when the #557 carry fails safe; the firstSave flag must reach the rule.
  // …from the record the SAVE produced, not a later active-canvas read (#941, codex).
  assert.match(saveBlock, /saveProducedIdentity\(producedRecord, \{ savedAs: !!outcome\.saved_as, firstSave: !!outcome\.first_save \}\)/);
  assert.match(saveAsBlock, /saveProducedIdentity\(producedRecord, \{ savedAs: true, firstSave: !!outcome\.first_save \}\)/);
});
