// UPLOAD-input recognition for the set_widget stale-combo recovery (#387).
//
// The #338/#340 stale-combo refresh re-pulls /object_info and revalidates a
// just-staged value against the AUTHORITATIVE option list. That covers a downloaded
// model (appears in the loader combo) and a TOP-LEVEL uploaded image (LoadImage's
// `image` combo lists it). It does NOT cover an image uploaded under a SUBFOLDER:
// ComfyUI's LoadImage.INPUT_TYPES enumerates only TOP-LEVEL files of the input dir
// (`os.listdir` + `isfile`), so a `subfolder/name.png` upload is NEVER in the
// /object_info combo — no refresh can make it a member — even though LoadImage will
// happily LOAD it (`folder_paths.get_annotated_filepath` resolves the nested path).
// So panel_set_widget rejected a perfectly loadable, server-confirmed input asset.
//
// The recovery: when a combo value is rejected for an UPLOAD input AND the server
// CONFIRMS the file exists in its input directory, accept it (add it to the live
// option list). This preserves #240 strictness — it is gated to upload inputs and to
// files the backend actually has, never a blanket accept-anything.
//
// Pure module (no DOM / no fetch): the caller injects the server-existence check.

// Upload-input config flags ComfyUI attaches to an input SPEC's config object. Any
// truthy one marks the input as one the user uploads a file into (image / video /
// audio / 3d model), whose valid values live on DISK, not only in the combo snapshot.
//
// #1569 — the 3D kind serializes as `file_upload`, NOT `model_upload`. ComfyUI's own
// `UploadType` enum (comfy_api/latest/_io.py) is image="image_upload",
// audio="audio_upload", video="video_upload", model="file_upload", and the V1 spelling
// that predates it was already `{"file_upload": True}` (ComfyUI bdf39379, Dec 2024, the
// commit that added Load3D). MEASURED on a live 0.33.2 /object_info (853 types): four
// `image_upload`, one `audio_upload`, one `video_upload`, TWO `file_upload`
// (Load3D.model_file, Load3DAdvanced.model_file) — and ZERO `model_upload`.
//
// `model_upload` is kept anyway, and that is a decision rather than an oversight. It has
// never been a ComfyUI flag in any release — `git log -S model_upload -- '*.py'` over the
// whole ComfyUI history returns no commit that introduces it as an input config key — so
// it cannot be legacy for an older supported server. It is kept because a third-party pack
// is free to invent it for a checkpoint-upload widget, dropping it could only ever REFUSE
// a write that is accepted today, and recognising it costs nothing: `uploadInputAccepts`
// admits a value only when the config carries the flag AND the extension matches THAT
// flag's own kind, so an unused flag can never widen anything.
const UPLOAD_CONFIG_FLAGS = ["image_upload", "video_upload", "audio_upload", "model_upload", "file_upload"];

