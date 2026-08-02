// Unit tests for web/js/lib/command-liveness.js — run with `node --test`.
//
// #508: the sidebar chat stayed CONNECTED and accepted the user's request, yet EVERY
// frontend command timed out with no reply from the registered tab — set_todo (5000 ms),
// graph_outline (6000 ms), workflow_list (6000 ms) — while the orchestrator kept
// targeting the same wf: id. A row of identical timeouts, forever.
//
// The load-bearing invariants locked here:
//   * a command frame ALWAYS produces a reply attempt on the socket it arrived on, and
//     no host callback can suppress it (the pre-reply throw, and the superseded-socket
//     early return, were both silent no-reply paths);
//   * an undelivered reply is journaled with its ACTUAL cause and replayed, rather than
//     leaving the caller with the orchestrator's guess that the tab is "frozen";
//   * self-heal re-registration is BOUNDED, and it can only ever re-advertise THIS tab's
//     own current identity — retargeting to a different workflow's tab is corruption
//     class and strictly worse than staying wedged.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  LOST_REPLY_CAP,
  RE_REGISTER_MAX,
  RE_REGISTER_WINDOW_MS,
  classifyUndeliveredReply,
  describeUndeliveredReply,
  createLostReplyJournal,
  isReplayable,
  REPLAY_MAX_AGE_MS,
  SENSITIVE_RESULT_CMDS,
  redactSensitiveReply,
  pruneAttempts,
  shouldReRegister,
  reRegisterExhaustedHint,
} from "../../web/js/lib/command-liveness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

// --- honest cause reporting ----------------------------------------------

test("#508: the cause is REPORTED, not guessed", () => {
  assert.equal(classifyUndeliveredReply({ socketOpen: false }), "socket_closed");
  assert.equal(classifyUndeliveredReply({ socketOpen: false, superseded: true }), "socket_superseded");
  assert.equal(classifyUndeliveredReply({ socketOpen: true, sendThrew: true }), "send_failed");
  assert.equal(classifyUndeliveredReply({ socketOpen: true }), null, "a healthy write has nothing to report");
});

test("#508: the user-facing line separates 'the command ran' from 'the reply was lost'", () => {
  const line = describeUndeliveredReply({ cmd: "workflow_open", ok: true, reason: "socket_closed" });
  assert.match(line, /completed "workflow_open"/);
  assert.match(line, /unknown outcome, not as a failure to act/);
  const superseded = describeUndeliveredReply({ cmd: "graph_outline", ok: true, reason: "socket_superseded" });
  assert.match(superseded, /replaced mid-command/);
  assert.equal(describeUndeliveredReply(null), "");
});

// --- the journal ----------------------------------------------------------

test("the lost-reply journal is bounded, keeps the newest, and drains exactly once", () => {
  const j = createLostReplyJournal();
  for (let i = 0; i < LOST_REPLY_CAP + 4; i++) {
    j.record({ reply: { rid: `r${i}`, ok: true, result: {} }, cmd: "graph_outline", at: i });
  }
  assert.equal(j.size(), LOST_REPLY_CAP);
  assert.equal(j.list()[j.size() - 1].rid, `r${LOST_REPLY_CAP + 3}`);
  assert.equal(j.drain().length, LOST_REPLY_CAP);
  assert.equal(j.size(), 0, "a drained journal must not replay again");
});

test("the journal keeps the EXACT reply frame (replayable verbatim) but omits it from summaries", () => {
  const j = createLostReplyJournal();
  const reply = { rid: "abc", ok: true, result: { opened: { path: "x.json" } } };
  j.record({ reply, cmd: "workflow_open", reason: "socket_closed", at: 7 });
  assert.deepEqual(j.list()[0].reply, reply, "the frame must survive intact for a verbatim replay");
  assert.deepEqual(j.summaries(), [{ rid: "abc", cmd: "workflow_open", ok: true, reason: "socket_closed", at: 7 }]);
});

