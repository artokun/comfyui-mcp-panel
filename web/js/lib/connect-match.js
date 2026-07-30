// graph_connect: type-based slot auto-matching + full-slot failure diagnostics.
// See docs/design/connect-auto-match.md. Ported/extended from FL-MCP's fl_api.js
// (type auto-match + rich failures) with `*` wildcard + COMBO handling, widget
// ranking, an ambiguity guard, and no silent fallback on a named-slot miss.
//
// Extracted from comfyui-mcp-panel.js into a shared, importable module so the
// auto-match logic runs the IDENTICAL code path the unit tests drive (the panel
// only resolves the live graph/nodes and delegates here). This mirrors the
// set-widget.js extraction and locks the connect edge-cases with real tests:
//   #351 — a numeric slot index that arrives as a STRING ("0", because MCP tool
//          args are JSON round-tripped) is an INDEX, not a slot NAME.
//   #169 — auto-match must never silently clobber an OCCUPIED dynamic wildcard
//          ("*") input (rgthree Fast Bypasser / Power Lora) when no free
//          wildcard slot is available yet.

export const SLOT_RANK_EXACT = 2;
export const SLOT_RANK_WILD = 1;

/** True if a slot type is a COMBO/array selector (LiteGraph passes the option
 *  list as the "type"), or the literal string "COMBO". Combos auto-match only
 *  against an identical combo — never via the "*" wildcard. */
export function isComboType(type) {
  return Array.isArray(type) || String(type ?? "").toUpperCase() === "COMBO";
}

/** Stable signature so two combos compare equal only when they carry the same
 *  option set (arrays) or are both the bare "COMBO". */
export function comboSignature(type) {
  if (Array.isArray(type)) return "COMBO[" + type.map((o) => String(o)).join(String.fromCharCode(0)) + "]";
  return "COMBO";
}

