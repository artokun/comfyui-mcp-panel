// #1549 — MiniMaxH3PromptBuilder's editor Save writes `prompt_text` and `builder_state`
// together. panel_set_widget is one widget per call, and the orchestrator fences a
// targeted graph mutation while a ComfyUI prompt is running, so the pair can split:
// prompt_text lands, a render starts, builder_state is refused unsent. The queued
// prompt and the saved editor then disagree; the next editor Save overwrites the
// queued prompt from the stale state.
//
// Facts from the pack's own source (ComfyUI-Fantastic-MiniMaxH3-PromptBuilder
// `web/promptbuilder.js` save() / generate() / defaultState()), not inferred from
// the report:
//
//   save() {
//     const pw = this.node.widgets?.find((w) => w.name === "prompt_text");
//     const sw = this.node.widgets?.find((w) => w.name === "builder_state");
//     if (pw) pw.value = generate(this.state);
//     if (sw) sw.value = JSON.stringify(this.state);
//   }
//
// execute() reads prompt_text for the STRING output and builder_state only for
// `_mode_of` (media gating). Mode and prompt cannot disagree after Save because
// they are assigned in the same turn. This route does the same assignment, in
// one undo envelope, with no await between the two widgets — so a render that
// starts after the call cannot split them.
//
// `builder_state` is the master (the editor's JSON). Writing it regenerates
// prompt_text via the pack's generate(). Writing prompt_text with a companion
// `builder_state` argument writes both as given. Writing prompt_text alone still
// writes BOTH widgets: the requested string (what execute() queues) and a
// builder_state aligned so generate(state) matches when the prompt is in the
// pack's labeled format, otherwise the primary editor field holds the new text.
//
// Keyed strictly to node type MiniMaxH3PromptBuilder and those two widget names.
// Dependency-free. Unit-testable with plain fixtures.

export const MINIMAX_H3_PROMPT_BUILDER_TYPE = "MiniMaxH3PromptBuilder";
export const MINIMAX_H3_PROMPT_TEXT_WIDGET = "prompt_text";
export const MINIMAX_H3_BUILDER_STATE_WIDGET = "builder_state";

export const MINIMAX_H3_PROMPT_BUILDER_MODES = Object.freeze([
  "T2VA",
  "I2VA",
  "FL2VA",
  "L2VA",
  "REF",
]);

const TASK_TYPES = Object.freeze([
  "keyframe completion",
  "reference generation",
  "video editing",
  "video continuation",
  "audio reuse",
  "audio reference",
]);

const IMD_PREFIX = "integrated_multimodal_description: ";
const SOUNDSCAPE_PREFIX = "overall_soundscape: ";
const MUSIC_PREFIX = "non_diegetic_music: ";

export class MiniMaxH3PromptBuilderWriteError extends Error {
  constructor(message) {
    super(message);
    this.name = "MiniMaxH3PromptBuilderWriteError";
  }
}

function baseWidgetName(widgetName) {
  if (typeof widgetName !== "string") return "";
  const dot = widgetName.indexOf(".");
  return dot === -1 ? widgetName : widgetName.slice(0, dot);
}

function findWidget(node, name) {
  const widgets = node && Array.isArray(node.widgets) ? node.widgets : [];
  return widgets.find((w) => w && w.name === name) ?? null;
}

export function isMiniMaxH3PromptBuilderNode(node) {
  if (!node || typeof node !== "object") return false;
  return node.type === MINIMAX_H3_PROMPT_BUILDER_TYPE || node.comfyClass === MINIMAX_H3_PROMPT_BUILDER_TYPE;
}

/**
 * `"master"` for builder_state, `"output"` for prompt_text, else null.
 * Either kind is routed through applyMiniMaxH3PromptBuilderWrite so both
 * widgets land in the same undo envelope.
 */
