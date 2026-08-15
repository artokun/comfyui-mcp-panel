/**
 * #952 (second half) — withdrawing an interactive card must END the command behind it.
 *
 * A CORRECTION to the trace on the issue comes first, because the shipped design rests on
 * it. That comment said a tab which disconnects mid-command "reconnects on a new socket
 * with a new epoch", so a retry lands in a different ledger scope and fails open into a
 * duplicate card. The orchestrator mints `SESSION_EPOCH` once per PROCESS, so a tab
 * reconnecting to the same process carries the SAME scope — the scope only changes across
 * an orchestrator restart. "Dedupe interactive cards on a scope that survives a reconnect"
 * was therefore a no-op: it already does.
 *
 * What is real is underneath it. `ask_user` / `request_secret` are the only commands whose
 * executor blocks on a human, and retirement (0.13.0) deliberately does not resolve the
 * card's promise. So the executor stays suspended forever, `settleRid` never runs, and the
 * ledger keeps an IN-FLIGHT entry — which is never evicted, by design, because dropping an
 * unsettled command would let its replay double-apply. Two consequences, both tested here:
 * the entry is unreclaimable, and a redelivery of that rid awaits a promise that can never
 * resolve, so the panel answers NOTHING at all.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  INTERACTIVE_ABANDONED,
  abandonedInteractiveError,
  isAbandonedInteractive,
} from "../../web/js/lib/interactive-abandon.js";
import { createCommandDedupeLedger } from "../../web/js/lib/command-dedupe.js";
import { redactSensitiveReply } from "../../web/js/lib/command-liveness.js";

const PANEL = new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url);

test("#952 the sentinel cannot be produced by a user's own answer", () => {
  // The question card's "Other…" field accepts arbitrary text, so a sentinel a human can
  // type is a sentinel a human can forge into an answer that fails their own command.
  assert.equal(typeof INTERACTIVE_ABANDONED, "symbol");
  for (const answer of [
    "Symbol(comfyui-mcp.interactiveAbandoned)",
    "comfyui-mcp.interactiveAbandoned",
    "abandoned",
    "",
    null,
    undefined,
    0,
    false,
    {},
    Symbol("comfyui-mcp.interactiveAbandoned"), // same DESCRIPTION, different symbol
  ]) {
    assert.equal(isAbandonedInteractive(answer), false, String(answer?.toString?.() ?? answer));
  }
  assert.equal(isAbandonedInteractive(INTERACTIVE_ABANDONED), true);
});

test("#952 the sentinel survives the module being evaluated twice", async () => {
  // Registry-backed on purpose: a second module instance holding a private Symbol() would
  // make the sentinel unrecognizable to the executor, silently restoring the hang.
  const again = await import("../../web/js/lib/interactive-abandon.js?dup=1");
  assert.equal(again.INTERACTIVE_ABANDONED, INTERACTIVE_ABANDONED);
  assert.equal(isAbandonedInteractive(again.INTERACTIVE_ABANDONED), true);
});

test("#952 the failure text claims only what withdrawal establishes", () => {
  for (const cmd of ["ask_user", "request_secret"]) {
    const note = abandonedInteractiveError(cmd);
    assert.match(note, /NOTHING WAS ANSWERED/, cmd);
    assert.match(note, /nothing was applied/, cmd);
    assert.match(note, /Re-issue it on the current connection/, cmd);
    // What the panel CANNOT know: whether the person ever looked at the card. Claiming a
    // decline or a dismissal would be a fabricated user action.
    assert.ok(!/declined|dismissed|refused|cancelled|canceled/i.test(note), cmd);
    // And it must not claim an answer exists somewhere, which is what would send a caller
    // hunting for one.
    assert.ok(!/collected|received the answer/i.test(note), cmd);
  }
  assert.match(abandonedInteractiveError("request_secret"), /secret request/);
  assert.match(abandonedInteractiveError("ask_user"), /question/);
});

test("#952 THE DEFECT: an unresolved card strands an in-flight ledger entry forever", async () => {
  // Reproduce the pre-fix shape with the real ledger: begin() a command whose executor
  // never returns, then run a full cap's worth of settled traffic past it.
  const ledger = createCommandDedupeLedger(4);
  ledger.begin("rid-ask", "fp-ask", "epoch-1"); // never settled — the abandoned question
  for (let i = 0; i < 12; i += 1) {
    ledger.begin(`rid-${i}`, `fp-${i}`, "epoch-1")({ rid: `rid-${i}`, ok: true });
  }
  const stranded = ledger.get("rid-ask", "fp-ask", "epoch-1");
  assert.ok(stranded instanceof Promise, "still in-flight after 12 settled commands evicted past cap");

  // And this is why it matters more than a leak: a redelivery of that rid awaits it.
  const raced = await Promise.race([
    stranded.then(() => "answered"),
    new Promise((r) => setTimeout(() => r("hung"), 30)),
  ]);
  assert.equal(raced, "hung", "the replay would wait forever and the panel would send nothing");
});

test("#952 THE FIX: abandoning settles the entry, and a replay learns the outcome", async () => {
  const ledger = createCommandDedupeLedger(4);
  const settle = ledger.begin("rid-ask", "fp-ask", "epoch-1");
  // What the wiring does: the card resolves with the sentinel, the executor recognizes it
  // and fails the command, and that failure settles the rid.
  const cardResult = INTERACTIVE_ABANDONED;
  assert.equal(isAbandonedInteractive(cardResult), true);
  settle({ rid: "rid-ask", ok: false, error: abandonedInteractiveError("ask_user") });

  const replay = await ledger.get("rid-ask", "fp-ask", "epoch-1");
  assert.equal(replay.ok, false, "the replay is answered rather than hanging");
  assert.match(replay.error, /NOTHING WAS ANSWERED/);

  // Settled entries are evictable, so the ledger's bound applies again.
  for (let i = 0; i < 12; i += 1) {
    ledger.begin(`rid-${i}`, `fp-${i}`, "epoch-1")({ rid: `rid-${i}`, ok: true });
  }
  assert.equal(ledger.get("rid-ask", "fp-ask", "epoch-1"), undefined, "aged out like any settled entry");
});

test("#952 a payload-free failure is journaled AS ITSELF, not as 'we collected an answer'", () => {
  // The redaction exists so a successful answer is never replayed onto a different
  // orchestrator. Applied to a FAILURE it asserted a collection that never happened —
  // the caller was told the panel had their answer and could not return it.
  const withdrawn = {
    rid: "r1",
    ok: false,
    error: abandonedInteractiveError("ask_user"),
  };
  assert.deepEqual(redactSensitiveReply(withdrawn, "ask_user"), withdrawn, "passes through");
  assert.deepEqual(
    redactSensitiveReply({ rid: "r2", ok: false, error: "This panel build can't collect secrets." }, "request_secret"),
    { rid: "r2", ok: false, error: "This panel build can't collect secrets." },
    "and so does any other panel-authored failure",
  );
});

test("#952 a reply that CARRIES the answer is still redacted — both commands", () => {
  for (const cmd of ["ask_user", "request_secret"]) {
    const answered = { rid: "r3", ok: true, result: "hunter2" };
    const safe = redactSensitiveReply(answered, cmd);
    assert.equal(safe.ok, false, cmd);
    assert.equal(safe.result, undefined, cmd);
    assert.ok(!JSON.stringify(safe).includes("hunter2"), `${cmd}: no trace of the value`);
    assert.equal(safe.rid, "r3", `${cmd}: still rid-correlated`);
    // The failing shape that motivated the narrowing: `ok:false` WITH a result present.
    // It is not produced today, but the rule is mechanical so it stays covered.
    const oddity = { rid: "r4", ok: false, result: "hunter2" };
    assert.ok(!JSON.stringify(redactSensitiveReply(oddity, cmd)).includes("hunter2"), cmd);
  }
  // Non-sensitive commands are untouched in every case.
  const graph = { rid: "r5", ok: true, result: { node_id: 4 } };
  assert.equal(redactSensitiveReply(graph, "graph_add_node"), graph);
});

test("#952 (codex ×2) the claim is the LEDGER — not a caller-visible recovery", () => {
  // Two drafts were too generous and both were caught here. The first implied the
  // disconnected caller would read "the question was withdrawn"; they do not — the bridge
  // already failed that call, the journal replay finds no pending rid, and the late-ask
  // buffer keeps `msg.ok` only. The second retreated to "a REDELIVERY reads it", which is
  // also not a production path for these two commands: every dispatch mints a fresh rid,
  // `retry_of` is injected only for RETRY_TOKEN_CMDS (which excludes both), and re-asking
  // mints a new `ask_id` that is part of the fingerprint. What survives is narrow: while
  // the settled entry is RETAINED a matching duplicate replays its recorded failure, and
  // settling makes the entry eligible for ordinary cap eviction. Not more — eviction is
  // fail-open, so a duplicate after it ages out executes fresh and blocks on a human again.
  const src = readFileSync(new URL("../../web/js/lib/interactive-abandon.js", import.meta.url), "utf8");
  assert.match(src, /It does NOT rescue the interrupted call/, "the limit is stated, not implied");
  assert.match(src, /the caller\s*(?:\/\/\s*)?never sees the text below/, "and stated concretely");
  assert.match(src, /keeps `msg\.ok` replies only/, "and names the specific orchestrator behaviour");
  assert.match(src, /Treat that branch as\s*(?:\/\/\s*)?defensive/, "the replay branch is not sold as recovery");
  // The claim that IS established, and it is bounded by RETENTION — eviction is fail-open,
  // so a duplicate arriving after the entry ages out executes fresh and blocks on a human
  // again. The eviction test above is that counterexample, so the two must agree.
  assert.match(src, /While the settled \(epoch, rid, fingerprint\) entry is RETAINED/);
  assert.match(src, /eligible for normal cap eviction/);
  assert.match(src, /Eviction is deliberately fail-open/);
  // Scanned across the module AND this file (codex r4): a negative assertion that only
  // polices the source lets the retracted claim survive in the comment that explains it,
  // which is where the next reader would pick it back up.
  const self = readFileSync(new URL("./interactive-abandon.test.mjs", import.meta.url), "utf8");
  for (const overclaim of [
    /the caller (?:learns|is told|sees) (?:that )?the card was withdrawn/i,
    /the only path on which a caller reads it/i,
    /does still reach the handler/i,
    /no (?:later|future) delivery (?:of that rid\s*(?:\/\/\s*)?)?can hang/i,
  ]) {
    assert.ok(!overclaim.test(src), `retracted claim is gone from the module: ${overclaim}`);
    // This file quotes the retracted phrasings inside the regex list itself, so compare
    // against the prose only — everything outside these bracketed patterns.
    const prose = self.replace(/for \(const overclaim of \[[\s\S]*?\]\) \{/, "");
    assert.ok(!overclaim.test(prose), `…and from this test's own comments: ${overclaim}`);
  }
});

test("#952 (codex r4) the trigger is a REPLACEMENT connection, not a bare disconnect", () => {
  // The header used to say the card is retired "when the connection that asked drops".
  // The sweep runs from a `connected` status carrying a different socket id — so a socket
  // that simply drops retires nothing, and the card stays live until something replaces
  // it. Documenting the wrong trigger would have a reader expect an abandonment reply at
  // a moment when none is produced.
  const src = readFileSync(new URL("../../web/js/lib/interactive-abandon.js", import.meta.url), "utf8");
  assert.match(src, /a bare disconnect retires nothing/, "the trigger is stated correctly");
  const panel = readFileSync(PANEL, "utf8");
  assert.match(
    panel,
    /if \(state === "connected"\) retireInteractiveCardsFromPreviousSockets\(\);/,
    "and that is what the wiring does",
  );
});

test("#952 (codex r3) the note does not claim a card that may not be on screen", () => {
  // Retirement returns early when the card is no longer in the DOM, and abandons the
  // command anyway. "The card on screen has been disabled" was therefore false in exactly
  // that case; scoping it to a card that IS still there is true in both.
  for (const cmd of ["ask_user", "request_secret"]) {
    const note = abandonedInteractiveError(cmd);
    assert.match(note, /any card still on screen for it has been disabled/, cmd);
    assert.ok(!/the card on screen has been disabled/.test(note), cmd);
  }
});

test("#952 source: retirement disables the card AND ends its command, in that order", () => {
  const src = readFileSync(PANEL, "utf8");
  const start = src.indexOf("function retireInteractiveCardsFromPreviousSockets()");
  assert.ok(start > 0, "the sweep exists");
  const body = src.slice(start, src.indexOf("\n  }", start));
  const retireAt = body.indexOf("record.retire?.()");
  const abandonAt = body.indexOf("record.abandon?.()");
  assert.ok(retireAt > 0 && abandonAt > 0, "both halves run");
  // ORDER: retirement asks the card whether it was already answered. Abandoning first
  // would make that question unanswerable and skip the visible half.
  assert.ok(retireAt < abandonAt, "retire before abandon");
  // SEPARATE try blocks — one throwing must not skip the other.
  assert.equal((body.match(/try \{/g) ?? []).length, 2, "each half guarded on its own");
});

test("#952 source: the abandon flag is NOT the answered flag", () => {
  const src = readFileSync(PANEL, "utf8");
  for (const fn of ["function paintQuestion(", "function paintSecret("]) {
    const start = src.indexOf(fn);
    assert.ok(start > 0, fn);
    const body = src.slice(start, start + 3000);
    assert.match(body, /let abandoned = false;/, fn);
    assert.match(body, /abandoned = true;\s*\r?\n\s*resolveFn\(INTERACTIVE_ABANDONED\);/, fn);
    // The trap this avoids: retirement checks `alreadyAnswered: () => done`, so an abandon
    // that set `done` would suppress the card's own retirement and leave it looking live.
    assert.ok(
      !/abandon = \(\) => \{[\s\S]{0,200}done = true;/.test(body),
      `${fn}: abandoning must not mark the card answered`,
    );
    // And a late click cannot resolve a promise whose command was already failed.
    assert.match(body, /if \(done \|\| abandoned\) return;/, fn);
  }
});

test("#952 source: both interactive executors recognize the sentinel and throw", () => {
  const src = readFileSync(PANEL, "utf8");
  for (const call of ["onAsk(msg, thisSock.__cmcpSocketId", "onSecret(msg, thisSock.__cmcpSocketId"]) {
    const at = src.indexOf(call);
    assert.ok(at > 0, call);
    const after = src.slice(at, at + 900);
    assert.match(
      after,
      /if \(isAbandonedInteractive\(result\)\) throw new Error\(abandonedInteractiveError\(msg\.cmd\)\);/,
      call,
    );
  }
  // THROWN, not replied directly: the existing catch is what builds the frame, and
  // `settleRid(reply)` runs right after it. A hand-built reply that bypassed the catch
  // would leave the ledger entry in flight — the whole defect.
  const settleAt = src.indexOf("settleRid(reply);");
  const catchAt = src.lastIndexOf("} catch (err) {", settleAt);
  assert.ok(catchAt > 0 && catchAt < settleAt, "the catch feeds the settle");
});
