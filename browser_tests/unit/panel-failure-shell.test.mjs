// panel#779 — a blank tab is not an acceptable failure state.
//
// A new user installed the pack, opened the Agent tab, and got a black
// rectangle: no header, no Connect button, no "not connected" state, nothing in
// the console attributed to us. Unable to tell "broken" from "not connected"
// from "not installed", they reinstalled ComfyUI, tried a second browser, and
// hard-refreshed both — an hour on things that were never the problem.
//
// The cause that time was a frontend DOM marker that moved (#784, fixed). This is
// the floor underneath it: ComfyUI mounts us with
// `mountCustomExtension = (e, t) => e.render(t)` and has NO handler, so anything
// that throws in render() leaves the container empty. Every future cause lands
// the same way, which is why this is a floor and not another special case.

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  panelFailureReport,
  buildPanelFailureShell,
} from "../../web/js/lib/panel-failure-shell.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_JS = join(HERE, "../../web/js/comfyui-mcp-panel.js");

/** A minimal document double — no jsdom in this suite. */
function fakeDoc() {
  const make = (tag) => ({
    tagName: tag,
    className: "",
    children: [],
    attrs: {},
    textContent: "",
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    appendChild(c) {
      this.children.push(c);
      return c;
    },
  });
  return { createElement: make };
}

const textOf = (el) =>
  [el.textContent, ...el.children.map(textOf)].filter(Boolean).join("\n");

test("#779 it reports what was OBSERVED and diagnoses nothing", () => {
  // Inventing a cause is what sent the reporter to reinstall. A wrong
  // explanation is worse than a blank tab, because it gets acted on.
  const r = panelFailureReport(new TypeError("x is not a function"));
  assert.match(r.message, /TypeError: x is not a function/);
  assert.match(r.body, /nothing here is a diagnosis of the cause/);
});

test("#779 it rules OUT the two things the reporter wasted an hour on", () => {
  const r = panelFailureReport(new Error("boom"));
  assert.match(r.body, /NOT a connection problem/);
  assert.match(r.body, /reinstalling ComfyUI or the pack will not change it/);
});

test("#779 a non-Error, and a message-less failure, still produce text", () => {
  // Whatever escapes a build can be anything. "" must not render an empty pre
  // that looks like the blank tab all over again.
  assert.equal(panelFailureReport("plain string").message, "plain string");
  assert.match(panelFailureReport(undefined).message, /no message/);
  assert.match(panelFailureReport(null).message, /no message/);
  assert.match(panelFailureReport("").message, /no message/);
  assert.match(panelFailureReport({ weird: true }).message, /no message/);
});

test("#779 versions are carried, and unknown is stated rather than blank", () => {
  const known = panelFailureReport(new Error("e"), {
    panelVersion: "0.11.44",
    frontendVersion: "1.50.3",
  });
  assert.equal(known.panelVersion, "0.11.44");
  assert.equal(known.frontendVersion, "1.50.3");
  // The frontend version is the single most useful field here — #779 turned on
  // it — so its absence must be visible rather than an empty gap.
  const bare = panelFailureReport(new Error("e"));
  assert.equal(bare.panelVersion, "unknown");
  assert.equal(bare.frontendVersion, "unknown");
});

test("#779 the shell renders the message, versions and where to report", () => {
  const el = buildPanelFailureShell(fakeDoc(), new Error("kaboom"), {
    panelVersion: "0.11.44",
    frontendVersion: "1.50.3",
  });
  assert.ok(el, "a shell must be produced");
  const text = textOf(el);
  assert.match(text, /could not start/);
  assert.match(text, /kaboom/);
  assert.match(text, /panel 0\.11\.44 · ComfyUI frontend 1\.50\.3/);
  assert.match(text, /github\.com\/artokun\/comfyui-mcp-panel\/issues/);
});

test("#779 the message goes in as TEXT, never markup", () => {
  // An error message can contain anything, and this renders inside ComfyUI's
  // page. textContent is the only safe sink.
  const el = buildPanelFailureShell(fakeDoc(), new Error("<img src=x onerror=alert(1)>"));
  const pre = el.children.find((c) => c.tagName === "pre");
  assert.ok(pre.textContent.includes("<img src=x onerror=alert(1)>"));
  assert.equal(pre.innerHTML, undefined, "innerHTML must never be set");
});

test("#779 it NEVER throws — it runs because something already did", () => {
  // A second throw here puts us back at the blank tab this exists to prevent.
  assert.equal(buildPanelFailureShell(null, new Error("e")), null);
  assert.equal(buildPanelFailureShell({}, new Error("e")), null);
  const hostile = {
    createElement: () => {
      throw new Error("no elements for you");
    },
  };
  assert.equal(buildPanelFailureShell(hostile, new Error("e")), null);
});

test("#779 WIRING: render() catches, resets `mounted`, and appends the shell", () => {
  const src = readFileSync(PANEL_JS, "utf8");
  assert.match(src, /import \{ buildPanelFailureShell \} from "\.\/lib\/panel-failure-shell\.js"/);
  const i = src.indexOf("render: (container) => {");
  assert.ok(i > 0, "the render callback must be findable");
  const body = src.slice(i, src.indexOf("\n        destroy:", i));
  assert.match(body, /try \{/, "the build path is guarded");
  assert.match(body, /\} catch \(err\) \{/);
  // A half-built root must not survive, or the next render appends a second one.
  assert.match(body, /mounted = null;/);
  assert.match(body, /buildPanelFailureShell\(document, err, \{/);
  assert.match(body, /if \(shell\) container\.appendChild\(shell\);/);
  // The frontend version is passed — it is what #779 turned on.
  assert.match(body, /frontendVersion:/);
});
