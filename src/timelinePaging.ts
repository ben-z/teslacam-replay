import { archiveDayKey, RECORDING_TYPES, type ArchiveCatalogs, type ArchiveDayKey, type ArchiveDays } from "./archive";
import { recordingOffsetMs, recordingWallTimeMs } from "./playback";
import type { DashcamEvent } from "./types";

export const TIMELINE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function earlierTimelineDate(date: string, days: number): string {
  if (!Number.isInteger(days) || days < 0) throw new Error(`Invalid Timeline day count: ${days}`);
  return new Date(recordingWallTimeMs(`${date}T00:00:00`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Plan archive-day reads independently of background updates to loaded days. */
export function timelinePaging(
  events: DashcamEvent[],
  catalogs: ArchiveCatalogs,
  days: ArchiveDays,
  requestedFromDate?: string,
): {
  fromDate: string | undefined;
  newestDate: string | undefined;
  requiredDays: ArchiveDayKey[];
  loadDays: ArchiveDayKey[];
  rangeIncomplete: boolean;
  hasOlder: boolean;
} {
  if (requestedFromDate !== undefined) recordingWallTimeMs(`${requestedFromDate}T00:00:00`);
  let newestClipDay: string | undefined;
  let oldestClipDay: string | undefined;
  for (const event of events) {
    for (const clip of event.clips) {
      if (!Number.isFinite(clip.durationSec) || clip.durationSec <= 0) {
        throw new Error(`Invalid clip duration: ${event.type}/${event.id}/${clip.timestamp}`);
      }
      const start = clip.captureTimeMs + recordingOffsetMs(clip);
      const firstDay = new Date(start).toISOString().slice(0, 10);
      const lastDay = new Date(start + clip.durationSec * 1000 - 1).toISOString().slice(0, 10);
      if (newestClipDay === undefined || lastDay > newestClipDay) newestClipDay = lastDay;
      if (oldestClipDay === undefined || firstDay < oldestClipDay) oldestClipDay = firstDay;
    }
  }

  const archiveDates = RECORDING_TYPES.flatMap((type) => catalogs[type]?.dates ?? []);
  const newestArchiveDay = archiveDates.reduce<string | undefined>((newest, date) =>
    newest === undefined || date > newest ? date : newest, undefined);
  // Restored older clips must not move the initial window behind the archive
  // head. A clip crossing midnight can extend the display past that head day.
  let newestDate = newestArchiveDay;
  if (newestClipDay !== undefined && (newestDate === undefined || newestClipDay > newestDate)) {
    newestDate = newestClipDay;
  }
  const target = requestedFromDate ?? (newestDate === undefined
    ? undefined : earlierTimelineDate(newestDate, TIMELINE_WINDOW_DAYS - 1));
  const unknownCatalog = RECORDING_TYPES.some((type) => catalogs[type] === undefined);
  const requiredDays: ArchiveDayKey[] = [];
  for (const type of RECORDING_TYPES) {
    const catalog = catalogs[type];
    if (!catalog || target === undefined) continue;
    const boundaryDay = catalog.dates.reduce<string | undefined>((boundary, date) =>
      date < target && (boundary === undefined || date > boundary) ? date : boundary, undefined);
    for (const date of catalog.dates) {
      // Trigger-folder dates can differ from clip dates. Retain the nearest
      // preceding archive day so recordings crossing the lower boundary arrive.
      if (date < target && date !== boundaryDay) continue;
      requiredDays.push({ type, date });
    }
  }
  requiredDays.sort((first, later) => later.date.localeCompare(first.date)
    || RECORDING_TYPES.indexOf(first.type) - RECORDING_TYPES.indexOf(later.type));

  const loadDays = requiredDays.filter((day) => days[archiveDayKey(day)] === undefined);
  return {
    fromDate: target,
    newestDate,
    requiredDays,
    loadDays,
    rangeIncomplete: unknownCatalog || loadDays.length > 0,
    hasOlder: unknownCatalog || Boolean(target && (
      archiveDates.some((date) => date < target) || (oldestClipDay && oldestClipDay < target)
    )),
  };
}
