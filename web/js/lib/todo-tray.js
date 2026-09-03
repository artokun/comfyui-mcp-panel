// Agent-controlled TODO tray (#2165).
//
// panel_set_todo paints a live plan into the footer tray. That list can occupy
// up to 9rem of the chat column, and the only hide path used to be an empty
// panel_set_todo (`.cmcp-tray[hidden]`). Collapse is local UI: it does not send
// a turn, does not persist onto the thread, and does not change the agent's
// items. Empty panel_set_todo still clears the tray.
//
// Kept as a module so unit tests drive THIS painter, not a copy of it.

import { todoItemGlyph } from "./plan-glyph.js";

export const TODO_LIST_CLASS = "cmcp-todo";
export const TODO_ITEM_CLASS = "cmcp-todo-item";
export const TODO_COLLAPSED_CLASS = "cmcp-todo-collapsed";
export const TODO_TOGGLE_CLASS = "cmcp-todo-toggle";

export function createTodoCollapseState() {
  let collapsed = false;
  return {
    isCollapsed: () => collapsed,
    setCollapsed(next) {
      collapsed = !!next;
      return collapsed;
    },
    toggle() {
      collapsed = !collapsed;
      return collapsed;
    },
    // A cleared plan should open expanded the next time items arrive.
    resetWhenEmpty(items) {
      if (!Array.isArray(items) || items.length === 0) collapsed = false;
      return collapsed;
    },
  };
}

export function paintTodoList({
  document: doc,
  items,
  collapsed,
  agentWorking,
  tr,
  onToggle,
}) {
  const list = doc.createElement("div");
  list.className = TODO_LIST_CLASS;
  if (collapsed) list.classList.add(TODO_COLLAPSED_CLASS);

  const doneN = items.filter((it) => it && it.status === "done").length;
  const planLabel = tr("panel.plan_done_total", "Plan · {done}/{total}", {
    done: doneN,
    total: items.length,
  });
  const action = collapsed
    ? tr("panel.expand_plan", "Expand plan")
    : tr("panel.collapse_plan", "Collapse plan");

  const btn = doc.createElement("button");
  btn.type = "button";
  btn.className = `cmcp-tray-head ${TODO_TOGGLE_CLASS}`;
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  btn.setAttribute("aria-label", `${action}. ${planLabel}`);
  btn.title = action;

  const caret = doc.createElement("span");
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = collapsed
    ? tr("panel.caret_collapsed", "▸")
    : tr("panel.caret_expanded", "▾");
  const label = doc.createElement("span");
  label.textContent = planLabel;
  btn.appendChild(caret);
  btn.appendChild(label);
  btn.addEventListener("click", (e) => {
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    onToggle();
  });
  list.appendChild(btn);

  for (const it of items) {
    const status = it && it.status === "active" ? "active" : it && it.status === "done" ? "done" : "pending";
    const row = doc.createElement("div");
    row.className = `${TODO_ITEM_CLASS} ${status}`;
    const icon = doc.createElement("i");
    icon.className = "pi " + todoItemGlyph(status, agentWorking);
    const txt = doc.createElement("span");
    txt.textContent = (it && it.text) || "";
    row.appendChild(icon);
    row.appendChild(txt);
    list.appendChild(row);
  }
  return list;
}
