import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertArchiveCatalog, assertArchiveDate, assertArchiveDay, type ArchiveCatalog, type ArchiveDay, type RecordingType } from "./archive";
import { readRecordingCache, writeArchiveCatalog, writeArchiveDay } from "./recordingCache";

const databaseName = "teslacam-replay-recordings";

function day(type: RecordingType, date: string): ArchiveDay {
  return {
    type, date,
    events: [{
      type,
      id: `${date}_01-20-00`,
      timestamp: `${date}T01:20:00`,
      hasThumbnail: true,
      thumbnailVersion: "revision-1",
      totalDurationSec: 60,
      clips: [{
        timestamp: `${date}_01-20-00`,
        captureTimeMs: Date.parse(`${date}T09:20:00Z`),
        durationSec: 60,
        cameras: ["front", "back"],
      }],
    }],
  };
}
function catalog(type: RecordingType): ArchiveCatalog {
  return { type, dates: ["2026-11-02", "2026-11-01"] };
}
function open(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onsuccess = () => resolve(request.result as IDBDatabase);
    request.onerror = () => reject(request.error);
  });
}
async function overwrite(store: string, value: unknown): Promise<void> {
  const database = await open(2);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(store, "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore(store).put(value);
    });
  } finally {
    database.close();
  }
}
async function storedDayCount(): Promise<number> {
  const database = await open(2);
  try {
    return await new Promise<number>((resolve, reject) => {
      const transaction = database.transaction("days", "readonly");
      const request = transaction.objectStore("days").count();
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("persistent archive day cache", () => {
  it("returns empty catalogs and days for a browser without a saved archive", async () => {
    expect(await readRecordingCache()).toEqual({ catalogs: [], days: [] });
  });

  it("round-trips independent sources and days with previews and absolute capture times", async () => {
    const saved = [day("RecentClips", "2026-11-01"), day("SavedClips", "2026-11-02")];
    await Promise.all([
      writeArchiveCatalog(catalog("SavedClips")),
      writeArchiveCatalog(catalog("RecentClips")),
      ...saved.map(writeArchiveDay),
    ]);
    expect(await readRecordingCache()).toEqual({
      catalogs: [catalog("RecentClips"), catalog("SavedClips")],
      days: saved,
    });
    expect((await readRecordingCache()).days[0]).not.toBe(saved[0]);
  });

  it("replaces a complete day including deleted recordings, clips and cameras", async () => {
    await writeArchiveCatalog(catalog("RecentClips"));
    const saved = day("RecentClips", "2026-11-01");
    saved.events.push({ ...saved.events[0], id: "2026-11-01_02-20-00" });
    saved.events[0].clips.push({ ...saved.events[0].clips[0], timestamp: "2026-11-01_01-21-00" });
    await writeArchiveDay(saved);
    const updated = day("RecentClips", "2026-11-01");
    updated.events[0].clips[0].cameras = ["front"];
    await writeArchiveDay(updated);
    expect((await readRecordingCache()).days).toEqual([updated]);
    await writeArchiveDay({ ...updated, events: [] });
    expect((await readRecordingCache()).days).toEqual([{ ...updated, events: [] }]);
  });

  it("prunes removed days atomically without affecting another source", async () => {
    await writeArchiveCatalog(catalog("SavedClips"));
    await writeArchiveCatalog(catalog("RecentClips"));
    await writeArchiveDay(day("SavedClips", "2026-11-01"));
    await writeArchiveDay(day("SavedClips", "2026-11-02"));
    await writeArchiveDay(day("RecentClips", "2026-11-01"));
    await writeArchiveCatalog({ type: "SavedClips", dates: ["2026-11-02"] });
    expect((await readRecordingCache()).days).toEqual([
      day("RecentClips", "2026-11-01"), day("SavedClips", "2026-11-02"),
    ]);
    expect(await storedDayCount()).toBe(2);
  });

  it("never restores an orphan day written after its catalog removed it", async () => {
    await writeArchiveCatalog({ type: "RecentClips", dates: [] });
    await writeArchiveDay(day("RecentClips", "2026-11-01"));
    expect(await storedDayCount()).toBe(1);
    expect(await readRecordingCache()).toEqual({ catalogs: [{ type: "RecentClips", dates: [] }], days: [] });
    await writeArchiveCatalog({ type: "RecentClips", dates: [] });
    expect(await storedDayCount()).toBe(0);
  });

  it("discards derived version 1 source snapshots during the schema upgrade", async () => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("sources", { keyPath: "type" });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as IDBDatabase);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("sources", "readwrite");
    transaction.objectStore("sources").put({ type: "RecentClips", events: [], pageCount: 8 });
    await new Promise<void>((resolve) => { transaction.oncomplete = () => resolve(); });
    database.close();
    expect(await readRecordingCache()).toEqual({ catalogs: [], days: [] });
    const upgraded = await open(2);
    expect(Array.from(upgraded.objectStoreNames)).toEqual(["catalogs", "days"]);
    upgraded.close();
  });

  it("closes every database connection after committed reads and writes", async () => {
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    await writeArchiveCatalog(catalog("SavedClips"));
    await writeArchiveDay(day("SavedClips", "2026-11-01"));
    await readRecordingCache();
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("rejects a write aborted after its request succeeds and retains the old day", async () => {
    const saved = day("RecentClips", "2026-11-01");
    await writeArchiveCatalog(catalog("RecentClips"));
    await writeArchiveDay(saved);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      request.onsuccess = () => this.transaction.abort();
      return request;
    });
    await expect(writeArchiveDay({ ...saved, events: [] })).rejects.toThrow("transaction was aborted");
    spy.mockRestore();
    expect((await readRecordingCache()).days).toEqual([saved]);
  });

  it("does not prune days when the catalog transaction aborts", async () => {
    const saved = day("RecentClips", "2026-11-01");
    await writeArchiveCatalog(catalog("RecentClips"));
    await writeArchiveDay(saved);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      request.onsuccess = () => this.transaction.abort();
      return request;
    });
    await expect(writeArchiveCatalog({ type: "RecentClips", dates: [] })).rejects.toThrow("transaction");
    spy.mockRestore();
    expect(await readRecordingCache()).toEqual({ catalogs: [catalog("RecentClips")], days: [saved] });
  });

  it("reports unavailable IndexedDB explicitly", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(readRecordingCache()).rejects.toThrow("requires IndexedDB");
  });

  it("reports database open errors", async () => {
    const database = await open(3);
    database.close();
    await expect(readRecordingCache()).rejects.toThrow("could not be opened");
  });

  it("reports blocked opens and closes a connection arriving after rejection", async () => {
    const request = {} as IDBOpenDBRequest;
    const close = vi.fn();
    vi.stubGlobal("indexedDB", { open: () => request });
    const reading = readRecordingCache();
    const failure = expect(reading).rejects.toThrow("blocked by another tab");
    request.onblocked!(new Event("blocked") as IDBVersionChangeEvent);
    await failure;
    Object.assign(request, { result: { close } });
    request.onsuccess!(new Event("success"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects malformed stored catalogs and days before restoring them", async () => {
    await readRecordingCache();
    await overwrite("catalogs", { type: "SavedClips", dates: ["2026-11-01", "2026-11-02"] });
    await expect(readRecordingCache()).rejects.toThrow("newest first");
    await overwrite("catalogs", catalog("SavedClips"));
    await overwrite("days", { ...day("SavedClips", "2026-11-01"), events: [{ ...day("SavedClips", "2026-11-01").events[0], clips: [{}] }] });
    await expect(readRecordingCache()).rejects.toThrow("missing capture time");
  });
});

describe("archive contracts", () => {
  it.each([undefined, null, "2026-02-30", "2026-11-1", "2026-13-01", 20261101])("rejects invalid archive date %j", (value) => {
    expect(() => assertArchiveDate(value)).toThrow("Invalid archive date");
  });

  it.each([
    { type: "UnknownClips", dates: [] },
    { type: "RecentClips", dates: ["2026-11-01", "2026-11-01"] },
    { type: "RecentClips", dates: ["2026-11-01", "2026-11-02"] },
    { type: "RecentClips", dates: ["2026-02-30"] },
    { type: "RecentClips" },
  ])("rejects invalid catalogs %j", (value) => {
    expect(() => assertArchiveCatalog(value)).toThrow();
  });

  it.each([
    { type: "UnknownClips" },
    { date: "2026-02-30" },
    { events: [{ ...day("SavedClips", "2026-11-01").events[0], type: "SentryClips" }] },
    { events: [{ ...day("SavedClips", "2026-11-01").events[0], id: "2026-11-02_01-20-00" }] },
    { events: [{ ...day("SavedClips", "2026-11-01").events[0], timestamp: "not a timestamp" }] },
    { events: [day("SavedClips", "2026-11-01").events[0], day("SavedClips", "2026-11-01").events[0]] },
    { events: [{ ...day("SavedClips", "2026-11-01").events[0], clips: [{ timestamp: "2026-11-01_01-20-00", durationSec: 60, cameras: ["front"] }] }] },
    { events: [{ ...day("SavedClips", "2026-11-01").events[0], clips: [{ timestamp: "2026-11-01_01-20-00", captureTimeMs: 0, durationSec: 60, cameras: ["unknown"] }] }] },
  ])("rejects invalid day fields %j", (invalid) => {
    expect(() => assertArchiveDay({ ...day("SavedClips", "2026-11-01"), ...invalid })).toThrow();
  });

  it("identifies a saved archive day by its folder even when video crosses midnight", () => {
    const saved = day("SavedClips", "2026-11-01");
    saved.events[0].timestamp = "2026-11-02T00:00:01";
    saved.events[0].clips[0].timestamp = "2026-10-31_23-59-30";
    expect(() => assertArchiveDay(saved)).not.toThrow();
  });
});
