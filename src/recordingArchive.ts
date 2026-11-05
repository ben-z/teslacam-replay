import { fetchArchiveCatalog, fetchArchiveDay } from "./api";
import { archiveDayKey, RECORDING_TYPES, type ArchiveCatalogs, type ArchiveDays, type ArchiveDayKey, type RecordingType } from "./archive";
import { readRecordingCache, writeArchiveCatalog, writeArchiveDay } from "./recordingCache";
import { replaceEventSnapshot } from "./events";
import type { DashcamEvent } from "./types";

export interface ArchiveState {
  catalogs: ArchiveCatalogs;
  days: ArchiveDays;
  details: DashcamEvent[];
  pending: ReadonlySet<string>;
  errors: Readonly<Record<string, string>>;
  cacheError: string | null;
  restored: boolean;
}

export function catalogKey(type: RecordingType): string {
  return `catalog/${type}`;
}
export function archiveEvents(state: ArchiveState): DashcamEvent[] {
  return state.details.reduce(replaceEventSnapshot, Object.values(state.days).flatMap((day) => day.events));
}

/** Catalogs and complete archive days are independent resources, including their IO. */
export class RecordingArchive {
  private state: ArchiveState = {
    catalogs: {}, days: {}, details: [], pending: new Set(), errors: {}, cacheError: null, restored: false,
  };
  private readonly listeners = new Set<() => void>();
  private readonly requests = new Map<string, Promise<void>>();
  private started: Promise<void> | undefined;

  getSnapshot = (): ArchiveState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(change: Partial<ArchiveState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Restore saved data, check catalogs, and start (but do not await) newest-day reads. */
  start(): Promise<void> {
    this.started ??= this.restore();
    return this.started;
  }

  private async restore(): Promise<void> {
    try {
      const saved = await readRecordingCache();
      this.update({
        catalogs: Object.fromEntries(saved.catalogs.map((catalog) => [catalog.type, catalog])),
        days: Object.fromEntries(saved.days.map((day) => [archiveDayKey(day), day])),
      });
    } catch (error) {
      this.update({ cacheError: `Could not restore saved recordings: ${error instanceof Error ? error.message : String(error)}` });
    }
    this.update({ restored: true });
    await Promise.all(RECORDING_TYPES.map(async (type) => {
      await this.loadCatalog(type);
      const date = this.state.catalogs[type]?.dates[0];
      // Startup checks the newest day; loading a catalog itself never starts
      // another resource request. Refresh owns its explicitly requested days.
      if (date) void this.loadDay({ type, date }, true);
    }));
  }

  private persist(write: Promise<void>): void {
    void write.catch((error: unknown) => {
      this.update({ cacheError: `Could not save recordings on this device: ${error instanceof Error ? error.message : String(error)}` });
    });
  }

  private request(key: string, run: () => Promise<void>): Promise<void> {
    const current = this.requests.get(key);
    if (current) return current;
    const errors = { ...this.state.errors };
    delete errors[key];
    this.update({ pending: new Set([...this.state.pending, key]), errors });
    const promise = (async () => {
      try {
        await run();
      } catch (error) {
        const [type, date] = key.split("/");
        // Ignore a failed read whose day was removed while it was running.
        if (type === "catalog" || this.state.catalogs[type as RecordingType]?.dates.includes(date)) {
          this.update({ errors: { ...this.state.errors, [key]: error instanceof Error ? error.message : String(error) } });
        }
      } finally {
        this.requests.delete(key);
        const pending = new Set(this.state.pending);
        pending.delete(key);
        this.update({ pending });
      }
    })();
    this.requests.set(key, promise);
    return promise;
  }

  loadCatalog = (type: RecordingType): Promise<void> => this.request(catalogKey(type), async () => {
    const detailsAtStart = this.state.details;
    const catalog = await fetchArchiveCatalog(type);
    const dates = new Set(catalog.dates);
    this.update({
      catalogs: { ...this.state.catalogs, [type]: catalog },
      days: Object.fromEntries(Object.entries(this.state.days).filter(([, day]) => day.type !== type || dates.has(day.date))),
      errors: Object.fromEntries(Object.entries(this.state.errors).filter(([key]) => !key.startsWith(`${type}/`) || dates.has(key.slice(type.length + 1)))),
      details: this.state.details.filter((event) => event.type !== type
        || dates.has(event.id.slice(0, 10)) || !detailsAtStart.includes(event)),
    });
    this.persist(writeArchiveCatalog(catalog));

  });

  loadDay = (key: ArchiveDayKey, refresh: boolean): Promise<void> => {
    const id = archiveDayKey(key);
    if (!this.state.catalogs[key.type]?.dates.includes(key.date)) return Promise.resolve();
    if (!refresh && this.state.days[id]) return Promise.resolve();
    return this.request(id, async () => {
      const detailsAtStart = this.state.details;
      const day = await fetchArchiveDay(key);
      // A catalog refresh can remove this day while its scan is running.
      if (!this.state.catalogs[key.type]?.dates.includes(key.date)) return;
      this.update({
        days: { ...this.state.days, [id]: day },
        details: this.state.details.filter((event) => event.type !== key.type || event.id.slice(0, 10) !== key.date
          || !detailsAtStart.includes(event)),
      });
      this.persist(writeArchiveDay(day));
    });
  };

  rememberRecording(event: DashcamEvent): void {
    this.update({ details: replaceEventSnapshot(this.state.details, event) });
  }

  refresh = async (days: ArchiveDayKey[]): Promise<void> => {
    await Promise.all([
      ...RECORDING_TYPES.map((type) => this.loadCatalog(type)),
      ...days.map((day) => this.loadDay(day, true)),
    ]);
  };
}