/** Split a (possibly comma-joined, e.g. "IMAGE,MASK") type string into segments. */
export function typeSegments(type) {
  return String(type ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when a (non-combo) slot type is a dynamic wildcard — its type is, or
 *  contains, the "*" segment. Used to protect occupied rgthree dynamic inputs
 *  from being silently replaced by auto-match (#169). A type-less input
 *  (undefined/null) is NOT treated as a wildcard here, so we never over-refuse a
 *  normal reconnect. */
export function isWildcardSlotType(type) {
  if (type == null) return false;
  if (isComboType(type)) return false;
  return typeSegments(type).includes("*");
}

/** Type-compatibility RANK between an output type and an input type:
 *    0 = incompatible, 2 (SLOT_RANK_EXACT) = exact, 1 (SLOT_RANK_WILD) = "*".
 * Higher wins, so an exact pairing always outranks a wildcard one. COMBO/array
 * types match identical-only and never via wildcard; comma multi-types match if
 * ANY segment matches. Falsy (0) when incompatible, so usable as a boolean. */
export function isTypeCompatible(outType, inType) {
  const outCombo = isComboType(outType);
  const inCombo = isComboType(inType);
  if (outCombo || inCombo) {
    if (!outCombo || !inCombo) return 0; // a combo only pairs with a combo
    return comboSignature(outType) === comboSignature(inType) ? SLOT_RANK_EXACT : 0;
  }
  const outSegs = typeSegments(outType);
  const inSegs = typeSegments(inType);
  let best = 0;
  for (const o of outSegs) {
    for (const i of inSegs) {
      if (o === "*" || i === "*") best = Math.max(best, SLOT_RANK_WILD);
      else if (o.toUpperCase() === i.toUpperCase()) best = Math.max(best, SLOT_RANK_EXACT);
    }
  }
  return best;
}

/** True when two slot types are the same (combo-aware, case-insensitive). */
export function sameSlotType(a, b) {
  if (isComboType(a) || isComboType(b)) return comboSignature(a) === comboSignature(b);
  return String(a ?? "").toUpperCase() === String(b ?? "").toUpperCase();
}

/** Human render of a slot type for diagnostics: COMBO(<n> options) for array
 *  combos, else the raw type string. */
export function renderSlotType(type) {
  if (Array.isArray(type)) return `COMBO(${type.length} options)`;
  if (String(type ?? "").toUpperCase() === "COMBO") return "COMBO";
  return String(type ?? "*");
}

/** Short base type name (no option count) for widget-tagged inputs. */
export function baseSlotType(type) {
  if (isComboType(type)) return "COMBO";
  return String(type ?? "*");
}

// One type-specific hint appended to the diagnostic tip when the failing output
// type is unambiguous.
export const SLOT_TYPE_HINTS = {
  MODEL: "MODEL outputs typically feed KSampler.model",
  CLIP: "CLIP outputs typically feed CLIPTextEncode.clip",
  VAE: "VAE outputs typically feed VAEDecode.vae / VAEEncode.vae",
  CONDITIONING: "CONDITIONING feeds KSampler.positive / negative",
  LATENT: "LATENT feeds KSampler.latent_image / VAEDecode.samples",
  IMAGE: "IMAGE feeds VAEEncode / PreviewImage / SaveImage",
};

/** A bare integer token (real number or numeric string like "0"/"3") → its int
 *  value, else null. MCP tool args are JSON round-tripped, so a slot INDEX can
 *  arrive as a string; it must still resolve as an index, never a slot name
 *  (#351). */
function asIndexToken(ref) {
  if (typeof ref === "number" && Number.isInteger(ref)) return ref;
  if (typeof ref === "string" && /^-?\d+$/.test(ref.trim())) return Number.parseInt(ref.trim(), 10);
  return null;
}

/** Build the full multi-line connect-failure diagnostic: every output and input
 *  with index, name, type and [connected] / (TYPE/widget) flags, plus a tip.
 *  `requested` carries the raw refs { from_output, to_input } and an optional
 *  `reason` (used by the ambiguity / wildcard guard) that overrides the computed
 *  tail. */
export function slotDiagnostic(origin, target, requested = {}) {
  const refLabel = (ref) =>
    ref == null ? "auto" : typeof ref === "string" ? `"${ref}"` : String(ref);
  const outs = (origin.outputs ?? [])
    .map((o, i) => `[${i}] "${o?.name ?? ""}" (${renderSlotType(o?.type)})`)
    .join(", ");
  const ins = (target.inputs ?? [])
    .map((inp, i) => {
      const typeStr = inp?.widget
        ? `${baseSlotType(inp?.type)}/widget`
        : renderSlotType(inp?.type);
      const connected = inp?.link != null ? " [connected]" : "";
      return `[${i}] "${inp?.name ?? ""}" (${typeStr})${connected}`;
    })
    .join(", ");

  // The output type we were trying to place, when known, used for the tail
  // sentence + type-specific hint. Resolve it with the SAME name-first precedence
  // as resolveExplicitSlot (a slot NAMED "0" wins over index 0; a numeric string
  // only falls back to an index when no slot bears that name) so the diagnostic
  // describes the slot that matching would actually have chosen.
  let failType = null;
  const fromRef = requested.from_output;
  const outList = origin.outputs ?? [];
  if (typeof fromRef === "number" && Number.isInteger(fromRef)) {
    failType = outList[fromRef]?.type ?? null;
  } else if (typeof fromRef === "string") {
    const want = fromRef.trim().toLowerCase();
    const hit = outList.find((o) => o?.name?.trim().toLowerCase() === want);
    if (hit) {
      failType = hit.type;
    } else {
      const idx = asIndexToken(fromRef);
      if (idx != null && outList[idx]) failType = outList[idx].type;
    }
  } else if (outList.length === 1) {
    failType = outList[0]?.type;
  }

  let tail;
  if (requested.reason) {
    tail = requested.reason;
  } else if (failType != null && !isComboType(failType)) {
    const typeName = typeSegments(failType)[0]?.toUpperCase();
    const hint = SLOT_TYPE_HINTS[typeName];
    tail =
      `No input on node ${target.id} accepts type ${renderSlotType(failType)}. ` +
      `Tip: ${hint ? hint + "; " : ""}check wiring with panel_query_graph.`;
  } else {
    tail =
      `No compatible output→input pair found between node ${origin.id} and node ${target.id}. ` +
      `Tip: check wiring with panel_query_graph.`;
  }

  const oType = origin.type ?? origin.comfyClass ?? origin.title ?? "node";
  const tType = target.type ?? target.comfyClass ?? target.title ?? "node";
  return (
    `Could not connect node ${origin.id} (${oType}) → node ${target.id} (${tType}).\n` +
    `Requested: from_output=${refLabel(requested.from_output)} → to_input=${refLabel(requested.to_input)}.\n` +
    `Node ${origin.id} outputs: ${outs || "none"}\n` +
    `Node ${target.id} inputs:  ${ins || "none"}\n` +
    tail
  );
}

/** Resolve one explicit slot ref to an index, or null when omitted (auto).
 *  A bare integer token (real number OR numeric string such as "0") is an INDEX
 *  and is range-checked; any other string is a case-insensitive/trimmed NAME
 *  lookup with NO silent fallback. Returns
 *  { index } | { error: "range"|"name" } | null (omitted). */
export function resolveExplicitSlot(slots, ref) {
  if (ref == null) return null;
  const list = slots ?? [];
  // A real numeric index.
  if (typeof ref === "number" && Number.isInteger(ref)) {
    if (ref < 0 || ref >= list.length) return { error: "range" };
    return { index: ref };
  }
  // Prefer an exact slot NAME match FIRST — this preserves the string-as-name
  // contract, so a slot literally named "0" stays reachable.
  const name = String(ref).trim().toLowerCase();
  const byName = list.findIndex((s) => s?.name?.trim().toLowerCase() === name);
  if (byName !== -1) return { index: byName };
  // #351: no slot has that name, but a bare integer token arrived JSON-stringified
  // ("0", because MCP tool args are JSON round-tripped) — resolve it as an INDEX
  // rather than failing as a name-miss (which surfaced the generic "no compatible
  // pair" error on a valid IMAGE→IMAGE). Real ComfyUI slots are never named with a
  // bare integer, so this only rescues a genuine index that came through as text.
  const idxToken = asIndexToken(ref);
  if (idxToken != null) {
    if (idxToken < 0 || idxToken >= list.length) return { error: "range" };
    return { index: idxToken };
  }
  return { error: "name" };
}

/** Resolve output/input slot indices for graph_connect, auto-matching omitted
 *  sides by type. Returns { outIdx, inIdx, autoMatched: [...] } or throws a
 *  diagnostic Error (range error for a bad index; slotDiagnostic otherwise:
 *  named-slot miss, no compatible pair, an ambiguous tie, or an occupied dynamic
 *  wildcard). */
export function autoMatchSlots(origin, target, fromRef, toRef) {
  const outputs = origin.outputs ?? [];
  const inputs = target.inputs ?? [];
  const requested = { from_output: fromRef, to_input: toRef };

  const out = resolveExplicitSlot(outputs, fromRef);
  const inp = resolveExplicitSlot(inputs, toRef);
  if (out?.error === "range")
    throw new Error(`output slot index ${fromRef} out of range (node has ${outputs.length})`);
  if (out?.error === "name") throw new Error(slotDiagnostic(origin, target, requested));
  if (inp?.error === "range")
    throw new Error(`input slot index ${toRef} out of range (node has ${inputs.length})`);
  if (inp?.error === "name") throw new Error(slotDiagnostic(origin, target, requested));

  const outIdxFixed = out ? out.index : null;
  const inIdxFixed = inp ? inp.index : null;

  // Both explicit → straight through, no auto-match.
  if (outIdxFixed != null && inIdxFixed != null) {
    return { outIdx: outIdxFixed, inIdx: inIdxFixed, autoMatched: [] };
  }

  const autoMatched = [];
  if (fromRef == null) autoMatched.push("from_output");
  if (toRef == null) autoMatched.push("to_input");

  const outCandidates = outIdxFixed != null ? [outIdxFixed] : outputs.map((_, i) => i);
  const inCandidates = inIdxFixed != null ? [inIdxFixed] : inputs.map((_, i) => i);

  // Score every type-compatible (output, input) pairing.
  const pairs = [];
  for (const oi of outCandidates) {
    const oType = outputs[oi]?.type;
    for (const ii of inCandidates) {
      const input = inputs[ii];
      const rank = isTypeCompatible(oType, input?.type);
      if (!rank) continue;
      pairs.push({
        outIdx: oi,
        inIdx: ii,
        rank,
        connected: input?.link != null,
        widget: !!input?.widget,
        inType: input?.type,
      });
    }
  }

  if (!pairs.length) throw new Error(slotDiagnostic(origin, target, requested));

  // Preference: exact type > wildcard; unconnected > connected; non-widget >
  // widget; then lowest input index, then lowest output index.
  const score = (p) => [p.rank, p.connected ? 0 : 1, p.widget ? 0 : 1];
  pairs.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] - sa[i];
    if (a.inIdx !== b.inIdx) return a.inIdx - b.inIdx;
    return a.outIdx - b.outIdx;
  });
  const best = pairs[0];

  // #169: when the INPUT side was auto-matched and the best (only) compatible
  // pair would REPLACE a link already on a dynamic wildcard ("*") input, refuse
  // non-destructively. rgthree dynamic nodes (Fast Bypasser / Power Lora / Any
  // Switch) append a fresh empty "*" slot after each connect; the scorer already
  // prefers a free slot, so best.connected on a wildcard here means NO free
  // wildcard exists yet — auto-connecting would silently drop an earlier
  // controller link. Explicit to_input still replaces deliberately.
  if (inIdxFixed == null && best.connected && isWildcardSlotType(best.inType)) {
    const nm = inputs[best.inIdx]?.name ?? best.inIdx;
    const reason =
      `input "${nm}" is an occupied dynamic wildcard (*) slot and no free wildcard ` +
      `input is available yet — retry after the node adds an empty slot, or pass an ` +
      `explicit to_input to replace this link deliberately`;
    throw new Error(slotDiagnostic(origin, target, { ...requested, reason }));
  }

  // Ambiguity guard: when the INPUT side was auto-matched, ≥2 equally-ranked,
  // unconnected, non-widget candidates on DIFFERENT input slots of the same type
  // → refuse rather than silently pick one (the classic wrong-negative bug).
  if (inIdxFixed == null && !best.connected && !best.widget) {
    const tied = pairs.filter(
      (p) =>
        p.inIdx !== best.inIdx &&
        p.rank === best.rank &&
        !p.connected &&
        !p.widget &&
        sameSlotType(p.inType, best.inType),
    );
    if (tied.length) {
      const uniqNames = [
        ...new Set([best, ...tied].map((p) => inputs[p.inIdx]?.name).filter(Boolean)),
      ];
      const reason = `ambiguous: ${uniqNames.length} ${renderSlotType(best.inType)} inputs (${uniqNames.join(
        ", ",
      )}) — name one`;
      throw new Error(slotDiagnostic(origin, target, { ...requested, reason }));
    }
  }

  return { outIdx: best.outIdx, inIdx: best.inIdx, autoMatched };
}
