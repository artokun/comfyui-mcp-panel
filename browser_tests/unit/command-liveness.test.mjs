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
// #1095 needs a REAL parser: the invariant is that no path exits between marking a
// command in flight and replying, which is a reachability property a token count cannot
// express — as review proved by running the counting version against the leaking code.
import ts from "typescript";
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

/**
 * #1095 — the line numbers of every statement that can EXIT `root` between `from` and `to`
 * without falling through to the reply.
 *
 * THE TRY BLOCK IS TRAVERSED, and the first cut of this scan did not traverse it. It
 * returned at every TryStatement and examined only the catch and finally, so a `return`
 * placed inside the marked executor's `try` — which skips the catch entirely, never reaches
 * deliverReply, and leaks the in-flight mark — was invisible, and this test would have gone
 * on passing. That is the same defect class as the counting version this scan replaced: an
 * assertion that cannot observe the property it claims to check. The fixture test below
 * drives exactly that shape.
 *
 * Only a CAUGHT `throw` is excluded, because the executor's catch is what turns a throw into
 * a reply — that is the whole point of it. A `return` is never caught by anything, and a
 * `throw` outside a try (or inside a catch/finally, which the enclosing try does not cover)
 * escapes just the same.
 */
/** The body of the bridge client's `sendUserMessage` / `sendFrame`, bounded by the method's
 *  own closing `\n    },` rather than a character count. */
function umBodyFor(src) {
  const at = src.indexOf("    sendUserMessage(");
  assert.notEqual(at, -1, "could not locate sendUserMessage");
  return src.slice(at, src.indexOf("\n    },", at));
}
function sfBodyFor(src) {
  const at = src.indexOf("    sendFrame(frame) {");
  assert.notEqual(at, -1, "could not locate sendFrame");
  return src.slice(at, src.indexOf("\n    },", at));
}

function escapingExits(sf, root, from, to) {
  const escapes = [];
  (function scan(node, caught) {
    if (ts.isFunctionLike(node) && node !== root) return; // nested callbacks have their own exits
    if (ts.isTryStatement(node)) {
      ts.forEachChild(node.tryBlock, (child) => scan(child, caught || !!node.catchClause));
      // A throw raised IN the handlers is not caught by this try — carry the outer state.
      if (node.catchClause) ts.forEachChild(node.catchClause, (child) => scan(child, caught));
      if (node.finallyBlock) ts.forEachChild(node.finallyBlock, (child) => scan(child, caught));
      return;
    }
    const at = node.getStart(sf);
    if (at > from && at < to) {
      const escapesHere = ts.isReturnStatement(node) || (ts.isThrowStatement(node) && !caught);
      if (escapesHere) escapes.push(sf.getLineAndCharacterOfPosition(at).line + 1);
    }
    ts.forEachChild(node, (child) => scan(child, caught));
  })(root, false);
  return escapes;
}

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
    /if \(!isReplayable\(entry, \{ now, targetUrl, targetEpoch \}\)\) \{\s*\n\s*dropped\+\+;\s*\n\s*continue;/,
    "an outcome belonging to a previous bridge, session, or too old must never be volunteered",
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

test("#694: isReplayable demands the SAME session epoch — match replays, mismatch drops, both-absent replays (legacy)", () => {
  const URL_A = "ws://127.0.0.1:9180";
  const now = 1_000_000;
  const fresh = { url: URL_A, at: now - 1000, epoch: "epoch-1" };
  // Same session (the ordinary reconnect within one orchestrator run) — replays.
  assert.equal(isReplayable(fresh, { now, targetUrl: URL_A, targetEpoch: "epoch-1" }), true);
  // A RESTARTED orchestrator at the same URL handshakes with a fresh epoch — dropped.
  assert.equal(
    isReplayable(fresh, { now, targetUrl: URL_A, targetEpoch: "epoch-2" }),
    false,
    "a predecessor session's journal must never replay into the new session",
  );
  // Legacy on BOTH sides (an epoch-less orchestrator): absent === absent — exactly
  // the pre-epoch URL+age behaviour.
  assert.equal(isReplayable({ url: URL_A, at: now - 1000 }, { now, targetUrl: URL_A }), true);
  // One-sided presence can never prove session continuity — fail CLOSED.
  assert.equal(
    isReplayable(fresh, { now, targetUrl: URL_A }),
    false,
    "an epoch'd entry must not replay to an epoch-less target",
  );
  assert.equal(
    isReplayable({ url: URL_A, at: now - 1000 }, { now, targetUrl: URL_A, targetEpoch: "epoch-1" }),
    false,
    "an epoch-less entry must not replay to an epoch'd target",
  );
});

test("#694: the journal records the session epoch and summaries filter by it identically", () => {
  const j = createLostReplyJournal();
  const now = 1_000_000;
  j.record({ reply: { rid: "same-session", ok: true }, cmd: "graph_outline", at: now - 1000, url: "ws://a", epoch: "e1" });
  j.record({ reply: { rid: "prior-session", ok: true }, cmd: "graph_outline", at: now - 1000, url: "ws://a", epoch: "e0" });
  j.record({ reply: { rid: "legacy", ok: true }, cmd: "graph_outline", at: now - 1000, url: "ws://a" });
  assert.equal(j.list()[0].epoch, "e1", "the entry must carry the session it belongs to");
  assert.equal(j.list()[2].epoch, undefined, "a legacy socket records no epoch (absent, not null)");
  assert.deepEqual(
    j.summaries({ now, targetUrl: "ws://a", targetEpoch: "e1" }).map((e) => e.rid),
    ["same-session"],
    "the advertised summaries must obey the same session rule as the replay",
  );
  assert.deepEqual(
    j.summaries({ now, targetUrl: "ws://a" }).map((e) => e.rid),
    ["legacy"],
    "an epoch-less target (legacy orchestrator) sees only epoch-less entries",
  );
  // No target ⇒ unfiltered (the journal's own bookkeeping view).
  assert.equal(j.summaries().length, 3);
});

test("#694 wiring: the epoch stamps from ANY epoch-carrying frame, before the models branch", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const genericAt = src.indexOf('typeof msg.epoch === "string"');
  const modelsAt = src.indexOf('msg.type === "models"');
  assert.notEqual(genericAt, -1, "the generic epoch stamp must exist (epoch-first session frame)");
  assert.notEqual(modelsAt, -1);
  assert.ok(
    genericAt < modelsAt,
    "the generic stamp must run BEFORE the models branch so an early session frame advances the epoch",
  );
  const branch = src.slice(genericAt, genericAt + 400);
  assert.match(branch, /thisSock\.__cmcpBridgeEpoch = msg\.epoch;/, "it stamps the socket's epoch from the frame");
});

