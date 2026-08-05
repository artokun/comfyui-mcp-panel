// #291 — the panel cannot see the agent's toolset, so it must not let the agent
// pretend it can see the canvas.
//
// THE DEFECT. The `panel_*` tools that read and edit the workflow the user is
// looking at are DEFINED once and served two ways: the Claude backend hosts them
// on an in-process SDK MCP server, every other backend receives them from the
// orchestrator over a loopback HTTP MCP. Sharing the definitions makes the two
// surfaces identical AT THE SERVER. It does not make them identical AT THE MODEL:
// a backend applies its own tool budget to everything it is given, and Codex was
// observed to SILENTLY DROP the whole panel MCP server once the ~250-tool headless
// comfyui surface saturated that budget — the server advertised the tools, the
// model never received them. (Root cause and the upstream remedy: comfyui-mcp#594,
// which spawns comfyui in compact mode for the non-Claude lane.)
//
// WHY A DISCLOSURE AND NOT A CHECK. The obvious fix — have the panel detect the
// missing tools and say so — is not available to the panel, and shipping a guess
// dressed as a check would be the worse bug. The panel receives no tool-use events
// and no toolset manifest; the ONLY panel-observable fact is POSITIVE: a `cmd`
// frame arrives only because the model invoked a panel_* tool, so one command
// PROVES exposure. Nothing proves the converse. An agent that simply had no reason
// to touch the canvas this session is indistinguishable, from here, from one that
// could not. So "no panel_* command yet" is UNESTABLISHED, never "unavailable",
// and this module never asserts the tools are missing.
//
// The one party that can see the toolset is the model. So the panel asks it, once,
// and tells it what to do with the answer — because the failure mode is not that
// the model lacks the tools, it is that a model told (by the system prompt) that it
// has panel_* tools, finding none, IMPROVISES: it saves a workflow file, enqueues
// headlessly, or narrates canvas edits it never made, and the user reads that as
// the panel being broken. That is the whole of #291 as the reporter experienced it.
//
// Pure + side-effect-free so the decision is unit-testable in isolation; the caller
// stamps the epochs and prepends the text.

/**
 * The text prepended to the agent's turn. Exported so the wiring and the tests
 * assert the SAME string, and so a change to what we tell the model is a visible
 * change to a named constant rather than an edit buried in a send path.
 *
 * Three properties this text must keep:
 *
 *  1. It states our own UNCERTAINTY as uncertainty. It does not tell the model its
 *     tools are missing (we do not know that) and it does not tell it they are
 *     present (we do not know that either). It asks the one party that can see.
 *
 *  2. It names the substitutes to REFUSE. "Say if you can't" is not enough on its
 *     own: the improvisations are individually reasonable-looking actions, and the
 *     reporter's session took one (`save_workflow`) and read as merely unhelpful
 *     rather than as a missing capability.
 *
 *  2b. It covers ADVERTISED-BUT-UNUSABLE, not only absent. A tool present in the
 *     list can still fail at call time — the loopback MCP can die, the panel tab
 *     can be gone — and "listed, therefore fine" is the same defect as "unlisted,
 *     therefore impossible", running the other way. So the present branch is not a
 *     free pass: it forbids the identical silent headless substitution after a
 *     panel_* call FAILS, which is where the fabrication would otherwise reappear.
 *
 *  3. Its remedies are actionable from where the user already is — update, prune
 *     the backend's own MCP config, restart, or switch backend — not "unavailable".
 *     They are also ordered by likelihood, and each names its OWN cause: a crowded
 *     tool budget, a deliberate `full` override, and a session that needs rebuilding
 *     are three different faults and must not be narrated as one.
 */
