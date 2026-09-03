// #2165 — the agent TODO tray must be collapsible from the header.
//
// panel_set_todo can pin up to 9rem of the chat column. The only hide path used
// to be an empty panel_set_todo (`.cmcp-tray[hidden]`). These tests drive the
// SHIPPED painter (`web/js/lib/todo-tray.js`) that the panel mounts, not a
// reimplementation, and pin the panel wiring so a later edit cannot go back to
// an inert header.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { tr } from "../../web/js/lib/i18n.js";
import {
  TODO_LIST_CLASS,
  TODO_ITEM_CLASS,
  TODO_COLLAPSED_CLASS,
  TODO_TOGGLE_CLASS,
  createTodoCollapseState,
  paintTodoList,
} from "../../web/js/lib/todo-tray.js";

const PANEL = readFileSync(
  fileURLToPath(new URL("../../web/js/comfyui-mcp-panel.js", import.meta.url)),
  "utf8",
);
const TRAY = readFileSync(
  fileURLToPath(new URL("../../web/js/lib/todo-tray.js", import.meta.url)),
  "utf8",
);

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = "";
    this.type = "";
    this.title = "";
    this._attrs = {};
    this._listeners = new Map();
    this.classList = {
      add: (...names) => {
        const set = new Set(String(this.className).split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        this.className = [...set].join(" ");
      },
      remove: (...names) => {
        const set = new Set(String(this.className).split(/\s+/).filter(Boolean));
        for (const n of names) set.delete(n);
        this.className = [...set].join(" ");
      },
      toggle: (n, force) => {
        const set = new Set(String(this.className).split(/\s+/).filter(Boolean));
        const on = force === undefined ? !set.has(n) : !!force;
        if (on) set.add(n);
        else set.delete(n);
        this.className = [...set].join(" ");
        return on;
      },
      contains: (n) => String(this.className).split(/\s+/).includes(n),
    };
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  addEventListener(t, fn) {
    if (!this._listeners.has(t)) this._listeners.set(t, []);
    this._listeners.get(t).push(fn);
  }
  click() {
    const e = {
      type: "click",
      preventDefault() {},
      stopPropagation() {},
    };
    for (const fn of this._listeners.get("click") || []) fn(e);
  }
}

const fakeDoc = { createElement: (t) => new El(t) };

function paint(opts = {}) {
  const calls = [];
  const list = paintTodoList({
    document: fakeDoc,
    items: opts.items ?? [
      { text: "step one", status: "done" },
      { text: "step two", status: "active" },
      { text: "step three", status: "pending" },
    ],
    collapsed: opts.collapsed ?? false,
    agentWorking: opts.agentWorking ?? false,
    tr,
    onToggle: () => {
      calls.push("toggle");
      opts.onToggle?.();
    },
  });
  return { list, calls };
}

function toggleBtn(list) {
  return list.children.find((c) => c.tagName === "BUTTON") ?? null;
}

function items(list) {
  return list.children.filter((c) => String(c.className).split(/\s+/).includes(TODO_ITEM_CLASS));
}

test("#2165 paintTodoList renders a keyboard-accessible header button", () => {
  const { list } = paint();
  const btn = toggleBtn(list);
  assert.ok(btn, "the plan header is a <button>");
  assert.equal(btn.type, "button");
  assert.ok(String(btn.className).split(/\s+/).includes(TODO_TOGGLE_CLASS));
  assert.ok(String(btn.className).split(/\s+/).includes("cmcp-tray-head"));
  assert.equal(btn.getAttribute("aria-expanded"), "true");
  assert.match(btn.getAttribute("aria-label"), /Collapse plan/);
  assert.match(btn.getAttribute("aria-label"), /Plan · 1\/3/);
});

test("#2165 collapsed paint keeps the items in the tree and marks the list", () => {
  const { list } = paint({ collapsed: true });
  assert.ok(list.classList.contains(TODO_COLLAPSED_CLASS));
  assert.equal(toggleBtn(list).getAttribute("aria-expanded"), "false");
  assert.match(toggleBtn(list).getAttribute("aria-label"), /Expand plan/);
  assert.equal(items(list).length, 3, "items stay mounted so re-expand does not need the agent");
});