test("#694 wiring: the models handshake stamps the socket's session epoch BEFORE the replay fires", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  const modelsAt = src.indexOf('msg.type === "models"');
  assert.notEqual(modelsAt, -1, "the models handshake branch must exist");
  const branch = src.slice(modelsAt, modelsAt + 1200);
  const stampAt = branch.indexOf("thisSock.__cmcpBridgeEpoch = msg.epoch;");
  const markAt = branch.indexOf("markConnected();");
  assert.notEqual(stampAt, -1, "the handshake must stamp the orchestrator's epoch on the socket");
  assert.notEqual(markAt, -1);
  assert.ok(
    stampAt < markAt,
    "the epoch must be stamped BEFORE markConnected() fires the lost-reply replay",
  );
});

test("#694 wiring: a journaled outcome stamps THIS socket's epoch, and the replay checks it", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /epoch: thisSock\.__cmcpBridgeEpoch,/, "the journal must record the socket's session epoch");
  const start = src.indexOf("function replayLostReplies(target) {");
  assert.notEqual(start, -1);
  const body = src.slice(start, src.indexOf("\n  }", start));
  assert.match(
    body,
    /const targetEpoch = target\?\.__cmcpBridgeEpoch;/,
    "the replay must compare against the TARGET socket's epoch, like the url check",
  );
});

test("codex R11 / #694: summaries obey the SAME cross-bridge/session/age rule as the replay — and ride the post-handshake frame, never the hello", () => {
  // The summaries advertise "the tab answered and the reply was lost", so an unfiltered
  // list would tell a bridge that never owned these commands their ids, names and
  // outcomes — even though replayLostReplies correctly withholds the replies themselves.
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
  // #694 — the hello fires at socket-open, BEFORE the models handshake stamps the
  // socket's epoch: a summary computed there is filtered with an UNKNOWN epoch and can
  // contradict the epoch-filtered replay. The hello must therefore carry NO summaries…
  // #1095 — `advertiseHello` is the payload builder; `sendHello` in front of it is the
  // gate. Slicing the gate would prove nothing, because a five-line wrapper trivially
  // contains no `lostReplies` — the assertion would pass on an empty window instead of on
  // the code it is about.
  const helloStart = src.indexOf("function advertiseHello() {");
  assert.notEqual(helloStart, -1, "could not locate the hello payload builder");
  const helloBody = src.slice(helloStart, src.indexOf("\n  }", helloStart));
  assert.equal(
    /lostReplies|lost_replies/.test(helloBody.replace(/\/\/[^\n]*/g, "")),
    false,
    "the hello must not advertise lost-reply summaries computed before the epoch is known",
  );
  // …they ride the post-handshake `lost_replies` frame, sent from INSIDE the replay with
  // the SAME targetUrl/targetEpoch locals the replay loop uses — agreement by construction.
  const replayStart = src.indexOf("function replayLostReplies(target) {");
  assert.notEqual(replayStart, -1);
  const replayBody = src.slice(replayStart, src.indexOf("\n  }", replayStart));
  assert.match(replayBody, /type: "lost_replies",/, "the summaries frame must exist");
  assert.match(
    replayBody,
    /entries: lostReplies\.summaries\(\{ now, targetUrl, targetEpoch \}\)/,
    "the summaries must be filtered with the SAME url+epoch the replay loop uses",
  );
  const epochAt = replayBody.indexOf("const targetEpoch = target?.__cmcpBridgeEpoch;");
  const summaryAt = replayBody.indexOf('type: "lost_replies"');
  const loopAt = replayBody.indexOf("for (const entry of lost) {");
  const nowAt = replayBody.indexOf("const now = Date.now();");
  assert.ok(nowAt !== -1 && nowAt < summaryAt, "one captured instant must serve BOTH the summary frame and the replay checks");
  assert.ok(epochAt !== -1 && summaryAt !== -1 && loopAt !== -1);
  assert.ok(
    epochAt < summaryAt && summaryAt < loopAt,
    "the epoch must be stamped, THEN the summaries sent, THEN the replay attempted",
  );
});

