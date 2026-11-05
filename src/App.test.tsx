import { recordingWallTimeMs } from "./playback";
// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashcamEvent } from "./types";
import { fetchEvent, fetchEventPage } from "./api";
import { readRecordingCache, writeRecordingCache, type CachedRecordingSource } from "./recordingCache";
import type { EventPagePositions, EventPageType } from "./api";
import { App } from "./App";

interface BrowserProps {
  active: boolean;
  events: DashcamEvent[];
  pagePositions: EventPagePositions;
  pendingTypes: EventPageType[];
  errorsByType: Partial<Record<EventPageType, string>>;
  cacheError: string | null;
  onRefresh: () => Promise<void>;
  onLoadMore: (types: EventPageType[]) => void;
  onRetry: (type: EventPageType) => void;
  onSelectEvent: (event: DashcamEvent, list: DashcamEvent[], startTime?: number) => void;
}
interface PlayerProps {
  event: DashcamEvent;
  initialTime: number;
  onBack: () => void;
  onRefresh: () => void;
  onNavigate: (direction: -1 | 1) => void;
}
const state = vi.hoisted(() => ({ browser: null as BrowserProps | null }));

vi.mock("./recordingCache", () => ({
  readRecordingCache: vi.fn(),
  writeRecordingCache: vi.fn(),
}));

vi.mock("./api", () => ({
  EVENT_PAGE_TYPES: ["SavedClips", "SentryClips", "RecentClips"],
  fetchEvent: vi.fn(),
  fetchEventPage: vi.fn(),
}));
vi.mock("./components/EventBrowser", () => ({
  EventBrowser: (props: BrowserProps) => {
    state.browser = props;
    return <div data-testid="browser" data-active={props.active} />;
  },
}));
vi.mock("./components/Player", () => ({
  Player: ({ event, initialTime, onBack, onRefresh, onNavigate }: PlayerProps) => <div>
    <output data-testid="player" data-recording={event.id} data-start={initialTime} />
    <button onClick={onBack}>Player back</button>
    <button onClick={onRefresh}>Refresh recording</button>
    <button onClick={() => onNavigate(1)}>Next recording</button>
  </div>,
}));

