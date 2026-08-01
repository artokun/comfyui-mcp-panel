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
 * a value with no slash is a root-level filename. Backslashes are normalized to
 * forward slashes so a Windows-style path still probes correctly.
 */
export function splitInputAssetRef(value) {
  const v = String(value ?? "").replace(/\\/g, "/");
  const i = v.lastIndexOf("/");
  if (i < 0) return { subfolder: "", filename: v };
  return { subfolder: v.slice(0, i), filename: v.slice(i + 1) };
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
