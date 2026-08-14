// #1188 — the three `/upload/image` sites, bounded.
//
// Same failure as #1161/#1180: after a ComfyUI restart the tab can hold a half-open
// connection where a request neither answers nor fails, so there is nothing for the
// existing `try/catch` to catch. Here it wedges the composer: `att.ready` catches
// everything internally so it never REJECTS — it simply never settles — and the send path
// awaits `Promise.all(pending.map((a) => a.ready))`. The user cannot send at all.
//
// Unlike the credentials frame (cmcp-secrets-bound.test.mjs), the logic here lives in an
// importable module, so most of this is BEHAVIOURAL. Source assertions are used only for
// the three monolith call sites, which cannot be constructed outside the panel IIFE.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { withTimeout } from "../../web/js/lib/bounded-step.js";
import {
  uploadBoundMs,
  boundedUpload,
  describeUploadTimeout,
  describeTimedOutUpload,
  readFileFacts,
  readErrorBody,
  UPLOAD_NO_ANSWER,
  UPLOAD_STALL_FLOOR_MS,
  UPLOAD_MIN_BYTES_PER_MS,
  MAX_TIMER_MS,
} from "../../web/js/lib/attachment-upload.js";

const SRC = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);

/** A promise that never settles — the half-open connection, modelled. */
const NEVER = () => new Promise(() => {});

// ── the bound itself ────────────────────────────────────────────────────────────────

test("#1188 uploadBoundMs never returns a non-positive number", () => {
  // `withTimeout` treats a non-positive ms as NO BOUND and returns the promise unchanged
  // (bounded-step.js:71), so any input that drove this to 0 or below would silently restore
  // the hang while every other assertion here still passed. That exact class of mutation
  // survived on #1180 until it was asserted for.
  for (const size of [0, -1, -99999, null, undefined, "", NaN, Infinity, -Infinity, "abc", {}, []]) {
    const ms = uploadBoundMs(size);
    assert.ok(Number.isFinite(ms) && ms > 0, `uploadBoundMs(${String(size)}) returned ${ms}`);
  }
  // A caller cannot disable the bound through the options object either.
  assert.ok(uploadBoundMs(1024, { floorMs: 0, bytesPerMs: 0 }) > 0, "a zeroed floor must not disarm it");
  assert.ok(uploadBoundMs(1024, { floorMs: -5, bytesPerMs: -5 }) > 0, "…nor a negative one");
});

test("#1188 an unknown size yields the floor rather than a fabricated allowance", () => {
  // describeSize's rule: an unmeasured value must be ABSENT, not zero. Coercing null to 0
  // here would produce the floor anyway, but by accident — pin the intent.
  assert.equal(uploadBoundMs(null), UPLOAD_STALL_FLOOR_MS);
  assert.equal(uploadBoundMs(undefined), UPLOAD_STALL_FLOOR_MS);
  assert.equal(uploadBoundMs(""), UPLOAD_STALL_FLOOR_MS);
});

test("#1188 the bound scales with the payload, so video is not cut off", () => {
  // The reason this is not a flat number: handleMediaUpload exists specifically for video.
  // A flat bound either refuses a legitimate large upload or waits absurdly long for a
  // small one.
  const small = uploadBoundMs(100 * 1024); // 100 KB
  const large = uploadBoundMs(500 * 1024 * 1024); // 500 MB
  assert.ok(large > small, "a larger payload must get a larger allowance");
  assert.ok(small >= UPLOAD_STALL_FLOOR_MS, "…and nothing may fall below the floor");
  // The allowance is exactly the floor plus the transfer time at the throughput floor.
  assert.equal(uploadBoundMs(1000), UPLOAD_STALL_FLOOR_MS + Math.ceil(1000 / UPLOAD_MIN_BYTES_PER_MS));
  // A pathological size must stay a finite number, not become Infinity/NaN — those are
  // non-positive-adjacent failures that would reach withTimeout and arm setTimeout(fn, NaN),
  // which fires immediately and would refuse every upload.
  assert.ok(Number.isFinite(uploadBoundMs(Number.MAX_SAFE_INTEGER)), "a huge size must stay finite");
});

