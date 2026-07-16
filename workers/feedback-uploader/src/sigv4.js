/**
 * sigv4.js — minimal, dependency-free AWS Signature Version 4 signer.
 *
 * Uses only Web Crypto (`crypto.subtle`), which exists in Cloudflare Workers
 * and in Node 18+ — so the same code runs in the Worker and under plain
 * `node --test` (see test/sigv4.test.mjs, which pins the signer to AWS's
 * published SigV4 test vector).
 *
 * Scope: exactly what the feedback uploader needs (header-signed requests,
 * single-chunk payload). Not a general SDK replacement.
 */

const enc = new TextEncoder();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a string or byte array, as lowercase hex. */
export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

async function hmac(key, data) {
  const rawKey = typeof key === "string" ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data)));
}

/** RFC 3986 encoding (what SigV4 canonicalization requires — stricter than
 *  encodeURIComponent, which leaves !'()* unescaped). */
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // malformed escape — canonicalize what we were given
  }
}

/** 20150830T123600Z */
function toAmzDate(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Sign an HTTP request with SigV4. Returns the complete header set to send
 * (input headers + host + x-amz-date [+ x-amz-content-sha256 for s3] +
 * authorization).
 *
 * @param {object} args
 * @param {string} args.method e.g. "PUT"
 * @param {string} args.url absolute URL (query string included)
 * @param {Record<string, string>} [args.headers] extra headers to sign (e.g. content-type)
 * @param {string} [args.body] request body ("" when absent)
 * @param {string} args.accessKeyId
 * @param {string} args.secretAccessKey
 * @param {string} args.region e.g. "us-east-1"
 * @param {string} [args.service] default "s3"
 * @param {Date} [args.date] override for tests
 * @returns {Promise<Record<string, string>>} headers including `authorization`
 */
export async function signRequest({
  method,
  url,
  headers = {},
  body = "",
  accessKeyId,
  secretAccessKey,
  region,
  service = "s3",
  date = new Date(),
}) {
  const u = new URL(url);
  const amzDate = toAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(body);

  const hdrs = { host: u.host, "x-amz-date": amzDate };
  for (const [k, v] of Object.entries(headers)) hdrs[k.toLowerCase()] = String(v);
  // S3 requires the payload hash as a header; other services (the test vector
  // uses iam) sign without it.
  if (service === "s3") hdrs["x-amz-content-sha256"] = payloadHash;

  const signedHeaderNames = Object.keys(hdrs).sort();
  const canonicalHeaders = signedHeaderNames
    .map((k) => `${k}:${hdrs[k].trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const canonicalPath =
    u.pathname
      .split("/")
      .map((seg) => encodeRfc3986(safeDecode(seg)))
      .join("/") || "/";

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let key = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  key = await hmac(key, region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  return {
    ...hdrs,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
