// Per-object node incarnation identity for graph read/write fences (#2478).
//
// The identity deliberately lives outside LiteGraph node data. A workflow can
// contain arbitrary serialized fields, so a value copied from the node itself
// would not prove that the panel is still holding the same live object. A
// WeakMap gives one stable token to one live node object and necessarily gives
// a replacement object a different token, even when its id and type are equal.
// This is a local correctness witness, not an attestation or security boundary.

const NODE_IDENTITIES = new WeakMap();
let fallbackCounter = 0;

function randomIdentity() {
  try {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.randomUUID === "function") {
      const uuid = cryptoApi.randomUUID();
      if (typeof uuid === "string" && uuid) return `node-incarnation:${uuid}`;
    }
    if (typeof cryptoApi?.getRandomValues === "function") {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      if (hex) return `node-incarnation:${hex}`;
    }
  } catch {
    // A local fallback still gives stable per-object identity when the host's
    // randomness API is unavailable or temporarily throws.
  }
  fallbackCounter += 1;
  return `node-incarnation:${Date.now().toString(36)}:${fallbackCounter.toString(36)}`;
}

/** Return the panel-owned identity of a live node object, or null for bad input. */
export function nodeInstanceIdentity(node) {
  if ((typeof node !== "object" || node === null) && typeof node !== "function") return null;
  let identity = NODE_IDENTITIES.get(node);
  if (!identity) {
    identity = randomIdentity();
    NODE_IDENTITIES.set(node, identity);
  }
  return identity;
}
