/**
 * panel#747 — a Save-As fenced the session that performed it, unrecoverably.
 *
 * `panel_save_workflow({name})` doing a Save-As switches the active canvas to the
 * NEWLY CREATED workflow. The caller's session is still fenced to the instance it
 * held BEFORE its own save, so every following `panel_*` call is refused with
 * `workflow instance mismatch`. The agent breaks its own binding by using a
 * documented tool exactly as documented.
 *
 * What made it UNRECOVERABLE is the shape of the deadlock, not the mismatch: the
 * reply said `{saved: true, workflow: "<name>"}` and nothing else. It carried no
 * identity, so the orchestrator had no value to re-fence to — and every call that
 * could have told it is itself fenced. The reporter watched one stale uuid survive
 * seven `panel_set_workflow_target({mode:"current"})` calls, an orchestrator
 * update, several reconnects, and a browser hard reset.
 *
 * So the save reply now carries the identity of the workflow that is active when
 * the save finishes. That is the one moment the panel knows the new instance and
 * the caller does not.
 *
 * NEVER MINTS. The identity comes from `establishedWorkflowReplyIdentity`, a pure
 * read: an identity that has not been established yet stays unreported, and the
 * reply says so instead of inventing one. A reply that could establish identity
 * would let a mere read decide what the canvas IS (#716) — the fence would then be
 * agreeing with itself rather than observing anything.
 */

/**
 * The identity fields a save reply should carry.
 *
 * @param {{routingKey?: string, uuid?: string}|null|undefined} identity the result
 *   of `establishedWorkflowReplyIdentity(activeWorkflowRef())`, or null when the
 *   panel has not established one.
 * @param {{savedAs?: boolean}} [opts] `savedAs` marks a save that CHANGED which
 *   workflow is active, which is the case that can strand the caller.
 * @returns {object} fields to spread into the reply — `{}` when nothing is known
 */
export function saveReplyIdentity(identity, { savedAs = false } = {}) {
  const uuid = typeof identity?.uuid === "string" && identity.uuid ? identity.uuid : null;
  const routingKey =
    typeof identity?.routingKey === "string" && identity.routingKey ? identity.routingKey : null;
  if (!uuid && !routingKey) {
    // Absent, not empty. Saying nothing here would read as "identity unchanged",
    // which is the exact assumption that stranded the reporter.
    return {
      workflow_identity_unavailable: true,
      workflow_identity_note:
        "This save did not report a workflow instance identity because the panel has not " +
        "established one for the active canvas. If a following command is refused with " +
        "\"workflow instance mismatch\", the session is fenced to the workflow that was " +
        "active BEFORE this save; re-target it against the live canvas rather than retrying.",
    };
  }
  return {
    ...(uuid ? { workflow_uuid: uuid } : {}),
    ...(routingKey ? { routing_key: routingKey } : {}),
    ...(savedAs
      ? {
          workflow_instance_changed: true,
          // #978 — RE-FENCING MAY NOT BE ENOUGH, and saying only "re-fence" stranded a
          // reporter who did it correctly and was still refused. ComfyUI's own store moves
          // the active pointer without repainting: `workflowStore.openWorkflow` does not
          // call `loadGraphData` (only `workflowService.openWorkflow` does), and the
          // Save-As adapter documents this as the reason it persists the copy from the
          // SOURCE tab. So this save does not ASK for a repaint — which is all that is
          // established here. Whether the canvas still holds the source graph WHEN THE
          // CALLER READS THIS is not observed: a user switching tabs, or a reconnect
          // restoring one, can repaint during the save's awaits. If it was not repainted,
          // the graph fence compares the live root's identity against the active
          // workflow's and refuses — correctly, because the canvas really is the other
          // workflow's — and `panel_open_workflow` is what brings the copy onto it.
          // WHAT IS ESTABLISHED is that the save did not ASK for a repaint (codex): it
          // activates through the store, and nothing here observes the root at reply
          // time. A user switching tabs, or a reconnect restoring one, could repaint the
          // copy during the save's awaits — so the consequence is stated conditionally
          // rather than asserted. Naming the cause of a refusal a caller may be about to
          // hit is the whole value; claiming the refusal will happen is not supported.
          canvas_repaint_not_requested: true,
          workflow_instance_note:
            "Save-As made a DIFFERENT workflow active, so a session still fenced to the " +
            "previous instance will have every following command refused with \"workflow " +
            "instance mismatch\" — re-fence it to the workflow_uuid reported here. That " +
            "may not be enough for GRAPH tools: this save activates the copy WITHOUT " +
            "asking for a canvas repaint, so unless something else repainted it, the " +
            "canvas still holds the source workflow's graph. If a graph command is then " +
            "refused for a root-workflow-uuid mismatch, that is why, and it is refusing " +
            "correctly. Open the saved workflow (panel_open_workflow) to put it on the " +
            "canvas before reading or editing the graph (#978).",
        }
      : {}),
  };
}

