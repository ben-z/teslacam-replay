import { describe, expect, it } from "vitest";
import { hasReachedPlaybackEnd, playbackBoundary, playbackTimeline, recordingWallTimeMs } from "./playback";
import type { EventClip } from "./types";

const clip = (timestamp: string): EventClip => ({ timestamp, cameras: ["front", "back"], durationSec: 60 });

describe("playback timeline", () => {
  it("replays completed available views even when a failed camera leaves the event duration estimated", () => {
    const clips = [clip("2026-10-21_20-35-58")];
    const completed = { [clips[0].timestamp]: { front: 43.67 } };
    expect(playbackTimeline(clips, completed).estimated).toBe(true);
    expect(hasReachedPlaybackEnd([{ ended: true }])).toBe(true);
    expect(hasReachedPlaybackEnd([{ ended: false }])).toBe(false);
    expect(completed[clips[0].timestamp]).not.toHaveProperty("back");
  });

  it("waits for a lagging surviving camera even after the shared clock reaches the final duration", () => {
    const globalTime = playbackBoundary(0, null, [43.61, 43.67]);
    const front = { currentTime: 42.92, ended: false };
    const left = { currentTime: 43.67, ended: true };
    expect(globalTime).toBe(43.67);
    expect(hasReachedPlaybackEnd([front, left])).toBe(false);
    expect(hasReachedPlaybackEnd([{ ...front, currentTime: 43.61, ended: true }, left])).toBe(true);
    expect(hasReachedPlaybackEnd([])).toBe(false);
  });

  it("ends playback at the longest completed camera, rather than the one-minute estimate", () => {
    expect(playbackBoundary(0, null, [43.52, 43.67, 43.49, 43.6, 43.55, 43.58])).toBe(43.67);
  });

  it("does not turn a progressive playlist's current duration into a final playback boundary", () => {
    expect(playbackBoundary(0, null, [43.52, undefined])).toBeNull();
    expect(playbackBoundary(0, 180, [43.52, undefined])).toBe(180);
  });

  it("preserves the next recording start when source files overlap", () => {
    expect(playbackBoundary(0, 60, [60.3, 60.4])).toBe(60);
  });

  it("replaces a one-minute estimate only after every camera has a completed duration", () => {
    const clips = [clip("2026-10-21_20-35-58")];
    expect(playbackTimeline(clips, { [clips[0].timestamp]: { front: 43.52 } })).toMatchObject({ offsets: [0, 60], estimated: true });
    expect(playbackTimeline(clips, { [clips[0].timestamp]: { front: 43.52, back: 43.67 } })).toEqual({ offsets: [0, 43.67], durations: [43.67], estimated: false });
  });

  it("keeps recording gaps instead of joining separated files into continuous footage", () => {
    const clips = [clip("2026-10-21_20-35-58"), clip("2026-10-21_20-38-58")];
    const completed = Object.fromEntries(clips.map((item) => [item.timestamp, { front: 43.52, back: 43.67 }]));
    const timeline = playbackTimeline(clips, completed);
    expect(timeline).toMatchObject({ durations: [43.67, 43.67], estimated: false });
    expect(timeline.offsets.slice(0, 2)).toEqual([0, 180]);
    expect(timeline.offsets[2]).toBeCloseTo(223.67);
  });

  it("handles an event with no playable videos", () => {
    expect(playbackTimeline([], {})).toEqual({ offsets: [0], durations: [], estimated: false });
  });

  it("rejects invalid or unordered recording timestamps", () => {
    expect(() => recordingWallTimeMs("2026-02-30_20-35-58")).toThrow("Invalid recording timestamp");
    expect(() => playbackTimeline([clip("2026-10-21_20-38-58"), clip("2026-10-21_20-35-58")], {})).toThrow("increasing timestamps");
  });

  it("uses recorded calendar fields without assigning the browser's timezone", () => {
    expect(recordingWallTimeMs("2026-10-21_20-35-58")).toBe(Date.UTC(2026, 9, 21, 20, 35, 58));
    expect(recordingWallTimeMs("2026-10-21T20:35:58-07:00")).toBe(recordingWallTimeMs("2026-10-21_20-35-58"));
  });
});
