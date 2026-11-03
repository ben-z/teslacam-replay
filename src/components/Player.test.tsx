// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashcamEvent } from "../types";
import { Player } from "./Player";

interface HlsDouble {
  url: string;
  destroyed: boolean;
  video: HTMLVideoElement | null;
  complete: (duration: number) => void;
}

const { instances, runtime } = vi.hoisted(() => ({ instances: [] as HlsDouble[], runtime: { native: false } }));

vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => !runtime.native;
    static Events = { ERROR: "error", LEVEL_LOADED: "levelLoaded", FRAG_BUFFERED: "fragBuffered" };
    url = "";
    destroyed = false;
    video: HTMLVideoElement | null = null;
    latestLevelDetails: { url: string; live: boolean; totalduration: number } | null = null;
    handlers = new Map<string, Set<(event: string, data: unknown) => void>>();
    constructor() { instances.push(this); }
    loadSource(url: string) { this.url = new URL(url, location.href).href; }
    attachMedia(video: HTMLVideoElement) {
      this.video = video;
      Object.defineProperty(video, "currentSrc", { configurable: true, get: () => this.url });
    }
    on(event: string, callback: (event: string, data: unknown) => void) {
      if (!this.handlers.has(event)) this.handlers.set(event, new Set());
      this.handlers.get(event)!.add(callback);
    }
    off(event: string, callback: (event: string, data: unknown) => void) { this.handlers.get(event)?.delete(callback); }
    destroy() { this.destroyed = true; this.handlers.clear(); }
    complete(duration: number) {
      this.latestLevelDetails = { url: this.url, live: false, totalduration: duration };
      for (const callback of this.handlers.get("levelLoaded") ?? []) callback("levelLoaded", { details: this.latestLevelDetails });
    }
  },
}));

