import { describe, expect, it, vi } from "vitest";
import { earlierTimelineDate, timelinePaging, TIMELINE_WINDOW_DAYS } from "./timelinePaging";
import { buildTimeline } from "./components/Timeline";
import { EVENT_PAGE_TYPES, type EventPagePositions, type EventPageType } from "./api";
import type { DashcamEvent } from "./types";

function recording(timestamp: string, type: EventPageType, durationSec: number): DashcamEvent {
  return {
    id: timestamp,
    type,
    timestamp: "2000-01-01T00:00:00",
    hasThumbnail: false,
    totalDurationSec: durationSec,
    clips: [{ timestamp, durationSec, cameras: ["front"] }],
  };
}

const LATEST = recording("2026-10-24_12-00-00", "RecentClips", 60);
const EXHAUSTED: EventPagePositions = Object.fromEntries(EVENT_PAGE_TYPES.map((type) => [
  type, Object.freeze({ nextPageToken: null, nextPageDate: null }),
]));
const INITIAL: EventPagePositions = {
  SavedClips: { nextPageToken: "saved", nextPageDate: "2026-10-04" },
  SentryClips: { nextPageToken: "sentry", nextPageDate: "2026-10-20" },
  RecentClips: { nextPageToken: "recent", nextPageDate: "2026-10-24" },
};

