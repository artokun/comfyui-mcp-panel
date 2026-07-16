import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEEDBACK_SCHEMA,
  MAX_WHY_CHARS,
  scrubText,
  scrubTranscript,
  buildFeedbackPayload,
  createShareModalState,
} from "../../web/js/lib/feedback.js";

// ---------------------------------------------------------------------------
// scrubText — credential material and identity fragments never survive
// ---------------------------------------------------------------------------

test("scrubText redacts ws:// and wss:// bridge URLs entirely", () => {
  const s = scrubText("connect to ws://127.0.0.1:9180 or wss://abc-9180.proxy.example.net/bridge?token=deadbeef now");
  assert.ok(!s.includes("ws://"), s);
  assert.ok(!s.includes("wss://"), s);
  assert.ok(!s.includes("deadbeef"), s);
  assert.ok(s.includes("[bridge-url redacted]"), s);
  assert.ok(s.endsWith(" now"), s); // surrounding prose survives
});

test("scrubText masks sensitive query values but keeps the URL readable", () => {
  const s = scrubText("see https://pod.example.com/view?id=42&token=sekrit123&x=1 and https://a.b/#access_token=abcd1234");
  assert.ok(!s.includes("sekrit123"), s);
  assert.ok(!s.includes("abcd1234"), s);
  assert.ok(s.includes("https://pod.example.com/view?id=42&token=[redacted]&x=1"), s);
});

test("scrubText masks recognizable API-key shapes and Bearer credentials", () => {
  const cases = [
    "key sk-ant-api03-AAAAAAAAAAAAAAAA here",
    "openai sk-proj-AAAABBBBCCCCDDDDEEEE",
    "hf hf_abcdefghijklmnopqrstuvwx",
    "github ghp_ABCDEFGHIJKLMNOP1234",
    "slack xoxb-1234-5678-abcdef",
    "aws AKIAIOSFODNN7EXAMPLE",
    "hdr Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
  ];
  for (const c of cases) {
    const s = scrubText(c);
    assert.ok(s.includes("redacted"), `expected redaction in: ${c} -> ${s}`);
  }
  // The specific token bodies are gone.
  assert.ok(!scrubText("hf hf_abcdefghijklmnopqrstuvwx").includes("hf_abcdefghijklmnopqrstuvwx"));
});

test("scrubText masks bare token/password assignments in prose and pasted config", () => {
  const s = scrubText("set HF token=abc123secret and password: hunter2 in the env");
  assert.ok(!s.includes("abc123secret"), s);
  assert.ok(!s.includes("hunter2"), s);
  assert.ok(s.includes("token=[redacted]"), s);
});

test("scrubText strips home-directory usernames but keeps the useful path tail", () => {
  const win = scrubText("saved to C:\\Users\\joespamley\\comfy\\models\\checkpoints\\x.safetensors");
  assert.ok(!win.includes("joespamley"), win);
  assert.ok(win.includes("models\\checkpoints\\x.safetensors"), win);
  const posix = scrubText("log at /home/joespamley/.comfyui/log.txt and /Users/joespamley/app");
  assert.ok(!posix.includes("joespamley"), posix);
  assert.ok(posix.includes("/home/[user]/"), posix);
  assert.ok(posix.includes("/Users/[user]/"), posix);
});

test("scrubText leaves ordinary prose untouched and tolerates non-strings", () => {
  const plain = "Generate a cyberpunk skyline at 1024x1024 with ksampler settings";
  assert.equal(scrubText(plain), plain);
  assert.equal(scrubText(null), null);
  assert.equal(scrubText(42), 42);
  assert.equal(scrubText(""), "");
});

// ---------------------------------------------------------------------------
// scrubTranscript — token cards dropped, plumbing dropped, size capped
// ---------------------------------------------------------------------------

const sampleMsgs = () => [
  { role: "user", text: "make me an image", mid: "m1" },
  { role: "agent", text: "On it — queueing a workflow." },
  { role: "card", icon: "pi-cog", text: "graph_build", detail: "12 nodes wired" },
  // The panel's token-save card (masked preview) — credential UI, must vanish.
  { role: "card", icon: "pi-lock", text: "HuggingFace token", detail: "saved hf_a…wxyz" },
  { role: "user", text: "use ws://127.0.0.1:9180 please", mid: "m2", rewindAnchor: "u-123" },
];

test("scrubTranscript drops token-prompt (pi-lock) cards entirely", () => {
  const t = scrubTranscript(sampleMsgs());
  assert.equal(t.length, 4);
  assert.ok(!t.some((m) => m.icon === "pi-lock"));
  assert.ok(!JSON.stringify(t).includes("HuggingFace token"));
});

test("scrubTranscript strips mid/rewindAnchor plumbing and scrubs nested strings", () => {
  const t = scrubTranscript(sampleMsgs());
  const json = JSON.stringify(t);
  assert.ok(!json.includes("mid"), json);
  assert.ok(!json.includes("rewindAnchor"), json);
  assert.ok(!json.includes("ws://127.0.0.1"), json);
  assert.ok(json.includes("[bridge-url redacted]"), json);
  // Ordinary content (incl. tool cards) survives — the whole point of sharing.
  assert.ok(json.includes("make me an image"));
  assert.ok(json.includes("graph_build"));
});