test("#1188 the bound stays inside what setTimeout can actually hold", () => {
  // Above 2^31-1 ms setTimeout overflows a 32-bit signed int and coerces the delay to 1ms,
  // so an allowance so generous it should never fire becomes a bound that refuses EVERY
  // upload instantly — the failure arriving through the mechanism meant to prevent it.
  // Measured directly rather than asserted from the spec: node reports _idleTimeout 1 for
  // a delay of MAX_SAFE_INTEGER.
  for (const size of [Number.MAX_SAFE_INTEGER, Number.MAX_VALUE, 1e30]) {
    const ms = uploadBoundMs(size);
    assert.ok(ms > 0 && ms <= MAX_TIMER_MS, `uploadBoundMs(${size}) = ${ms} is not a usable delay`);
  }
  // The options object is caller-reachable and can otherwise produce Infinity.
  const viaOptions = uploadBoundMs(Number.MAX_VALUE, { floorMs: Number.MAX_VALUE, bytesPerMs: 1 });
  assert.ok(Number.isFinite(viaOptions) && viaOptions <= MAX_TIMER_MS, `options produced ${viaOptions}`);
  assert.ok(Number.isFinite(uploadBoundMs(1, { bytesPerMs: Number.MIN_VALUE })), "a tiny rate must not overflow");
});

// ── measurements that may themselves fail ───────────────────────────────────────────

test("#1188 readFileFacts survives a File whose getters throw", () => {
  // The trap this closes: the bare reads throw at the top of the upload path, and then throw
  // AGAIN inside the catch that reports the failure, because that catch describes the file.
  // The exception escapes the handler and `att.ready` REJECTS — which the send path awaits
  // via Promise.all and is not built to handle.
  const hostile = {
    get size() { throw new Error("revoked"); },
    get type() { throw new Error("revoked"); },
  };
  const facts = readFileFacts(hostile);
  assert.equal(facts.size, undefined, "an unreadable size must be ABSENT, not a fabricated 0");
  assert.equal(facts.mediaType, "");
  // A half-hostile file still yields the half that reads.
  const partial = { size: 4096, get type() { throw new Error("revoked"); } };
  assert.equal(readFileFacts(partial).size, 4096);
  // …and the absent size flows through to a description that simply omits it, rather than
  // claiming "0 B" — describeSize's rule.
  assert.doesNotMatch(describeUploadTimeout({ name: "x.png", ...readFileFacts(hostile) }), /0 B/);
  for (const bad of [null, undefined, 0, "", false]) {
    assert.doesNotThrow(() => readFileFacts(bad), `readFileFacts(${String(bad)}) threw`);
  }
});

test("#1188 a stalled error body never costs us the status we already have", async () => {
  // #756's whole point was that "the status was in hand and thrown away". A body read that
  // stalls inside the OUTER upload bound would do exactly that by a new route: the outer
  // bound fires and a known HTTP 413 is reported to the user as "no response".
  const stalled = { text: () => new Promise(() => {}) };
  assert.equal(await readErrorBody(stalled, withTimeout, 20), null, "a stalled body must give up");
  // A body that arrives is still read.
  assert.equal(await readErrorBody({ text: async () => "too large" }, withTimeout, 5000), "too large");
  // A body that rejects degrades the same way, not into a throw the caller must catch.
  assert.equal(await readErrorBody({ text: async () => { throw new Error("x"); } }, withTimeout, 5000), null);
  // A response object that is not one at all must not throw either.
  assert.equal(await readErrorBody({}, withTimeout, 5000), null);
  assert.equal(await readErrorBody(null, withTimeout, 5000), null);
});

// ── the bounded exchange ────────────────────────────────────────────────────────────

test("#1188 a request that never answers resolves the sentinel, not a hang", async () => {
  const out = await boundedUpload(NEVER, { size: 1, withTimeout, boundMs: 20 });
  assert.equal(out, UPLOAD_NO_ANSWER);
});