// Extension allowlist PER upload kind. A successful `/view?type=input` probe proves a
// file EXISTS, not that it is a LOADABLE asset of the RIGHT kind — `/view` serves any
// input file regardless of type, so a bare existence check would let a `foo.txt` (or a
// stray file) be accepted into a LoadImage's image combo and then fail at execution,
// weakening #240's strict combo validation. Gating the fallback on an extension that
// matches the input's upload kind keeps the accept tight: only a plausibly-loadable
// image/video/audio/model file of the correct family is admitted. `gif` intentionally
// appears under both image and video.
const UPLOAD_KIND_EXTENSIONS = {
  image_upload: new Set([
    "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "jfif", "ppm",
    "avif", "ico", "apng", "heic", "heif",
  ]),
  video_upload: new Set([
    "mp4", "webm", "mkv", "mov", "avi", "m4v", "gif", "mpg", "mpeg", "wmv", "flv", "ogv",
  ]),
  audio_upload: new Set([
    "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma", "aiff", "aif",
  ]),
  model_upload: new Set([
    "safetensors", "ckpt", "pt", "pth", "bin", "gguf", "sft", "onnx",
  ]),
  // #1569 — the 3D-asset kind (`file_upload`), and it is NOT the weight-file kind above.
  // These are exactly the suffixes `Load3D.define_schema` itself enumerates when it builds
  // the combo (comfy_extras/nodes_load_3d.py: `file_path.suffix.lower() in {...}`), so a
  // value the panel admits here is one ComfyUI's own listing would have offered had the
  // file been under `input/3d/`. Deliberately NOT widened to `.usdz` — Preview3D declares a
  // USDZ socket type, but Load3D's listing does not include it, and #240 says refuse where
  // the server's own enumeration would not offer.
  //
  // Sharing the weight-file set would have been the wrong reuse: ComfyUI runs NO extension
  // check of its own on this input (`Load3D.validate_inputs` only asks
  // `exists_annotated_filepath`), so this list is the ONLY thing standing between a
  // server-confirmed `3d/notes.txt` and a Load3D combo — measured: `/view` serves that file
  // 206 and ComfyUI's own /prompt validation ACCEPTS it.
  file_upload: new Set([
    "gltf", "glb", "obj", "fbx", "stl", "spz", "splat", "ply", "ksplat",
  ]),
};

/**
 * The TRI-STATE verdict a ComfyUI `/view` existence probe supports (#1357).
 *
 *   true  — the server served the file: it is there.
 *   false — the server ANSWERED and said it is not there (404).
 *   null  — the question was NOT answered: no response, a traversal refusal (400),
 *           an auth/proxy status, a 5xx, a timeout.
 *
 * The third state is load-bearing. A caller that only ever over-reports (the
 * missing-media filter, which already has a STORE asserting the miss) may collapse
 * `false` and `null` into "keep reporting". The live combo scan may NOT: its only
 * other evidence is an option list that structurally cannot contain the value, so
 * a flaky fetch read as a confirmed miss manufactures the exact false positive
 * #1357 reported. `null` on every uncertainty, always.
 */
export function inputAssetProbeVerdict(res) {
  try {
    if (!res) return null;
    if (res.ok === true || res.status === 206) return true;
    return res.status === 404 ? false : null;
  } catch {
    return null;
  }
}

/**
 * Query string for a ComfyUI `/view` existence probe.
 *
 * Do not build this with `URLSearchParams`. That encodes a space as `+`
 * (application/x-www-form-urlencoded), and aiohttp/yarl on some ComfyUI
 * versions treat `+` as a literal plus, so `image (992).png` is asked as
 * `image+(992).png` and 404s. That is the #1357 regression after #1368 —
 * the original test value had no spaces, so the probe looked fine. Percent-
 * encoding matches ComfyUI's own `getResourceURL` (`filename=` +
 * encodeURIComponent): decodeURIComponent of the filename param is the file
 * on disk.
 */
export function inputAssetViewQuery({ filename, subfolder = "", type = "input" } = {}) {
  if (!filename || !type) return "";
  return (
    `filename=${encodeURIComponent(String(filename))}` +
    `&subfolder=${encodeURIComponent(String(subfolder ?? ""))}` +
    `&type=${encodeURIComponent(String(type))}`
  );
}

/**
 * TRI-STATE `/view` existence probe. `fetchApi` is injected so this module
 * stays free of the ComfyUI API client. See `inputAssetProbeVerdict`.
 */