test("#2165 clicking the header only fires the local onToggle", () => {
  const extra = [];
  const { list, calls } = paint({
    onToggle: () => extra.push("caller"),
  });
  toggleBtn(list).click();
  assert.deepEqual(calls, ["toggle"]);
  assert.deepEqual(extra, ["caller"]);
});

test("#2165 collapse state is local and resets when the agent clears the plan", () => {
  const state = createTodoCollapseState();
  assert.equal(state.isCollapsed(), false);
  assert.equal(state.toggle(), true);
  assert.equal(state.isCollapsed(), true);
  state.resetWhenEmpty([{ text: "still here", status: "done" }]);
  assert.equal(state.isCollapsed(), true, "an update that keeps items must not force-expand");
  state.resetWhenEmpty([]);
  assert.equal(state.isCollapsed(), false, "empty panel_set_todo opens the next plan expanded");
});

test("#2165 the painter does not invent an agent turn", () => {
  const click = TRAY.slice(TRAY.indexOf('btn.addEventListener("click"'), TRAY.indexOf("list.appendChild(btn);"));
  assert.match(click, /onToggle\(\)/);
  assert.doesNotMatch(click, /persistThreads|reviseThread|sendNowMsg|user_message/);
});

test("#2165 the panel mounts the shipped painter, not a copy", () => {
  assert.match(PANEL, /from "\.\/lib\/todo-tray\.js"/);
  assert.match(PANEL, /createTodoCollapseState\(\)/);
  assert.match(PANEL, /paintTodoList\(\{/);
  assert.match(PANEL, /todoCollapse\.toggle\(\)/);
  assert.match(PANEL, /todoCollapse\.resetWhenEmpty\(todoItems\)/);
});

test("#2165 the panel toggle is local UI — renderTray only, no agent turn", () => {
  const start = PANEL.indexOf("onToggle: () => {");
  assert.ok(start >= 0, "paintTodoList is wired with onToggle");
  const body = PANEL.slice(start, PANEL.indexOf("},", start));
  assert.match(body, /todoCollapse\.toggle\(\)/);
  assert.match(body, /renderTray\(\)/);
  assert.doesNotMatch(body, /persistThreads|reviseThread|sendNowMsg|sendMessage|user_message/);
});

test("#2165 empty panel_set_todo still hides the tray; collapse is extra", () => {
  assert.match(PANEL, /tray\.hidden = !hasPending && !hasDl && !hasTodo/);
  const start = PANEL.indexOf("onTodo(items) {");
  assert.ok(start >= 0, "onTodo handler still exists");
  const onTodo = PANEL.slice(start, PANEL.indexOf("onShowMedia(items)", start));
  assert.match(onTodo, /renderTodo\(items\)/);
  assert.doesNotMatch(onTodo, /todoCollapse/);
});

test("#2165 collapsed CSS hides the items, not the header", () => {
  assert.match(
    PANEL,
    /\.cmcp-todo\.cmcp-todo-collapsed \.cmcp-todo-item \{ display: none; \}/,
  );
  assert.match(PANEL, /\.cmcp-todo-toggle \{/);
  assert.match(PANEL, /\.cmcp-todo-toggle:focus-visible \{/);
});

test("#2165 list class names match the stylesheet the panel ships", () => {
  const { list } = paint({ collapsed: true });
  assert.equal(list.className.split(/\s+/).includes(TODO_LIST_CLASS), true);
  assert.equal(TODO_LIST_CLASS, "cmcp-todo");
  assert.equal(TODO_COLLAPSED_CLASS, "cmcp-todo-collapsed");
  assert.equal(TODO_TOGGLE_CLASS, "cmcp-todo-toggle");
  assert.equal(TODO_ITEM_CLASS, "cmcp-todo-item");
});