test("#1188 the bound covers the BODY, not just the response head", async () => {
  // `fetch` resolves as soon as the head arrives; the bytes stream afterwards inside
  // `json()`. Bounding the request alone leaves the part that actually waits unbounded —
  // exactly what shipped in #1180's first attempt at the log read, and it passed review
  // because the test stalled the HANDSHAKE rather than the body.
  let headArrived = false;
  const out = await boundedUpload(
    async () => {
      const res = { status: 200, json: NEVER }; // head fine, body never streams
      headArrived = true;
      return { info: await res.json() };
    },
    { size: 1, withTimeout, boundMs: 20 },
  );
  assert.ok(headArrived, "the request half must have completed — otherwise this proves nothing");
  assert.equal(out, UPLOAD_NO_ANSWER, "a body that never streams must still hit the bound");
});

test("#1188 a real failure keeps its own cause instead of becoming a timeout", async () => {
  // REIFY BEFORE BOUNDING. `withTimeout` never rejects by contract — it degrades a rejection
  // through onTimeout() exactly as it does a timeout — so handing it run() directly would
  // collapse "it threw" into "it never answered" and lose the error. #756's tests pin the
  // wording that describeUploadFailure({ error }) produces from that cause.
  const boom = new TypeError("Failed to fetch");
  await assert.rejects(
    () => boundedUpload(async () => { throw boom; }, { size: 1, withTimeout, boundMs: 5000 }),
    (err) => err === boom,
  );
});

test("#1188 a value that resolves in time passes through untouched", async () => {
  const ref = { filename: "a.png", subfolder: undefined, type: "input" };
  const out = await boundedUpload(async () => ref, { size: 1, withTimeout, boundMs: 5000 });
  assert.equal(out, ref, "the happy path must be byte-identical to the unbounded original");
  // null is a legitimate return here (uploadBlobToInput's non-200 branch) and must NOT be
  // confused with the sentinel.
  assert.equal(await boundedUpload(async () => null, { size: 1, withTimeout, boundMs: 5000 }), null);
});

test("#1188 the sentinel is unforgeable", () => {
  // A string or plain object could collide with a real upload result. ComfyUI's /upload/image
  // answers with arbitrary JSON.
  assert.equal(typeof UPLOAD_NO_ANSWER, "symbol");
});

test("#1188 a missing withTimeout fails loudly instead of running unbounded", async () => {
  // Degrading to an unbounded run would be the one outcome this exists to prevent, arriving
  // through the mechanism meant to prevent it — the failure #1191 recorded as "a guard can
  // cause what it reports".
  await assert.rejects(() => boundedUpload(NEVER, { size: 1 }), /requires withTimeout/);
  await assert.rejects(() => boundedUpload(NEVER, { size: 1, withTimeout: null }), /requires withTimeout/);
});

test("#1188 the ms handed to withTimeout is positive for every caller shape", async () => {
  // The bound-zero mutation, caught at the boundary rather than inferred from behaviour.
  const seen = [];
  const spy = (p, ms, onTimeout) => { seen.push(ms); return withTimeout(p, ms, onTimeout); };
  for (const size of [undefined, null, 0, -1, 12, 5 * 1024 * 1024]) {
    await boundedUpload(async () => "ok", { size, withTimeout: spy });
  }
  assert.ok(seen.length === 6, `expected 6 bounded calls, saw ${seen.length}`);
  for (const ms of seen) assert.ok(Number.isFinite(ms) && ms > 0, `withTimeout received ${ms}`);
});

test("#1188 a timeout is described as the transport failure it is a species of", () => {
  const msg = describeUploadTimeout({ name: "clip.mp4", size: 4096, mediaType: "video/mp4", boundMs: 30000 });
  // Routed through describeUploadFailure's `error` branch so it reads with the same shape as
  // #756's transport text — including the part that is precisely true here: the bound does
  // not cancel, so whether bytes reached the server is genuinely unknown.
  assert.match(msg, /did not COMPLETE/);
  assert.match(msg, /clip\.mp4/);
  assert.match(msg, /30s/, "the user must be told how long was waited");
  assert.match(msg, /Whether any bytes reached the server is unknown/);
});

