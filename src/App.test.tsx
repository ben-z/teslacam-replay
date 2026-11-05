import { recordingWallTimeMs } from "./playback";
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashcamEvent } from "./types";
import { fetchEvent, fetchArchiveCatalog, fetchArchiveDay } from "./api";
import { readRecordingCache, writeArchiveCatalog, writeArchiveDay } from "./recordingCache";
import type { ArchiveState } from "./recordingArchive";
import type { ArchiveDayKey, RecordingType } from "./archive";
import { App } from "./App";

interface BrowserProps {
  active: boolean;
  events: DashcamEvent[];
  archive: ArchiveState;
  onRefresh: (days: ArchiveDayKey[]) => Promise<void>;
  onLoadDays: (days: ArchiveDayKey[], refresh: boolean) => void;
  onLoadCatalog: (type: RecordingType) => void;
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
  writeArchiveCatalog: vi.fn(),
  writeArchiveDay: vi.fn(),
}));

vi.mock("./api", () => ({
  fetchEvent: vi.fn(),
  fetchArchiveCatalog: vi.fn(),
  fetchArchiveDay: vi.fn(),
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
  vi.mocked(readRecordingCache).mockReset().mockResolvedValue({ catalogs: [], days: [] });
  vi.mocked(writeArchiveCatalog).mockReset().mockResolvedValue();
  vi.mocked(writeArchiveDay).mockReset().mockResolvedValue();
  vi.mocked(fetchEvent).mockReset();
  vi.mocked(fetchArchiveCatalog).mockReset().mockImplementation(async (type) => ({ type, dates: [] }));
  vi.mocked(fetchArchiveDay).mockReset().mockImplementation(async (day) => ({ ...day, events: [] }));
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
  vi.mocked(fetchArchiveCatalog).mockImplementation(async (type) => ({ type, dates: type === "RecentClips" ? ["2026-11-01"] : [] }));
  vi.mocked(fetchArchiveDay).mockResolvedValue({ type: "RecentClips", date: "2026-11-01", events: [first, second] });
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
