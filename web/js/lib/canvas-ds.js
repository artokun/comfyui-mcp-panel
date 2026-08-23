// LiteGraph's viewport transform is serialized into workflow metadata as
// `extra.ds`. Older or partially initialized App Mode canvases can expose null,
// NaN, or otherwise unusable values; keep those values out of saved workflows.

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizedCanvasDs(ds) {
  const scale = finiteNumber(ds?.scale);
  const rawOffset = ds?.offset;
  const hasOffsetPair = Number(rawOffset?.length) >= 2;
  const x = hasOffsetPair ? finiteNumber(rawOffset[0]) : null;
  const y = hasOffsetPair ? finiteNumber(rawOffset[1]) : null;
  return {
    scale: scale !== null && scale > 0 ? scale : 1,
    offset: [x ?? 0, y ?? 0],
  };
}

/** Normalize a live LiteGraph transform without replacing a typed offset. */
export function normalizeCanvasDsInPlace(ds) {
  if (!ds || typeof ds !== "object") return normalizedCanvasDs(null);
  const normalized = normalizedCanvasDs(ds);
  ds.scale = normalized.scale;
  const offset = ds.offset;
  const hasMutableOffsetPair =
    offset !== null &&
    (typeof offset === "object" || typeof offset === "function") &&
    Number(offset.length) >= 2;
  if (hasMutableOffsetPair) {
    offset[0] = normalized.offset[0];
    offset[1] = normalized.offset[1];
  } else {
    ds.offset = normalized.offset;
  }
  return normalized;
}
