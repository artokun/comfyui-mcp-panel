// #183 — long sampler/VAE/video nodes can legitimately go quiet for several minutes.
// Keep the default conservative enough to avoid asking the agent to cancel active work,
// while retaining the explicit user setting as the source of truth when one is present.

export const DEFAULT_RENDER_STALL_SECONDS = 600;
export const RENDER_STALL_SECONDS_MIN = 15;
export const RENDER_STALL_SECONDS_MAX = 3600;

export function normalizeRenderStallSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RENDER_STALL_SECONDS;
  return Math.min(RENDER_STALL_SECONDS_MAX, Math.max(RENDER_STALL_SECONDS_MIN, Math.round(seconds)));
}