function recording(timestamp: string): DashcamEvent {
  return {
    id: timestamp,
    type: "RecentClips",
    timestamp,
    hasThumbnail: false,
    clips: [{ timestamp, captureTimeMs: recordingWallTimeMs(timestamp), cameras: ["front"], durationSec: 21 * 3600 }],
    totalDurationSec: 21 * 3600,
  };
}
const selected = recording("2026-10-21_00-00-00");

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, "", "/");
  state.browser = null;
  vi.mocked(readRecordingCache).mockReset().mockResolvedValue([]);
  vi.mocked(writeRecordingCache).mockReset().mockResolvedValue();
  vi.mocked(fetchEvent).mockReset();
  vi.mocked(fetchEventPage).mockReset().mockImplementation(async (type) => ({ type, events: [], nextPageToken: null, nextPageDate: null }));
  // Browser history traversal itself is outside this component's responsibility.
  vi.spyOn(history, "back").mockImplementation(() => {
    history.replaceState(null, "", "/");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open() {
  await act(async () => root.render(<App />));
}
async function select(event: DashcamEvent, startTime: number | undefined) {
  await act(async () => {
    state.browser!.onSelectEvent(event, [event], startTime);
    // Hash assignment dispatches hashchange on the next browser task.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
  expect(button, `Expected ${label} button`).toBeDefined();
  await act(async () => button!.click());
}
function playerStart() {
  const player = container.querySelector('[data-testid="player"]');
  expect(player).not.toBeNull();
  return Number(player!.getAttribute("data-start"));
}

describe("calendar playback selection", () => {
  it("offers a full reload after a recording-load failure", async () => {
    vi.mocked(fetchEvent).mockRejectedValue(new Error("Recording could not be loaded"));
    await open();
    await select(selected, 20 * 3600);
    const reload = vi.fn();
    vi.stubGlobal("location", { hash: location.hash, reload });
    await click("Reload app");
    expect(reload).toHaveBeenCalledExactlyOnceWith();
  });

  it("retains a late selected time when a recording load fails and the user retries", async () => {
    vi.mocked(fetchEvent).mockRejectedValueOnce(new Error("Drive listing failed")).mockResolvedValueOnce(selected);
    await open();
    await select(selected, 20 * 3600 + 15);
    expect(container.textContent).toContain("Drive listing failed");
    await click("Retry recording");
    expect(fetchEvent).toHaveBeenNthCalledWith(1, selected.type, selected.id, false);
    expect(fetchEvent).toHaveBeenNthCalledWith(2, selected.type, selected.id, true);
    expect(playerStart()).toBe(20 * 3600 + 15);
  });

  it("keeps the chosen wall time when the canonical recording begins earlier", async () => {
    const fragment = recording("2026-10-21_04-00-00");
    const canonical = { ...selected, clips: [...selected.clips, ...fragment.clips] };
    vi.mocked(fetchEvent).mockResolvedValue(canonical);
    await open();
    await select(fragment, 15 * 3600 + 30);
    expect(playerStart()).toBe(19 * 3600 + 30);
    expect(container.querySelector('[data-testid="player"]')!.getAttribute("data-recording")).toBe(canonical.id);
    expect(location.hash).toBe(`#/event/${canonical.type}/${canonical.id}`);
  });

  it("clears a failed calendar selection when the user goes back and directly reopens its route", async () => {
    vi.mocked(fetchEvent).mockRejectedValueOnce(new Error("Drive listing failed")).mockResolvedValueOnce(selected);
    await open();
    await select(selected, 20 * 3600);
    await click("Back to recordings");
    expect(state.browser!.active).toBe(true);
    await act(async () => {
      history.replaceState(null, "", `#/event/${selected.type}/${selected.id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(playerStart()).toBe(0);
  });

  it("opens a fresh card selection at the beginning after abandoning a failed calendar selection", async () => {
    vi.mocked(fetchEvent).mockRejectedValueOnce(new Error("Drive listing failed")).mockResolvedValueOnce(selected);
    await open();
    await select(selected, 20 * 3600);
    await click("Back to recordings");
    await select(selected, undefined);
    expect(playerStart()).toBe(0);
  });

  it("consumes the selected time after success so refresh starts without an old calendar request", async () => {
    vi.mocked(fetchEvent).mockResolvedValue(selected);
    await open();
    await select(selected, 20 * 3600);
    expect(playerStart()).toBe(20 * 3600);
    await click("Refresh recording");
    expect(playerStart()).toBe(0);
  });
});


it("navigates between repeated-hour recordings in the same order as the browser and timeline", async () => {
  const first = recording("2026-11-01_01-50-00");
  first.clips[0].captureTimeMs = Date.parse("2026-11-01T08:50:00Z");
  const second = recording("2026-11-01_01-20-00");
  second.clips[0].captureTimeMs = Date.parse("2026-11-01T09:20:00Z");
  vi.mocked(fetchEventPage).mockImplementation(async (type) => ({ type, events: type === "RecentClips" ? [first, second] : [], nextPageToken: null, nextPageDate: null }));
  vi.mocked(fetchEvent).mockImplementation(async (_type, id) => {
    const event = [first, second].find((event) => event.id === id);
    if (!event) throw new Error(`Unknown recording: ${id}`);
    return event;
  });
  await open();
  await act(async () => {
    state.browser!.onSelectEvent(second, [first, second], 0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.querySelector('[data-testid="player"]')!.getAttribute("data-recording")).toBe(second.id);
  await click("Next recording");
  expect(container.querySelector('[data-testid="player"]')!.getAttribute("data-recording")).toBe(first.id);
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function cachedSource(events: DashcamEvent[], pageCount: number): CachedRecordingSource {
  return { type: "RecentClips", events, pageCount, nextPageToken: "cached-older", nextPageDate: "2026-10-20" };
}

describe("saved recording list and background refresh", () => {
  it("restores recordings and their cursor before the network finishes, including in StrictMode", async () => {
    const page = deferred<Awaited<ReturnType<typeof fetchEventPage>>>();
    const cached = cachedSource([selected], 1);
    vi.mocked(readRecordingCache).mockResolvedValue([cached]);
    vi.mocked(fetchEventPage).mockImplementation(() => page.promise);
    await act(async () => root.render(<StrictMode><App /></StrictMode>));
    expect(state.browser!.events).toEqual([selected]);
    expect(state.browser!.pagePositions.RecentClips).toEqual({ nextPageToken: "cached-older", nextPageDate: "2026-10-20" });
    expect(state.browser!.pendingTypes).toContain("RecentClips");
    expect(readRecordingCache).toHaveBeenCalledTimes(1);
    expect(fetchEventPage).toHaveBeenCalledTimes(3);
  });

  it("refreshes the loaded depth with fresh cursors and replaces removed recordings atomically", async () => {
    const newer = recording("2026-10-22_00-00-00");
    const older = recording("2026-10-20_00-00-00");
    const secondPage = deferred<Awaited<ReturnType<typeof fetchEventPage>>>();
    vi.mocked(readRecordingCache).mockResolvedValue([cachedSource([selected, older], 2)]);
    vi.mocked(fetchEventPage).mockImplementation(async (type, token) => {
      if (type !== "RecentClips") return { type, events: [], nextPageToken: null, nextPageDate: null };
      if (token === null) return { type, events: [newer], nextPageToken: "fresh-next", nextPageDate: "2026-10-21" };
      expect(token).toBe("fresh-next");
      return secondPage.promise;
    });
    await open();
    expect(state.browser!.events).toEqual([selected, older]);
    expect(state.browser!.pagePositions.RecentClips!.nextPageToken).toBe("cached-older");
    await act(async () => secondPage.resolve({ type: "RecentClips", events: [older], nextPageToken: "fresh-older", nextPageDate: "2026-10-20" }));
    expect(state.browser!.events).toEqual([newer, older]);
    expect(state.browser!.pagePositions.RecentClips!.nextPageToken).toBe("fresh-older");
    expect(writeRecordingCache).toHaveBeenCalledWith({ type: "RecentClips", events: [newer, older], pageCount: 2, nextPageToken: "fresh-older", nextPageDate: "2026-10-20" });
    expect(fetchEventPage).not.toHaveBeenCalledWith("RecentClips", "cached-older", expect.anything());
  });

  it("retains the complete saved source on a later-page failure and retries from the first page", async () => {
    const cached = cachedSource([selected], 2);
    vi.mocked(readRecordingCache).mockResolvedValue([cached]);
    vi.mocked(fetchEventPage).mockImplementation(async (type, token) => {
      if (type !== "RecentClips") return { type, events: [], nextPageToken: null, nextPageDate: null };
      if (token !== null) throw new Error("Older refresh failed");
      return { type, events: [], nextPageToken: "fresh-next", nextPageDate: "2026-10-21" };
    });
    await open();
    expect(state.browser!.events).toEqual([selected]);
    expect(state.browser!.pagePositions.RecentClips!.nextPageToken).toBe("cached-older");
    expect(state.browser!.errorsByType.RecentClips).toBe("Older refresh failed");
    expect(writeRecordingCache).not.toHaveBeenCalledWith(expect.objectContaining({ type: "RecentClips" }));
    vi.mocked(fetchEventPage).mockResolvedValue({ type: "RecentClips", events: [], nextPageToken: null, nextPageDate: null });
    await act(async () => state.browser!.onRetry("RecentClips"));
    expect(fetchEventPage).toHaveBeenLastCalledWith("RecentClips", null, 24);
    expect(state.browser!.events).toEqual([]);
    expect(state.browser!.errorsByType.RecentClips).toBeUndefined();
  });

  it("persists additional loaded pages and refreshes the resulting depth", async () => {
    const older = recording("2026-10-20_00-00-00");
    vi.mocked(fetchEventPage).mockImplementation(async (type, token) => ({
      type, events: type === "RecentClips" ? [token === null ? selected : older] : [],
      nextPageToken: type === "RecentClips" && token === null ? "older" : null,
      nextPageDate: type === "RecentClips" && token === null ? "2026-10-21" : null,
    }));
    await open();
    await act(async () => state.browser!.onLoadMore(["RecentClips"]));
    expect(writeRecordingCache).toHaveBeenCalledWith(expect.objectContaining({ type: "RecentClips", events: [selected, older], pageCount: 2, nextPageToken: null }));
    vi.mocked(fetchEventPage).mockClear();
    await act(async () => state.browser!.onRefresh());
    expect(vi.mocked(fetchEventPage).mock.calls.filter(([type]) => type === "RecentClips")).toEqual([["RecentClips", null, 24], ["RecentClips", "older", 24]]);
  });

  it("reports cache read and write errors while still displaying live recordings", async () => {
    vi.mocked(readRecordingCache).mockRejectedValue(new Error("Storage access denied"));
    vi.mocked(writeRecordingCache).mockRejectedValue(new Error("Quota exceeded"));
    vi.mocked(fetchEventPage).mockImplementation(async (type) => ({ type, events: type === "RecentClips" ? [selected] : [], nextPageToken: null, nextPageDate: null }));
    await open();
    expect(state.browser!.events).toEqual([selected]);
    expect(state.browser!.cacheError).toContain("Quota exceeded");
    expect(state.browser!.errorsByType).toEqual({});
    expect(state.browser!.pendingTypes).toEqual([]);
  });

  it("keeps route details fetched during cache restoration and background refresh authoritative", async () => {
    const cache = deferred<CachedRecordingSource[]>();
    const page = deferred<Awaited<ReturnType<typeof fetchEventPage>>>();
    vi.mocked(readRecordingCache).mockReturnValue(cache.promise);
    vi.mocked(fetchEventPage).mockImplementation(async (type) => type === "RecentClips" ? page.promise : { type, events: [], nextPageToken: null, nextPageDate: null });
    vi.mocked(fetchEvent).mockResolvedValue({ ...selected, city: "Fresh route detail" });
    await open();
    await select(selected, undefined);
    await act(async () => cache.resolve([cachedSource([{ ...selected, city: "Old cached detail" }], 1)]));
    expect(state.browser!.events[0].city).toBe("Fresh route detail");
    // Fetch new route details after the page request has started.
    vi.mocked(fetchEvent).mockResolvedValue({ ...selected, city: "Newer route detail" });
    await click("Refresh recording");
    await act(async () => page.resolve({ type: "RecentClips", events: [{ ...selected, city: "Page detail" }], nextPageToken: null, nextPageDate: null }));
    expect(state.browser!.events[0].city).toBe("Newer route detail");
    expect(writeRecordingCache).toHaveBeenLastCalledWith(expect.objectContaining({ type: "RecentClips", events: [expect.objectContaining({ city: "Newer route detail" })] }));
  });
});