function recording(timestamps: string[], cameras: string[]): DashcamEvent {
  return {
    id: timestamps[0], type: "RecentClips", timestamp: timestamps[0], hasThumbnail: false,
    clips: timestamps.map((timestamp) => ({ timestamp, cameras, durationSec: 60 })),
    totalDurationSec: timestamps.length * 60,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  instances.length = 0;
  runtime.native = false;
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function open(event: DashcamEvent, initialTime: number) {
  await act(async () => root.render(<Player event={event} initialTime={initialTime} onBack={() => {}} onRefresh={() => {}} />));
}

function position() {
  return Number(container.querySelector('[aria-label="Recording position"]')!.getAttribute("aria-valuenow"));
}

describe("opening at a selected recording time", () => {
  it("loads only the selected source file when opening late in a long recording", async () => {
    const event = recording([
      "2026-10-21_00-00-00", "2026-10-21_20-00-00", "2026-10-21_20-01-00",
    ], ["front", "back"]);
    await open(event, 20 * 3600 + 20);
    expect(position()).toBe(20 * 3600 + 20);
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toContain("/2026-10-21_20-00-00/front/stream.m3u8");
    expect(instances[0].video!.currentTime).toBe(20);
    expect(instances.some((source) => source.url.includes("/2026-10-21_00-00-00/front/"))).toBe(false);
  });

  it.each([{ cameras: ["front"] }, { cameras: ["front", "back"] }])("corrects an initial seek beyond the final focused camera with $cameras", async ({ cameras }) => {
    await open(recording(["2026-10-21_20-00-00"], cameras), 55);
    expect(position()).toBe(55);
    expect(instances).toHaveLength(1);
    await act(async () => instances[0].complete(43));
    expect(position()).toBe(43);
    expect(instances[0].video!.currentTime).toBe(43);
    expect(container.querySelector('.player-time')!.textContent).toContain(cameras.length === 1 ? "0:43 / 0:43" : "0:43 / ~1:00");
    expect(instances).toHaveLength(1);
  });

  it("loads the newly selected segment when initialTime changes without a recording change", async () => {
    const event = recording(["2026-10-21_20-00-00", "2026-10-21_20-01-00"], ["front", "back"]);
    await open(event, 10);
    const first = instances[0];
    await open(event, 75);
    expect(first.destroyed).toBe(true);
    expect(position()).toBe(75);
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toContain("/2026-10-21_20-01-00/front/stream.m3u8");
    expect(instances[1].video!.currentTime).toBe(15);
  });
});


describe("seeking across recording gaps and missing cameras", () => {
  it("shows a measured recording gap and lets the user continue at the next source file", async () => {
    const event = recording(["2026-10-21_20-00-00", "2026-10-21_20-01-00"], ["front"]);
    await open(event, 45);
    await act(async () => instances[0].complete(30));
    expect(position()).toBe(45);
    expect(container.textContent).toContain("This camera has no video for this interval");
    await act(async () => (container.querySelector('[aria-label="Next segment"]') as HTMLButtonElement).click());
    expect(position()).toBe(60);
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toContain("/2026-10-21_20-01-00/front/stream.m3u8");
    expect(instances[1].video!.currentTime).toBe(0);
    expect(container.textContent).not.toContain("This camera has no video for this interval");
  });

  it("keeps a missing focused camera explicit after seeking and loads the chosen available camera", async () => {
    const event = recording(["2026-10-21_20-00-00", "2026-10-21_20-01-00"], ["front"]);
    event.clips[1].cameras = ["back"];
    await open(event, 10);
    await act(async () => (container.querySelector('[aria-label="Next segment"]') as HTMLButtonElement).click());
    expect(position()).toBe(60);
    expect(container.textContent).toContain("Front camera has no recorded video in this segment");
    expect((container.querySelector('[aria-label="Play"]') as HTMLButtonElement).disabled).toBe(true);
    expect(instances).toHaveLength(1);
    const picker = container.querySelector('[aria-label="Focused camera"]') as HTMLSelectElement;
    await act(async () => { picker.value = "back"; picker.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(instances).toHaveLength(2);
    expect(instances[1].url).toContain("/2026-10-21_20-01-00/back/stream.m3u8");
    expect(position()).toBe(60);
    expect(container.textContent).not.toContain("Front camera has no recorded video in this segment");
  });
});


describe("native HLS final-segment seeking", () => {
  it("keeps a native EVENT playlist's infinite duration provisional while preserving the requested position", async () => {
    runtime.native = true;
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    await open(recording(["2026-10-21_20-00-00"], ["front"]), 10);
    const video = container.querySelector('video[aria-label="Front camera"]') as HTMLVideoElement;
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 4 },
      duration: { configurable: true, value: Infinity },
      currentSrc: { configurable: true, get: () => video.src },
    });
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
      video.dispatchEvent(new Event("durationchange"));
      video.dispatchEvent(new Event("canplay"));
    });
    expect(position()).toBe(10);
    expect(video.currentTime).toBe(10);
    expect(container.querySelector('.player-time')!.textContent).toContain("0:10 / ~1:00");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain("Loading segment");
    expect(instances).toHaveLength(0);
  });

  it("corrects a paused native seek when the browser reaches the completed source end", async () => {
    runtime.native = true;
    vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
    await open(recording(["2026-10-21_20-00-00"], ["front"]), 55);
    expect(instances).toHaveLength(0);
    const video = container.querySelector('video[aria-label="Front camera"]') as HTMLVideoElement;
    expect(video.src).toContain("/2026-10-21_20-00-00/front/stream.m3u8");
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 4 },
      duration: { configurable: true, value: 43 },
      currentSrc: { configurable: true, get: () => video.src },
      ended: { configurable: true, value: true },
    });
    // WebKit reports readiness before reaching a completed native source's end.
    await act(async () => { video.dispatchEvent(new Event("canplay")); });
    await act(async () => { video.dispatchEvent(new Event("ended")); });
    expect(position()).toBe(43);
    expect(video.currentTime).toBe(43);
    expect(container.querySelector('.player-time')!.textContent).toContain("0:43 / 0:43");
    expect((container.querySelector('[aria-label="Play"]') as HTMLButtonElement).disabled).toBe(false);
  });
});
