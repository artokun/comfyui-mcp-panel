// #1801 — one rAF can land on contain-intrinsic-size while replayed message
// roots are still revealing their real heights. Exercise the shipped runtime
// helper with live and inert A2UI roots, not just source regexes.

import assert from "node:assert/strict";
import test from "node:test";

import { createChatScrollStabilizer } from "../../web/js/lib/chat-scroll-stabilizer.js";

class FakeLog {
  constructor(children = []) {
    this.children = children;
    this.scrollTop = 0;
  }

  get scrollHeight() {
    return this.children.reduce((total, child) => total + child.height, 0);
  }
}

const messageRoot = (className, height = 120) => ({
  classList: { contains: (name) => className.split(/\s+/).includes(name) },
  className,
  height,
});

class FakeResizeObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.targets = new Set();
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  disconnect() {
    this.disconnected = true;
    this.targets.clear();
  }

  deliver(...targets) {
    this.callback(targets.map((target) => ({ target })));
  }
}

class FakeMutationObserver {
  static instances = [];

  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    FakeMutationObserver.instances.push(this);
  }

  observe(target, options) {
    this.target = target;
    this.options = options;
  }

  disconnect() {
    this.disconnected = true;
  }

  deliver(...addedNodes) {
    this.callback([{ addedNodes }]);
  }
}

function frameHarness() {
  const frames = [];
  return {
    requestFrame(fn) {
      frames.push(fn);
      return frames.length;
    },
    flush() {
      assert.ok(frames.length, "a correction frame should be pending");
      frames.shift()();
    },
    get pending() {
      return frames.length;
    },
  };
}

test("#1801 replay settles at the true bottom after live and inert A2UI roots reveal", () => {
  FakeResizeObserver.instances = [];
  FakeMutationObserver.instances = [];
  const live = messageRoot("cmcp-a2ui", 120);
  const inert = messageRoot("cmcp-a2ui cmcp-a2ui-lit-inert", 120);
  const log = new FakeLog([live, inert]);
  const frames = frameHarness();
  let stick = true;
  const stabilizer = createChatScrollStabilizer({
    log,
    shouldStick: () => stick,
    requestFrame: frames.requestFrame,
    ResizeObserverCtor: FakeResizeObserver,
    MutationObserverCtor: FakeMutationObserver,
  });
  const resize = FakeResizeObserver.instances[0];

  assert.ok(resize.targets.has(live), "live A2UI root is observed");
  assert.ok(resize.targets.has(inert), "inert A2UI root is observed");

  stabilizer.schedule();
  frames.flush();
  assert.equal(log.scrollTop, 240, "the initial frame sees the intrinsic placeholders");

  // Containment reveal replaces the guessed 120px roots with their real replay
  // heights. Each delivery must chase the new geometry to the true bottom.
  live.height = 1534;
  resize.deliver(live);
  frames.flush();
  assert.equal(log.scrollTop, 1654);

  inert.height = 2934;
  resize.deliver(inert);
  frames.flush();
  assert.equal(log.scrollTop, 4468, "replay ends at the actual bottom, not 2934px above it");

  stick = false;
  live.height += 500;
  resize.deliver(live);
  assert.equal(frames.pending, 0, "a reader scrolled up is never yanked by layout reveal");
  assert.equal(log.scrollTop, 4468);

  stabilizer.dispose();
  assert.equal(resize.disconnected, true);
  assert.equal(FakeMutationObserver.instances[0].disconnected, true);
});

test("#1801 newly appended live/inert roots are observed before their first correction", () => {
  FakeResizeObserver.instances = [];
  FakeMutationObserver.instances = [];
  const log = new FakeLog([]);
  const frames = frameHarness();
  const stabilizer = createChatScrollStabilizer({
    log,
    requestFrame: frames.requestFrame,
    ResizeObserverCtor: FakeResizeObserver,
    MutationObserverCtor: FakeMutationObserver,
  });
  const live = messageRoot("cmcp-a2ui", 900);
  const inert = messageRoot("cmcp-a2ui cmcp-a2ui-lit-inert", 2100);
  log.children.push(live, inert);
  FakeMutationObserver.instances[0].deliver(live, inert);
  frames.flush();

  const resize = FakeResizeObserver.instances[0];
  assert.ok(resize.targets.has(live));
  assert.ok(resize.targets.has(inert));
  assert.equal(log.scrollTop, 3000);
  stabilizer.dispose();
});
