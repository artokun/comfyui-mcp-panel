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
// audio / 3d), whose valid values live on DISK, not only in the combo snapshot.
const UPLOAD_CONFIG_FLAGS = ["image_upload", "video_upload", "audio_upload", "model_upload"];

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
};

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
    const config = spec[1];
    if (!config || typeof config !== "object") return null;
    return UPLOAD_CONFIG_FLAGS.some((f) => config[f]) ? config : null;
  } catch {
    return null;
  }
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
 * non-combo spec (a type string like "INT"/"STRING"), or a NON-EMPTY declared list all
 * return false, so the value simply stays rejected exactly as before.
 */
export function serverDeclaresEmptyComboOptions(defsByType, type, widgetName) {
  try {
    if (!defsByType || !type || !widgetName) return false;
    const input = defsByType[type]?.input;
    if (!input) return false;
    const spec =
      (input.required && input.required[widgetName]) ??
      (input.optional && input.optional[widgetName]);
    if (!Array.isArray(spec)) return false;
    const options = spec[0];
    return Array.isArray(options) && options.length === 0;
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
 * Remove missing-media candidates for NESTED input files the server confirms are
 * present. ComfyUI's LoadImage combo only lists files at the input root, while
 * its validator can load `subfolder/file.png`; exact combo membership therefore
 * cannot adjudicate these candidates (#513).
 *
 * `confirmServerAsset(value)` is injected by the panel because this pure module
 * must not own a ComfyUI API client. The helper fails CLOSED: an unavailable,
 * rejected, or throwing probe keeps the original candidate reported. Root-level
 * values are not probed because the live combo is already authoritative there.
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
      const { subfolder, filename } = splitInputAssetRef(file, { backslashIsSeparator });
      if (!subfolder || !filename) return candidate;
      const key = `${subfolder}/${filename}`;
      let probe = probes.get(key);
      if (!probe) {
        probe = Promise.resolve()
          .then(() => confirmServerAsset(file))
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
