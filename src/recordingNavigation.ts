export const RECORDING_NAVIGATION = { initialWindowSec: 15 * 60, seekStepSec: 5, maximumBoundaryMarkers: 60 };

export function formatPlaybackTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function recordingViewport(total: number, window: number, center: number) {
  const duration = Math.min(total, window);
  const start = Math.max(0, Math.min(center - duration / 2, total - duration));
  return { start, end: start + duration, duration };
}