test("codex R8: a SENSITIVE result is never journaled in the clear (it must not survive to a replay)", () => {
  // request_secret's result IS the pasted secret; ask_user's is whatever the user typed.
  // A journaled raw frame is replayed on whatever socket is current later — which can be a
  // DIFFERENT orchestrator after a backend switch — so the payload must not be kept at all.
  for (const cmd of ["request_secret", "ask_user"]) {
    assert.ok(SENSITIVE_RESULT_CMDS.has(cmd), `${cmd} must be classified sensitive`);
    const j = createLostReplyJournal();
    const entry = j.record({
      reply: { rid: "r1", ok: true, result: "sk-live-SUPERSECRET" },
      cmd,
      at: 1,
      url: "ws://127.0.0.1:9180",
    });
    assert.equal(entry.redacted, true);
    assert.equal(entry.ok, false, "a redacted entry must not advertise a success it will not deliver");
    assert.equal(
      JSON.stringify(j.list()).includes("SUPERSECRET"),
      false,
      "the secret must not exist anywhere in the journal",
    );
    assert.match(entry.reply.error, /ask again on the current connection/);
    assert.equal(entry.reply.rid, "r1", "the refusal must still correlate to the command");
  }
});

test("codex R8: a NON-sensitive result is journaled verbatim so it can be replayed as-is", () => {
  const j = createLostReplyJournal();
  const reply = { rid: "r2", ok: true, result: { opened: { path: "x.json" } } };
  const entry = j.record({ reply, cmd: "workflow_open", at: 1, url: "ws://127.0.0.1:9180" });
  assert.equal(entry.redacted, false);
  assert.deepEqual(entry.reply, reply);
  assert.equal(entry.ok, true);
  assert.equal(entry.url, "ws://127.0.0.1:9180", "the owning bridge must be stamped on the entry");
  assert.equal(redactSensitiveReply(reply, "workflow_open"), reply, "pass-through must be identity");
});

test("codex R8: replay never crosses a bridge change — entries for another bridge are DROPPED", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf("function replayLostReplies(target) {");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n  }", start));
  assert.match(
    body,
    /if \(!isReplayable\(entry, \{ now: Date\.now\(\), targetUrl \}\)\) \{\s*\n\s*dropped\+\+;\s*\n\s*continue;/,
    "an outcome belonging to a previous bridge (or too old) must never be volunteered",
  );
  assert.match(body, /lostReplies\.replace\(keep\)/, "only undeliverable-but-still-ours entries are retried");
  assert.match(body, /Discarded \$\{dropped\}/, "the user must be told what was discarded");
  // codex R9 — the comparison must use the SOCKET's own bridge, not the mutable current
  // `url`: setUrl swaps `url` before the old socket closes, so a command finishing on the
  // retired socket would otherwise be stamped with (and compared against) the NEW bridge.
  assert.match(body, /const targetUrl = target\?\.__cmcpBridgeUrl \?\? url;/);
  assert.match(src, /const socketUrl = url;/, "each socket must capture the url it dialed");
  assert.match(src, /thisSock = new WebSocket\(socketUrl\)/, "…and dial exactly that url");
  assert.match(src, /thisSock\.__cmcpBridgeUrl = socketUrl;/, "…and carry it for the replay check");
  assert.match(src, /url: socketUrl,/, "the journal must stamp THIS socket's bridge, not the current one");
  assert.equal(
    /at: Date\.now\(\),\s*\n(?:\s*\/\/[^\n]*\n)*\s*url,\s*\n/.test(src),
    false,
    "the mutable current url must not be what gets journaled",
  );
});

test("codex R10: isReplayable demands the SAME bridge and a recent entry, and fails closed", () => {
  const URL_A = "ws://127.0.0.1:9180";
  const now = 1_000_000;
  const fresh = { url: URL_A, at: now - 1000 };
  assert.equal(isReplayable(fresh, { now, targetUrl: URL_A }), true);
  // Different endpoint — never volunteered.
  assert.equal(isReplayable(fresh, { now, targetUrl: "ws://127.0.0.1:9181" }), false);
  // Unattributable entries are refused rather than guessed at.
  assert.equal(isReplayable({ at: now }, { now, targetUrl: URL_A }), false, "no recorded bridge ⇒ refuse");
  assert.equal(isReplayable(fresh, { now }), false, "no target bridge ⇒ refuse");
  assert.equal(isReplayable(null, { now, targetUrl: URL_A }), false);
  // Age bound: a real drop-and-reconnect takes seconds; anything older is very likely a
  // different orchestrator that happens to share the address.
  assert.equal(isReplayable({ url: URL_A, at: now - REPLAY_MAX_AGE_MS - 1 }, { now, targetUrl: URL_A }), false);
  assert.equal(isReplayable({ url: URL_A, at: now - REPLAY_MAX_AGE_MS }, { now, targetUrl: URL_A }), true);
  // A negative age (clock moved) fails closed rather than replaying.
  assert.equal(isReplayable({ url: URL_A, at: now + 5000 }, { now, targetUrl: URL_A }), false);
  assert.equal(isReplayable({ url: URL_A, at: NaN }, { now, targetUrl: URL_A }), false);
});

