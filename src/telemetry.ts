import type { TelemetryData, TelemetryFrame } from "./types";

export function telemetryFrameAt(data: TelemetryData, localTimeMs: number): TelemetryFrame | null {
  if (!Number.isFinite(localTimeMs)) throw new Error("Vehicle data playback time must be finite");
  if (data.frames.length === 0) return null;
  if (data.frames.length !== data.frameTimesMs.length) throw new Error("Vehicle data frames and timestamps do not match");
  if (localTimeMs < data.frameTimesMs[0] || localTimeMs > data.frameTimesMs.at(-1)!) return null;
  let lo = 0;
  let hi = data.frameTimesMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (data.frameTimesMs[mid] <= localTimeMs) lo = mid;
    else hi = mid - 1;
  }
  return data.frames[lo];
}
