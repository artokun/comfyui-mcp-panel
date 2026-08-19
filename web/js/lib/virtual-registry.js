// comfyui-mcp#1400 — the frontend's VIRTUAL-node registry, as a bridge answer.
//
// `check_runtime` (the headless paid-API classifier in comfyui-mcp) works from a
// workflow's class_types and the server's /object_info. A type absent from
// /object_info is reported "unknown" — cautious, and right for a type that COULD
// be a paid node the server does not expose. But that caution collapses the
// whole verdict for types that can never execute at all: frontend-only VIRTUAL
// nodes (KJNodes' Get/Set bus, rgthree's Label / Fast Groups toggles, litegraph's
// own Note/Reroute/…). #1372/#1564 exempted the names it knew; the owner declined
// a list of third-party names — a list goes stale and then reads as authoritative.
//
// The authority is this page's LiteGraph registry. The signal, proven against the
// shipped frontend 1.48.7 bundle and each pack's own source (see
// lib/frontend-virtual-nodes.js for the full derivation), is
// `instance.isVirtualNode === true` — the exact flag ComfyUI's serializer reads
// to decide what never reaches the backend. frontend-virtual-nodes.js reads it
// off LIVE node instances; this module answers for a REGISTERED TYPE that has no
// live instance, which is check_runtime's case (it classifies a graph that is
// usually not on the canvas yet).
//
// HOW: construct one probe instance of the registered class and read the flag.
// Every pack that sets it does so unconditionally in its constructor (KJNodes
// `this.isVirtualNode = true`, rgthree's RgthreeBaseVirtualNode, the frontend's
// own natives), so one instance speaks for the type. The probe is never added to
// a graph and is discarded immediately.
//
// FAIL-CLOSED, in every direction that matters:
//
//   - Classes with BACKEND PROVENANCE (a static .nodeData/.comfyClass, stamped by
//     the frontend's registerNodesFromDefs — shared predicate with the #458 write
//     guards, so the two cannot drift) are never probed and never reported. Those
//     are the server's types (or a removed pack's stale husk); absence from
//     /object_info there must stay "unknown". This also keeps the frontend's
//     SUBGRAPH container classes out — they carry a synthesized def by design,
//     their constructors need graph arguments a probe cannot supply, and
//     check_runtime already recognizes subgraph instances structurally.
//   - A constructor that THROWS (some classes need construction context a bare
//     probe does not provide) proves nothing: the type is simply not reported,
//     and stays "unknown" to the classifier. Cautious, never wrong.
//   - A defless PLACEHOLDER is not a registered class at all, so it can never be
//     probed into a false positive — the #1284 rig (GetNode/SetNode as dead
//     placeholders in a tab that never loaded KJNodes' JS) reports NO virtual
//     types for them, exactly as the live-instance predicate does.
//   - The flag is re-read with `=== true` off the probe, not trusted from the
//     class: a truthy-but-not-true value is not proof (same bar as
//     isFrontendVirtualNode).
//
// What this deliberately does NOT do: maintain any list of names. A pack nobody
// has heard of is covered on the same terms, because a virtual node whose class
// does not set the flag is serialized into the prompt and rejected by the server
// — a pack cannot both omit the flag and work.

import { hasBackendProvenance } from "./node-resolve.js";

/**
 * The registered node types this page PROVES frontend-virtual, sorted.
 *
 * `registry` is LiteGraph.registered_node_types (type name → node class).
 * Anything unreadable — no registry, a non-function entry, a throwing
 * constructor, an unreadable flag — exempts nothing: the type is left out, and
 * the headless classifier keeps its cautious "unknown" for it.
 */
export function collectFrontendVirtualTypes(registry) {
  const out = new Set();
  if (!registry || typeof registry !== "object") return [];
  let names;
  try {
    names = Object.keys(registry);
  } catch {
    return [];
  }
  for (const type of names) {
    let ctor;
    try {
      ctor = registry[type];
    } catch {
      continue; // a throwing getter exempts nothing
    }
    if (typeof ctor !== "function") continue;
    // The server's own classes are never probed: a backend-derived (or stale
    // backend husk) class is /object_info's question, not this registry's.
    let backend = true;
    try {
      backend = hasBackendProvenance(ctor);
    } catch {
      continue; // a verdict we cannot read is not "frontend-only"
    }
    if (backend) continue;
    let probe;
    try {
      // The title argument is the TYPE, not the display title: rgthree's base
      // constructor throws on its unset "__NEED_CLASS_TITLE__" default, so a
      // no-arg probe would refuse every rgthree class for a cosmetic reason.
      // The probe is discarded; its title is never shown anywhere.
      probe = new ctor(type);
    } catch {
      continue; // a class that cannot be bare-constructed proves nothing
    }
    let virtual = false;
    try {
      virtual = !!probe && probe.isVirtualNode === true;
    } catch {
      virtual = false;
    }
    if (virtual) out.add(type);
  }
  return [...out].sort();
}
