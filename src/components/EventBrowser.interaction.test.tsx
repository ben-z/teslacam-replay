// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { fetchArchiveCatalog, fetchArchiveDay } from "../api";
import { readRecordingCache, writeArchiveCatalog, writeArchiveDay } from "../recordingCache";
import { RECORDING_TYPES, type ArchiveDay, type SavedArchive } from "../archive";

vi.mock("../api", () => ({ fetchArchiveCatalog: vi.fn(), fetchArchiveDay: vi.fn(), fetchEvent: vi.fn(), thumbnailUrl: () => "unused" }));
vi.mock("../recordingCache", () => ({ readRecordingCache: vi.fn(), writeArchiveCatalog: vi.fn(), writeArchiveDay: vi.fn() }));

function day(date: string, city: string): ArchiveDay {
  return { type: "RecentClips", date, events: [{
    id: `${date}_12-00-00`, type: "RecentClips", timestamp: `${date}T12:00:00`, city,
    hasThumbnail: false, totalDurationSec: 60,
    clips: [{ timestamp: `${date}_12-00-00`, captureTimeMs: Date.parse(`${date}T20:00:00Z`), cameras: ["front"], durationSec: 60 }],
  }] };
}
function saved(): SavedArchive {
  return {
    catalogs: RECORDING_TYPES.map((type) => ({ type, dates: type === "RecentClips" ? ["2026-11-05", "2026-11-04", "2026-10-29", "2026-10-28", "2026-10-22"] : [] })),
    days: [day("2026-11-05", "Old latest"), day("2026-11-04", "Cached"), day("2026-10-29", "Cached")],
  };
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, "", "/");
  vi.mocked(readRecordingCache).mockReset().mockResolvedValue(saved());
  vi.mocked(writeArchiveCatalog).mockReset().mockResolvedValue();
  vi.mocked(writeArchiveDay).mockReset().mockResolvedValue();
  vi.mocked(fetchArchiveCatalog).mockReset().mockImplementation(async (type) => saved().catalogs.find((entry) => entry.type === type)!);
  vi.mocked(fetchArchiveDay).mockReset().mockImplementation(async ({ date }) => day(date, "Fresh"));
  Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  Reflect.deleteProperty(Element.prototype, "scrollTo");
  vi.restoreAllMocks();
});
async function openTimeline() {
  await act(async () => root.render(<App />));
  await click("Timeline");
}
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find((button) => button.textContent === text);
  expect(button, `Missing ${text}`).toBeDefined();
  await act(async () => button!.click());
}
function earlier() {
  return [...container.querySelectorAll("button")].find((button) => button.textContent === "Earlier 7 days");
}

