# Chat History v2

Chat History v2 replaces the legacy `localStorage`-only ring (20 threads, 200
messages each) with a versioned, workflow-aware history system.

## Conversation scope

The conversation is always **panel-owned**: one conversation per backend that
spans every browser tab and every workflow. The agent session behind it is
orchestrator-scoped (comfyui-mcp#897) and persists in `~/.comfyui-mcp/sessions`,
so switching, saving, renaming, or creating workflows — or moving between tabs —
never swaps or resets the chat.

The former "Chat conversation scope" setting (**Panel** / **Workflow** / **Ask**)
was removed in comfyui-mcp#884: the workflow and ask modes were per-workflow
sessions under another name, which contradicts the orchestrator-global session.
Stored values of the old setting are ignored, and conversations created under
the retired modes remain in history as ordinary archive entries, openable from
any workflow.

Which conversation is *the* conversation is shared state, not tab state: the
**backend-scoped** active pointer `panel:backend:<id>` in history metadata
(one conversation per backend, mirroring the orchestrator's
`orchestrator::<backend>` session key; the pre-existing shared `panel:global`
key remains a one-way read fallback until a backend's key is first written).
Every tab resolves its own backend's pointer through one selector
(`selectPanelThread`/`resolvePanelPointer`) — on cold restore and on cross-tab
sync alike — and a tab whose selection moved adopts the new thread passively
(it repaints; only the tab the user acted in sends
`resume_session`/`new_session`).

**The commit is the transition:** an acting tab dispatches the session frame
first and publishes the pointer only when the frame actually left its socket —
a disconnected tab can still read an archive locally, but cannot move the
other tabs onto a conversation the backend never entered.

**Selection evidence only:** a pointer left stale by a pre-#884 build loses to
a *newer selection* (the retired workflow mode stamped workflow-scoped active
ops on every thread creation/open), never to mere message timestamps — an
imported archive, a straggler write, or a skewed clock carries newer messages
without any user selection and must not move the shared conversation.

**Turn ownership:** a turn's owner is pinned when its `user_message` is
dispatched (not at `turn:working`), and every transcript output — says, stream
deltas, plan updates, question cards, media, A2UI cards, command activity —
is fenced against a conversation the turn does not own. The prompt itself is
filed at dispatch time too: if the selection moves while attachments upload or
grounding runs, the recorded prompt is relocated (tombstoned + re-recorded)
into the conversation that will actually consume it.

The plus button starts a new conversation without deleting older chats. The
history button opens search, current-workflow filtering, rename, pin, delete,
export, and merge-import controls.

## Identity

Bridge routing uses `wf:<tab>:<path>`/`tmp:<uuid>` (the saved form is tab-scoped
since #640, so two browser tabs on one file register distinct routes) because the
orchestrator binds agents to the current tab. Workflow identity is separate:
`workflow:<UUID>`, stored in `workflow.extra.comfyui_mcp.workflow_uuid` by the
unsaved-workflow durability path (#570). Threads carry that key as ride-along
**provenance** for archive grouping — it does not scope the conversation.

Renaming therefore preserves history. Opening a copied graph as another workflow
detects the repeated UUID and gives the copy a fresh identity. A path→UUID alias
map provides backward compatibility before the graph is next saved.

## Storage and migration

The canonical browser snapshot is in IndexedDB database
`comfyui-mcp-panel-history`, schema version 3. A small `localStorage` shadow is
kept for instant paint and compatibility with older panel builds. On startup the
panel merges legacy and IndexedDB snapshots by stable record IDs and causal
revisions, then writes the migrated schema back automatically.

## Continuity and graph versions

Each thread records its provider, model, effort, session ID, active workflow,
and timestamps. Each user turn points to an FNV-1a graph hash plus node count;
graphs up to 300 KB also keep the serialized workflow snapshot. The hash is shown
inside the user bubble and in the history list.

When a provider session ID is absent, stale, or belongs to a different provider,
the panel creates a fresh session and arms a bounded transcript replay for the
next message. Only provider-matched session IDs continue through the
orchestrator's resume path.

Archive export is deliberately portable rather than a raw database dump. It
contains transcript content, workflow provenance, and safe path→UUID aliases,
but omits browser-local session IDs, active pointers, causal checkpoints,
operations, and deletion tombstones. Import rebases the portable records onto
the local causal clock, fills only missing aliases, and cannot delete or switch
existing local history. Colliding thread/message IDs are add-only: local content
and metadata always win. An import that would exceed the 500-thread or
5,000-entry limit fails atomically instead of evicting local history.

## Limits

IndexedDB keeps up to 500 threads with 5,000 recorded entries per thread. The
small compatibility shadow remains 20×200. Each thread keeps its 20 newest
workflow versions; snapshots larger than 300 KB of UTF-8 data fall back to
hash-only metadata. JSON imports are limited to 25 MB, merge by stable record ID,
reject unsupported future schemas, and never delete current history. Workflow
alias and active-pointer maps are causally compacted to 512 entries. If IndexedDB
is unavailable and the full snapshot no longer fits in the 20×200 shadow, the
panel warns that overflow remains only in the open tab and retains the complete
snapshot in memory for retry. Quarantined legacy transcripts, which cannot enter
the fenced IndexedDB store, are exempt from both shadow caps; a localStorage
quota failure is reported rather than silently truncating their only copy.