describe("requested Timeline range", () => {
  it("requests seven consecutive calendar days ending on the latest clip day", () => {
    expect(TIMELINE_WINDOW_DAYS).toBe(7);
    expect(timelinePaging([LATEST], EXHAUSTED)).toEqual({
      fromDate: "2026-10-18", requestedFromDate: "2026-10-18", newestDate: "2026-10-24",
      loadTypes: [], manualTypes: [], rangeIncomplete: false, hasOlder: false,
    });
  });

  it("loads every source still inside the requested week, skipping an already deeper sparse source", () => {
    expect(timelinePaging([LATEST], INITIAL)).toEqual({
      fromDate: "2026-10-24", requestedFromDate: "2026-10-18", newestDate: "2026-10-24",
      loadTypes: ["SentryClips", "RecentClips"], manualTypes: [], rangeIncomplete: true, hasOlder: true,
    });
    expect(timelinePaging([LATEST], {
      ...INITIAL,
      SavedClips: { nextPageToken: "saved-in-range", nextPageDate: "2026-10-22" },
    }).loadTypes).toEqual(EVENT_PAGE_TYPES);
  });

  it("keeps the common date guard while dense and sparse sources advance independently", () => {
    const saved = recording("2026-10-23_12-00-00", "SavedClips", 60);
    const older = recording("2026-10-12_12-00-00", "SavedClips", 60);
    const events = [LATEST, saved, older];
    let pages = { ...INITIAL };
    let result = timelinePaging(events, pages);
    expect(result.loadTypes).toEqual(["SentryClips", "RecentClips"]);
    expect(buildTimeline(events, result.fromDate).sessionList).toEqual([LATEST]);

    pages = { ...pages, SentryClips: { nextPageToken: "sentry-deeper", nextPageDate: "2026-10-17" } };
    result = timelinePaging(events, pages);
    expect(result.fromDate).toBe("2026-10-24");
    expect(result.loadTypes).toEqual(["RecentClips"]);

    pages = { ...pages, RecentClips: { nextPageToken: "recent-same-day", nextPageDate: "2026-10-24" } };
    expect(timelinePaging(events, pages)).toEqual(result);

    pages = { ...pages, RecentClips: { nextPageToken: "recent-21", nextPageDate: "2026-10-21" } };
    result = timelinePaging(events, pages);
    expect(result.fromDate).toBe("2026-10-21");
    expect(result.loadTypes).toEqual(["RecentClips"]);
    expect(buildTimeline(events, result.fromDate).sessionList).toEqual([LATEST, saved]);

    pages = { ...pages, RecentClips: { nextPageToken: "recent-boundary", nextPageDate: "2026-10-18" } };
    result = timelinePaging(events, pages);
    expect(result.fromDate).toBe("2026-10-18");
    expect(result.rangeIncomplete).toBe(true);
    expect(result.loadTypes).toEqual(["RecentClips"]);

    pages = { ...pages, RecentClips: { nextPageToken: "recent-beyond-week", nextPageDate: "2026-10-17" } };
    result = timelinePaging(events, pages);
    expect(result).toEqual({
      fromDate: "2026-10-18", requestedFromDate: "2026-10-18", newestDate: "2026-10-24",
      loadTypes: [], manualTypes: [], rangeIncomplete: false, hasOlder: true,
    });
    expect(buildTimeline(events, result.fromDate).sessionList).toEqual([LATEST, saved]);
  });

  it("extends by a week without reloading sources that already cover the earlier target", () => {
    const events = [LATEST, recording("2026-10-12_12-00-00", "SavedClips", 60)];
    let pages: EventPagePositions = {
      ...INITIAL,
      SentryClips: { nextPageToken: "sentry-17", nextPageDate: "2026-10-17" },
      RecentClips: { nextPageToken: "recent-17", nextPageDate: "2026-10-17" },
    };
    const earlier = earlierTimelineDate(timelinePaging(events, pages).requestedFromDate!, TIMELINE_WINDOW_DAYS);
    expect(earlier).toBe("2026-10-11");
    const result = timelinePaging(events, pages, earlier);
    expect(result.fromDate).toBe("2026-10-17");
    expect(result.loadTypes).toEqual(["SentryClips", "RecentClips"]);
    expect(buildTimeline(events, result.fromDate).sessionList).toEqual([LATEST]);

    pages = {
      ...pages,
      SentryClips: { nextPageToken: "sentry-10", nextPageDate: "2026-10-10" },
      RecentClips: { nextPageToken: "recent-10", nextPageDate: "2026-10-10" },
    };
    const completed = timelinePaging(events, pages, earlier);
    expect(completed.fromDate).toBe("2026-10-11");
    expect(completed.loadTypes).toEqual([]);
    expect(completed.rangeIncomplete).toBe(false);
    expect(buildTimeline(events, completed.fromDate).sessionList).toEqual(events);
  });

  it("does not let exhaustion hold back a range and stops requesting exhausted sources", () => {
    const pages = { ...INITIAL, RecentClips: EXHAUSTED.RecentClips };
    expect(timelinePaging([LATEST], pages)).toMatchObject({
      fromDate: "2026-10-20", loadTypes: ["SentryClips"], rangeIncomplete: true,
    });
    expect(timelinePaging([LATEST], { ...pages, SentryClips: EXHAUSTED.SentryClips })).toMatchObject({
      fromDate: "2026-10-18", loadTypes: [], rangeIncomplete: false, hasOlder: true,
    });
  });

  it("keeps already loaded older history discoverable after all remote cursors are exhausted", () => {
    const older = recording("2026-10-12_12-00-00", "SavedClips", 60);
    const events = [LATEST, older];
    const initial = timelinePaging(events, EXHAUSTED);
    expect(initial).toMatchObject({ fromDate: "2026-10-18", rangeIncomplete: false, hasOlder: true });
    expect(buildTimeline(events, initial.fromDate).sessionList).toEqual([LATEST]);

    const earlier = timelinePaging(events, EXHAUSTED, "2026-10-11");
    expect(earlier).toMatchObject({ fromDate: "2026-10-11", loadTypes: [], rangeIncomplete: false, hasOlder: false });
    expect(buildTimeline(events, earlier.fromDate).sessionList).toEqual(events);
  });

  it("requires one explicit continuation for an unknown date before automatic range loading can resume", () => {
    let pages: EventPagePositions = {
      ...EXHAUSTED,
      RecentClips: { nextPageToken: "unknown-a", nextPageDate: null },
    };
    const first = timelinePaging([LATEST], pages);
    expect(first).toEqual({
      fromDate: "2026-10-24", requestedFromDate: "2026-10-18", newestDate: "2026-10-24",
      loadTypes: [], manualTypes: ["RecentClips"], rangeIncomplete: true, hasOlder: true,
    });

    // An explicit Continue may return no recordings and another unknown bound.
    // The new token remains manual; it cannot initiate an automatic archive walk.
    pages = { ...pages, RecentClips: { nextPageToken: "unknown-b", nextPageDate: null } };
    expect(timelinePaging([LATEST], pages)).toEqual(first);

    pages = { ...pages, RecentClips: { nextPageToken: "known-23", nextPageDate: "2026-10-23" } };
    expect(timelinePaging([LATEST], pages)).toMatchObject({
      fromDate: "2026-10-23", loadTypes: ["RecentClips"], manualTypes: [], rangeIncomplete: true,
    });

    pages = { ...pages, RecentClips: { nextPageToken: "known-17", nextPageDate: "2026-10-17" } };
    expect(timelinePaging([LATEST], pages)).toMatchObject({
      fromDate: "2026-10-18", loadTypes: [], manualTypes: [], rangeIncomplete: false,
    });
  });

  it("allows dated sources to fill the target while an unknown source retains the common date guard", () => {
    let pages: EventPagePositions = {
      ...INITIAL,
      SavedClips: { nextPageToken: "unknown-saved", nextPageDate: null },
    };
    expect(timelinePaging([LATEST], pages)).toMatchObject({
      fromDate: "2026-10-24", loadTypes: ["SentryClips", "RecentClips"],
      manualTypes: ["SavedClips"], rangeIncomplete: true,
    });
    pages = {
      ...pages,
      SentryClips: { nextPageToken: "sentry-17", nextPageDate: "2026-10-17" },
      RecentClips: { nextPageToken: "recent-17", nextPageDate: "2026-10-17" },
    };
    expect(timelinePaging([LATEST], pages)).toMatchObject({
      fromDate: "2026-10-24", loadTypes: [], manualTypes: ["SavedClips"], rangeIncomplete: true,
    });
    pages = { ...pages, SavedClips: { nextPageToken: "saved-17", nextPageDate: "2026-10-17" } };
    expect(timelinePaging([LATEST], pages)).toMatchObject({
      fromDate: "2026-10-18", loadTypes: [], manualTypes: [], rangeIncomplete: false,
    });
  });

  it("does not infer exhaustion from an empty unknown-date continuation", () => {
    const pages: EventPagePositions = {
      ...EXHAUSTED,
      RecentClips: { nextPageToken: "empty-next", nextPageDate: null },
    };
    expect(timelinePaging([], pages)).toEqual({
      fromDate: undefined, requestedFromDate: undefined, newestDate: undefined,
      loadTypes: [], manualTypes: ["RecentClips"], rangeIncomplete: true, hasOlder: true,
    });
    expect(timelinePaging([], { ...pages, RecentClips: EXHAUSTED.RecentClips })).toEqual({
      fromDate: undefined, requestedFromDate: undefined, newestDate: undefined,
      loadTypes: [], manualTypes: [], rangeIncomplete: false, hasOlder: false,
    });
  });

  it("does not mistake an unresolved initial source for a completed range", () => {
    const pages: EventPagePositions = {
      SavedClips: EXHAUSTED.SavedClips,
      RecentClips: { nextPageToken: "recent-deeper", nextPageDate: "2026-10-17" },
    };
    expect(timelinePaging([LATEST], pages)).toMatchObject({
      fromDate: "2026-10-24", requestedFromDate: "2026-10-18",
      loadTypes: [], manualTypes: [], rangeIncomplete: true, hasOlder: true,
    });
    expect(timelinePaging([LATEST], { ...pages, SentryClips: EXHAUSTED.SentryClips })).toMatchObject({
      fromDate: "2026-10-18", rangeIncomplete: false,
    });
  });

  it("does not infer a requested date or exhaustion from an empty initial catalog", () => {
    expect(timelinePaging([], {})).toEqual({
      fromDate: undefined, requestedFromDate: undefined, newestDate: undefined,
      loadTypes: [], manualTypes: [], rangeIncomplete: true, hasOlder: true,
    });
    expect(timelinePaging([], EXHAUSTED)).toEqual({
      fromDate: undefined, requestedFromDate: undefined, newestDate: undefined,
      loadTypes: [], manualTypes: [], rangeIncomplete: false, hasOlder: false,
    });
  });

  it("ignores video-free metadata when choosing the latest recording day", () => {
    const metadataOnly = { ...recording("2050-01-01_12-00-00", "SavedClips", 0), clips: [] };
    expect(timelinePaging([LATEST, metadataOnly], EXHAUSTED).newestDate).toBe("2026-10-24");
  });

  it("keeps loaded footage visible when a remaining archive-entry day is newer", () => {
    expect(timelinePaging([recording("2026-10-21_12-00-00", "RecentClips", 60)], INITIAL)).toMatchObject({
      fromDate: "2026-10-21", newestDate: "2026-10-21", requestedFromDate: "2026-10-15",
      loadTypes: ["SentryClips", "RecentClips"], manualTypes: [], rangeIncomplete: true,
    });
    expect(timelinePaging([], INITIAL)).toMatchObject({
      fromDate: "2026-10-24", requestedFromDate: undefined, newestDate: undefined, rangeIncomplete: true,
    });
  });

  it("anchors the requested week to the clip end day with an exclusive midnight endpoint", () => {
    expect(timelinePaging([recording("2026-10-24_23-59-30", "RecentClips", 60)], EXHAUSTED)).toMatchObject({
      fromDate: "2026-10-19", requestedFromDate: "2026-10-19", newestDate: "2026-10-25",
    });
    expect(timelinePaging([recording("2026-10-24_23-59-00", "RecentClips", 60)], EXHAUSTED)).toMatchObject({
      fromDate: "2026-10-18", requestedFromDate: "2026-10-18", newestDate: "2026-10-24",
    });
  });

  it("does not mutate events or page positions while planning a range", () => {
    const events = structuredClone([LATEST]);
    const pages = structuredClone(INITIAL);
    const before = structuredClone({ events, pages });
    Object.freeze(events[0].clips[0].cameras);
    Object.freeze(events[0].clips[0]);
    Object.freeze(events[0].clips);
    Object.freeze(events[0]);
    Object.freeze(events);
    for (const position of Object.values(pages)) Object.freeze(position);
    Object.freeze(pages);
    expect(() => timelinePaging(events, pages)).not.toThrow();
    expect({ events, pages }).toEqual(before);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid clip duration %s", (duration) => {
    expect(() => timelinePaging([recording("2026-10-24_12-00-00", "RecentClips", duration)], EXHAUSTED))
      .toThrow("Invalid clip duration");
  });
});

