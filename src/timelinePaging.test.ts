import { describe, expect, it, vi } from "vitest";
import { archiveDayKey, RECORDING_TYPES, type ArchiveCatalogs, type ArchiveDayKey, type ArchiveDays, type RecordingType } from "./archive";
import { buildTimeline } from "./components/Timeline";
import { recordingWallTimeMs } from "./playback";
import { earlierTimelineDate, timelinePaging, TIMELINE_WINDOW_DAYS } from "./timelinePaging";
import type { DashcamEvent } from "./types";

function recording(timestamp: string, type: RecordingType, durationSec: number): DashcamEvent {
  return {
    id: timestamp,
    type,
    timestamp: "2000-01-01T00:00:00",
    hasThumbnail: false,
    totalDurationSec: durationSec,
    clips: [{ timestamp, captureTimeMs: recordingWallTimeMs(timestamp), durationSec, cameras: ["front"] }],
  };
}
function catalogs(dates: Partial<Record<RecordingType, string[]>>): ArchiveCatalogs {
  return Object.fromEntries(RECORDING_TYPES.map((type) => [type, { type, dates: dates[type] ?? [] }]));
}
function loaded(...keys: ArchiveDayKey[]): ArchiveDays {
  return Object.fromEntries(keys.map((key) => [archiveDayKey(key), { ...key, events: [] }]));
}
const recent = (date: string): ArchiveDayKey => ({ type: "RecentClips", date });
const saved = (date: string): ArchiveDayKey => ({ type: "SavedClips", date });
const sentry = (date: string): ArchiveDayKey => ({ type: "SentryClips", date });
const LATEST = recording("2026-10-24_12-00-00", "RecentClips", 60);
const CATALOGS = catalogs({ RecentClips: ["2026-10-24"] });
const DAYS = loaded(recent("2026-10-24"));