test("scrubTranscript scrubs user attachments (pasted text) too", () => {
  const t = scrubTranscript([
    {
      role: "user",
      text: "run with [Pasted text #1]",
      attachments: [{ id: "1", content: "config with token=abc123secret inside https://x.y/?key=zzz" }],
    },
  ]);
  const json = JSON.stringify(t);
  assert.ok(!json.includes("zzz"), json);
  assert.ok(json.includes("attachments"), json); // pasted content itself is kept
});

test("scrubTranscript trims from the OLD end and marks the trim", () => {
  const msgs = [];
  for (let i = 0; i < 50; i++) msgs.push({ role: "agent", text: `message ${i} ${"x".repeat(100)}` });
  const t = scrubTranscript(msgs, { maxChars: 1000 });
  assert.ok(t.length < 51);
  assert.equal(t[0].role, "system");
  assert.match(t[0].text, /trimmed for size/);
  // Newest message always survives.
  assert.ok(JSON.stringify(t).includes("message 49"));
  assert.ok(!JSON.stringify(t).includes("message 0 "));
});

test("scrubTranscript tolerates garbage input", () => {
  assert.deepEqual(scrubTranscript(null), []);
  assert.deepEqual(scrubTranscript("nope"), []);
  assert.deepEqual(scrubTranscript([null, 42, "str", {}, { role: 5 }]), []);
});

// ---------------------------------------------------------------------------
// buildFeedbackPayload — the exact upload shape
// ---------------------------------------------------------------------------

test("buildFeedbackPayload produces the documented schema", () => {
  const p = buildFeedbackPayload({
    verdict: "good",
    why: "  nailed the workflow  ",
    msgs: sampleMsgs(),
    versions: { model: "gemma4:e4b", panel: "0.8.2", backend: "ollama", comfyui: "1.19.9" },
    now: 1752537600000,
  });
  assert.equal(p.schema, FEEDBACK_SCHEMA);
  assert.equal(p.verdict, "good");
  assert.equal(p.why, "nailed the workflow");
  assert.equal(p.timestamp, new Date(1752537600000).toISOString());
  assert.deepEqual(p.versions, {
    model: "gemma4:e4b",
    panel: "0.8.2",
    mcp: null, // orchestrator doesn't report it yet — explicit null, never omitted
    backend: "ollama",
    comfyui: "1.19.9",
  });
  assert.ok(Array.isArray(p.transcript) && p.transcript.length === 4);
  assert.ok(typeof p.id === "string" && p.id.length >= 8);
});

test("payload id is anonymous and random — two payloads never share one", () => {
  const a = buildFeedbackPayload({ verdict: "bad", msgs: [] });
  const b = buildFeedbackPayload({ verdict: "bad", msgs: [] });
  assert.notEqual(a.id, b.id);
});

test("payload contains no account identifiers anywhere", () => {
  const p = buildFeedbackPayload({ verdict: "bad", msgs: sampleMsgs(), versions: { panel: "0.8.2" } });
  const keys = JSON.stringify(Object.keys(p)) + JSON.stringify(Object.keys(p.versions));
  for (const banned of ["email", "user", "account", "token", "hostname"]) {
    assert.ok(!keys.toLowerCase().includes(banned), `unexpected key material: ${banned}`);
  }
});

test("buildFeedbackPayload rejects a missing/invalid verdict", () => {
  assert.throws(() => buildFeedbackPayload({ msgs: [] }), TypeError);
  assert.throws(() => buildFeedbackPayload({ verdict: "meh", msgs: [] }), TypeError);
});

test("why is optional, scrubbed, and capped", () => {
  const none = buildFeedbackPayload({ verdict: "good", msgs: [] });
  assert.ok(!("why" in none));
  const scrubbed = buildFeedbackPayload({ verdict: "bad", msgs: [], why: "it leaked ws://127.0.0.1:9180" });
  assert.ok(!scrubbed.why.includes("ws://"));
  const long = buildFeedbackPayload({ verdict: "bad", msgs: [], why: "y".repeat(MAX_WHY_CHARS + 500) });
  assert.equal(long.why.length, MAX_WHY_CHARS);
});

// ---------------------------------------------------------------------------
// createShareModalState — the good/bad gating the modal relies on
// ---------------------------------------------------------------------------

test("modal state starts unlabeled with submit disabled", () => {
  const s = createShareModalState();
  assert.equal(s.verdict, null);
  assert.equal(s.canSubmit, false);
});

test("modal state enables submit only after an explicit good/bad pick", () => {
  const s = createShareModalState();
  assert.equal(s.setVerdict("excellent"), false); // unknown value rejected
  assert.equal(s.canSubmit, false);
  assert.equal(s.setVerdict("good"), true);
  assert.equal(s.verdict, "good");
  assert.equal(s.canSubmit, true);
  assert.equal(s.setVerdict("bad"), true); // user can change their mind
  assert.equal(s.verdict, "bad");
  // A later bogus value never clobbers a valid pick.
  assert.equal(s.setVerdict(undefined), false);
  assert.equal(s.verdict, "bad");
  assert.equal(s.canSubmit, true);
});

test("modal state carries the optional why text", () => {
  const s = createShareModalState();
  s.setWhy("looped forever");
  assert.equal(s.why, "looped forever");
  s.setWhy(null);
  assert.equal(s.why, "");
});
