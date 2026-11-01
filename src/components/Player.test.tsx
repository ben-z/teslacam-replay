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

const { instances } = vi.hoisted(() => ({ instances: [] as HlsDouble[] }));

vi.mock("hls.js", () => ({
  default: class {
    static isSupported = () => true;
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
