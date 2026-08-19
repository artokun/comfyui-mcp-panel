// Video-gen backend families the Apps converter (and the panel agent driving
// that surface) can treat as first-class (#428).
//
// THE GAP. AppBuilder's heuristic only knew image-shaped hints (LoadImage,
// EmptyLatentImage, SaveImage) plus two empty-video latents. Converting an
// LTX 2.3 / Wan / Bernini / Hunyuan / Easy-Use Media graph therefore:
//   * skipped LTXDirector / LTXVImgToVideo / WanVideoSampler / Bernini r2v as
//     inputs — the generation parameters the agent is supposed to drive,
//   * classified LoadVideo / VHS_LoadVideo as ordinary text (or missed them),
//   * treated SaveVideo as kind "images",
//   * never offered VHS_VideoCombine / easy saveVideo as outputs at all,
//   * dropped ComfyUI history's `videos[]` bag when rendering a run.
//
// This lib is the catalog + the predicates AppBuilder and the Apps UI share.
// Match on the ComfyUI class name (node.type / class_type). Prefix tests are
// keyed to the families named in #428, not a grab-bag of every video-adjacent
// node (WanVideoBlockSwap / LTXVTiledVAEDecode stay internal).

/** Generation families named in #428. VHS is I/O, not a generator. */
export const VIDEO_GEN_FAMILIES = Object.freeze(["ltx", "wan", "bernini", "hunyuan", "easyuse"]);

// Nodes whose widgets are the generation parameters a video-gen app should
// expose (length, strength, fps, prompt, seed, timeline). Exact class names
// from the packs/skills already in comfyui-mcp and from ComfyUI core.
const VIDEO_GEN_PARAM_TYPES = new Set([
  "EmptyLTXVLatentVideo",
  "EmptyHunyuanLatentVideo",
  "EmptyMochiLatentVideo",
  "LTXVImgToVideo",
  "LTXVConditioning",
  "LTXVScheduler",
  "LTXDirector",
  "WanFirstLastFrameToVideo",
  "WanImageToVideo",
  "WanVideoSampler",
  "WanVideoTextEncode",
  "WanVideoImageToVideoEncode",
  "WanVideoAnimateEmbeds",
  "HunyuanImageToVideo",
  "SamplerCustomAdvanced",
]);

/**
 * Which #428 generation family a node type belongs to, or null. VHS load/combine
 * and generic SaveVideo are I/O, not a family.
 */
export function classifyVideoGenFamily(nodeType) {
  const t = String(nodeType || "");
  if (!t) return null;
  if (/Bernini/i.test(t)) return "bernini";
  if (/^(LTXDirector|LTXV|LTXAV|EmptyLTXV)/i.test(t)) return "ltx";
  if (/^(WanVideo|WanFirstLastFrame|WanImageToVideo)/i.test(t)) return "wan";
  if (/^(EmptyHunyuanLatentVideo|HunyuanImageToVideo|HunyuanVideo)/i.test(t)) return "hunyuan";
  if (/^easy\s+/i.test(t) && /video/i.test(t)) return "easyuse";
  return null;
}

/** User-upload video file loaders (clip in, not a model loader). */
export function isVideoLoaderType(nodeType) {
  const t = String(nodeType || "");
  if (/^(LoadVideo|VHS_LoadVideo)/i.test(t)) return true;
  if (/^easy\s+loadVideo/i.test(t)) return true;
  return false;
}

/**
 * Nodes that WRITE a video file the Apps runner should collect. CreateVideo is
 * a mid-graph VIDEO producer (feeds SaveVideo) — not an output unless the
 * node's own output_node flag says so (handled by the caller).
 */
export function isVideoOutputType(nodeType) {
  const t = String(nodeType || "");
  if (/^(SaveVideo|PreviewVideo)$/i.test(t)) return true;
  if (/^VHS_VideoCombine/i.test(t)) return true;
  if (/^easy\s+saveVideo/i.test(t)) return true;
  return false;
}

/** Generation-parameter (or video-loader) node whose widgets belong on an app form. */
export function isVideoGenInputHint(nodeType) {
  const t = String(nodeType || "");
  if (!t) return false;
  if (VIDEO_GEN_PARAM_TYPES.has(t)) return true;
  if (isVideoLoaderType(t)) return true;
  if (/Bernini/i.test(t)) return true;
  return false;
}

/**
 * App output kind for a node type. `outputNode` is the live
 * `constructor.nodeData.output_node` flag — when true the node is an output
 * even if its class is not in the Save/Preview regex.
 *
 *   "video" | "text" | "images" | null (not an output)
 *
 * SaveAudio stays "images" here on purpose: that is what the previous regex
 * produced, and audio-app I/O is a different slice.
 */
export function appOutputKind(nodeType, outputNode = false) {
  const t = String(nodeType || "");
  if (isVideoOutputType(t)) return "video";
  const named = /^(SaveImage|PreviewImage|SaveVideo|SaveAudio|PreviewAudio|ShowText|PreviewAsText)/.test(
    t,
  );
  if (!named && outputNode !== true) return null;
  return /^Show|^PreviewAs/.test(t) ? "text" : "images";
}

/** Deduped image/gif/video refs from one node's ComfyUI /history outputs bag. */
export function collectAppRunMedia(out) {
  if (!out || typeof out !== "object") return [];
  const refs = [];
  const seen = new Set();
  for (const bag of [out.images, out.gifs, out.videos]) {
    if (!Array.isArray(bag)) continue;
    for (const ref of bag) {
      if (!ref || typeof ref !== "object") continue;
      const filename = String(ref.filename || ref.name || "");
      if (!filename) continue;
      const key = `${ref.subfolder || ""}/${filename}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * Image-vs-video for a history descriptor. Same rule as the panel's
 * isVideoOutput: honour `format` first (video/* vs image/*, so animated gif
 * stays an <img>), else the filename extension.
 */
export function isAppRunVideoRef(ref) {
  const fmt = String(ref?.format || "").toLowerCase();
  if (fmt.startsWith("video/")) return true;
  if (fmt.startsWith("image/")) return false;
  return /\.(mp4|webm|mov|mkv|m4v|avi)$/i.test(String(ref?.filename || ref?.name || ""));
}

/** Distinct #428 families present on a serialized or live node list. */
export function videoFamiliesOnGraph(nodes) {
  const found = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const family = classifyVideoGenFamily(node?.type || node?.class_type || node?.comfyClass);
    if (family) found.add(family);
  }
  return VIDEO_GEN_FAMILIES.filter((f) => found.has(f));
}
