// openExternalUrl is the panel's ONLY sanctioned way to leave the frame: in the
// ComfyUI desktop (Electron) build a plain in-frame navigation hijacks the whole
// window — no back button, hard-reload to escape.
//
// It prefers a desktop "open externally" bridge and documents a fallback to a new
// browser tab. But that bridge is ASYNC (Electron's shell.openExternal returns a
// Promise), and the function's try/catch only ever covered a SYNCHRONOUS throw. A
// rejected promise escaped it completely: nothing opened, the documented fallback
// never ran, and the failure surfaced only as an unhandled rejection in the console
// — while the caller had already told the user it was opening something. A guard
// that covers one of the two failure shapes is not a guard.
//
// These are BEHAVIOURAL tests. openExternalUrl is a self-contained module-level
// function in a file that cannot be imported (it boots the whole panel against
// ComfyUI globals), so it is extracted from the source and evaluated against a fake
// `window`. Deleting the fix makes them fail; they are not string matching.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "../../web/js/comfyui-mcp-panel.js"), "utf8");

/** Extract `function openExternalUrl(...) { … }` by brace-matching from the source. */
function loadOpenExternalUrl() {
  const start = SRC.indexOf("function openExternalUrl(href) {");
  assert.notEqual(start, -1, "openExternalUrl must exist");
  let depth = 0;
  let end = -1;
  for (let i = SRC.indexOf("{", start); i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.notEqual(end, -1, "openExternalUrl must be brace-balanced");
  // `window` is a parameter, so it shadows any global inside the extracted body.
  return new Function("window", `${SRC.slice(start, end)}; return openExternalUrl;`);
}

/** A fake window whose bridge opener behaves as scripted. */
function fakeWindow(openExternal) {
  const opened = [];
  return {
    win: {
      electronAPI: openExternal ? { openExternal } : undefined,
      open: (href, target, features) => {
        opened.push({ href, target, features });
        return null;
      },
    },
    opened,
  };
}

const make = loadOpenExternalUrl();

test("no bridge present → opens a new tab with noopener", () => {
  const { win, opened } = fakeWindow(null);
  make(win)("https://example.test/docs");
  assert.deepEqual(opened, [
    { href: "https://example.test/docs", target: "_blank", features: "noopener,noreferrer" },
  ]);
});

test("a bridge that RESOLVES opens once — no duplicate tab", async () => {
  const calls = [];
  const { win, opened } = fakeWindow(async (href) => {
    calls.push(href);
  });
  make(win)("https://example.test/docs");
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(calls, ["https://example.test/docs"]);
  assert.equal(opened.length, 0, "the bridge handled it; a second tab would be a duplicate");
});

test("a bridge that REJECTS falls back to a new tab instead of silently doing nothing", async () => {
  const { win, opened } = fakeWindow(() => Promise.reject(new Error("bridge refused")));
  make(win)("https://example.test/docs");
  await new Promise((r) => setTimeout(r, 0));
  // Before the fix this array stayed EMPTY: the rejection escaped the try/catch,
  // the documented "else a new browser tab" never happened, and the user was left
  // with a message saying something had opened.
  assert.deepEqual(opened, [
    { href: "https://example.test/docs", target: "_blank", features: "noopener,noreferrer" },
  ]);
});

test("a bridge rejection never escapes as an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const { win } = fakeWindow(() => Promise.reject(new Error("bridge refused")));
    make(win)("https://example.test/docs");
    // Two macrotask turns: Node reports an unhandled rejection only after the
    // microtask queue drains with no handler attached.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, [], "the rejection must be handled where it happens");
});

test("a bridge that throws SYNCHRONOUSLY still falls back (the original guard, unbroken)", () => {
  const { win, opened } = fakeWindow(() => {
    throw new Error("sync boom");
  });
  make(win)("https://example.test/docs");
  assert.deepEqual(opened, [
    { href: "https://example.test/docs", target: "_blank", features: "noopener,noreferrer" },
  ]);
});

test("the fallback's own failure cannot throw out of openExternalUrl", async () => {
  // Rule: every guard is itself an operation that can fail. If window.open is
  // blocked and throws, the recovery path must not become a NEW unhandled
  // rejection on top of the one it was recovering from.
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const win = {
      electronAPI: { openExternal: () => Promise.reject(new Error("bridge refused")) },
      open: () => {
        throw new Error("popup blocked");
      },
    };
    assert.doesNotThrow(() => make(win)("https://example.test/docs"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

// The three ways out of this function all end in window.open, and only ONE of them
// was guarded. Callers use openExternalUrl fire-and-forget, usually after something
// has already suppressed the anchor's native navigation, so an exception escaping
// here aborts whatever the caller meant to do next instead of falling back to
// anything. /docs hit exactly that: a throwing window.open killed the statement that
// puts the URL in the transcript, leaving "/docs failed: …" and no address to copy.
test("NO-BRIDGE path: a throwing window.open does not escape", () => {
  const win = {
    electronAPI: undefined,
    open: () => {
      throw new Error("popup blocked");
    },
  };
  assert.doesNotThrow(() => make(win)("https://example.test/docs"));
});

test("SYNC-THROW path: a throwing window.open does not escape either", () => {
  const win = {
    electronAPI: {
      get openExternal() {
        throw new Error("bridge getter exploded");
      },
    },
    open: () => {
      throw new Error("popup blocked");
    },
  };
  assert.doesNotThrow(() => make(win)("https://example.test/docs"));
});

test("a window with no open() at all is survivable", () => {
  assert.doesNotThrow(() => make({})("https://example.test/docs"));
});

test("an empty href is a no-op — no tab, no bridge call", () => {
  const calls = [];
  const { win, opened } = fakeWindow((href) => calls.push(href));
  make(win)("");
  make(win)(undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(opened, []);
});