export function classifyMiniMaxH3PromptBuilderWrite(node, widgetName) {
  if (!isMiniMaxH3PromptBuilderNode(node)) return null;
  const name = baseWidgetName(widgetName);
  if (name === MINIMAX_H3_BUILDER_STATE_WIDGET) return "master";
  if (name === MINIMAX_H3_PROMPT_TEXT_WIDGET) return "output";
  return null;
}

export function defaultMiniMaxH3BuilderState() {
  return {
    version: 1,
    mode: "T2VA",
    off: {},
    duration: 5,
    p2Shot: 1,
    lastShot: 1,
    imd: "",
    soundscape: "",
    music: "N/A",
    ref: {
      subjectDefs: [],
      summaryTypes: ["reference generation"],
      summaryText: "",
      retention: [],
      styleLine: "",
      detail: "",
      soundscape: "",
      music: "N/A",
    },
  };
}

/** Merge a stored state over the pack's defaults. Same shape as the editor's normaliseState. */
export function normaliseMiniMaxH3BuilderState(s) {
  if (!s || typeof s !== "object" || Array.isArray(s) || !s.version) {
    return defaultMiniMaxH3BuilderState();
  }
  const d = defaultMiniMaxH3BuilderState();
  const mode = MINIMAX_H3_PROMPT_BUILDER_MODES.includes(s.mode) ? s.mode : d.mode;
  return { ...d, ...s, mode, ref: { ...d.ref, ...(s.ref || {}) } };
}

function sectionOn(state, name) {
  return !(state.off && state.off[name]);
}

function snapLength(seconds) {
  let L = Math.max(5, Math.round((Number(seconds) || 0) * 24));
  L += (5 - (L % 17) + 17) % 17;
  return L;
}

function snappedSeconds(seconds) {
  return snapLength(seconds) / 24;
}

function fmtSS(seconds) {
  return (Math.round(seconds * 100) / 100).toFixed(2);
}

function genBase(state) {
  const S = fmtSS(snappedSeconds(state.duration));
  let head = "";
  if (state.mode === "I2VA") {
    head =
      "For the target video, at 0.00 seconds into the target video, " +
      "<Picture 1> (from [Shot 1]) is fully referenced.";
  } else if (state.mode === "FL2VA") {
    head =
      "How the reference pictures align with the target video — " +
      "Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; " +
      `Picture 2 (from Shot ${state.p2Shot || 1}) aligns with the ${S}-second mark of the target video.`;
  } else if (state.mode === "L2VA") {
    head =
      "How the reference pictures align with the target video — " +
      `<Picture 1> (from [Shot ${state.lastShot || 1}]) aligns with the ${S}-second mark of the target video.`;
  }
  const parts = [`${IMD_PREFIX}${String(state.imd ?? "").trim()}`];
  if (sectionOn(state, "overall_soundscape")) {
    parts.push(`${SOUNDSCAPE_PREFIX}${String(state.soundscape ?? "").trim()}`);
  }
  if (sectionOn(state, "non_diegetic_music")) {
    parts.push(`${MUSIC_PREFIX}${String(state.music ?? "").trim() || "N/A"}`);
  }
  const body = parts.join("\n\n");
  return head ? head + "\n\n" + body : body;
}

