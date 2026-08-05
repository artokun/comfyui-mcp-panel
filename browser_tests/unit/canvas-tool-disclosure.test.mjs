// Unit tests for the live-canvas tool disclosure (web/js/lib/canvas-tool-disclosure.js).
//
// #291: a Codex sidebar session received the panel system instructions but none of
// the panel_* live-graph tools — Codex silently dropped the whole panel MCP server
// once the headless comfyui surface saturated its tool budget. The model did not
// report the gap; it improvised a save_workflow fallback, and the user read that as
// the panel being broken.
//
// The panel cannot detect the gap (it gets no tool-use events and no toolset
// manifest), so these tests pin the two things it CAN be held to:
//
//   • it never asserts the tools are absent — the only evidence it has is positive,
//     and "no panel_* command yet" must stay UNESTABLISHED, not "unavailable";
//   • the text it sends actually tells the model to REFUSE the improvisations and
//     hands the user remedies they can act on.
//
// The reason is asserted alongside the boolean throughout: "do not disclose" is
// right for two entirely different states (proven present, already said), and a test
// that only checked the boolean would pass if they were confused for each other.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AGENT_SESSION_RESET_FRAMES,
  CANVAS_TOOL_DISCLOSURE,
  commandProvesExposure,
  planCanvasToolDisclosure,
  startsNewAgentSession,
} from "../../web/js/lib/canvas-tool-disclosure.js";
import { sendBridgeHello } from "../../web/js/lib/restart-tab-identity.js";

const panelPath = fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url));
const panelSource = () => readFileSync(panelPath, "utf8").replace(/\r\n/g, "\n");

test("a fresh session generation with no evidence discloses, as UNESTABLISHED", () => {
  const d = planCanvasToolDisclosure({ agentEpoch: 1, provenEpoch: null, disclosedEpoch: null });
  assert.equal(d.disclose, true);
  assert.equal(
    d.reason,
    "unestablished",
    "no evidence must be reported as unestablished — never as the tools being unavailable",
  );
});

test("a panel_* command in THIS generation proves exposure → no disclosure", () => {
  const d = planCanvasToolDisclosure({ agentEpoch: 4, provenEpoch: 4, disclosedEpoch: null });
  assert.equal(d.disclose, false);
  assert.equal(d.reason, "proven", "suppression here must be evidence, not the once-per-session rule");
});

test("proof from a PRIOR generation does not carry across a reconnect", () => {
  // sessionEpoch bumps on every orchestrator socket (re)connect, which may be a new
  // agent session with a different toolset — the previous generation's proof says
  // nothing about this one. A backend switch reconnects too, which is exactly the
  // Claude→Codex transition where #291 appears.
  const d = planCanvasToolDisclosure({ agentEpoch: 5, provenEpoch: 4, disclosedEpoch: null });
  assert.equal(d.disclose, true);
  assert.equal(d.reason, "unestablished");
});

test("already disclosed in this generation → silent, and for that reason specifically", () => {
  const d = planCanvasToolDisclosure({ agentEpoch: 2, provenEpoch: null, disclosedEpoch: 2 });
  assert.equal(d.disclose, false);
  assert.equal(d.reason, "already-disclosed");
});

test("a disclosure from a PRIOR generation is re-sent after a reconnect", () => {
  const d = planCanvasToolDisclosure({ agentEpoch: 3, provenEpoch: null, disclosedEpoch: 2 });
  assert.equal(d.disclose, true);
  assert.equal(d.reason, "unestablished");
});

test("proof outranks the once-per-session rule when both apply", () => {
  // Both suppress, but only one is backed by evidence. Reporting "already-disclosed"
  // here would hide the fact that the question is settled.
  const d = planCanvasToolDisclosure({ agentEpoch: 7, provenEpoch: 7, disclosedEpoch: 7 });
  assert.equal(d.disclose, false);
  assert.equal(d.reason, "proven");
});

test("an unusable session epoch discloses rather than deciding on garbage", () => {
  // Neither scoped comparison means anything without a real epoch: null === null and
  // NaN !== NaN would each answer the question by accident. Withholding is the
  // failure that produced #291, so the unknown case fails toward saying it.
  for (const agentEpoch of [undefined, null, NaN, "3"]) {
    const d = planCanvasToolDisclosure({ agentEpoch, provenEpoch: agentEpoch, disclosedEpoch: agentEpoch });
    assert.equal(d.disclose, true, `epoch ${String(agentEpoch)} must not suppress`);
    assert.equal(d.reason, "epoch-unknown");
  }
});

