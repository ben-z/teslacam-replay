import type { EventClip } from "./types";

/** A recording's calendar coordinate, not an inferred UTC instant. */
export function recordingWallTimeMs(timestamp: string): number {
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[_T](\d{2})[:-](\d{2})[:-](\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})?$/);
  if (!match) throw new Error(`Invalid recording timestamp: ${timestamp}`);
  const [, year, month, day, hour, minute, second, fraction] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number((fraction ?? "").padEnd(3, "0").slice(0, 3)));
  const date = new Date(ms);
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second)) {
    throw new Error(`Invalid recording timestamp: ${timestamp}`);
  }
  return ms;
}

export type CompletedDurations = Record<string, Record<string, number>>;

export function playbackParticipants<T>(available: T[], focused: T | null): T[] {
  if (focused === null) return available;
  return available.includes(focused) ? [focused] : [];
}

export function playbackBoundary(segmentStart: number, nextSegmentStart: number | null, cameraDurations: (number | undefined)[]): number | null {
  if (cameraDurations.length === 0 || cameraDurations.some((duration) => duration === undefined)) return nextSegmentStart;
  const completed = cameraDurations as number[];
  if (completed.some((duration) => !Number.isFinite(duration) || duration <= 0)) throw new Error("Invalid completed video duration");
  const mediaEnd = segmentStart + Math.max(...completed);
  return nextSegmentStart === null ? mediaEnd : Math.min(mediaEnd, nextSegmentStart);
}

export function hasReachedPlaybackEnd(cameras: { ended: boolean }[]): boolean {
  return cameras.length > 0 && cameras.every((camera) => camera.ended);
}

export function playbackTimeline(clips: EventClip[], completed: CompletedDurations): {
  offsets: number[];
  durations: number[];
  estimated: boolean;
} {
  if (clips.length === 0) return { offsets: [0], durations: [], estimated: false };
  const base = recordingWallTimeMs(clips[0].timestamp);
  const starts = clips.map((clip) => (recordingWallTimeMs(clip.timestamp) - base) / 1000);
  if (starts.some((start, i) => i > 0 && start <= starts[i - 1])) {
    throw new Error("Recording segments must have increasing timestamps");
  }
  let estimated = false;
  const durations = clips.map((clip) => {
    const cameraDurations = completed[clip.timestamp];
    const values = clip.cameras.map((camera) => cameraDurations?.[camera]);
    if (values.length && values.every((value): value is number => value !== undefined)) {
      if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error(`Invalid completed video duration: ${clip.timestamp}`);
      }
      return Math.max(...values);
    }
    estimated = true;
    return clip.durationSec;
  });
  return {
    offsets: [...starts, starts.at(-1)! + durations.at(-1)!],
    durations,
    estimated,
  };
}