function genRef(state) {
  const r = state.ref || defaultMiniMaxH3BuilderState().ref;
  const defs = (r.subjectDefs || [])
    .filter((d) => !d.off)
    .map((d) => String(d.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const types = TASK_TYPES.filter((t) => (r.summaryTypes || []).includes(t)).join(" + ");
  const summary = `[${types || "reference generation"}] ${String(r.summaryText ?? "").trim()}`;
  const retention = (r.retention || [])
    .filter((row) => row.label && !row.off)
    .map((row) => {
      const ctx = row.context?.trim() ? ` (${row.context.trim()})` : "";
      return `${row.label}${ctx}: ${row.marker} - ${String(row.note ?? "").trim()}`;
    })
    .join("\n");
  const detail = [String(r.styleLine ?? "").trim(), String(r.detail ?? "").trim()].filter(Boolean).join("\n");
  const on = (name) => sectionOn(state, name);
  const blocks = [];
  if (on("subject_definitions")) blocks.push(`subject_definitions:\n${defs}`);
  blocks.push(`summary:\n${summary}`);
  if (on("retention_analysis")) blocks.push(`retention_analysis:\n${retention}`);
  blocks.push(`detailed_description:\n${detail}`);
  if (on("overall_soundscape")) blocks.push(`overall_soundscape:\n${String(r.soundscape ?? "").trim()}`);
  if (on("non_diegetic_music")) blocks.push(`non_diegetic_music:\n${String(r.music ?? "").trim() || "N/A"}`);
  return blocks.join("\n\n");
}

/** The pack's generate(): the STRING execute() queues from editor state. */
export function generateMiniMaxH3Prompt(state) {
  const s = normaliseMiniMaxH3BuilderState(state);
  return s.mode === "REF" ? genRef(s) : genBase(s);
}

function looksLikeBuilderState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.version !== "number") return false;
  return MINIMAX_H3_PROMPT_BUILDER_MODES.includes(value.mode);
}

function parseJsonObject(raw, label) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") {
    throw new MiniMaxH3PromptBuilderWriteError(
      `MiniMaxH3PromptBuilder ${label} must be a JSON object or JSON string (#1549).`,
    );
  }
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "{}") return {};
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new MiniMaxH3PromptBuilderWriteError(
      `MiniMaxH3PromptBuilder ${label} is not valid JSON (#1549). The editor Save writes ` +
        `prompt_text and builder_state together; re-issue builder_state as the editor's JSON ` +
        `object (stringified) so both widgets can land in one call.`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MiniMaxH3PromptBuilderWriteError(
      `MiniMaxH3PromptBuilder ${label} must decode to a JSON object (#1549).`,
    );
  }
  return parsed;
}

export function parseMiniMaxH3BuilderState(value) {
  return normaliseMiniMaxH3BuilderState(parseJsonObject(value, "builder_state"));
}

function compiledPromptFromState(state) {
  if (typeof state.prompt_text === "string") return state.prompt_text;
  if (typeof state.compiled === "string") return state.compiled;
  return generateMiniMaxH3Prompt(state);
}

function splitLabeledBlocks(text) {
  return String(text ?? "")
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);
}

function takePrefix(block, prefix) {
  return block.startsWith(prefix) ? block.slice(prefix.length) : null;
}

/**
 * Inverse of generate() for the pack's labeled format. Returns null when the
 * text is not that format, so an unstructured prompt is aligned as a primary
 * field rather than guessed into the wrong sections.
 */
export function parseMiniMaxH3GeneratedPrompt(text, current) {
  const src = String(text ?? "").trim();
  if (!src) return null;
  const base = normaliseMiniMaxH3BuilderState(current);
  if (
    /(?:^|\n)(?:subject_definitions|summary|retention_analysis|detailed_description):/.test(src)
  ) {
    return parseRefGeneratedPrompt(src, base);
  }
  if (
    src.startsWith("For the target video, at 0.00 seconds") ||
    src.startsWith("How the reference pictures align with the target video") ||
    src.includes(IMD_PREFIX.trim())
  ) {
    return parseBaseGeneratedPrompt(src, base);
  }
  return null;
}

