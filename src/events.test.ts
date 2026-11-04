import { recordingWallTimeMs } from "./playback";
import { describe, expect, it } from "vitest";
import { compareRecordingOrder, mergeEvents, mergeRecentFragments, replaceEventSnapshot } from "./events";
import type { DashcamEvent } from "./types";

const saved: DashcamEvent = {
  id: "2026-10-21_20-36-52", type: "SavedClips", timestamp: "2026-10-21T20:36:41",
  hasThumbnail: true, totalDurationSec: 60, cameraCount: 2,
  clips: [{ timestamp: "2026-10-21_20-35-58", captureTimeMs: recordingWallTimeMs("2026-10-21_20-35-58"), durationSec: 60, cameras: ["front", "back"] }],
};

describe("authoritative event snapshots", () => {
  it("does not resurrect removed cameras, thumbnails or segments after refresh", () => {
    const refreshed = { ...saved, hasThumbnail: false, clips: [], totalDurationSec: 0, cameraCount: 0 };
    expect(mergeEvents([saved], [refreshed])).toEqual([refreshed]);
  });

  it("uses a corrected duration rather than the largest previously seen estimate", () => {
    const refreshed = { ...saved, totalDurationSec: 43, clips: [{ ...saved.clips[0], durationSec: 43, cameras: ["front"] }] };
    expect(mergeEvents([saved], [refreshed])[0].clips).toEqual(refreshed.clips);
  });

  it("combines overlapping Recent listing fragments without duplicating clips", () => {
    const recent = { ...saved, type: "RecentClips" as const };
    const page = { ...recent, clips: [
      { ...recent.clips[0], cameras: ["left_repeater"] },
      { timestamp: "2026-10-21_20-36-58", captureTimeMs: recordingWallTimeMs("2026-10-21_20-36-58"), durationSec: 60, cameras: ["front"] },
    ] };
    const result = mergeEvents([recent], [page])[0];
    expect(result.clips).toHaveLength(2);
    expect(result.clips[0].cameras).toEqual(["front", "back", "left_repeater"]);
    expect(result.totalDurationSec).toBe(120);
  });

  it("combines cameras split between different Recent page IDs using the server's canonical ID", () => {
    const first = { ...saved, type: "RecentClips" as const, id: "2026-10-21_20-35-58" };
    const next = { ...first, id: "2026-10-21_20-34-58", clips: [
      { timestamp: "2026-10-21_20-34-58", captureTimeMs: recordingWallTimeMs("2026-10-21_20-34-58"), durationSec: 60, cameras: ["front"] },
      { ...first.clips[0], cameras: ["left_repeater"] },
    ] };
    const result = mergeEvents([first], [next]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(next.id);
    expect(result[0].timestamp).toBe("2026-10-21T20:34:58");
    expect(result[0].clips[1].cameras).toEqual(["front", "back", "left_repeater"]);
  });

  it("does not join adjacent Recent fragments without an overlapping segment", () => {
    const first = { ...saved, type: "RecentClips" as const };
    const next = { ...first, id: "2026-10-21_20-36-58", clips: [{ timestamp: "2026-10-21_20-36-58", captureTimeMs: recordingWallTimeMs("2026-10-21_20-36-58"), durationSec: 60, cameras: ["front"] }] };
    expect(mergeEvents([first], [next])).toHaveLength(2);
  });

  it("replaces a refreshed Recent scope without resurrecting deleted cameras or clips", () => {
    const recent = { ...saved, type: "RecentClips" as const };
    const fragment = { ...recent, id: "2026-10-21_20-34-58", clips: [
      { timestamp: "2026-10-21_20-34-58", captureTimeMs: recordingWallTimeMs("2026-10-21_20-34-58"), durationSec: 60, cameras: ["front"] },
      { ...recent.clips[0], cameras: ["left_repeater"] },
    ] };
    const loaded = mergeEvents([recent], [fragment]);
    const snapshot = { ...fragment, hasThumbnail: false, clips: [{ ...recent.clips[0], durationSec: 43, cameras: ["front"] }], totalDurationSec: 43, cameraCount: 1 };
    expect(replaceEventSnapshot(loaded, snapshot)).toEqual([snapshot]);
    expect(replaceEventSnapshot(loaded, { ...snapshot, clips: [], totalDurationSec: 0, cameraCount: 0 })[0].clips).toEqual([]);
  });

  it("adopts the server canonical ID when browser groups were loaded in the opposite order", () => {
    const earlier = { ...saved, type: "RecentClips" as const, id: "2026-10-21_20-30-00", clips: [{ timestamp: "2026-10-21_20-30-00", captureTimeMs: recordingWallTimeMs("2026-10-21_20-30-00"), durationSec: 60, cameras: ["front"] }] };
    const later = { ...earlier, id: "2026-10-21_20-40-00", clips: [{ timestamp: "2026-10-21_20-40-00", captureTimeMs: recordingWallTimeMs("2026-10-21_20-40-00"), durationSec: 60, cameras: ["back"] }] };
    const bridge = { ...earlier, id: "2026-10-21_20-20-00", clips: [
      { timestamp: "2026-10-21_20-20-00", captureTimeMs: recordingWallTimeMs("2026-10-21_20-20-00"), durationSec: 60, cameras: ["front"] },
      { ...earlier.clips[0], cameras: ["left_repeater"] },
      { ...later.clips[0], cameras: ["left_repeater"] },
    ] };
    const loaded = mergeEvents([], [later, earlier]);
    expect(loaded.map((event) => event.id)).toEqual([later.id, earlier.id]);
    const publicBridge = { ...bridge, id: earlier.id };
    const result = mergeEvents(loaded, [publicBridge]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(earlier.id);
    expect(result[0].clips).toHaveLength(3);
    const merged = mergeRecentFragments([earlier, later], bridge, (first, incoming) => ({ ...incoming, id: first.id }));
    expect(merged.merged.id).toBe(earlier.id);
    expect(new Set(merged.originalIds)).toEqual(new Set([earlier.id, later.id, bridge.id]));
  });
});


describe("recording presentation order", () => {
  it("orders the repeated hour by capture time and keeps video-free entries after video on each date", () => {
    const firstHour = { ...saved, id: "first-hour", timestamp: "2026-11-01T01:50:00", clips: [
      { ...saved.clips[0], timestamp: "2026-11-01_01-50-00", captureTimeMs: Date.parse("2026-11-01T08:50:00Z") },
    ] };
    const secondHour = { ...firstHour, id: "second-hour", timestamp: "2026-11-01T01:20:00", clips: [
      { ...firstHour.clips[0], timestamp: "2026-11-01_01-20-00", captureTimeMs: Date.parse("2026-11-01T09:20:00Z") },
    ] };
    const noVideo = { ...firstHour, id: "no-video", timestamp: "2026-11-01T02:30:00", clips: [] };
    const earlierNoVideo = { ...noVideo, id: "earlier-no-video", timestamp: "2026-11-01T01:30:00" };
    const nextDate = { ...noVideo, id: "next-date", timestamp: "2026-11-02T00:00:00" };
    const previousDate = { ...firstHour, id: "previous-date", timestamp: "2026-10-31T23:50:00" };
    const recordings = [firstHour, noVideo, previousDate, secondHour, earlierNoVideo, nextDate];
    expect([...recordings].sort(compareRecordingOrder).map((event) => event.id)).toEqual([
      "next-date", "second-hour", "first-hour", "no-video", "earlier-no-video", "previous-date",
    ]);
    // Metadata carries no inferred UTC instant, so its ordering must not form a
    // cycle with the two video timestamps from different offsets.
    for (const permutation of [[firstHour, secondHour, noVideo], [noVideo, firstHour, secondHour], [secondHour, noVideo, firstHour]]) {
      expect(permutation.sort(compareRecordingOrder).map((event) => event.id)).toEqual(["second-hour", "first-hour", "no-video"]);
    }
  });
});