test("#694: the advertised summaries and the replay delivery set can never disagree — four epoch cases", () => {
  // The replay loop delivers entry.reply for exactly the entries where isReplayable
  // passes; the summaries frame advertises summaries() over the SAME filter. Lock the
  // equality across every epoch pairing so a future refactor can't split them.
  const now = 1_000_000;
  const URL_A = "ws://a";
  const build = () => {
    const j = createLostReplyJournal();
    j.record({ reply: { rid: "this-session", ok: true }, cmd: "graph_outline", at: now - 1000, url: URL_A, epoch: "e1" });
    j.record({ reply: { rid: "prior-session", ok: true }, cmd: "graph_outline", at: now - 1000, url: URL_A, epoch: "e0" });
    j.record({ reply: { rid: "legacy", ok: true }, cmd: "graph_outline", at: now - 1000, url: URL_A });
    j.record({ reply: { rid: "other-bridge", ok: true }, cmd: "graph_outline", at: now - 1000, url: "ws://b", epoch: "e1" });
    j.record({ reply: { rid: "stale", ok: true }, cmd: "graph_outline", at: now - REPLAY_MAX_AGE_MS - 1, url: URL_A, epoch: "e1" });
    return j;
  };
  const cases = [
    ["(a) epoch match — same-session reconnect", { now, targetUrl: URL_A, targetEpoch: "e1" }, ["this-session"]],
    ["(b) epoch mismatch — restarted orchestrator", { now, targetUrl: URL_A, targetEpoch: "e2" }, []],
    ["(c) both-absent — legacy orchestrator", { now, targetUrl: URL_A }, ["legacy"]],
    ["(d) one-sided — epoch'd target, epoch'd entries only", { now, targetUrl: URL_A, targetEpoch: "e0" }, ["prior-session"]],
  ];
  for (const [name, filter, expected] of cases) {
    const j = build();
    const advertised = j.summaries(filter).map((e) => e.rid);
    const delivered = j.list().filter((e) => isReplayable(e, filter)).map((e) => e.rid);
    assert.deepEqual(advertised, delivered, `${name}: advertised set must equal the replayed set`);
    assert.deepEqual(advertised, expected, `${name}: the filter itself picks the right entries`);
  }
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
  // #1095 — matched on the leading arguments, not the whole call. The claim here is about
  // ORDER (the reply is written before the superseded early return), and pinning the exact
  // arity made it fail when the in-flight mark became a fourth argument — a passing
  // assertion breaking for a reason unrelated to what it checks.
  const sendAt = block.search(/deliverReply\(reply, msg\.cmd, superseded[,)]/);
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
  assert.notEqual(listenerAt, -1, "could not locate the message listener");
  // Searched from the listener's start over the WHOLE source, not over a fixed 3000-char
  // window. The window was the same stand-in for "inside this listener" that this test
  // already corrects one line below, and it failed for the same reason on the very next
  // comment added to the guard (#1095's second pass): the block moved past character 3000
  // and `guardEnd` came back -1 from a slice that had been truncated mid-block, not from
  // any change to what is being asserted. The two `indexOf`s below are ordered relative to
  // each other, which is the actual claim, and both are asserted to have been found.
  const listener = src.slice(listenerAt);
  const parseAt = listener.indexOf("msg = JSON.parse(");
  const guardAt = listener.indexOf("if (!isActive()) {");
  assert.ok(parseAt !== -1 && guardAt !== -1, "the listener must parse before the instance guard");
  assert.ok(parseAt < guardAt, "the frame must be parsed BEFORE the superseded early return");
  // …and the refusal must be rid-correlated, explicitly NOT-APPLIED, and delivered/journaled.
  // Bounded by the guard block's OWN closing brace, not a fixed character count. The
  // count stood in for "inside this block" and stopped meaning it the moment the block
  // grew a comment (#1095 added one) — a passing assertion turning into a failing one for
  // a reason unrelated to what it checks, the same trap corrected for markConnected in
  // #1146. `\n      }` is this block's indent level, so it cannot match an inner brace.
  const guardEnd = listener.indexOf("\n      }", guardAt);
  assert.notEqual(guardEnd, -1, "could not locate the end of the superseded guard");
  const guarded = listener.slice(guardAt, guardEnd);
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
  // Bounded by the handler's OWN closing brace, not by a character count. This file has
  // already corrected the same trap twice — for markConnected (#1145) and for the
  // superseded guard (#1095) — and the window had 71 characters left: ONE more comment
  // line in the open handler and this assertion goes red for a reason that has nothing to
  // do with whether the hello rides socket-open. Measured, not guessed: `sendHello();` sat
  // at offset 1929 of 2000 in a 3308-character handler.
  const openAt = src.indexOf('thisSock.addEventListener("open"');
  assert.notEqual(openAt, -1, "could not locate the socket open handler");
  const openEnd = src.indexOf("\n    });", openAt);
  assert.notEqual(openEnd, -1, "could not locate the end of the open handler");
  const openHandler = src.slice(openAt, openEnd);
  assert.match(openHandler, /sendHello\(\);/, "the hello still rides socket-open");
  assert.equal(
    /replayLostReplies\(thisSock\);/.test(src),
    false,
    "replay must not fire at bare socket-open",
  );
  // Bound to markConnected's actual BODY, the way the #508 R6 test below bounds
  // handleUndeliveredReply's. A fixed character window stood in for "inside this
  // function" and stopped meaning that the moment the function grew a comment
  // (#1145 added one) — a passing assertion turning into a failing one for a reason
  // unrelated to what it checks.
  const mcStart = src.indexOf("function markConnected() {");
  assert.notEqual(mcStart, -1, "could not locate markConnected in the panel source");
  // Both ends are asserted: a -1 from either indexOf would slice a window that is not
  // the function — an unfound END silently degrades `slice` into a near-whole-file scan,
  // which would pass no matter where replayLostReplies actually sits.
  const mcEnd = src.indexOf("\n  }", mcStart);
  assert.notEqual(mcEnd, -1, "could not locate the end of markConnected");
  const markConnected = src.slice(mcStart, mcEnd);
  assert.match(markConnected, /replayLostReplies\(sock\);/, "replay rides the handshake");
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

// ── #1095: a re-advertise must not withdraw a route mid-command ───────────────
//
// rehelloForWorkflow's own note says the backend DROPS the socket's prior tab mapping
// when the panel re-advertises. That is correct — it stops a background workflow's output
// leaking into this tab — but it must not happen while a command is routed to that
// mapping: the orchestrator loses the route mid-command and reports OUTCOME UNKNOWN for
// work that actually applied, then "Connected: none" until the new mapping settles.
// Creating a workflow and immediately applying a batch of mutations is exactly that
// window, since the workflow poll ticks every 600ms — between two commands.
//
// THE GATE'S BEHAVIOUR IS DRIVEN IN rehello-gate.test.mjs. What is left here is wiring
// that only the panel source can answer: whether the mark/release pair is exactly paired
// across the command branch, and whether EVERY re-advertise actually reaches the gate.
// Both are structural claims about the source, which is why they are read off the syntax
// tree; neither is a claim that some code runs, which a source pattern cannot make.
test("#1095: the in-flight mark is paired across the command branch", () => {
  const src = readFileSync(PANEL_JS, "utf8");

  // Every mark must be paired with the single release in deliverReply, or the count
  // drifts: too high delays a re-advertise until the budget runs out, too low reopens the
  // race. Both command paths that reach deliverReply mark.
  const marks = (src.match(/^\s*(?:const \w+ = )?rehelloGate\.began\(/gm) || []).length;
  const releases = (src.match(/^\s*rehelloGate\.ended\(mark\);/gm) || []).length;
  assert.equal(marks, 3, "every command path that WAITS and then replies must mark it in flight");
  assert.equal(releases, 1, "the deliverReply paths release in exactly one place");

  // codex P1 — the release must NAME the mark it is releasing. deliverReply is per-SOCKET
  // while marks are per-COMMAND, and the two lifetimes come apart the moment a connection is
  // replaced: cancel() invalidates the retired socket's marks, but a command already
  // executing there still finishes and still calls this. A release that named nothing would
  // land on whatever the NEW socket is running. Both call sites must therefore pass one.
  assert.equal(
    (src.match(/^\s*const deliverReply = \(reply, cmd, superseded, mark\) => \{/gm) || []).length,
    1,
    "deliverReply must take the mark from its caller, not release blind",
  );
  assert.equal(
    /rehelloGate\.ended\(\);/.test(src),
    false,
    "an unnamed release would discount a command belonging to another generation",
  );

  // COUNTING THOSE IS NOT ENOUGH, and this test shipped believing it was. Review proved
  // it by execution: at the revision where the mark sat ABOVE the #517 dedupe region —
  // with five paths returning before any reply, leaking it permanently — this file was
  // byte-identical and still passed. Two marks and one release is true of both the broken
  // and the fixed arrangement, so the assertions above cannot tell them apart. What
  // actually matters is a REACHABILITY property, so it has to be read off the syntax tree
  // rather than off a token count.
  //
  // The real invariant: between the mark and the reply there is no exit. Returns and
  // throws inside a try are excluded — the executor's throws are caught below and turned
  // into a reply, which is the whole point of that catch.
  const sf = ts.createSourceFile(PANEL_JS, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  let branch = null;
  (function findBranch(n) {
    if (
      ts.isIfStatement(n) &&
      n.expression.getText(sf) === "isCommandFrame" &&
      n.getEnd() - n.getStart(sf) > 5000 // the executing branch, not the refusal stub
    ) branch = n;
    ts.forEachChild(n, findBranch);
  })(sf);
  assert.ok(branch, "could not locate the executing command branch");

  let incPos = -1;
  let replyPos = -1;
  (function locate(n) {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "rehelloGate.began") {
      incPos = n.getStart(sf);
    }
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "deliverReply") {
      replyPos = n.getStart(sf);
    }
    ts.forEachChild(n, locate);
  })(branch);
  assert.ok(incPos !== -1 && replyPos !== -1, "the branch must mark in flight and deliver a reply");
  assert.ok(incPos < replyPos, "the mark must precede the reply that releases it");

  const escapes = escapingExits(sf, branch, incPos, replyPos);
  assert.deepEqual(
    escapes,
    [],
    `every exit between marking a command in flight and replying leaks the mark — ` +
      `a leaked mark never returns the count to 0, so every later re-advertise pays the ` +
      `full budget. Leaking exits at line(s): ${escapes.join(", ")}`,
  );

  // The release must live INSIDE deliverReply, which every command path reaches once.
  const dStart = src.indexOf("const deliverReply = (reply, cmd, superseded, mark) => {");
  assert.notEqual(dStart, -1, "could not locate deliverReply");
  const dEnd = src.indexOf("\n    };", dStart);
  assert.notEqual(dEnd, -1, "could not locate the end of deliverReply");
  assert.match(
    src.slice(dStart, dEnd),
    /rehelloGate\.ended\(mark\);/,
    "the command is finished when its reply is handed over, whatever happens to it after",
  );

  // The superseded-socket refusal replies too, so it must balance the pair. The count is
  // CLIENT-scoped while that branch runs on a RETIRED socket, so an unpaired release
  // there would discount a command still running on the live socket — reintroducing the
  // race through the bookkeeping meant to close it.
  const gStart = src.indexOf("if (!isActive()) {");
  const gEnd = src.indexOf("\n      }", gStart);
  assert.ok(gStart !== -1 && gEnd !== -1, "could not bound the superseded guard");
  assert.match(
    src.slice(gStart, gEnd),
    /const refusalMark = rehelloGate\.began\(\);/,
    "the superseded refusal must balance the release its deliverReply performs",
  );
});

test("#1095 codex P1: the duplicate-replay wait is marked, and released in a finally", () => {
  // The #517 replay AWAITS a ledger promise and then answers with a direct `thisSock.send`,
  // so it holds the route exactly like an executing command — and it is easy to read as
  // "the reply already exists, nothing to protect". That is wrong when the retry lands on a
  // REPLACEMENT socket while the original is still running: cancel() invalidated the retired
  // socket's mark, so without one here the client believes nothing is in flight, and a
  // workflow switch during the await lets a re-hello withdraw the replacement's route before
  // the reply is written — the OUTCOME UNKNOWN this whole change exists to prevent.
  const src = readFileSync(PANEL_JS, "utf8");
  const sf = ts.createSourceFile(PANEL_JS, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  let block = null;
  (function walk(n) {
    if (ts.isIfStatement(n) && n.expression.getText(sf) === "priorRidReply !== undefined") block = n;
    ts.forEachChild(n, walk);
  })(sf);
  assert.ok(block, "could not locate the duplicate-replay branch");
  const body = block.getText(sf);
  assert.match(body, /const replayMark = rehelloGate\.began\(msg\.cmd\);/, "the wait must be marked");
  assert.match(body, /await awaitDuplicateReply\(/, "…and the mark must cover the await");

  // The release must be in a `finally`. This branch answers on two of its three exits with a
  // direct thisSock.send and never reaches deliverReply, so a release placed before any one
  // `return` is a release the next exit added will miss.
  let tryStmt = null;
  (function findTry(n) {
    if (ts.isTryStatement(n) && !tryStmt && n.getText(sf).includes("rehelloGate.ended(replayMark)")) tryStmt = n;
    ts.forEachChild(n, findTry);
  })(block);
  assert.ok(tryStmt, "the replay mark must be released from a try");
  assert.ok(tryStmt.finallyBlock, "…specifically a finally, so no exit can skip it");
  assert.match(
    tryStmt.finallyBlock.getText(sf),
    /rehelloGate\.ended\(replayMark\);/,
    "the finally must release exactly the mark this branch took",
  );
  // The mark must be taken OUTSIDE that try — taken inside, a throw before the assignment
  // would run a finally that releases `undefined` and silently leaks.
  const markAt = body.indexOf("const replayMark = rehelloGate.began(msg.cmd);");
  const tryAt = body.indexOf(tryStmt.getText(sf));
  assert.ok(markAt !== -1 && tryAt !== -1 && markAt < tryAt, "the mark is taken before the try it is released from");
});

test("#1095 codex P1: the canvas-tool disclosure is decided when the frame LEAVES", () => {
  // A held frame is sent after the hello it was waiting for, and a landed hello ADVANCES
  // agentSessionEpoch. Deciding the disclosure at call time therefore decides it for the
  // agent generation the message will not reach: if the outgoing generation had proven its
  // tools, `disclose` is false, the NEW generation gets no disclosure, and
  // canvasToolMessagedEpoch then marks it as prompted — so it never gets the paragraph at
  // all. Silent, and total for that session.
  const src = readFileSync(PANEL_JS, "utf8");
  const at = src.indexOf("    sendUserMessage(");
  assert.notEqual(at, -1, "could not locate sendUserMessage");
  const end = src.indexOf("\n    },", at);
  const body = src.slice(at, end);
  const closureAt = body.indexOf("const send = () => {");
  const planAt = body.indexOf("planCanvasToolDisclosure({");
  assert.ok(closureAt !== -1 && planAt !== -1, "both the closure and the plan must exist");
  assert.ok(planAt > closureAt, "the disclosure must be planned INSIDE the deferred send");
  // …and everything derived from it must live there too, or the recompute is decorative.
  const outContextAt = body.indexOf("const outContext =");
  const disclosedAt = body.indexOf("const disclosed =");
  assert.ok(disclosedAt > closureAt && outContextAt > closureAt, "the decision and the context ride with it");
  // The one-shot context is the opposite case and must stay OUTSIDE: pendingContext is
  // consumed when the user presses send, and re-reading it at drain time would either lose
  // it or attach it to the wrong message.
  const ctxAt = body.indexOf("const mergedContext =");
  assert.ok(ctxAt !== -1 && ctxAt < closureAt, "the one-shot context is captured at call time");
});

test("#1095 codex P1: BOTH outbound send paths consult the advertised route first", () => {
  // The leak this closes: onWorkflowMaybeChanged commits the new workflow inline, so while
  // the hello is parked the panel is on B and the socket's binding still says A. A
  // `user_message` carries NO tab id, so the orchestrator routes it by that binding — the
  // user's text, context and images for B delivered into A's conversation.
  //
  // Structural because the claim is a CLOSURE one: every path that writes an agent-directed
  // frame must pass the check. The check's own behaviour is driven in rehello-gate.test.mjs.
  const src = readFileSync(PANEL_JS, "utf8");
  const sf = ts.createSourceFile(PANEL_JS, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  const holdSites = [];
  const staleReads = [];
  (function walk(n) {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "rehelloGate.holdForRoute") {
      // Every hold must STAMP the route it was composed for. An unstamped frame is one a
      // later advertisement for a DIFFERENT workflow will deliver to that workflow.
      assert.equal(n.arguments.length, 2, "a held frame must carry the route it was composed for");
      holdSites.push(n.getStart(sf));
    }
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "advertisedRouteIsStale") {
      staleReads.push(n.getStart(sf));
    }
    ts.forEachChild(n, walk);
  })(sf);
  // ONE hold site, not two. A queued frame's outcome is not yet known, so it may only be
  // queued where nobody reads the answer — which is `sendFrame`'s session-ordered control
  // frames alone. `sendUserMessage` REFUSES instead: queueing it and answering `true` would
  // report it delivered while it can still be discarded (runCompletion's markDelivered
  // retires a prompt permanently on exactly that answer), and answering `false` would leave
  // the tray showing failed while the queued copy still goes out on the next advertisement.
  assert.equal(holdSites.length, 1, "only the session-ordered control frames may be queued");
  // …but BOTH send paths must consult the route first.
  //
  // #1389 — asserted by WHERE each read is, not by how many there are. A third reader now
  // exists and it is deliberately not a send path: the workflow poll's drift check
  // re-advertises on the same staleness these two refuse on, because nothing else did and
  // a held frame may never cause an advertisement (holdForRoute's own rule). Counting to
  // two would have made adding that reader look like a regression, and raising the count
  // to three would have stopped saying anything about where the reads are — which is the
  // whole claim. So: exactly one read inside each send path, and every other read
  // accounted for by name.
  const rangeOfMember = (name) => {
    const at = src.indexOf(`    ${name}(`);
    assert.notEqual(at, -1, `could not locate ${name}`);
    const end = src.indexOf("\n    },", at);
    assert.notEqual(end, -1, `could not bound ${name}`);
    return [at, end];
  };
  const driftStart = src.indexOf("workflowIdentityDriftRehello = () => {");
  assert.notEqual(driftStart, -1, "the drift re-advertise hook must exist");
  const driftEnd = src.indexOf("\n  };", driftStart);
  assert.notEqual(driftEnd, -1, "could not bound the drift re-advertise hook");
  const readerRanges = {
    sendUserMessage: rangeOfMember("sendUserMessage"),
    sendFrame: rangeOfMember("sendFrame"),
    workflowIdentityDriftRehello: [driftStart, driftEnd],
  };
  const readers = staleReads.map((pos) => {
    const hit = Object.entries(readerRanges).find(([, [a, b]]) => pos >= a && pos <= b);
    return hit ? hit[0] : `UNACCOUNTED@${pos}`;
  });
  assert.deepEqual(
    readers.slice().sort(),
    ["sendFrame", "sendUserMessage", "workflowIdentityDriftRehello"],
    "both send paths must consult the route, and only the drift re-advertise may also read it",
  );
  assert.equal(
    (src.match(/^\s*function advertisedRouteIsStale\(\) \{/gm) || []).length,
    1,
    "ONE definition of the check — a second copy is how two send paths drift apart",
  );

  // Each guard must sit INSIDE its send path, and the raw `sock.send` must be reachable only
  // through the closure the guard chooses between — not left as a second, ungated exit.
  for (const name of ["sendUserMessage", "sendFrame"]) {
    const at = src.indexOf(`    ${name}(`);
    assert.notEqual(at, -1, `could not locate ${name}`);
    const end = src.indexOf("\n    },", at);
    assert.notEqual(end, -1, `could not bound ${name}`);
    const body = src.slice(at, end);
    // The CALL, not a literal `if (...)` form — sendFrame conjoins the frame-type check.
    const guardAt = body.indexOf("advertisedRouteIsStale()");
    const plainAt = body.lastIndexOf("return send();");
    assert.ok(guardAt !== -1 && plainAt > guardAt, `${name} must only send directly AFTER the guard`);
  }

  // The two paths want OPPOSITE orderings, and each ordering is load-bearing.
  //
  // sendFrame can QUEUE, so its frame must be built before the branch — a held frame has to
  // be byte-identical to the one that would have gone out immediately.
  const sfBuildAt = sfBodyFor(src).indexOf("const send = () => {");
  const sfGuardAt = sfBodyFor(src).indexOf("advertisedRouteIsStale()");
  assert.ok(sfBuildAt !== -1 && sfBuildAt < sfGuardAt, "sendFrame must build the frame before deciding");
  // sendUserMessage REFUSES, so its guard must come first — building would consume the armed
  // one-shot for a frame that never leaves (see the ordering assertions below).
  const umBuildAt = umBodyFor(src).indexOf("const send = () => {");
  const umGuardAt = umBodyFor(src).indexOf("advertisedRouteIsStale()");
  assert.ok(umGuardAt !== -1 && umGuardAt < umBuildAt, "sendUserMessage must refuse before building");

  // sendUserMessage refuses outright; only sendFrame may queue, and only for the frames
  // whose senders ignore the answer.
  const umAt = src.indexOf("    sendUserMessage(");
  const umBody = src.slice(umAt, src.indexOf("\n    },", umAt));
  assert.match(umBody, /if \(advertisedRouteIsStale\(\)\) return false;/, "a user message is refused, never queued");

  // …AND THE REFUSAL MUST PRECEDE EVERY ONE-SHOT CONSUMPTION. `pendingContext` is an armed
  // transcript replay / workflow instruction that is merged into the frame and cleared. With
  // the refusal below that merge, the one-shot was consumed by a frame that never left, and
  // `trackSend` stores the payload it was GIVEN — so the retry went out without the armed
  // replay, silently. Same class as reporting a discarded frame delivered: the user's intent
  // evaporates with no signal. Ordering is asserted rather than a restore, because a restore
  // has to be remembered by every future edit and an early return does not.
  const umRefuseAt = umBody.indexOf("if (advertisedRouteIsStale()) return false;");
  const umMergeAt = umBody.indexOf("const mergedContext =");
  const umClearAt = umBody.indexOf("pendingContext = null;");
  assert.ok(umMergeAt !== -1 && umClearAt !== -1, "the one-shot merge and clear must still be here");
  assert.ok(umRefuseAt < umMergeAt, "the refusal must precede the one-shot merge");
  assert.ok(umRefuseAt < umClearAt, "…and the clear that consumes it");
  // `AGENT_BLIND` may still run before the refusal — it only nulls a local, consuming nothing.
  assert.ok(
    umBody.indexOf("if (AGENT_BLIND) images = undefined;") > umRefuseAt,
    "nothing that mutates caller state may run before the refusal",
  );
  // The CALL, not the word — the comment above it names holdForRoute to explain why this
  // path deliberately does not use it.
  assert.equal(
    /rehelloGate\.holdForRoute\(/.test(umBody),
    false,
    "…and it must not reach the queue at all",
  );

  // THE SCOPE LINE. Only the session-ordered frames are held; every other control frame
  // keeps its pre-#1095 behaviour. A brief cut refused them all, and that was worse rather
  // than stricter: cancel_message, interrupt, rewind, set_options and the pairing frames all
  // IGNORE this return, so a refusal did not stop them — it made them fail silently while
  // their callers announced success and, in rewind's case, resubmitted. Refusing a frame
  // nobody checks converts a routing problem into a lying UI.
  const sfAt = src.indexOf("    sendFrame(frame) {");
  const sfBody = src.slice(sfAt, src.indexOf("\n    },", sfAt));
  assert.match(
    sfBody,
    /if \(advertisedRouteIsStale\(\) && SESSION_ORDERED_FRAMES\.has\(frame\?\.type\)\) \{/,
    "only the fire-and-forget session frames may be diverted from the ordinary send",
  );
  assert.match(sfBody, /return rehelloGate\.holdForRoute\(send, routeId\);/, "…and the queued one carries its route");
  assert.equal(
    /SESSION_ORDERED_FRAMES\.has\(frame\?\.type\)\) return false;/.test(sfBody),
    false,
    "a control frame whose caller ignores the answer must not be silently refused",
  );
  // The set must stay exactly the fire-and-forget session frames. Adding a frame whose
  // sender reads the return would reintroduce "reported delivered, then discarded".
  assert.match(
    src,
    /const SESSION_ORDERED_FRAMES = new Set\(\["resume_session", "new_session"\]\);/,
    "only fire-and-forget session frames may be queued",
  );

  // The comparison must be against what the hello ACTUALLY carried, recorded on the landed
  // path only — the same rule as lastAdvertisedWorkflowUuid and advertisedSock beside it.
  const advBody = src.slice(src.indexOf("function advertiseHello() {"));
  const sentAt = advBody.indexOf("if (sent) {");
  const recordAt = advBody.indexOf("lastAdvertisedRouteId = advertisedRouteId;");
  assert.ok(sentAt !== -1 && recordAt !== -1 && recordAt > sentAt, "the route is recorded only once a hello LANDED");
  // …and the held queue is released from that same landed path, with the route that was
  // ACTUALLY carried. Releasing on intent rather than on arrival would send frames onto a
  // route the orchestrator was never told about.
  const notifyAt = advBody.indexOf("rehelloGate.noteAdvertised(advertisedRouteId);");
  assert.ok(notifyAt !== -1 && notifyAt > sentAt, "held frames are released by a LANDED hello, not an attempted one");

  // THE RULE THAT ENDS THE FAMILY: no send path may cause an advertisement. The workflow
  // poll binds SESSION_KEY before re-helloing and is the only place that commits a switch
  // as a whole — so anything else that advertises publishes a half-committed switch, pairing
  // the new route with the previous workflow's session.
  const gateSrc = readFileSync(join(HERE, "../../web/js/lib/rehello-gate.js"), "utf8");
  const holdStart = gateSrc.indexOf("    holdForRoute(send, route) {");
  assert.notEqual(holdStart, -1, "could not locate holdForRoute");
  const holdEnd = gateSrc.indexOf("\n    },", holdStart);
  const holdBody = gateSrc.slice(holdStart, holdEnd);
  assert.equal(
    /\b(flush|request)\(\)/.test(holdBody),
    false,
    "holding a frame must never trigger an advertisement — it waits for one",
  );
});

test("#1095 codex P2: the reachability scan SEES a return inside the marked try", () => {
  // The scan is the only thing standing between a refactor and a silently leaked mark, so
  // it is itself driven against fixtures rather than trusted. The first cut skipped every
  // TryStatement's body outright, which made case (b) below invisible — a test that could
  // not fail on the defect it exists to catch.
  const build = (body) => {
    const source = `async function h(){ if (isCommandFrame) { ${body} } }`;
    const sf = ts.createSourceFile("fixture.js", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    let branch = null;
    let from = -1;
    let to = -1;
    (function walk(n) {
      if (ts.isIfStatement(n) && n.expression.getText(sf) === "isCommandFrame") branch = n;
      if (ts.isCallExpression(n) && n.expression.getText(sf) === "rehelloGate.began") from = n.getStart(sf);
      if (ts.isCallExpression(n) && n.expression.getText(sf) === "deliverReply") to = n.getStart(sf);
      ts.forEachChild(n, walk);
    })(sf);
    assert.ok(branch && from !== -1 && to !== -1, "fixture must mark and reply");
    return escapingExits(sf, branch, from, to);
  };

  // (a) the shape the panel actually has — a throw inside the try is CAUGHT and answered,
  // so it is not an escape.
  assert.deepEqual(
    build(`rehelloGate.began(c); try { if (x) throw new Error("boom"); r = await run(); } catch (e) { r = err(e); } deliverReply(r);`),
    [],
    "a caught throw is turned into a reply — the catch is what makes it safe",
  );

  // (b) THE DEFECT. A return inside the try skips the catch, never reaches deliverReply,
  // and leaks the mark. The old scan reported nothing here.
  assert.deepEqual(
    build(`rehelloGate.began(c); try { if (x) return; r = await run(); } catch (e) { r = err(e); } deliverReply(r);`),
    [1],
    "a return inside the marked try must be reported as a leaking exit",
  );

  // (c) a throw in the CATCH is not covered by its own try, so it escapes too.
  assert.deepEqual(
    build(`rehelloGate.began(c); try { r = await run(); } catch (e) { throw e; } deliverReply(r);`),
    [1],
    "a rethrow from the handler escapes the branch just like a bare throw",
  );

  // (d) an exit AFTER the reply is not this invariant's business — the mark is already
  // released by then.
  assert.deepEqual(
    build(`rehelloGate.began(c); deliverReply(r); if (superseded) return;`),
    [],
    "the window ends at the reply",
  );

  // (e) a nested callback has its own exits and must not be attributed to the branch.
  assert.deepEqual(
    build(`rehelloGate.began(c); items.forEach((i) => { if (i) return; }); deliverReply(r);`),
    [],
    "a return that leaves only an inner function is not a branch exit",
  );
});

test("#1095 codex P2: an ordinary socket close clears the gate, like every other teardown", () => {
  // stop() / setUrl() / destroy() are the PANEL-DRIVEN teardowns; they null `sock`
  // synchronously, so their late close fails the active guard and never reaches this
  // handler. An ordinary drop (network, server restart) reaches recovery only through
  // scheduleReconnect here — so this was the one path that let a replacement socket inherit
  // the previous connection's gate state: a parked waiter or its timer could fire a hello
  // against the NEW socket, and the dead socket's outstanding marks would delay the next
  // legitimate re-advertise.
  const src = readFileSync(PANEL_JS, "utf8");
  const closeAt = src.indexOf('thisSock.addEventListener("close", () => {');
  assert.notEqual(closeAt, -1, "could not locate the close handler");
  const closeEnd = src.indexOf("\n    });", closeAt);
  assert.notEqual(closeEnd, -1, "could not locate the end of the close handler");
  const body = src.slice(closeAt, closeEnd);

  // It must be gated on the ACTIVE socket: a superseded socket's close must not clear the
  // live connection's gate — that would withdraw the route from commands running on it.
  const guardAt = body.indexOf("if (!isActive()) return;");
  const cancelAt = body.indexOf("rehelloGate.cancel();");
  assert.notEqual(guardAt, -1, "the handler must ignore a superseded socket's close");
  assert.notEqual(cancelAt, -1, "an ordinary close must drop any parked re-advertise");
  assert.ok(guardAt < cancelAt, "…and only for the socket that is actually current");
  assert.match(
    body,
    /advertisedSock = null;/,
    "the replacement socket has no mapping yet, so its first hello must not be gated",
  );
});

test("#1095: EVERY re-advertise goes through the gate — no caller can bypass it", () => {
  // This is the finding that sent the first cut back. The deferral was implemented at ONE
  // caller (the workflow poll), while `rehelloForWorkflow`, the #607/#570 fence via
  // noteWorkflowInstanceMismatch, the #310 free_vram re-advertise and the #508 self-heal
  // re-registration all call the hello directly and stayed ungated — and gating the poll
  // made the fence trip MORE often, routing more traffic through an ungated re-hello.
  //
  // A guard at one caller cannot be completed by patching callers, because the next caller
  // added is ungated again. So the property asserted is a CLOSURE one: the only code that
  // may reach the raw send is the gate itself and the gated entry point.
  const src = readFileSync(PANEL_JS, "utf8");
  const sf = ts.createSourceFile(PANEL_JS, src, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);

  let gateCall = null;
  let sendHelloFn = null;
  let advertiseFn = null;
  const rawCalls = [];
  (function walk(n) {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "createRehelloGate") gateCall = n;
    if (ts.isFunctionDeclaration(n) && n.name?.getText(sf) === "sendHello") sendHelloFn = n;
    if (ts.isFunctionDeclaration(n) && n.name?.getText(sf) === "advertiseHello") advertiseFn = n;
    if (ts.isCallExpression(n) && n.expression.getText(sf) === "advertiseHello") rawCalls.push(n);
    ts.forEachChild(n, walk);
  })(sf);

  assert.ok(gateCall, "the client must construct the re-advertise gate");
  assert.ok(sendHelloFn, "sendHello must remain the entry point every caller already uses");
  assert.ok(advertiseFn, "the raw hello send must exist as its own function");
  assert.ok(rawCalls.length >= 2, "the gate and the entry point must both be able to send");

  const inside = (node, host) => node.getStart(sf) >= host.getStart(sf) && node.getEnd() <= host.getEnd();
  const strays = rawCalls
    .filter((c) => !inside(c, gateCall) && !inside(c, sendHelloFn))
    .map((c) => sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1);
  assert.deepEqual(
    strays,
    [],
    `advertiseHello() may only be reached from the gate or from sendHello. A direct call ` +
      `elsewhere is an ungated re-advertise, which is the defect this change exists to ` +
      `close. Stray call(s) at line(s): ${strays.join(", ")}`,
  );

  // …and sendHello must actually consult the gate rather than merely sitting in front of
  // it. The bypass it DOES have is the first hello on a socket: that creates the mapping
  // instead of replacing one, so it can strand nothing, and deferring it would leave the
  // tab unregistered — strictly worse than the race.
  const entry = sendHelloFn.getText(sf);
  assert.match(entry, /rehelloGate\.request\(\)/, "a re-advertise must be routed through the gate");
  assert.match(
    entry,
    /sock !== advertisedSock/,
    "…and only the first hello on a socket may bypass it, keyed on the socket that has one",
  );
  // `advertisedSock` must be recorded on the SEND-LANDED path only. Arming the gate off a
  // hello that never left the tab would defer the retry that could actually register it —
  // the "recorded before it happened" defect this file names in three other places.
  const advBody = advertiseFn.getText(sf);
  const sentAt = advBody.indexOf("if (sent) {");
  const armAt = advBody.indexOf("advertisedSock = target;");
  assert.ok(sentAt !== -1 && armAt !== -1 && armAt > sentAt, "the gate arms only once a hello LANDED");

  // The clock must be the monotonic one. A wall clock can step backwards (NTP, a laptop
  // waking, a manual change) and an elapsed-time window built on it either expires
  // instantly or never — the same rule as monotonicNow()'s other consumers.
  assert.match(gateCall.getText(sf), /now:\s*monotonicNow/, "the budget is elapsed time, so it needs a monotonic clock");

  // A parked hello belongs to the connection it was queued for. Every teardown path must
  // drop it: setUrl (pointing at a DIFFERENT bridge — firing there would register this tab
  // somewhere nobody asked for, the corruption class #508 refuses to risk), stop, destroy
  // (a timer firing from a closure nothing owns any more), and — codex P2 — the ordinary
  // socket close, which is the only one of the four that recovers by RECONNECTING rather
  // than by tearing the client down, and so was the one that let a replacement socket
  // inherit its predecessor's gate state.
  assert.equal(
    (src.match(/^\s*rehelloGate\.cancel\(\);/gm) || []).length,
    4,
    "setUrl, stop, destroy and an active close must each drop a parked re-advertise",
  );
  assert.equal(
    (src.match(/^\s*advertisedSock = null;/gm) || []).length,
    4,
    "…and each must forget the socket that had a mapping, so the next hello is a first one",
  );
});

test("#1095: the workflow poll commits its state INLINE — it no longer gates anything", () => {
  // Review's third finding on the first cut. `panelHooks.applyChatScope` nulls
  // `currentWorkflowId`, calls this, and then repaints the context ring and announces the
  // scope change — it expects the re-bind to have happened. A deferred early return
  // announced a re-bind that had not, leaving the panel internally inconsistent until a
  // later tick repaired it. With the wait inside sendHello, only the wire send is delayed.
  const src = readFileSync(PANEL_JS, "utf8");
  const wStart = src.indexOf("function onWorkflowMaybeChanged() {");
  const wEnd = src.indexOf("\n  }", wStart);
  assert.ok(wStart !== -1 && wEnd !== -1, "could not bound onWorkflowMaybeChanged");
  const body = src.slice(wStart, wEnd);
  assert.match(body, /^\s*currentWorkflowId = /m, "the re-target must still commit the new workflow id");
  assert.equal(
    /commandsInFlight/.test(body.replace(/\/\/[^\n]*/g, "")),
    false,
    "the poll must not decide for itself whether to re-target — that is sendHello's job now",
  );
});