function parseBaseGeneratedPrompt(src, current) {
  let rest = src;
  let mode = current.mode === "REF" ? "T2VA" : current.mode;
  let duration = current.duration;
  let p2Shot = current.p2Shot;
  let lastShot = current.lastShot;
  if (rest.startsWith("For the target video, at 0.00 seconds")) {
    mode = "I2VA";
    const split = rest.indexOf("\n\n");
    rest = split >= 0 ? rest.slice(split + 2) : "";
  } else if (rest.startsWith("How the reference pictures align with the target video — Picture 1")) {
    mode = "FL2VA";
    const shot = rest.match(/Picture 2 \(from Shot (\d+)\)/);
    const dur = rest.match(/aligns with the ([0-9.]+)-second mark of the target video\./);
    if (shot) p2Shot = Number(shot[1]) || p2Shot;
    if (dur) duration = Number(dur[1]) || duration;
    const split = rest.indexOf("\n\n");
    rest = split >= 0 ? rest.slice(split + 2) : "";
  } else if (rest.startsWith("How the reference pictures align with the target video — <Picture 1>")) {
    mode = "L2VA";
    const shot = rest.match(/from \[Shot (\d+)\]/);
    const dur = rest.match(/aligns with the ([0-9.]+)-second mark of the target video\./);
    if (shot) lastShot = Number(shot[1]) || lastShot;
    if (dur) duration = Number(dur[1]) || duration;
    const split = rest.indexOf("\n\n");
    rest = split >= 0 ? rest.slice(split + 2) : "";
  }
  const blocks = splitLabeledBlocks(rest);
  const imdBlock = blocks.find((b) => b.startsWith(IMD_PREFIX));
  if (!imdBlock) return null;
  const off = { ...(current.off || {}) };
  const soundscapeBlock = blocks.find((b) => b.startsWith(SOUNDSCAPE_PREFIX));
  const musicBlock = blocks.find((b) => b.startsWith(MUSIC_PREFIX));
  off.overall_soundscape = !soundscapeBlock;
  off.non_diegetic_music = !musicBlock;
  return {
    ...current,
    mode,
    duration,
    p2Shot,
    lastShot,
    imd: takePrefix(imdBlock, IMD_PREFIX) ?? "",
    soundscape: soundscapeBlock ? takePrefix(soundscapeBlock, SOUNDSCAPE_PREFIX) ?? "" : current.soundscape,
    music: musicBlock ? takePrefix(musicBlock, MUSIC_PREFIX) ?? "N/A" : current.music,
    off,
  };
}

function parseRefGeneratedPrompt(src, current) {
  const blocks = splitLabeledBlocks(src);
  const byLabel = {};
  for (const block of blocks) {
    const nl = block.indexOf(":\n");
    const colon = block.indexOf(":");
    if (nl >= 0) byLabel[block.slice(0, nl)] = block.slice(nl + 2);
    else if (colon >= 0) byLabel[block.slice(0, colon)] = block.slice(colon + 1).trim();
  }
  if (!Object.prototype.hasOwnProperty.call(byLabel, "summary") &&
      !Object.prototype.hasOwnProperty.call(byLabel, "detailed_description")) {
    return null;
  }
  const off = { ...(current.off || {}) };
  off.subject_definitions = !Object.prototype.hasOwnProperty.call(byLabel, "subject_definitions");
  off.retention_analysis = !Object.prototype.hasOwnProperty.call(byLabel, "retention_analysis");
  off.overall_soundscape = !Object.prototype.hasOwnProperty.call(byLabel, "overall_soundscape");
  off.non_diegetic_music = !Object.prototype.hasOwnProperty.call(byLabel, "non_diegetic_music");
  const summaryRaw = byLabel.summary || "";
  const summaryMatch = summaryRaw.match(/^\[([^\]]*)\]\s*(.*)$/s);
  const typeStr = summaryMatch ? summaryMatch[1] : "";
  const summaryText = summaryMatch ? summaryMatch[2] : summaryRaw;
  const summaryTypes = typeStr
    .split(/\s*\+\s*/)
    .map((t) => t.trim())
    .filter((t) => TASK_TYPES.includes(t));
  const defLines = (byLabel.subject_definitions || "")
    .split("\n")
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
  const retention = (byLabel.retention_analysis || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(<[^>]+>|[^:(]+)(?:\s*\(([^)]*)\))?:\s*(\S+)\s*-\s*(.*)$/);
      if (!m) return { label: line, context: "", marker: "", note: "" };
      return { label: m[1].trim(), context: m[2] || "", marker: m[3], note: m[4] };
    });
  const detailRaw = byLabel.detailed_description || "";
  const detailNl = detailRaw.indexOf("\n");
  const styleLine = detailNl >= 0 ? detailRaw.slice(0, detailNl) : "";
  const detail = detailNl >= 0 ? detailRaw.slice(detailNl + 1) : detailRaw;
  return {
    ...current,
    mode: "REF",
    off,
    ref: {
      ...current.ref,
      subjectDefs: defLines.length ? defLines : current.ref.subjectDefs,
      summaryTypes: summaryTypes.length ? summaryTypes : current.ref.summaryTypes,
      summaryText: String(summaryText ?? "").trim(),
      retention: retention.length ? retention : current.ref.retention,
      styleLine,
      detail,
      soundscape: byLabel.overall_soundscape ?? current.ref.soundscape,
      music: byLabel.non_diegetic_music || current.ref.music,
    },
  };
}