test("a non-finite proof stamp is not evidence", () => {
  // Guards the `provenEpoch === sessionEpoch` shortcut: without the finiteness check
  // an uninitialized stamp could compare equal to an equally broken epoch and claim
  // proof that no command ever provided.
  for (const provenEpoch of [undefined, null, NaN, "6"]) {
    const d = planCanvasToolDisclosure({ agentEpoch: 6, provenEpoch, disclosedEpoch: null });
    assert.equal(d.disclose, true, `proof stamp ${String(provenEpoch)} must not count as proof`);
    assert.equal(d.reason, "unestablished");
  }
});

test("a non-finite disclosure stamp does not suppress", () => {
  for (const disclosedEpoch of [undefined, null, NaN, "6"]) {
    const d = planCanvasToolDisclosure({ agentEpoch: 6, provenEpoch: null, disclosedEpoch });
    assert.equal(d.disclose, true, `disclosure stamp ${String(disclosedEpoch)} must not suppress`);
    assert.equal(d.reason, "unestablished");
  }
});

test("called with nothing at all, it discloses", () => {
  const d = planCanvasToolDisclosure();
  assert.equal(d.disclose, true);
  assert.equal(d.reason, "epoch-unknown");
});

test("a same-socket new/resumed chat is a new generation, not a continuation", () => {
  // Round 2 of the gate caught this: the scope was the SOCKET, but a toolset belongs
  // to the AGENT. /new, closing a thread, and opening a chat from history all send
  // new_session over the live socket, so a socket-scoped rule handed the previous
  // agent's proof and disclosure to a fresh model that received neither — exactly
  // the #291 session, reachable without ever reconnecting.
  assert.equal(startsNewAgentSession("new_session"), true);
  assert.equal(startsNewAgentSession("resume_session"), true, "a resume renegotiates the toolset too");
  // Round 4 of the gate: the per-workflow re-target hellos the LIVE socket with the
  // session key cleared, which spawns a clean agent outright — no new_session frame
  // is sent anywhere, so a list without `hello` left that agent inheriting its
  // predecessor's proof and disclosure.
  assert.equal(startsNewAgentSession("hello"), true, "a re-hello can spawn a clean agent on a live socket");
  for (const t of ["set_options", "agent_event", "interrupt", "user_message", "title", undefined, null]) {
    assert.equal(startsNewAgentSession(t), false, `${String(t)} must not reset the disclosure`);
  }
  assert.deepEqual(AGENT_SESSION_RESET_FRAMES, ["hello", "new_session", "resume_session"]);
});

test("a command answering THIS generation's own message is proof", () => {
  assert.equal(commandProvesExposure({ agentEpoch: 3, messagedEpoch: 3 }), true);
});

test("a command that arrives before this generation was ever prompted is NOT proof", () => {
  // Round 3 of the gate caught this: sendFrame advances the generation the instant
  // new_session goes out, but the socket is bidirectional and the OUTGOING agent's
  // panel_* command can already be in flight. Landing after the bump, it used to
  // vouch for a successor it has nothing to do with — and the fresh, possibly
  // toolless model then got no disclosure. #291, reached by ordinary timing.
  //
  // Exact, not a timing window: a command answers a TURN, and the new agent has had
  // none until we send it one.
  assert.equal(
    commandProvesExposure({ agentEpoch: 4, messagedEpoch: 3 }),
    false,
    "a straggler from the agent the user just replaced must not vouch for its successor",
  );
  assert.equal(
    commandProvesExposure({ agentEpoch: 1, messagedEpoch: null }),
    false,
    "nothing has been prompted yet, so nothing can be answering",
  );
});

test("proof needs a real generation, and the comparison stays strict", () => {
  for (const agentEpoch of [undefined, null, NaN, "3"]) {
    assert.equal(
      commandProvesExposure({ agentEpoch, messagedEpoch: agentEpoch }),
      false,
      `epoch ${String(agentEpoch)} must not manufacture proof by comparing equal to itself`,
    );
  }
  assert.equal(commandProvesExposure({ agentEpoch: 3, messagedEpoch: "3" }), false, "no loose ==");
  assert.equal(commandProvesExposure(), false);
});