test("codex R11: hello summaries obey the SAME cross-bridge/age rule as the replay", () => {
  // The summaries ride the hello, so an unfiltered list would tell a bridge that never
  // owned these commands their ids, names and outcomes — even though replayLostReplies
  // correctly withholds the replies themselves.
  const j = createLostReplyJournal();
  const now = 1_000_000;
  j.record({ reply: { rid: "mine", ok: true }, cmd: "graph_outline", at: now - 1000, url: "ws://a" });
  j.record({ reply: { rid: "theirs", ok: true }, cmd: "graph_outline", at: now - 1000, url: "ws://b" });
  j.record({ reply: { rid: "ancient", ok: true }, cmd: "graph_outline", at: now - REPLAY_MAX_AGE_MS - 1, url: "ws://a" });
  assert.deepEqual(
    j.summaries({ now, targetUrl: "ws://a" }).map((e) => e.rid),
    ["mine"],
    "only this bridge's recent outcomes may be advertised",
  );
  // No target ⇒ unfiltered (the journal's own bookkeeping view).
  assert.equal(j.summaries().length, 3);

  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(
    src,
    /lostReplies\.summaries\(\{\s*\n\s*now: Date\.now\(\),\s*\n\s*targetUrl: sock\?\.__cmcpBridgeUrl \?\? url,\s*\n\s*\}\)/,
    "sendHello must filter the summaries by THIS socket's bridge",
  );
});

test("codex R12: replay only ever writes to a socket that PROVED itself with a handshake", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf("function replayLostReplies(target) {");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n  }", start));
  // An OPEN socket only proves something is bound to the port — it can be a different
  // orchestrator session at the same URL, or a non-orchestrator listener, and it can be
  // open before its `models` frame arrives. The check lives in the function (not only at
  // the call sites) so no caller can bypass it.
  assert.match(
    body,
    /if \(!target \|\| target !== handshakenSock \|\| target\.readyState !== WebSocket\.OPEN\) return;/,
    "replay must require the handshaken socket INSTANCE",
  );
  const gateAt = body.indexOf("target !== handshakenSock");
  const sendAt = body.indexOf("target.send(");
  assert.ok(gateAt !== -1 && sendAt !== -1 && gateAt < sendAt, "the gate must precede any write");
  // Identity, not a boolean: a replacement socket is a different object, which is what
  // closes the "open but not yet handshaken" race.
  assert.match(src, /handshakenSock = sock;/, "markConnected must record the proven instance");
  const markConnected = src.slice(src.indexOf("function markConnected() {"));
  const recordAt = markConnected.indexOf("handshakenSock = sock;");
  const replayAt = markConnected.indexOf("replayLostReplies(sock);");
  assert.ok(recordAt !== -1 && replayAt !== -1 && recordAt < replayAt, "record the instance, then replay");
  // Dropping the socket must forget it too.
  assert.ok(
    (src.match(/handshakenSock = null;/g) || []).length >= 3,
    "setUrl/stop/destroy must all forget the proven socket",
  );
});

test("codex R11: the tracker re-baseline aborts if exclusivity was lost across its own frame", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf("async function clearSpuriousOpenModified(wf");
  assert.notEqual(start, -1);
  const body = src.slice(start, start + 1400);
  const frameAt = body.indexOf("await nextFrame();");
  const guardAt = body.indexOf('if (typeof stillOwns === "function" && !stillOwns()) return;');
  const captureAt = body.indexOf("captureCanvasState");
  assert.ok(frameAt !== -1 && guardAt !== -1 && captureAt !== -1);
  // Checking before the await is not enough — the frame IS the gap in which an edit lands.
  assert.ok(frameAt < guardAt && guardAt < captureAt, "the ownership check must sit AFTER the frame");
});

test("the journal's replace() keeps only what it is given, still bounded", () => {
  const j = createLostReplyJournal({ cap: 3 });
  for (let i = 0; i < 3; i++) j.record({ reply: { rid: `r${i}`, ok: true }, cmd: "graph_outline" });
  const kept = j.list().slice(0, 1);
  assert.equal(j.replace(kept), 1);
  assert.equal(j.size(), 1);
  assert.equal(j.list()[0].rid, "r0");
  assert.equal(j.replace(null), 0, "a non-array clears the journal rather than corrupting it");
});

