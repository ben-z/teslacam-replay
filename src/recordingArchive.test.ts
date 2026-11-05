import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchArchiveCatalog, fetchArchiveDay } from "./api";
import { archiveDayKey, RECORDING_TYPES, type ArchiveCatalog, type ArchiveDay, type RecordingType, type SavedArchive } from "./archive";
import { archiveEvents, catalogKey, RecordingArchive } from "./recordingArchive";
import { readRecordingCache, writeArchiveCatalog, writeArchiveDay } from "./recordingCache";

vi.mock("./api", () => ({ fetchArchiveCatalog: vi.fn(), fetchArchiveDay: vi.fn() }));
vi.mock("./recordingCache", () => ({ readRecordingCache: vi.fn(), writeArchiveCatalog: vi.fn(), writeArchiveDay: vi.fn() }));

const type = "RecentClips";
const head = { type, date: "2026-11-05" } as const;
const older = { type, date: "2026-11-03" } as const;
const dates = ["2026-11-05", "2026-11-04", "2026-11-03"];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function day(source: RecordingType, date: string, city: string): ArchiveDay {
  return {
    type: source, date,
    events: [{
      type: source, id: `${date}_12-00-00`, timestamp: `${date}T12:00:00`, city,
      hasThumbnail: false, totalDurationSec: 60,
      clips: [{ timestamp: `${date}_12-00-00`, captureTimeMs: Date.parse(`${date}T20:00:00Z`), cameras: ["front", "back"], durationSec: 60 }],
    }],
  };
}
function savedArchive(): SavedArchive {
  return {
    catalogs: [{ type, dates }],
    days: [day(type, head.date, "Saved head"), day(type, "2026-11-04", "Saved history")],
  };
}
function useSavedArchive() {
  vi.mocked(readRecordingCache).mockResolvedValue(savedArchive());
  vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => ({ type: source, dates: source === type ? dates : [] }));
}

beforeEach(() => {
  vi.mocked(readRecordingCache).mockReset().mockResolvedValue({ catalogs: [], days: [] });
  vi.mocked(writeArchiveCatalog).mockReset().mockResolvedValue();
  vi.mocked(writeArchiveDay).mockReset().mockResolvedValue();
  vi.mocked(fetchArchiveCatalog).mockReset().mockImplementation(async (source) => ({ type: source, dates: [] }));
  vi.mocked(fetchArchiveDay).mockReset().mockImplementation(async (key) => day(key.type, key.date, "Live recording"));
});

