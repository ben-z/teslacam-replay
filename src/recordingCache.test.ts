import { IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRecordingCache, writeRecordingCache, type CachedRecordingSource } from "./recordingCache";

const databaseName = "teslacam-replay-recordings";

function source(type: CachedRecordingSource["type"]): CachedRecordingSource {
  return {
    type,
    pageCount: 2,
    nextPageToken: "opaque-cursor",
    nextPageDate: "2026-11-01",
    events: [{
      type,
      id: "2026-11-01_01-20-00",
      timestamp: "2026-11-01T01:20:00",
      hasThumbnail: true,
      thumbnailVersion: "revision-1",
      totalDurationSec: 60,
      clips: [{
        timestamp: "2026-11-01_01-20-00",
        captureTimeMs: Date.parse("2026-11-01T09:20:00Z"),
        durationSec: 60,
        cameras: ["front", "back"],
      }],
    }],
  };
}

function open(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, version);
    request.onsuccess = () => resolve(request.result as IDBDatabase);
    request.onerror = () => reject(request.error);
  });
}

async function overwrite(value: unknown): Promise<void> {
  const database = await open(1);
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("sources", "readwrite");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.objectStore("sources").put(value);
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

describe("persistent recording source cache", () => {
  it("returns an empty list for a browser with no saved index", async () => {
    expect(await readRecordingCache()).toEqual([]);
  });

  it("round-trips loaded pages, cursor bounds, previews and absolute capture times", async () => {
    const saved = source("RecentClips");
    await writeRecordingCache(saved);
    const restored = await readRecordingCache();
    expect(restored).toEqual([saved]);
    expect(restored[0]).not.toBe(saved);
  });

  it("updates one source without overwriting independently completed sources", async () => {
    await Promise.all([
      writeRecordingCache(source("SavedClips")),
      writeRecordingCache(source("SentryClips")),
      writeRecordingCache(source("RecentClips")),
    ]);
    const updated = { ...source("SavedClips"), pageCount: 3, nextPageToken: null, nextPageDate: null };
    await writeRecordingCache(updated);
    const restored = await readRecordingCache();
    expect(restored).toHaveLength(3);
    expect(restored.find((entry) => entry.type === "SavedClips")).toEqual(updated);
    expect(restored.find((entry) => entry.type === "RecentClips")).toEqual(source("RecentClips"));
  });

  it("closes every database connection after committed reads and writes", async () => {
    const close = vi.spyOn(IDBDatabase.prototype, "close");
    await writeRecordingCache(source("SavedClips"));
    await readRecordingCache();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects a write aborted after its request succeeds and preserves the previous snapshot", async () => {
    const saved = source("SavedClips");
    await writeRecordingCache(saved);
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = put.apply(this, args);
      request.onsuccess = () => this.transaction.abort();
      return request;
    });
    await expect(writeRecordingCache({ ...saved, pageCount: 8 })).rejects.toThrow("transaction was aborted");
    spy.mockRestore();
    expect(await readRecordingCache()).toEqual([saved]);
  });

  it("reports unavailable IndexedDB explicitly", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(readRecordingCache()).rejects.toThrow("requires IndexedDB");
  });

  it("reports database open errors", async () => {
    const database = await open(2);
    database.close();
    await expect(readRecordingCache()).rejects.toThrow("could not be opened");
  });

  it("reports a blocked open and closes a connection that arrives after rejection", async () => {
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

  it.each([
    { type: "UnknownClips" },
    { pageCount: 0 },
    { pageCount: 1.5 },
    { nextPageToken: "" },
    { nextPageDate: "2026-02-30" },
    { nextPageToken: null, nextPageDate: "2026-11-01" },
    { events: [{ ...source("SavedClips").events[0], type: "SentryClips" }] },
    { events: [{ ...source("SavedClips").events[0], clips: [{ timestamp: "2026-11-01_01-20-00", durationSec: 60, cameras: ["front"] }] }] },
  ])("rejects malformed stored data: %j", async (invalid) => {
    await readRecordingCache();
    await overwrite({ ...source("SavedClips"), ...invalid });
    await expect(readRecordingCache()).rejects.toThrow("Recording cache contains");
  });
});
