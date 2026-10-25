import { EVENT_PAGE_TYPES, type EventPagePositions, type EventPageType } from "./api";
import { recordingWallTimeMs } from "./playback";
import type { DashcamEvent } from "./types";

/** Archive-entry day bounds guide paging, not a claim of complete footage coverage. */
export function timelinePaging(events: DashcamEvent[], pages: EventPagePositions): {
  fromDate: string | undefined;
  loadTypes: EventPageType[];
  incomplete: boolean;
} {
  let newestLoadedDay: string | undefined;
  for (const event of events) {
    for (const clip of event.clips) {
      if (!Number.isFinite(clip.durationSec) || clip.durationSec <= 0) {
        throw new Error(`Invalid clip duration: ${event.type}/${event.id}/${clip.timestamp}`);
      }
      const lastDay = new Date(recordingWallTimeMs(clip.timestamp) + clip.durationSec * 1000 - 1)
        .toISOString().slice(0, 10);
      if (newestLoadedDay === undefined || lastDay > newestLoadedDay) newestLoadedDay = lastDay;
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
  return {
    fromDate,
    loadTypes: (unknown.length > 0 ? unknown : unfinished.filter((type) =>
      pages[type]!.nextPageDate === newestUnloadedDay))
      .filter((type) => Boolean(pages[type]?.nextPageToken)),
    incomplete: unfinished.length > 0,
  };
}