test("the journal refuses a frame with no rid (nothing could ever correlate it)", () => {
  const j = createLostReplyJournal();
  assert.equal(j.record({ reply: { ok: true }, cmd: "x" }), null);
  assert.equal(j.record({ cmd: "x" }), null);
  assert.equal(j.size(), 0);
});

// --- bounded self-heal ----------------------------------------------------

test("#508: self-heal is BOUNDED — never a re-registration storm", () => {
  const now = 100000;
  const base = { socketOpen: true, lostCount: 1, now };
  assert.equal(shouldReRegister({ ...base, attempts: [] }), true);
  const spent = Array.from({ length: RE_REGISTER_MAX }, (_, i) => now - i * 100);
  assert.equal(shouldReRegister({ ...base, attempts: spent }), false, "budget spent inside the window");
  // …and the budget REFRESHES once the window has rolled past.
  const old = spent.map((t) => t - RE_REGISTER_WINDOW_MS - 1);
  assert.equal(shouldReRegister({ ...base, attempts: old }), true);
});

test("#508: no live socket ⇒ no re-registration (the reconnect path owns that recovery)", () => {
  assert.equal(shouldReRegister({ socketOpen: false, lostCount: 3, attempts: [], now: 1 }), false);
});

test("#508: nothing lost ⇒ no re-registration (never hello on speculation)", () => {
  assert.equal(shouldReRegister({ socketOpen: true, lostCount: 0, attempts: [], now: 1 }), false);
});

test("pruneAttempts drops only entries outside the window and never mutates the input", () => {
  const now = 50000;
  const input = [now - 1, now - RE_REGISTER_WINDOW_MS - 1, now - 10];
  const out = pruneAttempts(input, now);
  assert.deepEqual(out, [now - 1, now - 10]);
  assert.equal(input.length, 3, "input must be untouched");
  assert.deepEqual(pruneAttempts(null, now), []);
});

test("#508: the exhausted hint is an ACTIONABLE instruction, not another timeout", () => {
  const hint = reRegisterExhaustedHint();
  assert.match(hint, /Reconnect/);
  assert.match(hint, /reload the ComfyUI page/);
});

// --- wiring contract in the panel -----------------------------------------

