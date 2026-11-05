import { EVENT_PAGE_TYPES, type EventPagePosition, type EventPageType } from "./api";
import { recordingWallTimeMs } from "./playback";
import { ALL_CAMERAS, type DashcamEvent } from "./types";

export interface CachedRecordingSource extends EventPagePosition {
  type: EventPageType;
  events: DashcamEvent[];
  pageCount: number;
}

// Increase the database version when the public recording shape changes. Version 1
// requires absolute MP4 capture times so restored clips preserve clock changes.
const DATABASE_NAME = "teslacam-replay-recordings";
const DATABASE_VERSION = 1;
const STORE_NAME = "sources";

function cacheError(message: string, cause: unknown): Error {
  return new Error(`Recording cache ${message}`, { cause });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("Recording cache requires IndexedDB in this browser."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    let blocked = false;
    request.onupgradeneeded = () => {
      const database = request.result;
      if (database.objectStoreNames.contains(STORE_NAME)) database.deleteObjectStore(STORE_NAME);
      database.createObjectStore(STORE_NAME, { keyPath: "type" });
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Recording cache is blocked by another tab. Close other TeslaCam Replay tabs and reload."));
    };
    request.onerror = () => reject(cacheError("could not be opened.", request.error));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      if (blocked) database.close();
      else resolve(database);
    };
  });
}

async function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore, setResult: (result: T) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(cacheError("transaction was aborted.", transaction.error));
      transaction.onerror = () => reject(cacheError("transaction failed.", transaction.error));
      operation(transaction.objectStore(STORE_NAME), (value) => { result = value; });
    });
  } finally {
    database.close();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validTimestamp(value: unknown): boolean {
  if (typeof value !== "string") return false;
  // Match the same local timestamp contract as playback before it reaches views.
  recordingWallTimeMs(value);
  return true;
}

function validateSource(value: unknown): asserts value is CachedRecordingSource {
  if (!isObject(value)
    || !EVENT_PAGE_TYPES.includes(value.type as EventPageType)
    || !Number.isSafeInteger(value.pageCount) || Number(value.pageCount) < 1
    || !(value.nextPageToken === null || (typeof value.nextPageToken === "string" && value.nextPageToken.length > 0))
    || !(value.nextPageDate === null || validDate(value.nextPageDate))
    || (value.nextPageToken === null && value.nextPageDate !== null)
    || !Array.isArray(value.events)) {
    throw new Error("Recording cache contains an invalid source or page position.");
  }
  for (const event of value.events) {
    if (!isObject(event) || event.type !== value.type || typeof event.id !== "string" || !event.id
      || !validTimestamp(event.timestamp) || typeof event.hasThumbnail !== "boolean"
      || typeof event.totalDurationSec !== "number" || !Number.isFinite(event.totalDurationSec) || event.totalDurationSec < 0
      || !Array.isArray(event.clips)) {
      throw new Error("Recording cache contains an invalid recording.");
    }
    for (const field of ["city", "reason", "camera", "thumbnailVersion"]) {
      if (event[field] !== undefined && typeof event[field] !== "string") {
        throw new Error(`Recording cache contains invalid recording ${field}.`);
      }
    }
    for (const field of ["lat", "lon", "cameraCount"]) {
      if (event[field] !== undefined && (typeof event[field] !== "number" || !Number.isFinite(event[field]))) {
        throw new Error(`Recording cache contains invalid recording ${field}.`);
      }
    }
    for (const clip of event.clips) {
      if (!isObject(clip) || !validTimestamp(clip.timestamp)
        || !Number.isSafeInteger(clip.captureTimeMs) || !Number.isFinite(new Date(Number(clip.captureTimeMs)).getTime())
        || typeof clip.durationSec !== "number" || !Number.isFinite(clip.durationSec) || clip.durationSec <= 0
        || !Array.isArray(clip.cameras) || clip.cameras.length === 0
        || !clip.cameras.every((camera) => ALL_CAMERAS.includes(camera))) {
        throw new Error("Recording cache contains an invalid clip or missing capture time.");
      }
    }
  }
}

export async function readRecordingCache(): Promise<CachedRecordingSource[]> {
  const sources = await transaction<unknown[]>("readonly", (store, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => setResult(request.result);
  });
  for (const source of sources) validateSource(source);
  return sources as CachedRecordingSource[];
}

export async function writeRecordingCache(source: CachedRecordingSource): Promise<void> {
  validateSource(source);
  await transaction<void>("readwrite", (store) => { store.put(source); });
}
