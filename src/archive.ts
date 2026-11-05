import { ALL_CAMERAS, type DashcamEvent } from "./types";
import { recordingWallTimeMs } from "./playback";

export const RECORDING_TYPES = ["SavedClips", "SentryClips", "RecentClips"] as const;
export type RecordingType = typeof RECORDING_TYPES[number];

/** Dates identify archive folders, whose recordings can cross calendar days. */
export interface ArchiveCatalog {
  type: RecordingType;
  dates: string[];
}
export interface ArchiveDayKey {
  type: RecordingType;
  date: string;
}
export interface ArchiveDay extends ArchiveDayKey {
  events: DashcamEvent[];
}
export type ArchiveCatalogs = Partial<Record<RecordingType, ArchiveCatalog>>;
export type ArchiveDays = Record<string, ArchiveDay>;
export interface SavedArchive {
  catalogs: ArchiveCatalog[];
  days: ArchiveDay[];
}
export function archiveDayKey(day: ArchiveDayKey): string {
  return `${day.type}/${day.date}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordingType(value: unknown): value is RecordingType {
  return RECORDING_TYPES.includes(value as RecordingType);
}

export function assertArchiveDate(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid archive date: ${String(value)}`);
  }
}

export function assertArchiveCatalog(value: unknown): asserts value is ArchiveCatalog {
  if (!isObject(value) || !isRecordingType(value.type) || !Array.isArray(value.dates)) {
    throw new Error("Invalid archive catalog.");
  }
  let previous: string | undefined;
  for (const date of value.dates) {
    assertArchiveDate(date);
    if (previous !== undefined && date >= previous) {
      throw new Error("Archive catalog dates must be unique and sorted newest first.");
    }
    previous = date;
  }
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== "string") throw new Error("Invalid recording timestamp.");
  recordingWallTimeMs(value);
}

export function assertArchiveDay(value: unknown): asserts value is ArchiveDay {
  if (!isObject(value) || !isRecordingType(value.type) || !Array.isArray(value.events)) {
    throw new Error("Invalid archive day.");
  }
  assertArchiveDate(value.date);
  const ids = new Set<string>();
  for (const event of value.events) {
    if (!isObject(event) || event.type !== value.type || typeof event.id !== "string"
      || !/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(event.id)
      || event.id.slice(0, 10) !== value.date || ids.has(event.id)
      || typeof event.hasThumbnail !== "boolean"
      || typeof event.totalDurationSec !== "number" || !Number.isFinite(event.totalDurationSec) || event.totalDurationSec < 0
      || !Array.isArray(event.clips)) {
      throw new Error("Invalid recording in archive day.");
    }
    assertTimestamp(event.id);
    assertTimestamp(event.timestamp);
    ids.add(event.id);
    for (const field of ["city", "reason", "camera", "thumbnailVersion"]) {
      if (event[field] !== undefined && typeof event[field] !== "string") {
        throw new Error(`Invalid recording ${field}.`);
      }
    }
    for (const field of ["lat", "lon", "cameraCount"]) {
      if (event[field] !== undefined && (typeof event[field] !== "number" || !Number.isFinite(event[field]))) {
        throw new Error(`Invalid recording ${field}.`);
      }
    }
    for (const clip of event.clips) {
      if (!isObject(clip)
        || !Number.isSafeInteger(clip.captureTimeMs) || !Number.isFinite(new Date(Number(clip.captureTimeMs)).getTime())
        || typeof clip.durationSec !== "number" || !Number.isFinite(clip.durationSec) || clip.durationSec <= 0
        || !Array.isArray(clip.cameras) || clip.cameras.length === 0
        || !clip.cameras.every((camera) => ALL_CAMERAS.includes(camera))) {
        throw new Error("Invalid archive clip or missing capture time.");
      }
      assertTimestamp(clip.timestamp);
    }
  }
}
