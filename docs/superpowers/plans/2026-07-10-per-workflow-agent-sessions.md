# Per-Workflow Agent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each ComfyUI workflow its own agent conversation — switching workflow tabs auto-swaps the chat to that workflow's thread; saved workflows keep their conversation across restarts.

**Architecture:** Frontend re-key. The orchestrator already isolates agents per `tabId` and resumes by `sessionId`; the panel already persists multi-thread conversations and `loadThread()` already switches+resumes. We (a) derive `tabId` from the active workflow instead of one per-browser-session UUID, (b) tag each thread with its workflow, (c) detect workflow changes and drive `loadThread()` + a re-hello, and (d) adopt a temp conversation into the file identity on save. One tiny backend fix prevents a retargeted socket from leaking a background workflow's output.

**Tech Stack:** Vanilla browser JS (ComfyUI custom-node frontend, single file `web/js/comfyui-mcp-panel.js`), a Node WS bridge (`comfyui-mcp` orchestrator, TypeScript). No build step for the frontend (served as-is; reload = Cmd+R). Backend change requires `npm run build` + orchestrator restart.

## Global Constraints

- **Frontend file:** `/Users/michaelcurtis/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel/web/js/comfyui-mcp-panel.js` (one large file; follow its existing idioms — `ssGet/ssSet`, `crypto.randomUUID()`, no framework).
- **Backend file:** `/Volumes/Main External/Development/comfyui-mcp/src/services/ui-bridge.ts`.
- **Identity scheme (verbatim):** saved → `"wf:" + wf.path`; unsaved/temporary → `"tmp:" + crypto.randomUUID()` (stable per `wf.key` for the app session).
- **Never open a second concurrent bridge client** (same-`tabId` reconnect storm). Retarget the existing single client.
- **Backend stays minimal** — exactly one small change (Task 1). No agent-lifecycle changes.
- **Verification is live-browser** via the running ComfyUI at `http://127.0.0.1:8188` (drive it with the chrome-devtools MCP: `new_page`, `evaluate_script`). Frontend-only tasks need just a page reload; Task 1 needs an orchestrator rebuild + restart.
- **Runtime ownership:** the user starts/stops the orchestrator (visible terminal / `comfyui-mcp/scripts/launch-orchestrator.sh`). Do NOT restart it silently — ask, or hand the restart to the user.

---

### Task 1: Backend — drop the stale conn when a socket retargets

**Why first:** it's the safety net that makes re-hello (Task 4) correct. `push(frame, tabId)` sends frames with no `tab_id` (the socket is the tab), so if a socket re-hellos under a new `tabId` while its old `tabId` conn still points at it, a background agent's `push(old)` leaks into the current view. Deleting the stale mapping on re-hello prevents that.

**Files:**
- Modify: `/Volumes/Main External/Development/comfyui-mcp/src/services/ui-bridge.ts` (hello handler, ~L316-343)

**Interfaces:**
- Produces: no API change — the `hello` handler now guarantees one socket maps to exactly one live `tabId`.

- [ ] **Step 1: Read the current hello handler**

Run: `sed -n '314,345p' "/Volumes/Main External/Development/comfyui-mcp/src/services/ui-bridge.ts"`
Confirm it starts with `if (msg.type === "hello" && typeof msg.tab_id === "string") {` and does `tabId = msg.tab_id;` then `this.conns.set(tabId, {...})`.

- [ ] **Step 2: Insert the stale-conn cleanup**

Immediately BEFORE the line `tabId = msg.tab_id;`, add:

```ts
        // A single socket may RE-HELLO under a new tab id when the user switches
        // ComfyUI workflow tabs (per-workflow sessions). Drop this socket's PRIOR
        // tab mapping so a background agent's push() to the old tab can't leak into
        // the newly-targeted view (frames carry no tab_id — the socket is the tab).
        if (tabId && tabId !== msg.tab_id && this.conns.get(tabId)?.sock === sock) {
          this.conns.delete(tabId);
        }
```

- [ ] **Step 3: Typecheck + build**

Run: `cd "/Volumes/Main External/Development/comfyui-mcp" && npm run build`
Expected: exits 0, no TS errors.

- [ ] **Step 4: Commit**

```bash
cd "/Volumes/Main External/Development/comfyui-mcp"
git add src/services/ui-bridge.ts
git commit -m "fix(bridge): drop stale conn when a socket retargets to a new tab id"
```

- [ ] **Step 5: Hand off restart**

Tell the user: "Backend built — restart the orchestrator when ready so this ships (it's the only backend change in #1)." Do NOT restart it yourself.

