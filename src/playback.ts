import type { EventClip } from "./types";

// Modern UTC offsets use quarter-hour increments. Tesla can name a partial
// minute file after its MP4 creation time, so filenames can differ by one clip.
const CLOCK_CONFIG = { offsetQuantumMs: 15 * 60_000, maximumFilenameSkewMs: 60_000, maximumUtcOffsetMs: 14 * 3600_000 } as const;

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

/** The offset recorded by the car, without assigning the viewer's timezone. */
export function recordingOffsetMs(clip: EventClip): number {
  if (!Number.isSafeInteger(clip.captureTimeMs)) throw new Error(`Missing or invalid capture time: ${clip.timestamp}`);
  const difference = recordingWallTimeMs(clip.timestamp) - clip.captureTimeMs;
  const offset = Math.round(difference / CLOCK_CONFIG.offsetQuantumMs) * CLOCK_CONFIG.offsetQuantumMs;
  if (Math.abs(offset) > CLOCK_CONFIG.maximumUtcOffsetMs) throw new Error(`Invalid recording UTC offset: ${clip.timestamp}`);
  if (Math.abs(difference - offset) > CLOCK_CONFIG.maximumFilenameSkewMs) {
    throw new Error(`Filename and capture time disagree by more than one minute: ${clip.timestamp}`);
  }
  return offset;
}

export function formatUtcOffset(offsetMs: number): string {
  if (!Number.isSafeInteger(offsetMs) || offsetMs % 1000 !== 0) throw new Error(`Invalid recording UTC offset: ${offsetMs}`);
  const seconds = Math.abs(offsetMs) / 1000;
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const rest = seconds % 60;
  return `UTC${offsetMs < 0 ? "−" : "+"}${hours}:${minutes}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

export function recordingClockAt(clips: EventClip[], elapsedSec: number): { wallTimeMs: number; utcOffsetMs: number } {
  if (!clips.length) throw new Error("Cannot read the clock of a recording without clips");
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) throw new Error(`Invalid recording position: ${elapsedSec}`);
  const captureTimeMs = clips[0].captureTimeMs + elapsedSec * 1000;
  let current = clips[0];
  for (const clip of clips) {
    if (clip.captureTimeMs > captureTimeMs) break;
    current = clip;
  }
  const utcOffsetMs = recordingOffsetMs(current);
  return { wallTimeMs: captureTimeMs + utcOffsetMs, utcOffsetMs };
}

/** Every occurrence of a local clock reading, across the car's offset changes. */
export function recordingTimeCandidates(clips: EventClip[], total: number, wallTimeMs: number): { timeSec: number; utcOffsetMs: number }[] {
  if (!clips.length) throw new Error("Cannot select a recording without clips");
  if (!Number.isFinite(total) || total < 0 || !Number.isFinite(wallTimeMs)) throw new Error("Invalid recording time selection");
  const base = clips[0].captureTimeMs;
  return clips.flatMap((clip, index) => {
    const utcOffsetMs = recordingOffsetMs(clip);
    const timeSec = (wallTimeMs - utcOffsetMs - base) / 1000;
    const start = (clip.captureTimeMs - base) / 1000;
    const last = index === clips.length - 1;
    const end = last ? total : (clips[index + 1].captureTimeMs - base) / 1000;
    if (timeSec < start || timeSec > end || (!last && timeSec === end)) return [];
    return [{ timeSec, utcOffsetMs }];
  });
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
  const base = clips[0].captureTimeMs;
  const starts = clips.map((clip) => {
    recordingOffsetMs(clip);
    return (clip.captureTimeMs - base) / 1000;
  });
  if (starts.some((start, i) => i > 0 && start <= starts[i - 1])) {
    throw new Error("Recording segments must have increasing capture timestamps");
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