test("the text asks about the toolset instead of asserting anything about it", () => {
  // The defect class this repo keeps hitting is "could not determine X" shipped as
  // "determined X is not the case". The panel genuinely cannot determine this, so
  // the text must not read as a verdict in EITHER direction.
  assert.match(
    CANVAS_TOOL_DISCLOSURE,
    /CANNOT observe whether they reached your toolset/,
    "must state the panel's own blindness as the reason it is asking",
  );
  assert.match(
    CANVAS_TOOL_DISCLOSURE,
    /a question, not a claim that anything is wrong/,
    "must disclaim that anything has been established",
  );
  assert.doesNotMatch(
    CANVAS_TOOL_DISCLOSURE,
    /you (?:do not|don't) have|are (?:not available|unavailable|missing)/i,
    "must never assert the tools are absent — the panel has no evidence of absence",
  );
});

test("the text names the tool the model should look for", () => {
  // "Check your tools" is unfalsifiable advice. It has to name one, and it has to be
  // a tool that actually exists — vendor/tool-vocabulary.json is the ledger and
  // scripts/check-tool-vocabulary.mjs enforces it against this file too.
  assert.match(CANVAS_TOOL_DISCLOSURE, /panel_graph_outline/);
});

test("a LISTED tool is not treated as a working one", () => {
  // "Listed, therefore fine" is the same defect as "unlisted, therefore impossible",
  // running the other way — and it is the direction the settled rules call out
  // explicitly: a tool that appears and then fails is worse than one never listed.
  // So the present branch must not be a free pass; a FAILED panel_* call has to
  // surface, not quietly become a headless workaround.
  assert.match(CANVAS_TOOL_DISCLOSURE, /being listed is not proof the canvas is reachable/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /if a panel_\* call then FAILS, report that failure/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /do NOT quietly substitute a headless workaround for it/);
});

test("the text does not claim a transport it cannot claim for every backend", () => {
  // It is sent to EVERY backend. Claude receives panel_* from an in-process SDK MCP
  // server; only the non-Claude lane uses the orchestrator's loopback HTTP MCP. An
  // earlier draft told all of them "over a separate MCP connection", which is false
  // agent-facing operational detail — and the model does not need it either way.
  assert.doesNotMatch(CANVAS_TOOL_DISCLOSURE, /separate MCP connection|loopback|HTTP MCP/i);
  assert.match(CANVAS_TOOL_DISCLOSURE, /supplied to you by the panel's orchestrator/);
});

test("the text refuses the specific improvisations #291 produced", () => {
  // The reporter's session fell back to save_workflow and the user could not tell
  // that anything had failed. A bare "say if you can't" does not cover it: each of
  // these is a plausible-looking action on its own.
  assert.match(CANVAS_TOOL_DISCLOSURE, /saving a workflow file/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /generate_image\/enqueue_workflow/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /never\s+describe graph edits you did not make/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /Say plainly that this session did not receive the live-canvas tools/);
});

test("the remedies are actionable from where the user already is, and are distinct", () => {
  // One "not available" sentence covering several faults is a bucket narrated as a
  // cause. These are three different faults with three different fixes: a crowded
  // tool budget, a deliberate full-surface override, and a session to rebuild.
  assert.match(CANVAS_TOOL_DISCLOSURE, /update comfyui-mcp/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /COMFYUI_MCP_TOOL_MODE=full/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /\/restart/);
  assert.match(CANVAS_TOOL_DISCLOSURE, /switch this chat to the Claude backend/);
});

test("the text ends with a blank line so it cannot run into the user's message", () => {
  // It is PREPENDED to the turn text. Without the separator the user's first words
  // continue the disclosure's last sentence.
  assert.ok(CANVAS_TOOL_DISCLOSURE.endsWith("\n\n"));
});

// ---------------------------------------------------------------------------
// Wiring. The module above is pure and fully covered, but a correct decision that
// nothing calls is worth nothing — and the panel's send path and bridge callbacks
// live inside a 23k-line browser module with no DOM-free entry point. These read
// the source the way pi-readiness-ordering.test.mjs does, and pin the three joints
// where this fix can silently come apart. The browser BEHAVIOUR (that the model
// actually receives the paragraph) is only confirmable in a live session.
// ---------------------------------------------------------------------------

test("wiring: a received command frame stamps proof for the CURRENT generation", () => {
  const source = panelSource();
  const start = source.indexOf("    onCommandReceived() {");
  const end = source.indexOf("    onCommand(cmd, msg, reply) {", start);
  assert.ok(start >= 0 && end > start, "could not locate the onCommandReceived bridge callback");
  const handler = source.slice(start, end);
  assert.match(
    handler,
    /canvasToolsProvenEpoch = agentSessionEpoch/,
    "the only evidence the panel has must be recorded where every command frame lands",
  );
  assert.match(
    handler,
    /if \(commandProvesExposure\(\{ agentEpoch: agentSessionEpoch, messagedEpoch: canvasToolMessagedEpoch \}\)\)/,
    "and must be gated — an unconditional stamp lets a replaced agent's straggler vouch for its successor",
  );
});

test("wiring: a generation is marked prompted only after its message reached the wire", () => {
  // The gate above is only as good as this stamp. Set before the send, a message
  // that threw would still mark the generation prompted, and the very next straggler
  // would count as proof — reopening the round-3 hole.
  const body = sendUserMessageBody(panelSource());
  const send = body.indexOf("sock.send(");
  const stamp = body.indexOf("canvasToolMessagedEpoch = agentSessionEpoch");
  assert.ok(send >= 0 && stamp > send, "the prompted stamp must follow the send");
});

test("wiring: proof is stamped on RECEIPT, not on a successful command", () => {
  // onCommand runs only for non-silent commands and has the reply in hand, so
  // stamping there would miss silent commands and could be narrowed to reply.ok —
  // and a tool that ERRORS is still a tool the model was given.
  const source = panelSource();
  const start = source.indexOf("    onCommand(cmd, msg, reply) {");
  const end = source.indexOf("onAgentStatus(s) {", start);
  assert.ok(start >= 0 && end > start, "could not locate the onCommand bridge callback");
  assert.doesNotMatch(source.slice(start, end), /canvasToolsProvenEpoch/);
});

/** The bridge client's sendUserMessage — the single frame-emitting choke point. */
function sendUserMessageBody(source) {
  const start = source.indexOf("    sendUserMessage(text, context, images, mid) {");
  const end = source.indexOf("    /** Send an arbitrary control frame", start);
  assert.ok(start >= 0 && end > start, "could not locate sendUserMessage");
  return source.slice(start, end);
}

test("wiring: the disclosure rides on the WIRE frame, not on the composer", () => {
  // Round 1 of the gate caught this: assembling it in the composer covered typed
  // messages only. The post-restart and soft-reload RESUME nudges call
  // sendUserMessage directly, on a brand-new socket — a fresh generation whose
  // toolset is precisely what is in question — and they instruct the agent to
  // "continue exactly what you were doing", which is the instruction a toolless
  // model improvises around. Those turns must carry the disclosure too.
  const body = sendUserMessageBody(panelSource());
  assert.match(
    body,
    /planCanvasToolDisclosure\(\{\s*agentEpoch: agentSessionEpoch,\s*provenEpoch: canvasToolsProvenEpoch,\s*disclosedEpoch: canvasToolDisclosedEpoch,\s*\}\)/,
    "the decision must be delegated to the tested module, with the real epochs",
  );
  assert.match(
    body,
    /const disclosed = disclosure\.disclose && typeof text === "string";/,
    "the module's verdict must actually gate the prepend — a constant here silently disables the fix",
  );
  assert.match(
    body,
    /CANVAS_TOOL_DISCLOSURE \+ text/,
    "the disclosure must be PREPENDED — appended after the message it reads as commentary",
  );
  assert.match(body, /text: outText/, "the frame must carry the disclosed text, not the original");
});

test("wiring: the composer no longer assembles the disclosure itself", () => {
  // Two prepend sites would double it on every typed message. Asserting the
  // absence of the old form, not merely the presence of the new one.
  const source = panelSource();
  const start = source.indexOf("    const changeBanner = manualChangeBanner();");
  const end = source.indexOf("    // Track delivery:", start);
  assert.ok(start >= 0 && end > start, "could not locate the composer's agent-facing text assembly");
  assert.doesNotMatch(source.slice(start, end), /CANVAS_TOOL_DISCLOSURE/);
});

test("wiring: every user_message path goes through the one choke point", () => {
  // The guarantee above holds only while sendUserMessage is the sole emitter of a
  // user_message frame. A second one would be a silent hole.
  // Comment lines are excluded by content, not by position: the wire-protocol
  // header at the top of the file documents the frame and would otherwise count.
  const emitters = panelSource()
    .split("\n")
    .filter((l) => l.includes('type: "user_message"') && !l.trim().startsWith("//"));
  assert.deepEqual(emitters.map((l) => l.trim()), ['type: "user_message",'],
    "a second user_message emitter would bypass the disclosure");
});

test("wiring: the disclosure is marked sent only AFTER the frame actually went out", () => {
  // Rule: every guard is itself an operation that can fail. sock.send() throws on a
  // socket that closed after the readyState check, and stamping first would spend
  // this generation's one disclosure on a frame that never left.
  const body = sendUserMessageBody(panelSource());
  const send = body.indexOf("sock.send(");
  const stamp = body.indexOf("canvasToolDisclosedEpoch = agentSessionEpoch");
  assert.ok(send >= 0 && stamp > send, "the stamp must follow the send, not precede it");
  assert.match(
    body,
    /if \(disclosed\) canvasToolDisclosedEpoch = agentSessionEpoch/,
    "and must be conditional on having actually disclosed",
  );
});

test("sendBridgeHello reports whether the hello reached the wire — the contract the epoch rides on", async () => {
  // Executable, because the panel's generation advance is now gated on this return
  // value. If it ever became void, the panel would stop advancing the generation
  // ENTIRELY and silently — the original #291 direction — and a purely static
  // wiring test would still be green.
  const sent = [];
  const socket = { send: (s) => sent.push(s) };
  const ok = await sendBridgeHello({
    socket,
    isCurrent: () => true,
    resolveTabIdentity: async () => "tab-1",
    makePayload: (id) => ({ type: "hello", tabSessionId: id }),
  });
  assert.equal(ok, true, "a hello that was written to the socket must report true");
  assert.equal(sent.length, 1);

  const superseded = await sendBridgeHello({
    socket,
    isCurrent: () => false, // this socket was replaced while identity resolved
    resolveTabIdentity: async () => "tab-2",
    makePayload: (id) => ({ type: "hello", tabSessionId: id }),
  });
  assert.equal(superseded, false, "a hello abandoned mid-flight must report false");
  assert.equal(sent.length, 1, "and must not have written anything");
});

test("the README does not promise parity it cannot guarantee — anywhere in the file", () => {
  // Normally prose is not worth a test. This is, because the claim is the reason
  // #291 stayed invisible: "both providers expose this identical surface … feature
  // parity is automatic" told every reader there was nothing to check. The first
  // retraction fixed the body and left the SAME claim standing in the introduction,
  // which a reader hits first — so the file contradicted itself and the retraction
  // was largely undone. Scanning the whole file is what catches that.
  //
  // CHANGELOG.md is deliberately NOT scanned. It records what was claimed at the
  // time of each release, and rewriting that is falsifying history, not correcting
  // a claim — the same reason the repo's tool-vocabulary gate exempts it.
  const readme = readFileSync(
    fileURLToPath(new URL("../../README.md", import.meta.url)),
    "utf8",
  );
  for (const claim of ["full feature parity", "feature parity is automatic", "identical surface"]) {
    assert.equal(
      readme.includes(claim),
      false,
      `README still promises "${claim}" — parity is offered, not guaranteed received`,
    );
  }
  // …and the qualification is actually there, not merely the absence of the boast.
  assert.match(readme, /Offered, not guaranteed received/);
  assert.match(readme, /identical \*\*as served\*\*/);
});

/** The whole body of the bridge client's sendHello(). */
function sendHelloBody(source) {
  const start = source.indexOf("  function sendHello() {");
  const end = source.indexOf("  // When the workflow title changes", start);
  assert.ok(start >= 0 && end > start, "could not locate sendHello");
  return source.slice(start, end);
}

test("wiring: the generation advances only once the hello is ON THE WIRE", () => {
  // The independent gate's P0. Advancing before `sendBridgeHello` resolves means a
  // hello that never reached the orchestrator — identity still resolving when the
  // socket was superseded or closed — still burned a generation. Nothing new was
  // bound, so the consequence is the INVERSE of #291: a working agent's proof is
  // invalidated and a session that demonstrably had the tools is asked whether it
  // does. Same rule as #621 and #836: do not record that you did something before
  // you did it.
  const body = sendHelloBody(panelSource());
  // The guard, whichever form it takes (`if (sent) …` on one line, or a block that
  // also publishes what the hello advertised — #607). What matters is that the
  // advance is INSIDE it and after the send, not the punctuation.
  const guard = body.search(/if \(sent\)[ ]*\{?/);
  assert.notEqual(guard, -1, "the advance must be conditional on the hello having actually been sent");
  const call = body.indexOf("sendBridgeHello({");
  const bump = body.indexOf("agentSessionEpoch++");
  assert.ok(call >= 0 && bump > call, "the advance must FOLLOW the send, not precede it");
  assert.ok(bump > guard, "the advance must sit INSIDE the sent-guard, not beside it");
  // …and there must be no second, unconditional one left behind in front of it.
  assert.equal(
    (body.match(/agentSessionEpoch\+\+/g) ?? []).length,
    1,
    "exactly one advance — a stray eager one would reintroduce the P0",
  );
});

test("wiring: the socket-open path still reaches the hello that advances the generation", () => {
  // The explicit bump that used to sit in the open handler was removed in favour of
  // sendHello's. That is only sound while the open handler actually calls it.
  const source = panelSource();
  const openStart = source.indexOf('    thisSock.addEventListener("open", () => {');
  const openEnd = source.indexOf("      clearHandshake();", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart, "could not locate the socket open handler");
  const open = source.slice(openStart, openEnd);
  assert.match(open, /sendHello\(\);/);
  assert.doesNotMatch(open, /agentSessionEpoch/, "the open handler must not advance it a second time");
});

test("wiring: a same-socket session reset frame advances the generation, after it is sent", () => {
  // Decided by the module's list rather than by a condition rewritten at the call
  // site, so adding a session-starting frame is an edit to one list.
  const source = panelSource();
  const frameStart = source.indexOf("    sendFrame(frame) {");
  const frameEnd = source.indexOf("    sendCancel(", frameStart) >= 0
    ? source.indexOf("    sendCancel(", frameStart)
    : frameStart + 3000;
  const body = source.slice(frameStart, frameEnd);
  assert.match(body, /if \(startsNewAgentSession\(frame\?\.type\)\) agentSessionEpoch\+\+/);
  const send = body.indexOf("sock.send(");
  assert.ok(body.indexOf("startsNewAgentSession") > send, "reset only after the frame actually went out");
});

test("wiring: the disclosure is scoped to the AGENT epoch, never the socket epoch", () => {
  // sessionEpoch (the socket binding, #369) does not move on a same-socket
  // new_session, so reading it here would silently reintroduce the round-2 hole.
  const source = panelSource();
  for (const name of ["canvasToolsProvenEpoch", "canvasToolDisclosedEpoch"]) {
    // Every ASSIGNMENT, excluding the `let … = null` declaration, which is the
    // initial state rather than a stamp.
    const stamps = [...source.matchAll(new RegExp(`(let )?\\b${name} = (\\w+)`, "g"))]
      .filter((m) => !m[1])
      .map((m) => m[2]);
    assert.ok(stamps.length, `could not find any assignment to ${name}`);
    assert.deepEqual(
      [...new Set(stamps)],
      ["agentSessionEpoch"],
      `${name} must be stamped only with the agent epoch, not ${stamps.join("/")}`,
    );
  }
});

test("wiring: the panel's import edge names every binding it uses (module-link P0)", () => {
  // The named imports at the top of THIS file are the link check for the module's
  // exports — if one were missing, this file would fail to link and node --test
  // would say so. That does not cover the PANEL's own import statement: a binding
  // used in comfyui-mcp-panel.js but absent from its import list is a ReferenceError
  // at panel load, which `node --check` cannot see and which takes down the whole
  // sidebar (see module-graph-link.test.mjs for the same P0 in another edge).
  const source = panelSource();
  const stmt = source.match(/import \{([^}]*)\} from "\.\/lib\/canvas-tool-disclosure\.js";/);
  assert.ok(stmt, "the panel must import from lib/canvas-tool-disclosure.js");
  const imported = new Set(stmt[1].split(",").map((s) => s.trim()).filter(Boolean));
  const body = source.slice(stmt.index + stmt[0].length);
  for (const name of ["CANVAS_TOOL_DISCLOSURE", "commandProvesExposure", "planCanvasToolDisclosure", "startsNewAgentSession"]) {
    if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(body))
      assert.ok(imported.has(name), `${name} is used in the panel but not imported`);
  }
});

test("wiring: the panel never decides this itself", () => {
  // The whole point is that the panel cannot see the toolset. If it ever grows its
  // own branch on these epochs, the decision has escaped the module that documents
  // why "no command yet" is not "no tools".
  const source = panelSource();
  const decisions = source.match(/canvasToolsProvenEpoch\s*(?:===|!==|==|!=|<|>)/g) ?? [];
  assert.deepEqual(decisions, [], "exposure must be judged only in lib/canvas-tool-disclosure.js");
});
