import { EVENT_PAGE_TYPES, type EventPagePositions, type EventPageType } from "./api";
import { recordingWallTimeMs } from "./playback";
import type { DashcamEvent } from "./types";

export const TIMELINE_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function earlierTimelineDate(date: string, days: number): string {
  if (!Number.isInteger(days) || days < 0) throw new Error(`Invalid Timeline day count: ${days}`);
  return new Date(recordingWallTimeMs(`${date}T00:00:00`) - days * DAY_MS).toISOString().slice(0, 10);
}

/** Archive-entry day bounds guide paging, not a claim of complete footage coverage. */
export function timelinePaging(events: DashcamEvent[], pages: EventPagePositions, requestedFromDate?: string): {
  fromDate: string | undefined;
  requestedFromDate: string | undefined;
  newestDate: string | undefined;
  loadTypes: EventPageType[];
  manualTypes: EventPageType[];
  rangeIncomplete: boolean;
  hasOlder: boolean;
} {
  if (requestedFromDate !== undefined) recordingWallTimeMs(`${requestedFromDate}T00:00:00`);
  let newestLoadedDay: string | undefined;
  let oldestLoadedDay: string | undefined;
  for (const event of events) {
    for (const clip of event.clips) {
      if (!Number.isFinite(clip.durationSec) || clip.durationSec <= 0) {
        throw new Error(`Invalid clip duration: ${event.type}/${event.id}/${clip.timestamp}`);
      }
      const lastDay = new Date(recordingWallTimeMs(clip.timestamp) + clip.durationSec * 1000 - 1)
        .toISOString().slice(0, 10);
      if (newestLoadedDay === undefined || lastDay > newestLoadedDay) newestLoadedDay = lastDay;
      const firstDay = clip.timestamp.slice(0, 10);
      if (oldestLoadedDay === undefined || firstDay < oldestLoadedDay) oldestLoadedDay = firstDay;
    }
  }
  const unfinished = EVENT_PAGE_TYPES.filter((type) => !pages[type] || pages[type]!.nextPageToken !== null);
  const unknown = unfinished.filter((type) => !pages[type] || pages[type]!.nextPageDate === null);
  const newestUnloadedDay = unfinished.reduce<string | undefined>((day, type) => {
    const next = pages[type]?.nextPageDate;
    return next && (day === undefined || next > day) ? next : day;
  }, undefined);
  let fromDate = newestUnloadedDay;
  if (unknown.length > 0) fromDate = newestLoadedDay;
  else if (fromDate && newestLoadedDay && fromDate > newestLoadedDay) fromDate = newestLoadedDay;
  const target = requestedFromDate ?? (newestLoadedDay === undefined
    ? undefined
    : earlierTimelineDate(newestLoadedDay, TIMELINE_WINDOW_DAYS - 1));
  const needed = unfinished.filter((type) => !pages[type] || pages[type]!.nextPageDate === null
    || target === undefined || pages[type]!.nextPageDate! >= target);
  if (target !== undefined && (fromDate === undefined || fromDate < target)) fromDate = target;
  return {
    fromDate,
    requestedFromDate: target,
    newestDate: newestLoadedDay,
    loadTypes: needed.filter((type) => pages[type]?.nextPageToken && pages[type]!.nextPageDate !== null),
    manualTypes: needed.filter((type) => pages[type]?.nextPageToken && pages[type]!.nextPageDate === null),
    rangeIncomplete: needed.length > 0,
    hasOlder: unfinished.length > 0 || Boolean(target && oldestLoadedDay && oldestLoadedDay < target),
  };
}