test("#508 wiring: the turn-activity host callback can no longer suppress a reply", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const at = src.indexOf("onCommandReceived?.();");
  assert.notEqual(at, -1, "the command handler must still mark turn activity");
  // It must sit inside its OWN try, so a throw is contained rather than aborting the
  // async listener before the reply is ever built.
  const before = src.slice(Math.max(0, at - 200), at);
  assert.match(before, /try \{\s*$/, "onCommandReceived must be wrapped in its own try");
  const after = src.slice(at, at + 260);
  assert.match(after, /catch \(err\) \{[\s\S]*onCommandReceived threw/, "the throw must be caught and logged, not swallowed silently");
});

test("#508 wiring: a SUPERSEDED socket still gets its reply — only the UI continuation is dropped", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const supersededAt = src.indexOf("const superseded = !isActive();");
  assert.notEqual(supersededAt, -1, "the instance guard must be captured, not used as an early return");
  const block = src.slice(supersededAt, supersededAt + 1200);
  const sendAt = block.indexOf("deliverReply(reply, msg.cmd, superseded)");
  const gateAt = block.indexOf("if (superseded) return;");
  assert.notEqual(sendAt, -1, "the reply must still be written to the socket it arrived on");
  assert.notEqual(gateAt, -1, "the UI continuation must still be gated on the instance guard");
  assert.ok(sendAt < gateAt, "the reply must be sent BEFORE the superseded early return");
  // And the pre-#508 shape (returning before the reply) must not come back.
  assert.equal(
    /if \(!isActive\(\)\) return;\s*\n\s*try \{\s*\n\s*if \(thisSock\.readyState/.test(src),
    false,
    "the superseded early-return must not precede the reply write again",
  );
});

test("#508 codex R3: a command arriving on an ALREADY-superseded socket is refused, never dropped", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // The listener must PARSE first: returning before parsing discards a queued command
  // frame outright — neither executed, nor replied to, nor journaled — which is the very
  // "registered tab that never acknowledges anything" wedge this change exists to remove.
  const listenerAt = src.indexOf('thisSock.addEventListener("message"');
  const listener = src.slice(listenerAt, listenerAt + 3000);
  const parseAt = listener.indexOf("msg = JSON.parse(");
  const guardAt = listener.indexOf("if (!isActive()) {");
  assert.ok(parseAt !== -1 && guardAt !== -1, "the listener must parse before the instance guard");
  assert.ok(parseAt < guardAt, "the frame must be parsed BEFORE the superseded early return");
  // …and the refusal must be rid-correlated, explicitly NOT-APPLIED, and delivered/journaled.
  const guarded = listener.slice(guardAt, guardAt + 1600);
  assert.match(guarded, /if \(isCommandFrame\) \{/, "only command frames get a refusal");
  assert.match(guarded, /rid: msg\.rid/, "the refusal must correlate to the command");
  assert.match(guarded, /ok: false/, "a stale command is refused, never reported as done");
  assert.match(guarded, /NOTHING was applied/, "the refusal must say it is safe to re-issue");
  assert.match(guarded, /deliverReply\(/, "the refusal goes through the same deliver+journal path");
  // The stale command must NOT be executed.
  assert.equal(/GRAPH_TOOL_EXECUTORS/.test(guarded), false, "a superseded socket must never execute");
});

test("#508 wiring: an undelivered reply is journaled, replayed after hello, and self-heals boundedly", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /lostReplies\.record\(\{/, "an undelivered reply must be journaled");
  assert.match(src, /handleUndeliveredReply\(/, "…and routed to the bounded self-heal");
  assert.match(src, /shouldReRegister\(\{/, "self-heal must consult the bounded decision");
  // codex R10 — replay must fire on the real HANDSHAKE, not at bare socket-open: an open
  // socket only proves something is listening on the port, while the `models` frame proves
  // a real orchestrator is behind it. The hello already went out at open.
  const openHandler = src.slice(src.indexOf('thisSock.addEventListener("open"'));
  assert.match(openHandler.slice(0, 2000), /sendHello\(\);/, "the hello still rides socket-open");
  assert.equal(
    /replayLostReplies\(thisSock\);/.test(src),
    false,
    "replay must not fire at bare socket-open",
  );
  const markConnected = src.slice(src.indexOf("function markConnected() {"));
  assert.match(markConnected.slice(0, 1600), /replayLostReplies\(sock\);/, "replay rides the handshake");
});

test("#508 codex R6: an outcome journaled AFTER the replacement socket replayed is delivered anyway", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf("function handleUndeliveredReply(entry) {");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n  }", start));
  // The replacement socket replays ONCE, at open. A long command still running on the
  // retired socket finishes after that, so the journal was empty when the replay fired —
  // without this the entry would wait for a reconnect that may never come.
  assert.match(body, /replayLostReplies\(sock\);/, "a live socket must receive the outcome immediately");
  // …and it must NOT be gated on the re-registration budget: telling the truth is not a retry.
  const replayAt = body.indexOf("replayLostReplies(sock);");
  const elseAt = body.indexOf("} else {");
  assert.ok(elseAt !== -1 && replayAt > body.indexOf("reRegisterExhaustedHint()"), "replay must follow both branches");
  assert.equal(
    /\} else \{[\s\S]*replayLostReplies\(sock\);[\s\S]*\}\s*$/.test(body),
    false,
    "replay must sit outside the budget branches, not inside one",
  );
});

test("#508 wiring: replay keeps what it could not send, so a partial replay is retried not lost", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf("function replayLostReplies(target) {");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n  }", start));
  // An entry that could not be written (socket closed / send threw) goes back in `keep`;
  // only the delivered ones and the cross-bridge drops leave the journal.
  assert.match(body, /keep\.push\(entry\);/, "an undeliverable entry must be retained for a later attempt");
  assert.match(body, /if \(sent \|\| dropped\) lostReplies\.replace\(keep\);/, "a partial replay must be retried, not lost");
  assert.match(body, /target\.readyState !== WebSocket\.OPEN/, "never write to a closed socket");
  // It must not re-enter the journal path (which would recurse through handleUndeliveredReply).
  assert.equal(/lostReplies\.record\(/.test(body), false, "replay must not re-journal, or it would recurse");
});

test("#508 wiring: self-heal re-registers via sendHello ONLY — it can never pick another tab", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const start = src.indexOf("function handleUndeliveredReply(entry) {");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n  }", start));
  assert.match(body, /\bsendHello\(\);/, "re-registration must reuse the existing hello path");
  // Nothing in this path may reference a tab id it did not derive from the live active
  // workflow — no id argument, no list lookup, no adoption of another tab.
  assert.equal(/tab_id|tabMigrations|attach_tab|openWorkflows/.test(body), false, "self-heal must not select a target tab");
  assert.match(body, /reRegisterExhaustedHint\(\)/, "an exhausted budget must surface a user action");
});