describe("timeline requests remain independent", () => {
  it("opens the preceding week while the newest day and IndexedDB writes are held", async () => {
    const head = deferred<ArchiveDay>();
    const write = deferred<void>();
    vi.mocked(writeArchiveDay).mockReturnValue(write.promise);
    vi.mocked(fetchArchiveDay).mockImplementation(async ({ date }) => date === "2026-11-05" ? head.promise : day(date, "Older"));
    await openTimeline();
    expect(container.querySelector(".recent-scan-status")!.textContent).toContain("Archive days loaded for this range.");
    expect(earlier()!.hasAttribute("aria-disabled")).toBe(false);
    await click("Earlier 7 days");
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-10-28" });
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-10-22" });
    expect(container.querySelector(".recent-scan-status")!.textContent).toContain("2026-10-23–2026-11-05");
    expect(container.querySelector(".recent-scan-status")!.textContent).toContain("Archive days loaded for this range.");
    // The head remains unresolved and all writes remain uncommitted.
    expect(earlier()!.hasAttribute("aria-disabled")).toBe(false);
    await act(async () => head.resolve(day("2026-11-05", "Updated latest")));
    await click("Recordings (5)");
    expect(container.textContent).toContain("Updated latest");
    expect(container.textContent).toContain("Older");
    await act(async () => write.resolve());
  });

  it("keeps the cached week visible and older navigation available when a new head day is missing", async () => {
    const head = deferred<ArchiveDay>();
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (type) => ({ type, dates: type === "RecentClips"
      ? ["2026-11-06", ...saved().catalogs.find((entry) => entry.type === type)!.dates] : [] }));
    vi.mocked(fetchArchiveDay).mockImplementation(async ({ date }) => date === "2026-11-06" ? head.promise : day(date, "Older"));
    await openTimeline();
    expect(container.querySelector(".recent-scan-status")!.textContent).toContain("still need loading");
    expect(container.querySelector(".timeline-day-label-date")!.textContent).toBe("Nov 5");
    expect(earlier()!.hasAttribute("aria-disabled")).toBe(false);
    await click("Earlier 7 days");
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-10-28" });
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-10-22" });
    expect(container.textContent).toContain("5 recordings loaded");
    await act(async () => head.resolve(day("2026-11-06", "New head")));
    expect(container.textContent).toContain("6 recordings loaded");
  });

  it("loads newest cards after a failed catalog is retried in the recording list", async () => {
    vi.mocked(readRecordingCache).mockResolvedValue({ catalogs: [], days: [] });
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (type) => {
      if (type === "RecentClips") throw new Error("Dates unavailable");
      return { type, dates: [] };
    });
    await act(async () => root.render(<App />));
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (type) => saved().catalogs.find((entry) => entry.type === type)!);
    await click("Retry Recent dates");
    expect(container.textContent).toContain("Recordings (1)");
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-11-05" });
  });

  it("loads a newly discovered latest day after Refresh in the recording list", async () => {
    await act(async () => root.render(<App />));
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (type) => ({ type, dates: type === "RecentClips"
      ? ["2026-11-06", ...saved().catalogs.find((entry) => entry.type === type)!.dates] : [] }));
    await click("Refresh");
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-11-06" });
    expect(container.textContent).toContain("Recordings (4)");
  });

  it("keeps older navigation working after a failed update to a cached day", async () => {
    vi.mocked(fetchArchiveDay).mockImplementation(async ({ date }) => {
      if (date === "2026-11-05") throw new Error("Newest day unavailable");
      return day(date, "Older");
    });
    await openTimeline();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("Previously loaded recordings are still shown.");
    expect(container.querySelector(".recent-scan-status")!.textContent).toContain("Archive days loaded for this range.");
    await click("Earlier 7 days");
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-10-28" });
    expect(container.textContent).toContain("5 recordings loaded");
  });

  it("loads an in-range backfill without replaying already loaded days", async () => {
    vi.mocked(fetchArchiveCatalog).mockImplementation(async (type) => ({ type, dates: type === "RecentClips"
      ? ["2026-11-05", "2026-11-04", "2026-10-31", "2026-10-29", "2026-10-28", "2026-10-22"] : [] }));
    await openTimeline();
    expect(fetchArchiveDay).toHaveBeenCalledWith({ type: "RecentClips", date: "2026-10-31" });
    expect(fetchArchiveDay).not.toHaveBeenCalledWith({ type: "RecentClips", date: "2026-11-04" });
    expect(fetchArchiveDay).not.toHaveBeenCalledWith({ type: "RecentClips", date: "2026-10-29" });
    expect(container.textContent).toContain("4 recordings loaded");
  });

  it("refreshes the visible week and preserves loaded history outside it", async () => {
    const cache = saved();
    cache.days.push(day("2026-10-22", "Older saved history"));
    vi.mocked(readRecordingCache).mockResolvedValue(cache);
    await openTimeline();
    vi.mocked(fetchArchiveDay).mockClear();
    const button = container.querySelector<HTMLButtonElement>('[title="Refresh recordings"]')!;
    await act(async () => button.click());
    expect(vi.mocked(fetchArchiveDay).mock.calls.map(([key]) => key.date).sort()).toEqual(["2026-10-29", "2026-11-04", "2026-11-05"]);
    await click("Recordings (4)");
    expect(container.textContent).toContain("Older saved history");
  });
});