describe("requested Timeline archive days", () => {
  it("requests seven calendar days ending on the latest actual clip day", () => {
    expect(TIMELINE_WINDOW_DAYS).toBe(7);
    expect(timelinePaging([LATEST], CATALOGS, DAYS)).toEqual({
      fromDate: "2026-10-18", newestDate: "2026-10-24",
      requiredDays: [recent("2026-10-24")], loadDays: [], rangeIncomplete: false, hasOlder: false,
    });
  });

  it("plans only missing known day keys independently across dense and sparse sources", () => {
    const sources = catalogs({
      SavedClips: ["2026-10-22", "2026-10-04"],
      SentryClips: ["2026-10-20", "2026-10-17", "2026-10-01"],
      RecentClips: ["2026-10-24", "2026-10-23", "2026-10-18", "2026-10-17", "2026-10-16"],
    });
    const days = loaded(recent("2026-10-24"), recent("2026-10-17"), saved("2026-10-04"), sentry("2026-10-17"));
    expect(timelinePaging([LATEST], sources, days)).toEqual({
      fromDate: "2026-10-18", newestDate: "2026-10-24",
      requiredDays: [recent("2026-10-24"), recent("2026-10-23"), saved("2026-10-22"), sentry("2026-10-20"), recent("2026-10-18"), sentry("2026-10-17"), recent("2026-10-17"), saved("2026-10-04")],
      loadDays: [recent("2026-10-23"), saved("2026-10-22"), sentry("2026-10-20"), recent("2026-10-18")],
      rangeIncomplete: true, hasOlder: true,
    });
  });

  it("renders loaded recordings while other archive days in the window remain missing", () => {
    const oldSaved = recording("2026-10-22_12-00-00", "SavedClips", 60);
    const events = [LATEST, oldSaved];
    const sources = catalogs({ RecentClips: ["2026-10-24", "2026-10-23", "2026-10-21"] });
    const first = timelinePaging(events, sources, DAYS);
    expect(first.fromDate).toBe("2026-10-18");
    expect(buildTimeline(events, first.fromDate).sessionList).toEqual([LATEST, oldSaved]);
    const second = timelinePaging(events, sources, { ...DAYS, ...loaded(recent("2026-10-23")) });
    expect(second.fromDate).toBe("2026-10-18");
    expect(buildTimeline(events, second.fromDate).sessionList).toContain(oldSaved);
    expect(timelinePaging(events, sources, { ...DAYS, ...loaded(recent("2026-10-23"), recent("2026-10-21")) })).toMatchObject({
      fromDate: "2026-10-18", loadDays: [], rangeIncomplete: false,
    });
  });

  it("keeps the cached week visible while a newly discovered head day is still loading", () => {
    const cached = recording("2026-11-04_12-00-00", "RecentClips", 60);
    const sources = catalogs({ RecentClips: ["2026-11-05", "2026-11-04", "2026-10-29"] });
    const days = loaded(recent("2026-11-04"), recent("2026-10-29"));
    const result = timelinePaging([cached], sources, days);
    expect(result).toMatchObject({
      fromDate: "2026-10-30", newestDate: "2026-11-05",
      loadDays: [recent("2026-11-05")], rangeIncomplete: true,
    });
    expect(buildTimeline([cached], result.fromDate).sessionList).toEqual([cached]);
  });

  it("includes exactly the nearest preceding archive day as a boundary read", () => {
    const sources = catalogs({ RecentClips: ["2026-10-24", "2026-10-18", "2026-10-17", "2026-10-15", "2026-09-01"] });
    const result = timelinePaging([LATEST], sources, DAYS);
    expect(result.loadDays).toEqual([recent("2026-10-18"), recent("2026-10-17")]);
    expect(result.fromDate).toBe("2026-10-18");
    expect(result.rangeIncomplete).toBe(true);
  });

  it("uses available archive dates for a sparse boundary rather than a fixed lookback", () => {
    const sources = catalogs({ SavedClips: ["2026-09-01", "2026-01-01"] });
    expect(timelinePaging([LATEST], sources, {}).loadDays).toEqual([saved("2026-09-01")]);
  });

  it("retains a Recent clip crossing midnight from the preceding archive day", () => {
    const crossing = recording("2026-10-17_23-59-30", "RecentClips", 60);
    const sources = catalogs({ RecentClips: ["2026-10-24", "2026-10-17"] });
    expect(timelinePaging([LATEST], sources, DAYS).loadDays).toEqual([recent("2026-10-17")]);
    const result = timelinePaging([LATEST, crossing], sources, { ...DAYS, ...loaded(recent("2026-10-17")) });
    expect(result).toMatchObject({ fromDate: "2026-10-18", loadDays: [], rangeIncomplete: false });
    const timeline = buildTimeline([LATEST, crossing], result.fromDate);
    expect(timeline.days.map((day) => day.dateStr)).toEqual(["2026-10-24", "2026-10-18"]);
    expect(timeline.sessionList).toContain(crossing);
  });

  it("loads newer Saved trigger folders whose clips belong to the displayed day", () => {
    const sources = catalogs({ SavedClips: ["2026-10-25"] });
    const first = timelinePaging([LATEST], sources, {}, "2026-10-24");
    expect(first.loadDays).toEqual([saved("2026-10-25")]);
    expect(first.fromDate).toBe("2026-10-24");
    const event = { ...recording("2026-10-24_23-58-00", "SavedClips", 60), id: "2026-10-25_00-01-00" };
    const result = timelinePaging([LATEST, event], sources, loaded(saved("2026-10-25")), "2026-10-24");
    expect(result.rangeIncomplete).toBe(false);
    expect(buildTimeline([LATEST, event], result.fromDate).sessionList).toContain(event);
  });

  it("loads a Saved boundary folder containing clips after its trigger day", () => {
    const event = { ...recording("2026-10-18_00-00-30", "SavedClips", 60), id: "2026-10-17_23-59-59" };
    const sources = catalogs({ SavedClips: ["2026-10-17"] });
    expect(timelinePaging([LATEST], sources, DAYS).loadDays).toEqual([saved("2026-10-17")]);
    const result = timelinePaging([LATEST, event], sources, loaded(saved("2026-10-17")));
    expect(buildTimeline([LATEST, event], result.fromDate).sessionList).toContain(event);
  });

  it("keeps an empty loaded day complete without depending on request or freshness state", () => {
    const sources = catalogs({ RecentClips: ["2026-10-24", "2026-10-23"] });
    const result = timelinePaging([LATEST], sources, loaded(recent("2026-10-24"), recent("2026-10-23")));
    expect(result).toMatchObject({ loadDays: [], rangeIncomplete: false });
  });

  it("requests a newly cataloged backfill without replaying previously loaded days", () => {
    const sources = catalogs({ RecentClips: ["2026-10-24", "2026-10-23", "2026-10-21"] });
    const days = loaded(recent("2026-10-24"), recent("2026-10-23"), recent("2026-10-21"));
    expect(timelinePaging([LATEST], sources, days).loadDays).toEqual([]);
    expect(timelinePaging([LATEST], catalogs({ RecentClips: ["2026-10-24", "2026-10-23", "2026-10-22", "2026-10-21"] }), days).loadDays)
      .toEqual([recent("2026-10-22")]);
  });

  it("does not request removed catalog dates or treat orphaned cache entries as available archive days", () => {
    const days = loaded(recent("2026-10-24"), recent("2026-10-01"));
    expect(timelinePaging([LATEST], CATALOGS, days)).toMatchObject({ loadDays: [], rangeIncomplete: false, hasOlder: false });
    expect(timelinePaging([LATEST], catalogs({ RecentClips: ["2026-10-24", "2026-10-01"] }), days).hasOlder).toBe(true);
  });

  it("extends by a week without requesting already loaded day snapshots", () => {
    const sources = catalogs({ RecentClips: ["2026-10-24", "2026-10-17", "2026-10-12", "2026-10-10", "2026-10-01"] });
    const days = loaded(recent("2026-10-24"), recent("2026-10-17"));
    const initial = timelinePaging([LATEST], sources, days);
    expect(initial).toMatchObject({ requiredDays: [recent("2026-10-24"), recent("2026-10-17")], loadDays: [], rangeIncomplete: false, hasOlder: true });
    const target = earlierTimelineDate(initial.fromDate!, TIMELINE_WINDOW_DAYS);
    expect(target).toBe("2026-10-11");
    expect(timelinePaging([LATEST], sources, days, target)).toMatchObject({
      requiredDays: [recent("2026-10-24"), recent("2026-10-17"), recent("2026-10-12"), recent("2026-10-10")],
      loadDays: [recent("2026-10-12"), recent("2026-10-10")],
    });
  });

  it("keeps already loaded older footage discoverable after every catalog day is loaded", () => {
    const older = recording("2026-10-12_12-00-00", "SavedClips", 60);
    const sources = catalogs({ RecentClips: ["2026-10-24"], SavedClips: ["2026-10-12"] });
    const days = loaded(recent("2026-10-24"), saved("2026-10-12"));
    const initial = timelinePaging([LATEST, older], sources, days);
    expect(initial).toMatchObject({ loadDays: [], rangeIncomplete: false, hasOlder: true });
    expect(buildTimeline([LATEST, older], initial.fromDate).sessionList).toEqual([LATEST]);
    const earlier = timelinePaging([LATEST, older], sources, days, "2026-10-11");
    expect(earlier).toMatchObject({ fromDate: "2026-10-11", loadDays: [], rangeIncomplete: false, hasOlder: false });
    expect(buildTimeline([LATEST, older], earlier.fromDate).sessionList).toContain(older);
  });

  it("keeps cached clip ranges discoverable when their source folder date is inside the window", () => {
    const older = { ...recording("2026-10-12_12-00-00", "SavedClips", 60), id: "2026-10-24_13-00-00" };
    const sources = catalogs({ SavedClips: ["2026-10-24"] });
    const days = loaded(saved("2026-10-24"));
    expect(timelinePaging([LATEST, older], sources, days).hasOlder).toBe(true);
    expect(timelinePaging([LATEST, older], sources, days, "2026-10-11")).toMatchObject({ hasOlder: false, loadDays: [] });
  });

  it("marks an unknown catalog incomplete while allowing known sources to load", () => {
    const sources: ArchiveCatalogs = { RecentClips: { type: "RecentClips", dates: ["2026-10-24", "2026-10-23"] } };
    expect(timelinePaging([LATEST], sources, DAYS)).toEqual({
      fromDate: "2026-10-18", newestDate: "2026-10-24",
      requiredDays: [recent("2026-10-24"), recent("2026-10-23")], loadDays: [recent("2026-10-23")], rangeIncomplete: true, hasOlder: true,
    });
  });

  it("does not infer a range or exhaustion before catalogs arrive", () => {
    expect(timelinePaging([], {}, {})).toEqual({
      fromDate: undefined, newestDate: undefined,
      requiredDays: [], loadDays: [], rangeIncomplete: true, hasOlder: true,
    });
    expect(timelinePaging([], catalogs({}), {})).toEqual({
      fromDate: undefined, newestDate: undefined,
      requiredDays: [], loadDays: [], rangeIncomplete: false, hasOlder: false,
    });
  });

  it("bootstraps a bounded calendar window from catalog dates before any video is loaded", () => {
    const sources = catalogs({ RecentClips: ["2026-10-24", "2026-10-23", "2026-10-01", "2025-01-01"] });
    expect(timelinePaging([], sources, {})).toEqual({
      fromDate: "2026-10-18", newestDate: "2026-10-24",
      requiredDays: [recent("2026-10-24"), recent("2026-10-23"), recent("2026-10-01")],
      loadDays: [recent("2026-10-24"), recent("2026-10-23"), recent("2026-10-01")], rangeIncomplete: true, hasOlder: true,
    });
    expect(timelinePaging([], sources, loaded(recent("2026-10-24"), recent("2026-10-23"), recent("2026-10-01")))).toMatchObject({
      fromDate: "2026-10-18", loadDays: [], rangeIncomplete: false, hasOlder: true,
    });
  });

  it("uses the latest archive day even when its newest recording contains metadata only", () => {
    const metadataOnly = { ...recording("2050-01-01_12-00-00", "SavedClips", 0), clips: [] };
    const sources = catalogs({ SavedClips: ["2050-01-01"], RecentClips: ["2026-10-24"] });
    const result = timelinePaging([LATEST, metadataOnly], sources, loaded(saved("2050-01-01"), recent("2026-10-24")));
    expect(result.newestDate).toBe("2050-01-01");
    expect(result.fromDate).toBe("2049-12-26");
    expect(result.loadDays).toEqual([]);
  });

  it("does not let an old cached clip turn the initial week into a full archive scan", () => {
    const dates = Array.from({ length: 365 }, (_, index) =>
      new Date(Date.UTC(2026, 10, 5) - index * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
    const oldDate = dates.at(-1)!;
    const oldClip = recording(`${oldDate}_12-00-00`, "RecentClips", 60);
    const result = timelinePaging([oldClip], catalogs({ RecentClips: dates }), loaded(recent(oldDate)));
    expect(result.newestDate).toBe("2026-11-05");
    expect(result.fromDate).toBe("2026-10-30");
    expect(result.requiredDays).toEqual(dates.slice(0, 8).map(recent));
    expect(result.loadDays).toEqual(result.requiredDays);
  });

  it("keeps the current archive window when an older sparse source finishes first", () => {
    const oldSaved = recording("2026-01-01_12-00-00", "SavedClips", 60);
    const sources = catalogs({ SavedClips: ["2026-01-01"], RecentClips: ["2026-11-05", "2026-11-04", "2026-10-29", "2026-10-28"] });
    const result = timelinePaging([oldSaved], sources, loaded(saved("2026-01-01")));
    expect(result).toMatchObject({
      newestDate: "2026-11-05", fromDate: "2026-10-30",
      loadDays: [recent("2026-11-05"), recent("2026-11-04"), recent("2026-10-29")],
    });
  });

  it("anchors the requested week to the clip end day with an exclusive midnight endpoint", () => {
    expect(timelinePaging([recording("2026-10-24_23-59-30", "RecentClips", 60)], CATALOGS, DAYS)).toMatchObject({
      fromDate: "2026-10-19", newestDate: "2026-10-25",
    });
    expect(timelinePaging([recording("2026-10-24_23-59-00", "RecentClips", 60)], CATALOGS, DAYS)).toMatchObject({
      fromDate: "2026-10-18", newestDate: "2026-10-24",
    });
  });

  it("does not mutate recordings, catalogs, or loaded days", () => {
    const events = structuredClone([LATEST]);
    const sources = structuredClone(CATALOGS);
    const days = structuredClone(DAYS);
    const before = structuredClone({ events, sources, days });
    for (const clip of events[0].clips) { Object.freeze(clip.cameras); Object.freeze(clip); }
    Object.freeze(events[0].clips); Object.freeze(events[0]); Object.freeze(events);
    for (const source of Object.values(sources)) { Object.freeze(source!.dates); Object.freeze(source); }
    Object.freeze(sources);
    for (const day of Object.values(days)) { Object.freeze(day.events); Object.freeze(day); }
    Object.freeze(days);
    expect(() => timelinePaging(events, sources, days)).not.toThrow();
    expect({ events, sources, days }).toEqual(before);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid clip duration %s", (duration) => {
    expect(() => timelinePaging([recording("2026-10-24_12-00-00", "RecentClips", duration)], CATALOGS, DAYS))
      .toThrow("Invalid clip duration");
  });
});

describe("Timeline calendar navigation", () => {
  it.each([
    ["2026-01-01", 7, "2025-12-25"], ["2024-03-01", 1, "2024-02-29"],
    ["2026-03-01", 1, "2026-02-28"], ["2026-03-10", 7, "2026-03-03"],
    ["2026-11-03", 7, "2026-10-27"], ["2026-10-24", 0, "2026-10-24"],
  ])("subtracts %s by %s recorded calendar days", (date, days, expected) => {
    expect(earlierTimelineDate(date, days)).toBe(expected);
  });

  it("keeps range and calendar arithmetic independent of the device timezone", () => {
    const before = timelinePaging([LATEST], CATALOGS, DAYS);
    vi.stubEnv("TZ", "Pacific/Auckland");
    try {
      expect(timelinePaging([LATEST], CATALOGS, DAYS)).toEqual(before);
      expect(earlierTimelineDate("2026-03-10", 7)).toBe("2026-03-03");
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([-1, 0.5, NaN, Infinity])("rejects invalid day count %s", (days) => {
    expect(() => earlierTimelineDate("2026-10-24", days)).toThrow("Invalid Timeline day count");
  });

  it.each(["2026-2-01", "2026-02-30", "2026-10-24T00:00:00", "not-a-date"])("rejects invalid date %s", (date) => {
    expect(() => earlierTimelineDate(date, 7)).toThrow();
    expect(() => timelinePaging([LATEST], CATALOGS, DAYS, date)).toThrow();
  });
});
