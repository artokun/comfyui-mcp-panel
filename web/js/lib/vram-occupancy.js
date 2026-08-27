/**
 * #1956 — panel_free_vram success used to return `{freed:true, unload_models, free_memory}`
 * with no MB, no before/after, and no indication whether occupancy was re-read.
 *
 * Two honest branches, both still success after POST /free 2xx:
 *   - `verified_system_stats` — /system_stats answered, so the numbers we actually have
 *   - `bare_free_receipt` — /free accepted, occupancy was not re-read
 *
 * Occupancy reads never decide the command: a /system_stats miss degrades to the
 * bare receipt instead of failing a free that already landed.
 */

const BYTES_PER_MB = 1024 * 1024;

function roundMb(n) {
  return Math.round(Number(n) / BYTES_PER_MB);
}

/**
 * Device occupancy rows from a ComfyUI `/system_stats` payload.
 * Unreadable devices are skipped; an unreadable payload is `[]`.
 */
export function vramOccupancyFromStats(stats) {
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  const out = [];
  for (const d of devices) {
    let total;
    let free;
    try {
      total = Number(d?.vram_total);
      free = Number(d?.vram_free);
    } catch {
      continue;
    }
    if (!Number.isFinite(total) || !Number.isFinite(free)) continue;
    let name = "";
    try {
      name = typeof d?.name === "string" ? d.name : "";
    } catch {
      name = "";
    }
    out.push({
      name,
      vram_total_mb: roundMb(total),
      vram_free_mb: roundMb(free),
      vram_used_mb: roundMb(total - free),
    });
  }
  return out;
}

function usedMb(rows) {
  return rows.reduce((sum, d) => sum + d.vram_used_mb, 0);
}

/**
 * Best-effort occupancy. Returns `null` rather than throwing — a miss must not
 * fail a /free that already succeeded.
 */
export async function readVramOccupancy(fetchApi) {
  try {
    if (typeof fetchApi !== "function") return null;
    const res = await fetchApi("/system_stats", { cache: "no-store" });
    if (!res || !res.ok) return null;
    const stats = await res.json();
    const rows = vramOccupancyFromStats(stats);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Success payload after POST /free 2xx. Always `{freed:true, unload_models, free_memory}`;
 * occupancy and `branch` are whatever this call actually measured.
 */
export function freeVramSuccessResult({ before = null, after = null } = {}) {
  const base = { freed: true, unload_models: true, free_memory: true };
  const beforeOcc = Array.isArray(before) && before.length ? before : null;
  const afterOcc = Array.isArray(after) && after.length ? after : null;
  if (beforeOcc && afterOcc) {
    const beforeMb = usedMb(beforeOcc);
    const afterMb = usedMb(afterOcc);
    return {
      ...base,
      branch: "verified_system_stats",
      occupancy: {
        before_mb: beforeMb,
        after_mb: afterMb,
        freed_mb: beforeMb - afterMb,
        devices_before: beforeOcc,
        devices_after: afterOcc,
      },
    };
  }
  if (afterOcc) {
    return {
      ...base,
      branch: "verified_system_stats",
      occupancy: {
        after_mb: usedMb(afterOcc),
        devices_after: afterOcc,
      },
    };
  }
  return {
    ...base,
    branch: "bare_free_receipt",
    note:
      "POST /free accepted this request (unload_models and free_memory). Occupancy was not " +
      "re-read from /system_stats, so no MB before/after is available.",
  };
}