---

### Task 2: `workflowTabId()` — workflow-derived agent identity

**Files:**
- Modify: `web/js/comfyui-mcp-panel.js` — add near `getTabId()` (~L258); rewire `sendHello()` (~L4819) and `sendTitle()` (~L4844) and the per-frame sender (~L4937).

**Interfaces:**
- Produces:
  - `workflowTabId(): string` — the active workflow's agent id (`wf:<path>` | `tmp:<uuid>` | legacy `getTabId()` fallback).
  - `activeWorkflowRef(): object|null` — the ComfyUI active-workflow object or null.
  - `_tempWorkflowIds: Map<string,string>` — `wf.key → tmp uuid`, module-scoped.

- [ ] **Step 1: Add the identity function** (right after `getTabId()`'s closing brace, ~L270)

```js
// --- Per-workflow agent identity -----------------------------------------
// Each ComfyUI workflow gets its OWN agent session. Saved workflows key by file
// path (stable across restarts → the conversation lives with the file). Unsaved
// ones get a stable temp id for this app session (adopted into the file id on save,
// see the workflow-change handler). Falls back to the legacy per-browser-session id
// when no workflow service is present (headless / odd frontend).
const _tempWorkflowIds = new Map(); // wf.key -> "tmp:<uuid>"
function activeWorkflowRef() {
  try {
    return (
      window.comfyAPI?.app?.app?.extensionManager?.workflow?.activeWorkflow ||
      (typeof app !== "undefined" && app?.extensionManager?.workflow?.activeWorkflow) ||
      null
    );
  } catch {
    return null;
  }
}
function workflowTabId() {
  const wf = activeWorkflowRef();
  if (!wf) return getTabId();
  const saved =
    wf.isPersisted === true && wf.isTemporary !== true && typeof wf.path === "string" && wf.path;
  if (saved) return "wf:" + wf.path;
  const k = wf.key || wf.id || "unsaved";
  let id = _tempWorkflowIds.get(k);
  if (!id) {
    id = "tmp:" + crypto.randomUUID();
    _tempWorkflowIds.set(k, id);
  }
  return id;
}
```

- [ ] **Step 2: Use it in `sendHello()`** — change `tab_id: getTabId(),` (~L4819) to:

```js
          tab_id: workflowTabId(),
```

- [ ] **Step 3: Use it in `sendTitle()`** — change `sock.send(JSON.stringify({ type: "title", tab_id: getTabId(), title: t }));` (~L4844) to:

```js
      sock.send(JSON.stringify({ type: "title", tab_id: workflowTabId(), title: t }));
```

- [ ] **Step 4: Use it in the per-frame sender** — change `sock.send(JSON.stringify({ tab_id: getTabId(), ...frame }));` (~L4937) to:

```js
        sock.send(JSON.stringify({ tab_id: workflowTabId(), ...frame }));
```

- [ ] **Step 5: Syntax check**

Run: `node --check "/Users/michaelcurtis/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel/web/js/comfyui-mcp-panel.js"`
Expected: prints nothing, exits 0.

- [ ] **Step 6: Live check — hello carries the workflow id**

Reload ComfyUI (chrome-devtools `new_page` → `http://127.0.0.1:8188`), open the Agent panel, then evaluate:

```js
() => { const w = window.comfyAPI?.app?.app?.extensionManager?.workflow?.activeWorkflow;
  return { path: w?.path, key: w?.key, persisted: w?.isPersisted, temporary: w?.isTemporary }; }
```
Expected: an object describing the current workflow (so `workflowTabId()` will produce `wf:<path>` for a saved one). Confirm the panel still connects (status "connected").

- [ ] **Step 7: Commit**

```bash
cd "/Users/michaelcurtis/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel"
git add web/js/comfyui-mcp-panel.js
git commit -m "feat(panel): derive bridge tab id from the active workflow"
```

---

### Task 3: Tag threads with their workflow

**Files:**
- Modify: `web/js/comfyui-mcp-panel.js` — `record()` (~L7163) and add `threadForWorkflow()` near it.

**Interfaces:**
- Consumes: `workflowTabId()` (Task 2); `threads[]`, `thread`, `persistThreads()`, `ssSet`, `CURRENT_THREAD_KEY`.
- Produces:
  - Thread records now carry `workflowKey: string`.
  - `threadForWorkflow(wfid: string): object|null`.

- [ ] **Step 1: Tag new threads in `record()`** — change the thread-creation block (~L7165) from:

```js
      thread = { id: crypto.randomUUID(), ts: Date.now(), msgs: [] };
```
to:
```js
      thread = { id: crypto.randomUUID(), ts: Date.now(), msgs: [], workflowKey: workflowTabId() };
```

- [ ] **Step 2: Add the lookup** (right after `persistThreads()`'s closing brace, ~L7161)

```js
  // Find the (single) thread bound to a workflow id, or null. One conversation per
  // workflow: newest wins if duplicates ever exist.
  function threadForWorkflow(wfid) {
    for (let i = threads.length - 1; i >= 0; i--) {
      if (threads[i].workflowKey === wfid) return threads[i];
    }
    return null;
  }
```

- [ ] **Step 3: Syntax check**

Run: `node --check "/Users/michaelcurtis/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel/web/js/comfyui-mcp-panel.js"`
Expected: exits 0.

- [ ] **Step 4: Live check — a new message tags the thread**

Reload, open panel on a saved workflow, send one message ("hi"), then evaluate:

```js
() => JSON.parse(localStorage.getItem("comfyui-mcp.panel.threads") || "[]")
       .map(t => ({ id: t.id.slice(0,8), workflowKey: t.workflowKey, msgs: t.msgs.length }))
```
Expected: the newest thread has `workflowKey` starting `wf:` (or `tmp:`) matching the current workflow.

- [ ] **Step 5: Commit**

```bash
git add web/js/comfyui-mcp-panel.js
git commit -m "feat(panel): tag chat threads with their workflow id"
```

---

### Task 4: Auto-follow — switch (and adopt-on-save) on workflow change

**Files:**
- Modify: `web/js/comfyui-mcp-panel.js` — add the change handler; wire it to the existing `titleObserver` (~L4849) and call once after the client connects.

**Closure map (read first):** `sendHello`/`sock`/`titleObserver` live in the **bridge-client** closure (~L4804-4851). `loadThread`/`record`/`thread`/`resetFeed`/`client` live in the **panel-mount** closure (`loadThread` ~L8040, uses `client?.sendFrame`). These are DIFFERENT closures. Therefore: put detection **and** reaction in the panel-mount closure (it has `loadThread`, `thread`, `client`), give the bridge client a public **`rehello()`** so the panel can re-target the socket, and drive detection from the panel closure's **own** title observer (do NOT try to call panel functions from the bridge-client's observer). Confirm with: `grep -n "function sendHello\|function loadThread\|return {" web/js/comfyui-mcp-panel.js` and locate the object `createBridgeClient` returns.

**Interfaces:**
- Consumes: `workflowTabId()`, `activeWorkflowRef()`, `_tempWorkflowIds` (Task 2); `threadForWorkflow()` (Task 3); `loadThread()`, `resetFeed()`, `persistThreads()`, `thread`, `client`, `ssSet`, `CURRENT_THREAD_KEY`, `SESSION_KEY` (existing, panel-mount closure).
- Produces:
  - `client.rehello()` — public method on the bridge client that sends a fresh `hello` (picks up the current `workflowTabId()`) on the existing socket.
  - `onWorkflowMaybeChanged(): void` and `rehelloForWorkflow(sessionId): void` in the panel-mount closure.
  - panel-closure state `currentWorkflowId: string|null`, `currentWorkflowKey: string|null`.

- [ ] **Step 1: Expose `rehello` on the bridge client** — find the object `createBridgeClient` returns (the one assigned to `client`/`liveBridgeClient`; it already exposes `sendFrame`, `destroy`). Add `sendHello` to it:

```js
    // Public re-hello so the panel can re-target this socket to a new workflow's
    // tab id (per-workflow sessions) without opening a second client.
    rehello: sendHello,
```

- [ ] **Step 2: Add the handler in the PANEL-MOUNT closure** (place near `loadThread`, ~L8055, where `loadThread`/`thread`/`client` are in scope)

```js
  // Per-workflow auto-follow. Called on any workflow change (open/switch/save/rename).
  // Three cases:
  //   1) id unchanged -> nothing (title tick during a run/edit).
  //   2) same wf.key, id flipped tmp:->wf: -> ADOPT: migrate the temp thread to the
  //      file identity, keep the SAME agent session.
  //   3) different id -> SWITCH: re-hello + load that workflow's thread (or a fresh
  //      empty view if it has none).
  let currentWorkflowId = null;
  let currentWorkflowKey = null;
  function rehelloForWorkflow(sessionId) {
    // Re-target the socket to the current workflow's tab id, then resume that
    // workflow's agent session. The backend drops the socket's prior tab mapping
    // (Task 1) so a background workflow's output can't leak here.
    try {
      client?.rehello?.();
      if (sessionId) client?.sendFrame?.({ type: "resume_session", session_id: sessionId });
    } catch {
      /* reconnect path retries the hello */
    }
  }
  function onWorkflowMaybeChanged() {
    const wf = activeWorkflowRef();
    const wfid = workflowTabId();
    const wfkey = wf ? (wf.key || wf.id || "unsaved") : null;
    if (wfid === currentWorkflowId) return; // case 1

    const adopting =
      currentWorkflowId &&
      currentWorkflowKey &&
      wfkey === currentWorkflowKey &&
      currentWorkflowId.startsWith("tmp:") &&
      wfid.startsWith("wf:");
    if (adopting) {
      const t = threadForWorkflow(currentWorkflowId);
      if (t) { t.workflowKey = wfid; persistThreads(); }        // migrate to file id
      if (wf && (wf.key || wf.id)) _tempWorkflowIds.delete(wf.key || wf.id);
      currentWorkflowId = wfid;
      currentWorkflowKey = wfkey;
      rehelloForWorkflow(t?.sessionId || null);                  // same session continues
      return;
    }

    currentWorkflowId = wfid;
    currentWorkflowKey = wfkey;
    const existing = threadForWorkflow(wfid);
    rehelloForWorkflow(existing?.sessionId || null);
    if (existing) {
      loadThread(existing);                                      // resets feed + repaints + resumes
    } else {
      thread = null;                                            // fresh empty view; thread minted on 1st message
      ssSet(CURRENT_THREAD_KEY, null);
      ssSet(SESSION_KEY, null);
      resetFeed();
    }
  }
```

- [ ] **Step 3: Drive it from a panel-closure title observer** — in the panel-mount closure (near where the panel builds), add its OWN observer so detection lives beside the reaction:

```js
  // The document <title> mutates whenever the active workflow changes (open/switch/
  // save/rename), so it is a reliable, framework-free change signal.
  const _wfTitleEl = document.querySelector("title");
  const _wfObserver = _wfTitleEl ? new MutationObserver(() => onWorkflowMaybeChanged()) : null;
  _wfObserver?.observe(_wfTitleEl, { childList: true });
```

Ensure it is torn down in the panel's `destroy()` (add `_wfObserver?.disconnect();` there).

- [ ] **Step 4: Seed the current identity once the client is live** — where `client`/`liveBridgeClient` is assigned in the panel closure (search `liveBridgeClient = client`), seed tracking so the first switch is detected:

```js
  currentWorkflowId = workflowTabId();
  currentWorkflowKey = (() => { const w = activeWorkflowRef(); return w ? (w.key || w.id || "unsaved") : null; })();
```

- [ ] **Step 5: Syntax check**

Run: `node --check "/Users/michaelcurtis/Documents/ComfyUI/ComfyUI/ComfyUI/custom_nodes/comfyui-agent-panel/web/js/comfyui-mcp-panel.js"`
Expected: exits 0.

- [ ] **Step 6: Live check — switching workflows swaps the thread**

Reload. Open two SAVED workflows in ComfyUI (two tabs at top). In workflow A send "message in A". Switch ComfyUI to workflow B; send "message in B". Switch back to A. Evaluate after each switch:

```js
() => { const log = document.querySelector(".cmcp-log") || document.querySelector('[class*="cmcp"][class*="log"]');
  return { visibleText: (log?.innerText || "").slice(0, 200),
           currentThread: sessionStorage.getItem("comfyui-mcp.panel.currentThreadId") }; }
```
Expected: on A the log shows "message in A"; on B it shows "message in B"; switching back to A restores A's transcript. `currentThreadId` differs between A and B.

- [ ] **Step 7: Commit**

```bash
git add web/js/comfyui-mcp-panel.js
git commit -m "feat(panel): auto-follow the active workflow (switch + adopt-on-save)"
```

---

### Task 5: A2UI seam — chat surface width as single owned state

**Why:** the spec's one forward-compatibility requirement so the future A2UI feature can expand/shrink the chat surface without a refactor. Keep it minimal — no resize UI is built now.

**Files:**
- Modify: `web/js/comfyui-mcp-panel.js` — add a single no-op-by-default surface hook near the panel root creation.

**Interfaces:**
- Produces: `cmcpSetChatSurface(mode: "normal"|"wide"): void` on the panel bridge object (default `"normal"`, sets one CSS var). Currently unused; A2UI will call it.

- [ ] **Step 1: Find the panel root element** — `grep -n "cmcp-root" web/js/comfyui-mcp-panel.js` and note the variable holding the root element created in `buildPanel()`.

- [ ] **Step 2: Add the hook** (right after the root element is created in `buildPanel()`)

```js
  // A2UI seam (forward-compat, see spec): the chat surface width is a SINGLE piece
  // of owned state, not scattered CSS, so a future A2UI layer can widen the surface
  // (e.g. to show a diagram) and shrink it back. No-op visual default today.
  root.style.setProperty("--cmcp-surface-width", "100%");
  function cmcpSetChatSurface(mode) {
    root.style.setProperty("--cmcp-surface-width", mode === "wide" ? "60%" : "100%");
    root.dataset.surface = mode === "wide" ? "wide" : "normal";
  }
```

- [ ] **Step 3: Expose it** — add `cmcpSetChatSurface` to the object returned by `buildPanel()` (the `{ root, destroy, ... }` return) so A2UI can reach it later. If `buildPanel` returns `{ root, destroy }`, change to `{ root, destroy, setChatSurface: cmcpSetChatSurface }`.

- [ ] **Step 4: Syntax check + confirm no visual regression**

Run: `node --check ".../comfyui-mcp-panel.js"` (exits 0). Reload; the panel looks identical (mode defaults to normal). Evaluate:
```js
() => { const r = document.querySelector(".cmcp-root"); return { w: getComputedStyle(r).getPropertyValue("--cmcp-surface-width").trim(), surface: r?.dataset.surface }; }
```
Expected: `w` is `100%` (or empty→treated as normal); no layout change.

- [ ] **Step 5: Commit**

```bash
git add web/js/comfyui-mcp-panel.js
git commit -m "feat(panel): expose chat-surface width hook (A2UI seam)"
```

---

### Task 6: Full-stack verification (the four spec acceptance checks)

**Files:** none (verification only). Requires the orchestrator running the Task 1 build (ask the user to restart it first).

- [ ] **Step 1: Two workflows keep separate threads**

Open workflow A and B (saved). Converse in each; switch back and forth. PASS = each shows only its own messages (re-run the Task 4 Step 5 check).

- [ ] **Step 2: Background survival**

In A, ask for something slow (e.g. "list every node type you know, one per line"). Immediately switch to B. Wait ~15s. Switch back to A. PASS = A's answer completed and is visible (reconciled via resume). Confirm no B content leaked into A and vice-versa.

- [ ] **Step 3: Adopt-on-save**

Open a NEW workflow ("Unsaved Workflow"). Send "remember the number 42". Save the workflow (Ctrl+S / menu) with a name. Send "what number did I say?". PASS = the agent answers 42 (the temp conversation was adopted into the saved file's session — no reset). Evaluate that the thread's `workflowKey` is now `wf:<path>`:
```js
() => JSON.parse(localStorage.getItem("comfyui-mcp.panel.threads")||"[]").slice(-1)[0]?.workflowKey
```
Expected: starts with `wf:`.

- [ ] **Step 4: Persistence across reload**

With A and B having conversations, hard-reload ComfyUI. Reopen workflow A. PASS = A's transcript is restored and typing continues its session.

- [ ] **Step 5: Record results**

Summarize PASS/FAIL for Steps 1-4 to the user. For any FAIL, capture the console (`chrome-devtools` `list_console_messages`) and diagnose before declaring done.

- [ ] **Step 6: Update project memory**

Append to the ComfyUI project memory that the agent panel is now per-workflow (tabId = `wf:<path>` | `tmp:<uuid>`, auto-follow via titleObserver, adopt-on-save, backend already per-tabId + the ui-bridge stale-conn fix), and that A2UI is the next design cycle with the surface-width seam in place.

---

## Notes for the implementer

- **No frontend build.** Editing `comfyui-mcp-panel.js` takes effect on ComfyUI **Cmd+R** (the file is served as-is). Only Task 1 (TypeScript) needs `npm run build` + an orchestrator restart.
- **Closure scoping is the main hazard.** `sendHello`/`sock` live in the bridge-client closure; `loadThread`/`record`/`thread` live in the panel-mount closure. Verify with grep before Task 4 and, if they are separate, bridge them via the existing `liveBridgeClient` object pattern rather than duplicating.
- **Don't open a second WS client** on switch — re-hello the existing one (Task 4 `rehelloForWorkflow`).
- **Greeting on switch:** if re-hello visibly re-greets ("agent ready") on every switch and it's annoying, suppress it by gating the greeting render on a "first hello per socket" flag — note it but only act if observed.