describe("independent archive resources", () => {
  it("restores complete saved days while catalog requests are held, without rescanning historical days", async () => {
    useSavedArchive();
    const catalog = deferred<ArchiveCatalog>();
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => source === type ? catalog.promise : { type: source, dates: [] });
    const archive = new RecordingArchive();
    const start = archive.start();
    await vi.waitFor(() => expect(archive.getSnapshot().restored).toBe(true));
    expect(archiveEvents(archive.getSnapshot()).map((event) => event.city)).toEqual(["Saved head", "Saved history"]);
    expect(archive.getSnapshot().pending.has(catalogKey(type))).toBe(true);
    expect(fetchArchiveDay).not.toHaveBeenCalled();
    catalog.resolve({ type, dates });
    await start;
    expect(fetchArchiveDay).toHaveBeenCalledExactlyOnceWith(head);
  });

  it("loads an older day while the catalog and then the latest day remain pending", async () => {
    useSavedArchive();
    const catalog = deferred<ArchiveCatalog>();
    const latest = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => source === type ? catalog.promise : { type: source, dates: [] });
    vi.mocked(fetchArchiveDay).mockImplementation(async (key) => key.date === head.date ? latest.promise : day(key.type, key.date, "New history"));
    const archive = new RecordingArchive();
    const start = archive.start();
    await vi.waitFor(() => expect(archive.getSnapshot().restored).toBe(true));
    await archive.loadDay(older, false);
    expect(fetchArchiveDay).toHaveBeenCalledWith(older);
    expect(archive.getSnapshot().days[archiveDayKey(older)].events[0].city).toBe("New history");
    catalog.resolve({ type, dates });
    await start;
    expect(archive.getSnapshot().pending.has(archiveDayKey(head))).toBe(true);
    expect(archive.getSnapshot().days[archiveDayKey(older)].events[0].city).toBe("New history");
    latest.resolve(day(type, head.date, "Fresh head"));
    await archive.loadDay(head, true);
    expect(archiveEvents(archive.getSnapshot()).map((event) => event.city)).toEqual(["Fresh head", "Saved history", "New history"]);
    expect(fetchArchiveDay).toHaveBeenCalledTimes(2);
  });

  it("does not hold network requests or their completion behind IndexedDB writes", async () => {
    useSavedArchive();
    const catalogWrite = deferred<void>();
    const dayWrite = deferred<void>();
    vi.mocked(writeArchiveCatalog).mockReturnValue(catalogWrite.promise);
    vi.mocked(writeArchiveDay).mockReturnValue(dayWrite.promise);
    const archive = new RecordingArchive();
    await archive.start();
    await archive.loadDay(older, false);
    expect(fetchArchiveDay).toHaveBeenCalledWith(head);
    expect(fetchArchiveDay).toHaveBeenCalledWith(older);
    expect(archive.getSnapshot().days[archiveDayKey(older)]).toEqual(day(type, older.date, "Live recording"));
    expect(archive.getSnapshot().pending.size).toBe(0);
    catalogWrite.resolve();
    dayWrite.resolve();
  });

  it("continues browsing a saved source when its catalog check fails", async () => {
    useSavedArchive();
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => {
      if (source === type) throw new Error("Catalog unavailable");
      return { type: source, dates: [] };
    });
    const archive = new RecordingArchive();
    await archive.start();
    expect(archive.getSnapshot().errors[catalogKey(type)]).toBe("Catalog unavailable");
    await archive.loadDay(older, false);
    expect(archive.getSnapshot().days[archiveDayKey(older)]).toEqual(day(type, older.date, "Live recording"));
    expect(archiveEvents(archive.getSnapshot())).toHaveLength(3);
    expect(archive.getSnapshot().errors[archiveDayKey(older)]).toBeUndefined();
  });

  it("keeps a failed latest-day refresh isolated from older-day requests and retries", async () => {
    useSavedArchive();
    const latest = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveDay).mockImplementation(async (key) => key.date === head.date ? latest.promise : day(key.type, key.date, "New history"));
    const archive = new RecordingArchive();
    await archive.start();
    const refreshing = archive.loadDay(head, true);
    latest.reject(new Error("Latest day unavailable"));
    await refreshing;
    expect(archive.getSnapshot().errors[archiveDayKey(head)]).toBe("Latest day unavailable");
    expect(archive.getSnapshot().days[archiveDayKey(head)].events[0].city).toBe("Saved head");
    await archive.loadDay(older, false);
    expect(archive.getSnapshot().days[archiveDayKey(older)].events[0].city).toBe("New history");
    vi.mocked(fetchArchiveDay).mockResolvedValue(day(type, head.date, "Recovered head"));
    await archive.loadDay(head, true);
    expect(archive.getSnapshot().errors[archiveDayKey(head)]).toBeUndefined();
    expect(archive.getSnapshot().days[archiveDayKey(head)].events[0].city).toBe("Recovered head");
  });

  it("replaces the exact day snapshot, including deleted recordings, clips and cameras", async () => {
    const saved = savedArchive();
    saved.days[0].events.push({ ...saved.days[0].events[0], id: `${head.date}_13-00-00` });
    saved.days[0].events[0].clips.push({ ...saved.days[0].events[0].clips[0], timestamp: `${head.date}_12-01-00` });
    vi.mocked(readRecordingCache).mockResolvedValue(saved);
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => ({ type: source, dates: source === type ? dates : [] }));
    const latest = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveDay).mockReturnValue(latest.promise);
    const archive = new RecordingArchive();
    await archive.start();
    const refreshing = archive.loadDay(head, true);
    const fresh = day(type, head.date, "Changed day");
    fresh.events[0].clips[0].cameras = ["front"];
    latest.resolve(fresh);
    await refreshing;
    expect(archive.getSnapshot().days[archiveDayKey(head)]).toEqual(fresh);
    expect(archiveEvents(archive.getSnapshot())).toHaveLength(2);
    expect(writeArchiveDay).toHaveBeenCalledExactlyOnceWith(fresh);
  });

  it("removes catalog-deleted days and ignores a scan that finishes after deletion", async () => {
    useSavedArchive();
    const archive = new RecordingArchive();
    await archive.start();
    const removed = { type, date: "2026-11-04" } as const;
    const scanning = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveDay).mockImplementation(async (key) => key.date === removed.date ? scanning.promise : day(key.type, key.date, "Fresh head"));
    const request = archive.loadDay(removed, true);
    archive.rememberRecording({ ...day(type, removed.date, "Removed detail").events[0] });
    vi.mocked(fetchArchiveCatalog).mockResolvedValue({ type, dates: [head.date] });
    await archive.loadCatalog(type);
    expect(archive.getSnapshot().days[archiveDayKey(removed)]).toBeUndefined();
    expect(archiveEvents(archive.getSnapshot()).every((event) => event.id.startsWith(head.date))).toBe(true);
    vi.mocked(writeArchiveDay).mockClear();
    scanning.resolve(day(type, removed.date, "Late removed day"));
    await request;
    expect(archive.getSnapshot().days[archiveDayKey(removed)]).toBeUndefined();
    expect(archive.getSnapshot().pending.has(archiveDayKey(removed))).toBe(false);
    expect(writeArchiveDay).not.toHaveBeenCalledWith(expect.objectContaining(removed));
  });

  it("does not mark a direct recording route's day as loaded or write an incomplete day", () => {
    const archive = new RecordingArchive();
    const detail = day(type, head.date, "Route details").events[0];
    archive.rememberRecording(detail);
    expect(archiveEvents(archive.getSnapshot())).toEqual([detail]);
    expect(archive.getSnapshot().days).toEqual({});
    expect(archive.getSnapshot().catalogs).toEqual({});
    expect(writeArchiveDay).not.toHaveBeenCalled();
  });

  it("preserves route details during restoration, then lets a later-started day scan replace them", async () => {
    const cache = deferred<SavedArchive>();
    vi.mocked(readRecordingCache).mockReturnValue(cache.promise);
    const catalog = deferred<ArchiveCatalog>();
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => source === type ? catalog.promise : { type: source, dates: [] });
    const archive = new RecordingArchive();
    const start = archive.start();
    archive.rememberRecording(day(type, head.date, "Fresh route").events[0]);
    cache.resolve(savedArchive());
    await vi.waitFor(() => expect(archive.getSnapshot().restored).toBe(true));
    expect(archiveEvents(archive.getSnapshot())[0].city).toBe("Fresh route");
    catalog.resolve({ type, dates });
    await start;
    await archive.loadDay(head, true);
    expect(archiveEvents(archive.getSnapshot())[0].city).toBe("Live recording");
  });

  it("keeps details completed after a day scan started authoritative without saving them as a day", async () => {
    useSavedArchive();
    const latest = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveDay).mockReturnValue(latest.promise);
    const archive = new RecordingArchive();
    await archive.start();
    const refreshing = archive.loadDay(head, true);
    const detail = day(type, head.date, "New route detail").events[0];
    archive.rememberRecording(detail);
    const fresh = day(type, head.date, "Earlier day scan");
    latest.resolve(fresh);
    await refreshing;
    expect(archiveEvents(archive.getSnapshot())[0]).toEqual(detail);
    expect(archive.getSnapshot().days[archiveDayKey(head)]).toEqual(fresh);
    expect(writeArchiveDay).toHaveBeenCalledExactlyOnceWith(fresh);
    vi.mocked(fetchArchiveDay).mockResolvedValue(day(type, head.date, "Later day scan"));
    await archive.loadDay(head, true);
    expect(archiveEvents(archive.getSnapshot())[0].city).toBe("Later day scan");
  });

  it("starts once across repeated subscribers and StrictMode start calls", async () => {
    useSavedArchive();
    const cache = deferred<SavedArchive>();
    vi.mocked(readRecordingCache).mockReturnValue(cache.promise);
    const archive = new RecordingArchive();
    const listener = vi.fn();
    const unsubscribe = archive.subscribe(listener);
    const first = archive.start();
    unsubscribe();
    archive.subscribe(listener);
    const second = archive.start();
    expect(second).toBe(first);
    cache.resolve(savedArchive());
    await first;
    expect(readRecordingCache).toHaveBeenCalledTimes(1);
    expect(fetchArchiveCatalog).toHaveBeenCalledTimes(RECORDING_TYPES.length);
    expect(fetchArchiveDay).toHaveBeenCalledExactlyOnceWith(head);
    expect(listener).toHaveBeenCalled();
  });

  it("deduplicates simultaneous requests for the same day while allowing a different day", async () => {
    useSavedArchive();
    const latest = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveDay).mockImplementation(async (key) => key.date === head.date ? latest.promise : day(key.type, key.date, "Older result"));
    const archive = new RecordingArchive();
    await archive.start();
    const first = archive.loadDay(head, true);
    const second = archive.loadDay(head, true);
    expect(first).toBe(second);
    await archive.loadDay(older, false);
    expect(fetchArchiveDay).toHaveBeenCalledTimes(2);
    latest.resolve(day(type, head.date, "Latest result"));
    await Promise.all([first, second]);
    expect(archive.getSnapshot().pending.size).toBe(0);
  });

  it("deduplicates simultaneous catalog checks and reuses saved days without a network request", async () => {
    useSavedArchive();
    const catalog = deferred<ArchiveCatalog>();
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => source === type ? catalog.promise : { type: source, dates: [] });
    const archive = new RecordingArchive();
    const start = archive.start();
    await vi.waitFor(() => expect(archive.getSnapshot().restored).toBe(true));
    const first = archive.loadCatalog(type);
    expect(archive.loadCatalog(type)).toBe(first);
    await archive.loadDay({ type, date: "2026-11-04" }, false);
    expect(fetchArchiveDay).not.toHaveBeenCalled();
    expect(vi.mocked(fetchArchiveCatalog).mock.calls.filter(([source]) => source === type)).toHaveLength(1);
    catalog.resolve({ type, dates });
    await Promise.all([start, first]);
  });

  it("refreshes a requested head once when its scan finishes before a held catalog check", async () => {
    useSavedArchive();
    const archive = new RecordingArchive();
    await archive.start();
    await vi.waitFor(() => expect(archive.getSnapshot().pending.size).toBe(0));
    vi.mocked(fetchArchiveDay).mockClear();
    const catalog = deferred<ArchiveCatalog>();
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => source === type ? catalog.promise : { type: source, dates: [] });
    const refreshing = archive.refresh([head]);
    await vi.waitFor(() => {
      expect(fetchArchiveDay).toHaveBeenCalledExactlyOnceWith(head);
      expect(archive.getSnapshot().pending.has(archiveDayKey(head))).toBe(false);
    });
    expect(archive.getSnapshot().pending.has(catalogKey(type))).toBe(true);
    catalog.resolve({ type, dates });
    await refreshing;
    expect(fetchArchiveDay).toHaveBeenCalledExactlyOnceWith(head);
    expect(archive.getSnapshot().pending.size).toBe(0);
  });

  it("clears an obsolete day error so a removed and later re-added day can load normally", async () => {
    useSavedArchive();
    const archive = new RecordingArchive();
    await archive.start();
    vi.mocked(fetchArchiveDay).mockRejectedValue(new Error("Day unavailable"));
    await archive.loadDay(older, false);
    expect(archive.getSnapshot().errors[archiveDayKey(older)]).toBe("Day unavailable");
    vi.mocked(fetchArchiveCatalog).mockResolvedValue({ type, dates: dates.slice(0, 2) });
    await archive.loadCatalog(type);
    expect(archive.getSnapshot().errors[archiveDayKey(older)]).toBeUndefined();
    vi.mocked(fetchArchiveCatalog).mockResolvedValue({ type, dates });
    await archive.loadCatalog(type);
    const recovered = day(type, older.date, "Re-added archive day");
    vi.mocked(fetchArchiveDay).mockResolvedValue(recovered);
    await archive.loadDay(older, false);
    expect(archive.getSnapshot().days[archiveDayKey(older)]).toEqual(recovered);
    expect(archive.getSnapshot().errors[archiveDayKey(older)]).toBeUndefined();
  });

  it("ignores a failed scan after its day has disappeared from the catalog", async () => {
    useSavedArchive();
    const archive = new RecordingArchive();
    await archive.start();
    const scan = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveDay).mockReturnValue(scan.promise);
    const loading = archive.loadDay(older, false);
    vi.mocked(fetchArchiveCatalog).mockResolvedValue({ type, dates: dates.slice(0, 2) });
    await archive.loadCatalog(type);
    scan.reject(new Error("Removed day unavailable"));
    await loading;
    expect(archive.getSnapshot().errors[archiveDayKey(older)]).toBeUndefined();
    expect(archive.getSnapshot().days[archiveDayKey(older)]).toBeUndefined();
    expect(archive.getSnapshot().pending.has(archiveDayKey(older))).toBe(false);
  });

  it("removes a route detail absent from a catalog check that started after the detail was read", async () => {
    const archive = new RecordingArchive();
    archive.rememberRecording(day(type, older.date, "Stale route detail").events[0]);
    vi.mocked(fetchArchiveCatalog).mockResolvedValue({ type, dates: [head.date] });
    await archive.loadCatalog(type);
    expect(archiveEvents(archive.getSnapshot())).toEqual([]);
    expect(archive.getSnapshot().details).toEqual([]);
  });

  it("preserves route details completed after a catalog check started until a later check", async () => {
    const archive = new RecordingArchive();
    const catalog = deferred<ArchiveCatalog>();
    vi.mocked(fetchArchiveCatalog).mockReturnValue(catalog.promise);
    const checking = archive.loadCatalog(type);
    const detail = day(type, older.date, "New route detail").events[0];
    archive.rememberRecording(detail);
    catalog.resolve({ type, dates: [head.date] });
    await checking;
    expect(archiveEvents(archive.getSnapshot())).toEqual([detail]);
    await archive.loadCatalog(type);
    expect(archiveEvents(archive.getSnapshot())).toEqual([]);
  });

  it("reports storage failures separately while preserving successful network data", async () => {
    vi.mocked(readRecordingCache).mockRejectedValue(new Error("Storage access denied"));
    vi.mocked(writeArchiveDay).mockRejectedValue(new Error("Quota exceeded"));
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (source) => ({ type: source, dates: source === type ? [head.date] : [] }));
    const archive = new RecordingArchive();
    await archive.start();
    await vi.waitFor(() => expect(archive.getSnapshot().cacheError).toContain("Quota exceeded"));
    expect(archiveEvents(archive.getSnapshot())[0].city).toBe("Live recording");
    expect(archive.getSnapshot().errors).toEqual({});
    expect(archive.getSnapshot().pending.size).toBe(0);
  });
});