test("#1188 a status observed before the OUTER bound fires is still reported", async () => {
  // The race the first fix missed. Giving the body its own shorter bound is not enough,
  // because that bound runs INSIDE the outer one: a response head arriving near the outer
  // deadline with a body that then stalls lets the OUTER bound fire first, and a known
  // HTTP 413 was about to be reported as "no response". Evidence already gathered must
  // outrank the bound's verdict — the bound knows only that IT stopped waiting.
  const observed = {};
  const outcome = await boundedUpload(
    async () => {
      // head arrives just under the outer deadline…
      await new Promise((r) => setTimeout(r, 25));
      observed.status = 413;
      observed.statusText = "Payload Too Large";
      observed.body = await readErrorBody({ text: () => new Promise(() => {}) }, withTimeout, 5000);
      return { failure: "unreachable — the outer bound fires first" };
    },
    { size: 1, withTimeout, boundMs: 40 },
  );
  assert.equal(outcome, UPLOAD_NO_ANSWER, "the outer bound must win this race — otherwise nothing is proven");
  const msg = describeTimedOutUpload({ observed, name: "big.png", size: 4096, mediaType: "image/png" });
  assert.match(msg, /HTTP 413/, "the status we already held must survive the outer timeout");
  assert.match(msg, /Payload Too Large/);
  assert.doesNotMatch(msg, /no response within/, "…and must NOT be downgraded to a transport timeout");
  // A body that never arrived degrades to the existing body-less refusal wording.
  assert.match(msg, /sent no body explaining it/);
});

test("#1188 a genuine no-answer still reads as a transport timeout", () => {
  // The floor case for the assertion above: with nothing observed, the timeout wording is
  // still correct. Without this, describeTimedOutUpload could report "HTTP undefined".
  const msg = describeTimedOutUpload({ observed: {}, name: "x.png", size: 10, mediaType: "image/png", boundMs: 30000 });
  assert.match(msg, /did not COMPLETE/);
  assert.doesNotMatch(msg, /HTTP/);
  // And a malformed record must not be mistaken for a real status. The check is "is it a
  // status", not "does it coerce to a number": 0, false and [] all coerce finitely and were
  // rendering as `HTTP 0`, `HTTP false` and a blank status — invented server answers from
  // the function whose job is to tell an answer from silence.
  const notStatuses = [
    undefined, null, "", "   ", NaN, Infinity, -1, 0, 99, 600, 1000, 4.5,
    false, true, [], {}, "nope", "413 Payload Too Large", () => 413,
  ];
  for (const status of notStatuses) {
    const msg = describeTimedOutUpload({ observed: { status }, name: "x", size: 10 });
    assert.match(msg, /did not COMPLETE/, `status ${String(status)} was treated as real`);
    assert.doesNotMatch(msg, /REFUSED/, `status ${String(status)} produced an invented refusal`);
  }
  // …while a status that genuinely denotes a refusal IS honoured, in either representation.
  for (const status of [400, 404, 413, 500, 599, "413"]) {
    assert.match(
      describeTimedOutUpload({ observed: { status }, name: "x" }),
      /REFUSED/,
      `a real refusal status ${String(status)} was thrown away`,
    );
  }
  // A 1xx/2xx/3xx is a status but NOT a refusal, and describeUploadFailure's status branch
  // words itself as "upload REFUSED … Nothing was written to input/" — a lie about a 200.
  // A 200 whose body never finished streaming is a timeout, and reads as one.
  for (const status of [100, 200, 201, 204, 302, 399]) {
    const msg = describeTimedOutUpload({ observed: { status }, name: "x", size: 10 });
    assert.match(msg, /did not COMPLETE/, `status ${status} should not read as a refusal`);
    assert.doesNotMatch(msg, /REFUSED|Nothing was written/, `status ${status} fabricated a refusal`);
  }
});

// ── the three monolith call sites ───────────────────────────────────────────────────

