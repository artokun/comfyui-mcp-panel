import { test } from "node:test";
import assert from "node:assert/strict";
import { signRequest, sha256Hex } from "../src/sigv4.js";

// AWS's published SigV4 test vector ("Example: signature calculations",
// AWS General Reference — Signature Version 4). If the signer drifts from
// the spec, this pins it.
const VECTOR = {
  method: "GET",
  url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
  headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
  body: "",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "iam",
  date: new Date("2015-08-30T12:36:00Z"),
};

test("matches AWS's published SigV4 test vector", async () => {
  const headers = await signRequest(VECTOR);
  assert.equal(headers["x-amz-date"], "20150830T123600Z");
  assert.equal(headers.host, "iam.amazonaws.com");
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
      "SignedHeaders=content-type;host;x-amz-date, " +
      "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
  );
});

test("empty-payload hash is the well-known SHA-256 of the empty string", async () => {
  assert.equal(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});

test("s3 service adds and signs x-amz-content-sha256", async () => {
  const headers = await signRequest({
    method: "PUT",
    url: "https://my-bucket.s3.us-east-1.amazonaws.com/feedback/2026/07/15/good-abc.json",
    headers: { "content-type": "application/json" },
    body: '{"ok":true}',
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    date: new Date("2026-07-15T00:00:00Z"),
  });
  assert.equal(headers["x-amz-content-sha256"], await sha256Hex('{"ok":true}'));
  assert.match(headers.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,/);
  assert.match(headers.authorization, /Credential=AKIDEXAMPLE\/20260715\/us-east-1\/s3\/aws4_request,/);
});

test("signing is deterministic for identical inputs", async () => {
  const a = await signRequest(VECTOR);
  const b = await signRequest(VECTOR);
  assert.equal(a.authorization, b.authorization);
});