export const CANVAS_TOOL_DISCLOSURE =
  `⚙ LIVE-CANVAS TOOLS — CHECK YOUR TOOLSET BEFORE YOU ACT ON THE CANVAS. ` +
  `The panel_* tools that read and edit the workflow this user has open are supplied to you by the ` +
  `panel's orchestrator, and the panel CANNOT observe whether they reached your toolset — only you ` +
  `can see that. This is a question, not a claim that anything is wrong.\n` +
  `• IF panel_graph_outline IS in your toolset: work on the canvas normally. But being listed is not ` +
  `proof the canvas is reachable — if a panel_* call then FAILS, report that failure and what it ` +
  `said; do NOT quietly substitute a headless workaround for it.\n` +
  `• IF IT IS NOT in your toolset: do NOT improvise a substitute — no saving a workflow file instead ` +
  `of editing the canvas, no headless generate_image/enqueue_workflow standing in for a canvas run — ` +
  `and never describe graph edits you did not make. Say plainly that this session did not receive the ` +
  `live-canvas tools, then give the user these remedies in order: (1) update comfyui-mcp — on a ` +
  `non-Claude backend the headless comfyui tools can crowd panel_* out of the backend's tool budget, ` +
  `which is issue #291 and is fixed upstream; (2) if COMFYUI_MCP_TOOL_MODE=full is set, unset it, and ` +
  `drop MCP servers you don't need from that backend's own config, to leave budget for panel_*; ` +
  `(3) run /restart in the panel to rebuild the session, or switch this chat to the Claude backend, ` +
  `which receives panel_* by a different route.\n\n`;

/**
 * Frames that bind this socket to an agent session whose toolset we have no
 * evidence about — including ones that do so on a socket that never closed.
 *
 * The disclosure's scope is an AGENT session, because that is what owns a toolset,
 * and a socket generation is NOT the same thing. Three same-socket paths hand the
 * next turn to a different agent, and every one of them was a hole in an earlier
 * draft of this fix:
 *
 *   • `new_session` — `/new`, or closing the open thread.
 *   • `resume_session` — picking a chat out of history. Included even though it
 *     names an EXISTING session: the orchestrator re-establishes that session's
 *     backend, so the toolset is negotiated again and we have no evidence it came
 *     back the same.
 *   • `hello` — the per-workflow re-target. The panel follows the user's workflow
 *     tabs by re-helloing the LIVE socket with the new tab id; with the session key
 *     cleared that hello spawns a clean agent outright, with no `new_session` frame
 *     anywhere. Note this one does NOT travel through `sendFrame` — `sendHello`
 *     dispatches it — so it is listed here for the rule, and the bump lives in
 *     `sendHello`.
 *
 * EVERY ONE OF THESE ADVANCES THE GENERATION ONLY ONCE ITS FRAME IS ON THE WIRE.
 * A frame that was never sent bound nothing, so advancing for it would invalidate a
 * working agent's proof and re-ask a session that demonstrably had the tools whether
 * it had them — the inverse of the bug this module exists to fix. The hello case is
 * the subtle one, because its send is asynchronous (it waits on restart-identity
 * exclusivity) and can be abandoned mid-flight when the socket is superseded.
 *
 * THE TRADE, named rather than left as a surprise: this list is deliberately coarse.
 * A re-hello (plus its `resume_session`) also fires for events that keep the SAME
 * conversation — a save migrating a tab from `tmp:` to `wf:`, a rename — so those
 * users see the paragraph again mid-chat. Distinguishing them would mean tracking
 * which session id we were already on and trusting that tracking to decide whether
 * to warn, i.e. a second piece of state whose being wrong is silent. The cost of
 * being coarse is a repeated paragraph on an occasional, user-initiated event; the
 * cost of being precise and wrong is #291. Frequency is bounded either way: it is
 * once per generation, never per turn.
 *
 * Exported and derived-from rather than inlined at the call sites so the rule is one
 * testable list, and so a new session-starting frame is a change to this list rather
 * than a silent hole.
 */
export const AGENT_SESSION_RESET_FRAMES = ["hello", "new_session", "resume_session"];

/** Does sending this frame type start a turn under a possibly-different toolset? */
export function startsNewAgentSession(frameType) {
  return AGENT_SESSION_RESET_FRAMES.includes(frameType);
}

