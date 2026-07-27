# Chat History v2

Chat History v2 replaces the legacy `localStorage`-only ring (20 threads, 200
messages each) with a versioned, workflow-aware history system.

## Conversation scope

Settings → ComfyUI MCP Agent → General → **Chat conversation scope**:

- **Panel** keeps one conversation while canvases change.
- **Workflow** keeps an independent collection of conversations for every graph.
- **Ask** chooses between those behaviors whenever the active workflow changes.

The plus button starts a new conversation without deleting older chats. The
history button opens search, current-workflow filtering, rename, pin, delete,
export, and merge-import controls.

## Identity

Bridge routing still uses `wf:<path>`/`tmp:<uuid>` because the orchestrator binds
agents to the current tab. Transcript identity is separate:
`workflow:<embedded UUID>`. The UUID is stored in
`workflow.extra.comfyui_mcp.workflow_uuid` on the first per-workflow chat.

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
