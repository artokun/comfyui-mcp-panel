// panel#756 — a chat attachment upload that fails must report WHAT WAS OBSERVED.
//
// Both upload paths threw the outcome away twice: a non-200 had no `else` at all,
// and the `catch` was bare. The agent got the string `upload failed` and nothing
// more — no status, no size, no MIME type, no exception — so two failing .mp4
// uploads could not be diagnosed by anyone, including the reporter.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  describeUploadFailure,
  attachmentSummaryLine,
  clipUploadBody,
  describeSize,
} from "../../web/js/lib/attachment-upload.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

test("#756 a refused upload reports the STATUS and the server's own words", () => {
  const msg = describeUploadFailure({
    status: 413,
    statusText: "Payload Too Large",
    body: "file exceeds max upload size",
    name: "clip.mp4",
    size: 88 * 1024 * 1024,
    mediaType: "video/mp4",
  });
  assert.match(msg, /HTTP 413/);
  assert.match(msg, /Payload Too Large/);
  assert.match(msg, /clip\.mp4/);
  assert.match(msg, /88\.0 MB/, "the size is what tells a caller whether to shrink it");
  assert.match(msg, /video\/mp4/);
  assert.match(msg, /Server said: file exceeds max upload size/);
  assert.match(msg, /Nothing was written to input/);
});

test("#756 it does NOT infer a cause from the status", () => {
  // A 413 is evidence ABOUT size; "the file is too big" is a conclusion. Asserting
  // it is the same defect as the fence claiming "the workflow was switched" for
  // every mismatch (#750) — and it would be wrong for a proxy-imposed limit.
  const msg = describeUploadFailure({ status: 413, name: "a.mp4", size: 10, mediaType: "video/mp4" });
  assert.doesNotMatch(msg, /too big|too large a file|shrink|re-encode|reduce the/i);
  // …and it says plainly that the server explained nothing, rather than filling in.
  assert.match(msg, /sent no body explaining it/);
});

test("#756 a transport failure is reported as a THROW, distinctly from a refusal", () => {
  // The two need different responses: a refusal means the server judged the file,
  // a throw means the request never completed. The old bare catch made them
  // indistinguishable.
  const msg = describeUploadFailure({ error: new TypeError("Failed to fetch"), name: "b.mp4", size: 2048 });
  assert.match(msg, /did not COMPLETE/);
  assert.match(msg, /Failed to fetch/);
  assert.match(msg, /2\.0 KB/);
  assert.doesNotMatch(msg, /HTTP/, "there was no status — do not invent one");
  // Honest about the part that genuinely is unknown.
  assert.match(msg, /Whether any bytes reached the server is unknown/);
});

test("#756 neither observed ⇒ says so, rather than picking the likelier half", () => {
  const msg = describeUploadFailure({ name: "c.mp4" });
  assert.match(msg, /unobserved reason/);
  assert.match(msg, /no HTTP status and no exception were captured/);
  assert.doesNotMatch(msg, /HTTP \d/);
});

test("#756 a huge error body is clipped, with the true length disclosed", () => {
  // This lands in an agent's context; an HTML error page would otherwise paste the
  // whole document into the chat. Truncation that hides its own extent is the
  // silent-omission bug in miniature, so the real length is stated.
  const body = "x".repeat(5000);
  const clipped = clipUploadBody(body);
  assert.ok(clipped.length < 600);
  assert.match(clipped, /\[5000 chars total\]/);
  assert.equal(clipUploadBody("   "), null, "an empty body is absent, not an empty quote");
  assert.equal(clipUploadBody(undefined), null);
});

test("#756 describeSize refuses nonsense instead of rendering it", () => {
  assert.equal(describeSize(512), "512 B");
  assert.equal(describeSize(2048), "2.0 KB");
  assert.equal(describeSize(1572864), "1.5 MB");
  for (const bad of [undefined, null, -1, NaN, "big"]) assert.equal(describeSize(bad), null);
});

test("#756 the SUCCESS line is unchanged — only failure gained detail", () => {
  const line = attachmentSummaryLine({ token: "[Video #3]", inputRef: "sub/clip.mp4" });
  assert.equal(line, "[Video #3] → input/sub/clip.mp4");
});

test("#756 the failure line carries the captured cause, not a bare 'upload failed'", () => {
  const withCause = attachmentSummaryLine({
    token: "[Video #3]",
    name: "clip.mp4",
    uploadError: "upload REFUSED by ComfyUI — HTTP 413. Nothing was written to input/.",
  });
  assert.match(withCause, /HTTP 413/);
  // And with nothing captured it still degrades to the old string rather than
  // rendering "undefined" — a fallback, not a fabrication.
  const bare = attachmentSummaryLine({ token: "[Video #3]", name: "clip.mp4" });
  assert.equal(bare, "[Video #3] (clip.mp4 — upload failed)");
});

test("#756 WIRING: both upload paths record the status and the exception", () => {
  // The helper being right proves nothing if the call sites still discard. Pin the
  // two sites that had the defect, and that neither bare form survives.
  const src = readFileSync(PANEL_JS, "utf8");
  // #1188 moved the exchange inside a bounded callback, so the non-200 description is now
  // BUILT there and assigned by the caller. Same contract — the status must still be
  // captured on both paths — pinned at both ends of the new shape so neither half can be
  // dropped: a `failure:` nobody reads, or an `att.uploadError` fed by something else.
  assert.equal(
    (src.match(/failure: describeUploadFailure\(\{\s*\r?\n?\s*status: res\.status/g) || []).length,
    2,
    "both upload paths must record a non-200 status",
  );
  assert.equal(
    (src.match(/att\.uploadError = outcome\.failure;/g) || []).length,
    2,
    "…and both must surface it as the attachment's error",
  );
  // Window widened from 200 to 500: #1188 added a defensive re-read of the file's
  // measurements inside each catch, which pushed the assignment further from `catch (err) {`.
  // The contract is unchanged — the caught exception must still be what gets reported.
  assert.equal(
    (src.match(/catch \(err\) \{[\s\S]{0,500}?att\.uploadError = describeUploadFailure\(\{ error: err/g) || []).length,
    2,
    "both upload paths must record the caught exception",
  );
  // #1188 — and neither catch may read `file.size`/`file.type` directly. A throwing getter
  // there throws a SECOND time while reporting the first failure, escapes the handler, and
  // rejects `att.ready` — which the send path awaits and cannot handle.
  assert.equal(
    (src.match(/catch \(err\) \{[\s\S]{0,500}?describeUploadFailure\(\{ error: err, name, size: file\.size/g) || []).length,
    0,
    "the reporting catch must not re-read a property that may be what threw",
  );
  assert.ok(
    !src.includes("/* upload failed — the chip still references it by name as a fallback */"),
    "the bare image catch must be gone",
  );
  assert.ok(
    !src.includes("/* upload failed — the chip still names the file as a fallback */"),
    "the bare media catch must be gone",
  );
});

test("#756 WIRING: the agent-facing lines report failure on BOTH branches", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  // media branch routes through the shared builder…
  assert.match(src, /\.map\(\(a\) => attachmentSummaryLine\(a\)\)/);
  // …and the image branch, which used to say NOTHING when the ref was absent.
  assert.match(src, /NOT in input\/ — \$\{a\.uploadError \?\? "upload failed, cause unobserved"\}/);
});