/** Source with comment lines removed. The comments here NAME the calls they explain, so a
 *  raw scan matches prose and a mutation that moves real code into a comment slips through.
 *  One did on #1180: replacing a throw with a return while leaving `// was: throw …` behind
 *  passed every assertion. */
const CODE = SRC.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

test("#1188 no /upload/image call site bypasses the bound", () => {
  // The whole fix in one line: if a raw request to that endpoint survives outside a bounded
  // callback, that site is still unbounded no matter how good the helper is.
  const calls = CODE.split("\n").filter((l) => /await api\.fetchApi\("\/upload\/image"/.test(l));
  assert.equal(calls.length, 3, `expected exactly 3 upload sites, saw ${calls.length}`);
  const bounded = (CODE.match(/await boundedUpload\(/g) || []).length;
  assert.equal(bounded, 3, `expected all 3 to go through boundedUpload, saw ${bounded}`);
});

test("#1188 each upload site's body read sits INSIDE the bounded callback", () => {
  // Same trap as the credentials helper: bounding the request while awaiting res.json()
  // afterwards leaves the waiting part unbounded and still passes a handshake-stalling test.
  // Anchored on the options argument rather than on closing-brace indentation: the three
  // sites sit at different nesting depths, and an indentation-coupled window silently
  // matched the wrong span for two of them.
  // "{ size" matches both the explicit `{ size: blob?.size, … }` and the shorthand
  // `{ size, … }` the composer sites use after hoisting the read.
  const sites = CODE.split("await boundedUpload(").slice(1).map((chunk) => {
    const end = chunk.indexOf("{ size");
    assert.ok(end > 0, "each bounded call must pass its options object");
    return chunk.slice(0, end);
  });
  assert.equal(sites.length, 3, `expected 3 bounded callbacks, matched ${sites.length}`);
  for (const body of sites) {
    assert.match(body, /async \(\) => \{/, "the exchange must be a callback, not a bare promise");
    assert.match(body, /await api\.fetchApi\("\/upload\/image"/, "the request must be inside");
    assert.match(body, /await res\.json\(\)/, "…and so must the body read");
  }
});

test("#1188 every uploadBlobToInput caller branches on the null it can now return", () => {
  // The claim "all callers already branch on a null ref" was made in a comment before it was
  // checked, and it was false on both halves: there are FIVE sites, not four, and civitai's
  // did not branch at all. Muted, it announced "Saved {name} to ComfyUI inputs." for an
  // upload that wrote nothing; unmuted, it dereferenced `ref.filename`. Counted here so the
  // claim cannot rot back into a guess.
  const sites = [
    ["web/js/cmcp-apps-ui.js", /const ref = await uploadBlobToInput\(/],
    ["web/js/cmcp-civitai-ui.js", /const ref = await ctx\.uploadBlobToInput\(/],
    ["web/js/cmcp-training-ui.js", /ctx\.uploadBlobToInput\(/],
    ["web/js/lib/media-preview.js", /const ref = await uploadBlobToInput\(/],
    ["web/js/lib/run-completion-frame.js", /const ref = await uploadBlobToInput\(/],
  ];
  for (const [rel, call] of sites) {
    const raw = readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");
    // Measure CODE distance, not text distance. This repo writes long explanatory comments,
    // and one of them sits between civitai's call and its guard — a raw character window
    // put the guard out of range and failed a site that is actually correct.
    const src = raw.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    const at = src.search(call);
    assert.ok(at >= 0, `${rel} no longer calls uploadBlobToInput — update this list`);
    // SCOPED to the 400 code-characters after the call. An unscoped search over the whole
    // file was vacuous: media-preview.js has unrelated `!ref`/`ref ?` expressions ~340 lines
    // above its upload, so the assertion passed even with the real guard deleted. A test
    // that cannot fail is worse than no test, because it reads as coverage.
    assert.match(
      src.slice(at, at + 400),
      /if \(!ref\)|!ref\b|ref \?|ref &&|typeof ref/,
      `${rel} does not branch on a null ref within 400 code-chars of the call`,
    );
  }
  // …and the civitai path specifically, because it is the one that was wrong.
  const civitai = readFileSync(fileURLToPath(new URL("../../web/js/cmcp-civitai-ui.js", import.meta.url)), "utf8");
  const at = civitai.indexOf("const ref = await ctx.uploadBlobToInput(");
  const guard = civitai.indexOf("if (!ref)", at);
  const muted = civitai.indexOf("ctx.isMuted()", at);
  assert.ok(guard > at && guard < muted, "civitai must refuse a null ref BEFORE announcing a save");
});

test("#1188 uploadBlobToInput still answers null, so no caller learns a new shape", () => {
  // FIVE callers, enumerated and asserted in the test above — this comment said "four" until
  // a review counted them, which is the same unchecked claim the source comment carried.
  // Returning the sentinel to them instead would make `!ref` false and send a Symbol into
  // `viewUrl`.
  assert.match(
    CODE,
    /return out === UPLOAD_NO_ANSWER \? null : out;/,
    "the sentinel must be collapsed to the existing failure value",
  );
});

test("#1188 the composer reads each file's measurements once, defensively", () => {
  // Passing the size to the bound added a read on the HAPPY path, where the original only
  // read it on the non-200 branch — widening a throwing-getter trap from rare to universal.
  const hoisted = (CODE.match(/const \{ size, mediaType \} = readFileFacts\(file\);/g) || []).length;
  assert.equal(hoisted, 2, `both composer sites must hoist the read, saw ${hoisted}`);
  // And the bound must be given that hoisted value, not a fresh `file.size` read.
  assert.equal(
    (CODE.match(/\{ size, withTimeout \},/g) || []).length,
    2,
    "both bounded calls must use the hoisted size",
  );
});

test("#1188 a refusal's body is bounded separately from the upload", () => {
  // Otherwise a stalled explanation drags a KNOWN status into the outer bound and it gets
  // reported as "no response" — #756's defect, reintroduced by #1188's own fix.
  assert.equal(
    (CODE.match(/body: \(observed\.body = await readErrorBody\(res, withTimeout\)\),/g) || []).length,
    2,
    "both composer sites must bound the error body on its own, recording it as they go",
  );
  assert.equal(
    (CODE.match(/body: await res\.text\(\)\.catch\(\(\) => null\),/g) || []).length,
    0,
    "no site may read a refusal body under the outer bound alone",
  );
});

test("#1188 the composer's two sites report the timeout instead of silently succeeding", () => {
  // A sentinel falling through to the success branch would set att.inputRef from
  // `outcome.info` on an undefined `info` and throw a TypeError the user cannot act on.
  const guards = (CODE.match(/if \(outcome === UPLOAD_NO_ANSWER\) \{/g) || []).length;
  assert.equal(guards, 2, `both composer sites must branch on the sentinel, saw ${guards}`);
  // describeTimedOutUpload, NOT describeUploadTimeout: the timeout branch must consult the
  // status the callback recorded before falling back to the transport wording.
  const reported = (CODE.match(/att\.uploadError = describeTimedOutUpload\(\{ observed,/g) || []).length;
  assert.equal(reported, 2, `…and both must say so, saw ${reported}`);
  assert.equal(
    (CODE.match(/att\.uploadError = describeUploadTimeout\(/g) || []).length,
    0,
    "no site may report a timeout without first checking what was observed",
  );
});

test("#1188 both composer sites record the status before awaiting the body", () => {
  // Order matters: recording after the body read would leave the record empty in exactly
  // the race it exists for.
  const sites = CODE.split('await boundedUpload(').slice(1);
  const composer = sites.filter((c) => c.includes('observed.status = res.status;'));
  assert.equal(composer.length, 2, `both composer sites must record the status, saw ${composer.length}`);
  for (const body of composer) {
    const rec = body.indexOf('observed.status = res.status;');
    const read = body.indexOf('readErrorBody(');
    assert.ok(rec >= 0 && read > rec, 'the status must be recorded BEFORE the body is awaited');
  }
  assert.equal((CODE.match(/const observed = {};/g) || []).length, 2, 'each site needs its own record');
});