describe("Timeline calendar navigation", () => {
  it.each([
    ["2026-01-01", 7, "2025-12-25"],
    ["2024-03-01", 1, "2024-02-29"],
    ["2026-03-01", 1, "2026-02-28"],
    ["2026-03-10", 7, "2026-03-03"],
    ["2026-11-03", 7, "2026-10-27"],
    ["2026-10-24", 0, "2026-10-24"],
  ])("subtracts %s by %s recorded calendar days", (date, days, expected) => {
    expect(earlierTimelineDate(date, days)).toBe(expected);
  });

  it("keeps the range and calendar arithmetic independent of the device timezone", () => {
    const before = timelinePaging([LATEST], INITIAL);
    vi.stubEnv("TZ", "Pacific/Auckland");
    try {
      expect(timelinePaging([LATEST], INITIAL)).toEqual(before);
      expect(earlierTimelineDate("2026-03-10", 7)).toBe("2026-03-03");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid day count %s", (days) => {
    expect(() => earlierTimelineDate("2026-10-24", days)).toThrow("Invalid Timeline day count");
  });

  it.each(["2026-2-01", "2026-02-30", "2026-10-24T00:00:00", "not-a-date"])("rejects invalid date %s", (date) => {
    expect(() => earlierTimelineDate(date, 7)).toThrow();
    expect(() => timelinePaging([LATEST], EXHAUSTED, date)).toThrow();
  });
});
