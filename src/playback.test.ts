import { describe, expect, it } from "vitest";
import { formatUtcOffset, hasReachedPlaybackEnd, playbackBoundary, playbackParticipants, playbackTimeline, recordingClockAt, recordingOffsetMs, recordingTimeCandidates, recordingWallTimeMs } from "./playback";
import type { EventClip } from "./types";

const clip = (timestamp: string): EventClip => ({ timestamp, captureTimeMs: recordingWallTimeMs(timestamp), cameras: ["front", "back"], durationSec: 60 });

describe("playback timeline", () => {
  it("keeps all cameras in Grid and only the selected available camera in Focus", () => {
    const available = ["front", "back", "left_repeater"];
    expect(playbackParticipants(available, null)).toEqual(available);
    expect(playbackParticipants(available, "back")).toEqual(["back"]);
    expect(playbackParticipants(["left_repeater"], "back")).toEqual([]);
    expect(playbackParticipants([], "back")).toEqual([]);
  });

  it("ends a focused camera without discarding longer or unknown recording durations", () => {
    const clips = [clip("2026-10-21_20-35-58")];
    const partial = { [clips[0].timestamp]: { front: 8 } };
    expect(playbackTimeline(clips, partial)).toMatchObject({ offsets: [0, 60], estimated: true });
    const cameras = [{ name: "front", ended: true }, { name: "back", ended: false }];
    expect(hasReachedPlaybackEnd(cameras.filter((camera) => playbackParticipants(clips[0].cameras, "front").includes(camera.name)))).toBe(true);
    expect(hasReachedPlaybackEnd(cameras)).toBe(false);
    expect(playbackTimeline(clips, { [clips[0].timestamp]: { front: 8, back: 12 } })).toMatchObject({ offsets: [0, 12], estimated: false });
  });
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
    expect(() => playbackTimeline([clip("2026-10-21_20-38-58"), clip("2026-10-21_20-35-58")], {})).toThrow("increasing capture timestamps");
  });

  it("uses recorded calendar fields without assigning the browser's timezone", () => {
    expect(recordingWallTimeMs("2026-10-21_20-35-58")).toBe(Date.UTC(2026, 9, 21, 20, 35, 58));
    expect(recordingWallTimeMs("2026-10-21T20:35:58-07:00")).toBe(recordingWallTimeMs("2026-10-21_20-35-58"));
  });

  it("keeps the full source interval when the car repeats an hour", () => {
    const clips = [
      { ...clip("2026-11-01_01-59-00"), captureTimeMs: Date.parse("2026-11-01T08:59:00Z") },
      { ...clip("2026-11-01_01-00-00"), captureTimeMs: Date.parse("2026-11-01T09:00:00Z") },
      { ...clip("2026-11-01_01-01-00"), captureTimeMs: Date.parse("2026-11-01T09:01:00Z") },
    ];
    expect(playbackTimeline(clips, {}).offsets).toEqual([0, 60, 120, 180]);
    expect(playbackBoundary(0, 60, [59.9978])).toBe(59.9978);
    expect(recordingClockAt(clips, 59).wallTimeMs).toBe(recordingWallTimeMs("2026-11-01T01:59:59"));
    expect(recordingClockAt(clips, 60)).toEqual({ wallTimeMs: recordingWallTimeMs("2026-11-01T01:00:00"), utcOffsetMs: -8 * 3600_000 });
  });

  it("does not add an hour of empty playback when the car jumps forward", () => {
    const clips = [
      { ...clip("2026-03-08_01-59-00"), captureTimeMs: Date.parse("2026-03-08T09:59:00Z") },
      { ...clip("2026-03-08_03-00-00"), captureTimeMs: Date.parse("2026-03-08T10:00:00Z") },
    ];
    expect(playbackTimeline(clips, {}).offsets).toEqual([0, 60, 120]);
    expect(recordingTimeCandidates(clips, 120, recordingWallTimeMs("2026-03-08T02:30:00"))).toEqual([]);
    expect(recordingTimeCandidates(clips, 120, recordingWallTimeMs("2026-03-08T03:00:00"))).toEqual([{ timeSec: 60, utcOffsetMs: -7 * 3600_000 }]);
  });

  it("returns both repeated clock readings without choosing one", () => {
    const clips = [
      { ...clip("2026-11-01_00-00-00"), captureTimeMs: Date.parse("2026-11-01T07:00:00Z") },
      { ...clip("2026-11-01_01-00-00"), captureTimeMs: Date.parse("2026-11-01T09:00:00Z") },
    ];
    expect(recordingTimeCandidates(clips, 4 * 3600, recordingWallTimeMs("2026-11-01T01:30:00"))).toEqual([
      { timeSec: 90 * 60, utcOffsetMs: -7 * 3600_000 },
      { timeSec: 150 * 60, utcOffsetMs: -8 * 3600_000 },
    ]);
    expect(recordingTimeCandidates(clips, 4 * 3600, recordingWallTimeMs("2026-11-01T02:00:00"))).toEqual([
      { timeSec: 3 * 3600, utcOffsetMs: -8 * 3600_000 },
    ]);
    expect(recordingTimeCandidates(clips, 4 * 3600, recordingWallTimeMs("2026-11-01T03:00:00"))).toEqual([
      { timeSec: 4 * 3600, utcOffsetMs: -8 * 3600_000 },
    ]);
  });

  it("retains exact local dates across midnight and non-hour timezone changes", () => {
    const clips = [
      { ...clip("2026-10-21_23-59-30"), captureTimeMs: Date.parse("2026-10-21T18:14:30Z") },
    ];
    expect(formatUtcOffset(recordingOffsetMs(clips[0]))).toBe("UTC+05:45");
    expect(recordingTimeCandidates(clips, 1200, recordingWallTimeMs("2026-10-22T00:05:15"))).toEqual([
      { timeSec: 345, utcOffsetMs: 345 * 60_000 },
    ]);
  });

  it("rejects missing capture metadata instead of using filename arithmetic", () => {
    expect(() => playbackTimeline([{ ...clip("2026-11-01_01-30-00"), captureTimeMs: NaN }], {})).toThrow("Missing or invalid capture time");
    expect(() => playbackTimeline([{ ...clip("2026-11-01_01-30-00"), captureTimeMs: Date.parse("1970-01-01T01:30:00Z") }], {})).toThrow("Invalid recording UTC offset");
  });

  it("does not turn writer rounding and partial-minute filenames into timezone changes", () => {
    const clips = [
      { ...clip("2026-11-01_02-12-59"), captureTimeMs: Date.parse("2026-11-01T10:12:04Z") },
      { ...clip("2026-11-01_02-13-06"), captureTimeMs: Date.parse("2026-11-01T10:13:07Z") },
    ];
    expect(clips.map(recordingOffsetMs)).toEqual([-8 * 3600_000, -8 * 3600_000]);
    expect(recordingClockAt(clips, 0).wallTimeMs).toBe(recordingWallTimeMs("2026-11-01T02:12:04"));
    expect(playbackTimeline(clips, {}).offsets).toEqual([0, 63, 123]);
    expect(() => recordingOffsetMs({ ...clips[0], timestamp: "2026-11-01_02-13-05" })).toThrow("disagree by more than one minute");
  });
});