function alignStateToPrompt(current, prompt) {
  const parsed = parseMiniMaxH3GeneratedPrompt(prompt, current);
  if (parsed && generateMiniMaxH3Prompt(parsed) === prompt) return { state: parsed, how: "parsed" };
  if (parsed) return { state: parsed, how: "parsed_approx" };
  const mode = current.mode === "REF" ? current.mode : current.mode || "T2VA";
  if (mode === "REF") {
    return {
      state: {
        ...current,
        mode: "REF",
        off: {
          ...(current.off || {}),
          overall_soundscape: true,
          non_diegetic_music: true,
          subject_definitions: true,
          retention_analysis: true,
        },
        ref: { ...current.ref, summaryText: "", styleLine: "", detail: prompt },
      },
      how: "primary_text",
    };
  }
  return {
    state: {
      ...current,
      mode,
      imd: prompt,
      off: { ...(current.off || {}), overall_soundscape: true, non_diegetic_music: true },
    },
    how: "primary_text",
  };
}

function readCurrentState(node) {
  const w = findWidget(node, MINIMAX_H3_BUILDER_STATE_WIDGET);
  try {
    return parseMiniMaxH3BuilderState(w?.value ?? "{}");
  } catch {
    return defaultMiniMaxH3BuilderState();
  }
}

function resolvePair(node, widgetName, value, companionState) {
  const name = baseWidgetName(widgetName);
  const current = readCurrentState(node);

  if (name === MINIMAX_H3_BUILDER_STATE_WIDGET) {
    const state = parseMiniMaxH3BuilderState(value);
    return {
      state,
      prompt: compiledPromptFromState(state),
      source: "builder_state",
      aligned: "generated",
    };
  }

  if (companionState !== undefined && companionState !== null && companionState !== "") {
    const state = parseMiniMaxH3BuilderState(companionState);
    const prompt = value == null ? compiledPromptFromState(state) : String(value);
    return {
      state,
      prompt,
      source: "pair",
      aligned: generateMiniMaxH3Prompt(state) === prompt ? "pair_matches" : "pair_explicit",
    };
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (looksLikeBuilderState(parsed)) {
          const state = normaliseMiniMaxH3BuilderState(parsed);
          return {
            state,
            prompt: compiledPromptFromState(state),
            source: "prompt_text_as_state",
            aligned: "generated",
          };
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.builder_state != null) {
          const state = parseMiniMaxH3BuilderState(parsed.builder_state);
          const prompt =
            typeof parsed.prompt_text === "string" ? parsed.prompt_text : compiledPromptFromState(state);
          return { state, prompt, source: "envelope", aligned: "pair_explicit" };
        }
      } catch {
        // Plain prompt that happens to start with `{` — treat as output text.
      }
    }
  }

  const prompt = value == null ? "" : String(value);
  if (generateMiniMaxH3Prompt(current) === prompt) {
    return { state: current, prompt, source: "prompt_text", aligned: "already" };
  }
  const aligned = alignStateToPrompt(current, prompt);
  return { state: aligned.state, prompt, source: "prompt_text", aligned: aligned.how };
}