/**
 * May a command frame arriving NOW be counted as proof for the current generation?
 *
 * A `cmd` frame carries no agent-session correlation, and the socket is
 * bidirectional: when a same-socket reset (`/new`, a chat picked from history)
 * advances the generation, a command the OUTGOING agent already put on the wire can
 * land immediately afterwards. Stamped naively, that straggler proves a generation
 * it was never part of — and the fresh, possibly toolless model then gets no
 * disclosure. That is precisely #291 again, reached by ordinary WebSocket timing
 * rather than by anything exotic.
 *
 * The disambiguator is exact rather than a timing window: a command is a response
 * to a turn, and the new agent has no turn until the panel sends it one. So a
 * command arriving in a generation the panel has not yet sent a user_message in
 * cannot be that agent's, and is refused as evidence.
 *
 * `messagedEpoch` is the generation of the last user_message the panel actually got
 * onto the wire — not the last one composed, since a message that never left cannot
 * have prompted anything.
 *
 * RESIDUAL, stated rather than papered over: a straggler that arrives AFTER the new
 * generation's first message can still be miscounted. It is benign — by then that
 * generation's one disclosure has already been delivered, which is the outcome this
 * whole module exists to secure. Closing it would need a session id on the command
 * frame, which is an orchestrator-side wire change, not a panel one.
 */
export function commandProvesExposure({ agentEpoch, messagedEpoch } = {}) {
  return Number.isFinite(agentEpoch) && messagedEpoch === agentEpoch;
}

/**
 * Decide whether to prepend {@link CANVAS_TOOL_DISCLOSURE} to this turn.
 *
 * Epochs count AGENT-session generations: bumped on every orchestrator socket
 * (re)connect AND on every {@link AGENT_SESSION_RESET_FRAMES} frame. Both the proof
 * and the disclosure are scoped to ONE generation, so neither carries across a
 * reconnect, a backend switch, or a same-socket new/resumed chat.
 *
 * @param {{agentEpoch?:unknown, provenEpoch?:unknown, disclosedEpoch?:unknown}} state
 *   agentEpoch     — the current agent-session generation.
 *   provenEpoch    — the generation in which a panel_* command was last received
 *                    (i.e. exposure was PROVEN), or null if never.
 *   disclosedEpoch — the generation this disclosure was last emitted in, or null.
 * @returns {{disclose:boolean, reason:"proven"|"already-disclosed"|"unestablished"|"epoch-unknown"}}
 */
export function planCanvasToolDisclosure({ agentEpoch, provenEpoch, disclosedEpoch } = {}) {
  // A non-finite epoch (missing / NaN — an uninitialized or corrupted stamp) makes
  // both scoped comparisons below meaningless: `null === null` and `NaN !== NaN`
  // would silently decide the question on garbage. We cannot scope the
  // once-per-session rule, so we do the harmless thing rather than the quiet one
  // and disclose. A disclosure the model does not need costs it one paragraph it is
  // explicitly told to ignore; a disclosure wrongly withheld is the #291 session,
  // where the model improvised and the user blamed the panel.
  if (!Number.isFinite(agentEpoch)) return { disclose: true, reason: "epoch-unknown" };

  // Both comparisons below are STRICT and are deliberately not paired with their
  // own finiteness guard. The early return above already establishes that
  // agentEpoch is a real number, so `undefined`, `null`, `NaN` and the string
  // "3" all fail `===` against it on their own; a second Number.isFinite() call
  // could not change any outcome, and a guard no test can distinguish is
  // decoration that later reads as protection. What DOES matter is that these
  // stay `===`: a loosened `==` would let the string "3" pass as proof.

  // PROVEN. A panel_* command reached this panel in THIS generation, so the model
  // demonstrably has the tools — asking it to check would be noise about a
  // question already answered. This is the only branch backed by evidence, and it
  // is evidence of PRESENCE; there is deliberately no "proven absent" branch,
  // because nothing observable from the panel would justify one.
  if (provenEpoch === agentEpoch) return { disclose: false, reason: "proven" };

  // ALREADY DISCLOSED in this generation — it is in the model's context for the
  // rest of the session. Repeating it every turn would train the model to skim
  // past the one paragraph that has to be read.
  if (disclosedEpoch === agentEpoch) return { disclose: false, reason: "already-disclosed" };

  // UNESTABLISHED — not "unavailable". We have no evidence either way, which is
  // exactly the state the disclosure is written for.
  return { disclose: true, reason: "unestablished" };
}
