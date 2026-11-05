import {
  assertArchiveCatalog,
  assertArchiveDay,
  type ArchiveCatalog,
  type ArchiveDay,
  type SavedArchive,
} from "./archive";

// Day snapshots replace version 1's source-wide snapshots and opaque cursors.
const DATABASE_NAME = "teslacam-replay-recordings";
const DATABASE_VERSION = 2;
const CATALOG_STORE = "catalogs";
const DAY_STORE = "days";

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
      for (const name of Array.from(database.objectStoreNames)) database.deleteObjectStore(name);
      database.createObjectStore(CATALOG_STORE, { keyPath: "type" });
      database.createObjectStore(DAY_STORE, { keyPath: ["type", "date"] });
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
  stores: string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction, setResult: (result: T) => void) => void,
): Promise<T> {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(stores, mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(cacheError("transaction was aborted.", transaction.error));
      transaction.onerror = () => reject(cacheError("transaction failed.", transaction.error));
      operation(transaction, (value) => { result = value; });
    });
  } finally {
    database.close();
  }
}

export async function readRecordingCache(): Promise<SavedArchive> {
  const saved = await transaction<{ catalogs: unknown[]; days: unknown[] }>(
    [CATALOG_STORE, DAY_STORE], "readonly", (transaction, setResult) => {
      const result = { catalogs: [] as unknown[], days: [] as unknown[] };
      const catalogs = transaction.objectStore(CATALOG_STORE).getAll();
      const days = transaction.objectStore(DAY_STORE).getAll();
      catalogs.onsuccess = () => { result.catalogs = catalogs.result; };
      days.onsuccess = () => { result.days = days.result; };
      setResult(result);
    },
  );
  for (const catalog of saved.catalogs) assertArchiveCatalog(catalog);
  for (const day of saved.days) assertArchiveDay(day);
  const { catalogs, days } = saved as SavedArchive;
  return {
    catalogs,
    // A day write already in flight can finish after its catalog removed it.
    days: days.filter((day) => catalogs.some((catalog) =>
      catalog.type === day.type && catalog.dates.includes(day.date))),
  };
}

export async function writeArchiveCatalog(catalog: ArchiveCatalog): Promise<void> {
  assertArchiveCatalog(catalog);
  await transaction<void>([CATALOG_STORE, DAY_STORE], "readwrite", (transaction) => {
    transaction.objectStore(CATALOG_STORE).put(catalog);
    const dates = new Set(catalog.dates);
    const request = transaction.objectStore(DAY_STORE).openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const [type, date] = cursor.primaryKey as [string, string];
      if (type === catalog.type && !dates.has(date)) cursor.delete();
      cursor.continue();
    };
  });
}

export async function writeArchiveDay(day: ArchiveDay): Promise<void> {
  assertArchiveDay(day);
  await transaction<void>([DAY_STORE], "readwrite", (transaction) => {
    transaction.objectStore(DAY_STORE).put(day);
  });
}