function missingWidgetsMessage(nodeId, missing) {
  return (
    `MiniMaxH3PromptBuilder node ${nodeId} is missing the widget(s) ${missing.join(", ")}, so ` +
    `prompt_text and builder_state cannot be written together (#1549). The pack's editor Save ` +
    `assigns both in one step; writing one alone is what leaves the queued prompt and the ` +
    `editor out of sync. Check that ComfyUI-Fantastic-MiniMaxH3-PromptBuilder is installed ` +
    `and this node is up to date.`
  );
}

/**
 * Write prompt_text and builder_state in one undo envelope, matching the pack's Save.
 *
 * `companionState` is the optional `builder_state` argument on graph_set_widget,
 * used when the caller's widget is prompt_text so both values arrive in ONE
 * command (the race the reporter hit is strictly between two commands).
 */
export function applyMiniMaxH3PromptBuilderWrite(
  node,
  widgetName,
  value,
  { builder_state: companionState, beforeChange, afterChange, setDirty } = {},
) {
  const promptWidget = findWidget(node, MINIMAX_H3_PROMPT_TEXT_WIDGET);
  const stateWidget = findWidget(node, MINIMAX_H3_BUILDER_STATE_WIDGET);
  const missing = [];
  if (!promptWidget) missing.push(MINIMAX_H3_PROMPT_TEXT_WIDGET);
  if (!stateWidget) missing.push(MINIMAX_H3_BUILDER_STATE_WIDGET);
  if (missing.length) {
    throw new MiniMaxH3PromptBuilderWriteError(missingWidgetsMessage(node?.id, missing));
  }

  const pair = resolvePair(node, widgetName, value, companionState);
  const serializedState = JSON.stringify(pair.state);
  const prevPrompt = promptWidget.value;
  const prevState = stateWidget.value;

  beforeChange?.();
  try {
    promptWidget.value = pair.prompt;
    stateWidget.value = serializedState;
    if (node && typeof node === "object") node._mmh3Draft = null;
  } catch (err) {
    try {
      promptWidget.value = prevPrompt;
    } catch {
      /* restore is best-effort so the original write error stays the refusal */
    }
    try {
      stateWidget.value = prevState;
    } catch {
      /* restore is best-effort so the original write error stays the refusal */
    }
    throw err;
  } finally {
    afterChange?.();
  }
  setDirty?.();

  return {
    set: {
      widget: baseWidgetName(widgetName) || MINIMAX_H3_PROMPT_TEXT_WIDGET,
      value: pair.source === "builder_state" || pair.source === "prompt_text_as_state"
        ? serializedState
        : pair.prompt,
      previous: pair.source === "builder_state" || pair.source === "prompt_text_as_state"
        ? prevState
        : prevPrompt,
      node_id: node.id,
    },
    companion: {
      widget:
        pair.source === "builder_state" || pair.source === "prompt_text_as_state"
          ? MINIMAX_H3_PROMPT_TEXT_WIDGET
          : MINIMAX_H3_BUILDER_STATE_WIDGET,
      value:
        pair.source === "builder_state" || pair.source === "prompt_text_as_state"
          ? pair.prompt
          : serializedState,
      previous:
        pair.source === "builder_state" || pair.source === "prompt_text_as_state"
          ? prevPrompt
          : prevState,
    },
    minimax_h3_prompt_builder: {
      node_id: node.id,
      synced: [MINIMAX_H3_PROMPT_TEXT_WIDGET, MINIMAX_H3_BUILDER_STATE_WIDGET],
      source: pair.source,
      aligned: pair.aligned,
    },
  };
}