/**
 * Should the panel ESTABLISH an identity for the canvas a save just made active (#941)?
 *
 * The #716 rule this sits next to is that a READ must never establish identity — a fence
 * refreshed from a value a read invented is agreeing with itself rather than observing
 * anything. `establishedWorkflowReplyIdentity` therefore refuses to mint, and that is
 * right.
 *
 * But a Save-As is not a read. It is a mutation whose entire job is to make a DIFFERENT
 * workflow active, and the object it activates is brand new — nothing has ever established
 * an identity for it. So the reply found none and said so honestly, while the fence, whose
 * own read DOES mint, immediately saw one. Measured on 0.11.80:
 *
 *     workflow_save({name}) -> { saved: true, saved_as: true, workflow_identity_unavailable: true }
 *     graph_outline()       -> "workflow instance mismatch: ... issued for instance b273a69f,
 *                               and the active canvas reports 14d699d3"
 *
 * The panel knew the new identity well enough to refuse the next call with it, and had
 * refused to report it one call earlier. Every `panel_*` graph tool is then dead for the
 * session, and the documented recovery is fence-exempt but cannot re-derive what was never
 * published — which left the reporter choosing between a ComfyUI restart and ~3h of queued
 * renders (#941).
 *
 * Establishing it as part of the save closes that gap at the only moment the panel knows
 * the new instance and the caller does not. Deliberately NOT widened to every save: an
 * in-place save keeps the same object, whose identity is already established, so there is
 * nothing to mint and no reason to touch it. Only the cases that strand a caller.
 *
 * #978 recurrence — a FIRST save is one of those cases too, and scoping this to Save-As
 * left it standing. A first save (never-persisted tab saved under a name) swaps the active
 * object exactly like a Save-As: the successor is brand new, and nothing has established
 * an identity for it either. The #557 carry was supposed to cover that case by threading
 * the predecessor's uuid onto the successor — and on a healthy run it does. But the carry
 * is deliberately fail-safe: any proof gap (a tab switch landing in the save's awaits, an
 * unreadable openWorkflows list, a token mismatch on an unverified frontend) aborts it,
 * and then the reply found nothing established and reported `workflow_identity_unavailable`
 * — while the fence, whose own read mints, refused the very next call with the identity
 * the reply had declined to publish. Measured on panel 0.14.41 / frontend 1.48.7: a first
 * save of a new tab succeeded with `workflow_identity_unavailable: true` and the session
 * stayed fenced to the pre-save instance until a manual re-target.
 *
 * The #716 objection does not apply here for the same reason it did not apply to Save-As:
 * this establishes an identity for the record the SAVE ITSELF produced (the token- or
 * event-proven output of the save transaction), never for whatever canvas happens to be
 * active — so it is the mutation reporting its own result, not a read deciding what the
 * canvas is. And it cannot collide with the carry: a record the carry already seeded reads
 * as `alreadyEstablished` and is left alone.
 */
export function shouldEstablishIdentityAfterSave({ savedAs = false, firstSave = false, alreadyEstablished = false } = {}) {
  if (alreadyEstablished) return false;
  return savedAs === true || firstSave === true;
}