export async function probeInputAssetPresence(ref, timeoutMs, fetchApi) {
  try {
    if (typeof fetchApi !== "function") return null;
    const { filename, type } = ref ?? {};
    if (!filename || !type) return null;
    if (!(timeoutMs > 0)) return null;
    const qs = inputAssetViewQuery(ref);
    const res = await fetchApi(`/view?${qs}`, {
      method: "GET",
      cache: "no-store",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return inputAssetProbeVerdict(res);
  } catch {
    return null;
  }
}

/**
 * `config` back, when it is an input spec's config object carrying at least one
 * UPLOAD flag; otherwise null. Callers that already hold the per-input config
 * (the live combo scan reads it straight out of `/object_info/<class>`) use this
 * instead of re-walking a whole defs map, so both paths decide "is this an upload
 * input" from the ONE flag list above.
 */
export function uploadConfigOf(config) {
  try {
    if (!config || typeof config !== "object") return null;
    return UPLOAD_CONFIG_FLAGS.some((f) => config[f]) ? config : null;
  } catch {
    return null;
  }
}

/**
 * The config object for `widgetName` on the fresh /object_info def for `type`, when
 * that input is an UPLOAD input; otherwise null. ComfyUI encodes an input spec as
 * `[typeOrOptions, config?]`; an upload input carries e.g. `{ image_upload: true }`.
 * Reads required THEN optional. Fully defensive — a malformed def yields null (⇒ no
 * upload fallback ⇒ the value simply stays rejected, same as before).
 */
export function uploadInputConfig(defsByType, type, widgetName) {
  try {
    if (!defsByType || !type || !widgetName) return null;
    const def = defsByType[type];
    const input = def?.input;
    if (!input) return null;
    const spec =
      (input.required && input.required[widgetName]) ??
      (input.optional && input.optional[widgetName]);
    if (!Array.isArray(spec)) return null;
    return uploadConfigOf(spec[1]);
  } catch {
    return null;
  }
}

/**
 * The authoritative option list a def spec publishes, or NULL when this spec does not
 * carry one. Never guesses: a caller that gets null has learned that it cannot read
 * this list, which is a different thing from an input that is not a combo.
 *
 * MEASURED against a live ComfyUI 0.33 /object_info, because the V1 shape was the only
 * one originally handled and it is now the MINORITY:
 *
 *     [[opt, ...], config?]                    V1 — the historical shape
 *     ["COMBO", { options: [opt, ...] }]       V2 — the common shape today
 *     ["COMBO", { remote: { route } }]         V2 remote — the list is a separate fetch;
 *                                              nothing to read until it lands
 *     ["COMFY_DYNAMICCOMBO_V3", { options: [{ key, inputs }] }]
 *                                              the keys select SUB-INPUTS to materialize;
 *                                              they are not an option list
 *
 * The last two return null on purpose — "I could not read it", never "it is empty".
 * That distinction is load-bearing for `serverDeclaresEmptyComboOptions` below.
 *
 * Lives in this LEAF module (no imports) so both consumers can share one reader:
 * asset-staleness.js re-exports it, and `serverDeclaresEmptyComboOptions` uses it
 * directly. It previously lived in asset-staleness.js, which this file must not
 * import from — that is how the two drifted apart (mcp#1940).
 */
export function authoritativeComboValues(spec) {
  if (!Array.isArray(spec)) return null;
  // V1 — the first element IS the option array.
  if (Array.isArray(spec[0])) return spec[0];
  // V2 — a "COMBO" type string, options under the config object.
  //
  // A REMOTE list is unread by definition: it arrives from a separate fetch and the
  // frontend shows "Loading…" until it lands. Measured remote V2 specs carry no `options`
  // array at all, so this is defense in depth rather than a live shape — but the whole
  // safety argument for reading V2 is that UNREAD never becomes EMPTY, and a spec carrying
  // `remote` alongside an empty `options` would be exactly the case that breaks it.
  if (spec[0] === "COMBO" && spec[1]?.remote) return null;
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options;
  return null;
}

/**
 * TRUE only when the freshly-fetched /object_info AUTHORITATIVELY declares `widgetName`
 * on `type` to be a combo whose option list is EMPTY — i.e. the SERVER itself says there
 * is nothing to validate against (StarNodes' `"model": ((), {...})` ⇒ `[[], {...}]`).
 *
 * This is the gate on #507's last-resort "an empty option list is not knowable, so take
 * the value as written". Reading the LIVE widget alone is NOT sufficient (codex round-2,
 * SEVERE): a widget whose `options.values` is a FUNCTION is deliberately never clobbered
 * by the combo refresh (refreshComboOptionsFromDefs skips function sources), so a dynamic
 * source that happens to return `[]` right now would otherwise look "empty" even while
 * /object_info publishes a real, non-empty list — and an off-list value would be written,
 * violating #240. Requiring the SERVER to declare the list empty makes that impossible.
 *
 * Fails CLOSED on every uncertainty: no defs, no def for the type, no such input, a
 * spec that publishes no readable option list, or a NON-EMPTY declared list all return
 * false, so the value simply stays rejected exactly as before.
 *
 * mcp#1940 — the emptiness test reads the list through `authoritativeComboValues`, NOT
 * off `spec[0]`. `spec[0]` is the option array only in the V1 shape; the now-common V2
 * `["COMBO", { options: [] }]` puts it under the config object and leaves the literal
 * type string "COMBO" at `spec[0]`. Testing `Array.isArray(spec[0])` therefore filed
 * every V2 combo under "not a combo" and returned false — measured on a live 0.33
 * /object_info as 0 of 11 server-declared-empty V2 inputs recognised, against 30 of 30
 * V1. That made #507's last-resort accept UNREACHABLE for them, so `CustomCombo.choice`
 * (declared `["COMBO", { multiselect: false, options: [] }]`) was permanently unwritable
 * and the refusal blamed a STALE list that no refresh could ever change.
 *
 * The read stays authoritative in the direction that matters. A remote V2 and a dynamic
 * V3 both yield null, not [], so neither is mistaken for "the server says empty" — an
 * unread list must keep failing closed, exactly as a NON-EMPTY one does.
 */
export function serverDeclaresEmptyComboOptions(defsByType, type, widgetName) {
  try {
    if (!defsByType || !type || !widgetName) return false;
    const input = defsByType[type]?.input;
    if (!input) return false;
    const spec =
      (input.required && input.required[widgetName]) ??
      (input.optional && input.optional[widgetName]);
    const options = authoritativeComboValues(spec);
    return Array.isArray(options) && options.length === 0;
  } catch {
    return false;
  }
}

/**
 * TRUE when /object_info identifies a V2 COMBO whose options arrive from a separate remote
 * source. That source is not an empty option list: the panel cannot know its valid values until
 * the remote fetch lands, so this must never authorize #507's blind write.
 */
export function serverDeclaresRemoteComboOptions(defsByType, type, widgetName) {
  try {
    if (!defsByType || !type || !widgetName) return false;
    const input = defsByType[type]?.input;
    if (!input) return false;
    const spec =
      (input.required && input.required[widgetName]) ??
      (input.optional && input.optional[widgetName]);
    return Array.isArray(spec) && spec[0] === "COMBO" && !!spec[1]?.remote;
  } catch {
    return false;
  }
}

/**
 * True when `value`'s file extension is a plausibly-LOADABLE asset for the upload
 * `config`'s kind (image/video/audio/model). This is the strictness gate on top of a
 * mere server-existence probe (#240): `/view?type=input` confirms the file is on disk
 * but NOT that it is a loadable image, so a LoadImage image combo must still refuse a
 * `.txt`/`.json`/extensionless file even if the server has one. A config may carry
 * more than one upload flag; the value is accepted if its extension matches ANY of the
 * present kinds. Defensive: a null config or an extensionless value returns false.
 */
export function uploadInputAccepts(config, value) {
  try {
    if (!config) return false;
    const { filename } = splitInputAssetRef(value);
    const dot = filename.lastIndexOf(".");
    if (dot <= 0 || dot === filename.length - 1) return false; // no usable extension
    const ext = filename.slice(dot + 1).toLowerCase();
    for (const flag of UPLOAD_CONFIG_FLAGS) {
      if (config[flag] && UPLOAD_KIND_EXTENSIONS[flag]?.has(ext)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Split a LoadImage-style asset value into `{ subfolder, filename }` for a
 * ComfyUI `/view?type=input` existence probe. ComfyUI stores uploaded inputs at
 * `input/<subfolder>/<filename>` and the widget value is the POSIX-joined
 * `subfolder/filename` (or a bare `filename` at the root). Splits on the LAST slash;
 * a value with no slash is a root-level filename.
 *
 * `backslashIsSeparator` (default true) mirrors how the SERVER resolves the value:
 * ComfyUI joins it with `os.path`, where a backslash is a path separator ONLY on
 * Windows — on a POSIX server it is a literal filename character. Normalizing it
 * away unconditionally would probe a DIFFERENT path than LoadImage resolves, so an
 * existing `dir/file.png` could falsely clear a genuinely missing `dir\file.png`
 * on a POSIX server (#513 review). Pass the server platform's verdict; when the
 * platform is unknown, pass false (POSIX semantics) so a backslash value is never
 * re-interpreted into a path the server would not resolve.
 */
export function splitInputAssetRef(value, { backslashIsSeparator = true } = {}) {
  const raw = String(value ?? "");
  const v = backslashIsSeparator ? raw.replace(/\\/g, "/") : raw;
  const i = v.lastIndexOf("/");
  if (i < 0) return { subfolder: "", filename: v };
  return { subfolder: v.slice(0, i), filename: v.slice(i + 1) };
}

// ComfyUI's annotated-filepath suffixes, recognized EXACTLY the way
// folder_paths.annotated_filepath does (folder_paths.py): a bare endswith()
// check — NO preceding space required — followed by a FIXED-length slice of
// suffix+1 chars (9/8/7 for output/input/temp, one more than
// "[output]"/"[input]"/"[temp]" so the usual separating space goes too). The
// extra char is sliced UNCONDITIONALLY: an unspaced `foo[output]` resolves as
// `fo` in the output root — quirky, but it is precisely the path LoadImage will
// resolve, so the probe must check that same file. Lookalikes (`[output2]`) and
// mid-string brackets are not suffixes and stay unannotated.
const ANNOTATED_SUFFIXES = [
  ["[output]", "output", 9],
  ["[input]", "input", 8],
  ["[temp]", "temp", 7],
];

/**
 * Strip ComfyUI's `[output]` / `[input]` / `[temp]` annotation off a media
 * widget value, mirroring `folder_paths.annotated_filepath`: returns the bare
 * `name` (any subfolder prefix INTACT — the annotation selects the ROOT, it is
 * not part of the path) and the `type` root it resolves against. An unannotated
 * value defaults to `input`, exactly like ComfyUI. `annotated` tells callers the
 * suffix was really there — an annotated value can NEVER be adjudicated by the
 * loader combo, which only lists bare input-dir filenames (#743).
 */
export function parseAnnotatedFilepath(value) {
  const raw = String(value ?? "");
  for (const [suffix, type, sliceLen] of ANNOTATED_SUFFIXES) {
    if (raw.endsWith(suffix)) {
      // Python's name[:-N] clamps to "" when the slice exceeds the string;
      // Math.max keeps JS slice(0, -k) from instead eating a trailing char.
      return { name: raw.slice(0, Math.max(raw.length - sliceLen, 0)), type, annotated: true };
    }
  }
  return { name: raw, type: "input", annotated: false };
}

/**
 * Interpret a ComfyUI `/system_stats` payload for the input-path split above.
 * `system.os` is Python's `sys.platform` on ComfyUI ≥ 0.4.0 — "win32" on
 * Windows — while older servers report `os.name` ("nt" on Windows); BOTH
 * Windows spellings are accepted, or every modern Windows server falls
 * through to the POSIX branch and a genuinely-present `dir\file.png` stays
 * falsely reported missing (#513 review). Cygwin/MSYS2 Pythons report
 * sys.platform "cygwin"/"msys" but their os.path is posixpath — a backslash
 * is NOT a separator there — so they correctly fall through to POSIX
 * semantics, as do "linux"/"darwin". Any missing/malformed shape returns
 * false (POSIX semantics), so an unreadable stats payload can never enable a
 * split the server would not perform.
 */
export function inputPathsUseWindowsSeparators(systemStats) {
  try {
    const os = String(systemStats?.system?.os ?? "").toLowerCase();
    return os === "win32" || os === "nt";
  } catch {
    return false;
  }
}

/**
 * Remove missing-media candidates the server confirms are present. Two value
 * shapes the live combo can NEVER adjudicate (#513, #743):
 *
 *   1. NESTED input files — ComfyUI's LoadImage combo only lists files at the
 *      input root, while its validator can load `subfolder/file.png`.
 *   2. ANNOTATED values — `sub/file.png [output]` / `[temp]` / `[input]` carry
 *      the root they resolve against (folder_paths.annotated_filepath); the
 *      combo lists only bare input-dir names, so even a ROOT-LEVEL annotated
 *      value is never a member. The annotation is stripped BEFORE the
 *      subfolder/filename split and selects the `/view` `type` root, so an
 *      existing `detailed/Anima_00005_.png [output]` is probed at
 *      `<output>/detailed/Anima_00005_.png` instead of 404ing as a literal
 *      "[output]"-suffixed name under `input/` (#743 false positive).
 *
 * `confirmServerAsset(value, ref)` is injected by the panel because this pure
 * module must not own a ComfyUI API client. `value` is the RAW widget value;
 * `ref` carries the parsed `{ filename, subfolder, type }` to probe. The helper
 * fails CLOSED: an unavailable, rejected, or throwing probe keeps the original
 * candidate reported. Root-level UNANNOTATED values are not probed because the
 * live combo is already authoritative there.
 *
 * `backslashIsSeparator` must match the SERVER's platform (see splitInputAssetRef):
 * on a POSIX server a `dir\file.png` value is a literal filename, NOT a nested
 * path, so it is left un-split and un-probed — the candidate stays reported,
 * which is the truthful verdict for a file LoadImage cannot resolve there.
 */
export async function filterServerConfirmedInputSubfolderCandidates(
  candidates,
  confirmServerAsset,
  { backslashIsSeparator = true } = {},
) {
  if (!Array.isArray(candidates)) return [];
  if (typeof confirmServerAsset !== "function") return candidates;
  const probes = new Map();
  const filtered = await Promise.all(
    candidates.map(async (candidate) => {
      const file = candidate?.file;
      if (typeof file !== "string") return candidate;
      const { name, type, annotated } = parseAnnotatedFilepath(file);
      const { subfolder, filename } = splitInputAssetRef(name, { backslashIsSeparator });
      if (!filename) return candidate;
      // The combo adjudicates only bare root-level input names; anything else
      // (nested, or root-annotated) needs the server probe.
      if (!annotated && !subfolder) return candidate;
      const key = `${type}:${subfolder}/${filename}`;
      let probe = probes.get(key);
      if (!probe) {
        probe = Promise.resolve()
          .then(() => confirmServerAsset(file, { filename, subfolder, type }))
          .then((present) => present === true, () => false);
        probes.set(key, probe);
      }
      return (await probe) ? null : candidate;
    }),
  );
  return filtered.filter(Boolean);
}

/**
 * Add `value` to a combo widget's option list in place (so a following revalidation
 * accepts it) WITHOUT clobbering a dynamic function-valued option source. Returns
 * true if the option list now contains the value. Defensive; no-op on a bad widget.
 */
export function addComboOption(widget, value) {
  try {
    if (!widget) return false;
    const raw = widget.options?.values;
    // A dynamic (function) option source computes its own list; do not mutate it.
    // Its membership is decided by the function, so we cannot force-accept here.
    if (typeof raw === "function") return false;
    if (!widget.options || typeof widget.options !== "object") widget.options = {};
    const list = Array.isArray(widget.options.values) ? widget.options.values : [];
    if (!list.includes(value)) list.push(value);
    widget.options.values = list;
    return list.includes(value);
  } catch {
    return false;
  }
}
