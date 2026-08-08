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
          workflow_instance_note:
            "Save-As made a DIFFERENT workflow active. A session still fenced to the " +
            "previous instance will have every following command refused with \"workflow " +
            "instance mismatch\" — re-fence it to the workflow_uuid reported here.",
        }
      : {}),
  };
}
