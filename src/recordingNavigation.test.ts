import { describe, expect, it } from "vitest";
import { formatPlaybackTime, recordingViewport } from "./recordingNavigation";

describe("recording navigation coordinates", () => {
  it.each([
    [0, "0:00"],
    [59.9, "0:59"],
    [60, "1:00"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [20 * 3600 + 5 * 60 + 9, "20:05:09"],
    [26 * 3600, "26:00:00"],
  ])("formats %s seconds for both short and multi-day recordings", (seconds, expected) => {
    expect(formatPlaybackTime(seconds)).toBe(expected);
  });

  it("shows a useful local window at either end of a 21-hour recording", () => {
    const total = 21 * 3600;
    expect(recordingViewport(total, 900, 0)).toEqual({ start: 0, end: 900, duration: 900 });
    expect(recordingViewport(total, 900, total)).toEqual({ start: total - 900, end: total, duration: 900 });
    expect(recordingViewport(total, 900, 12 * 3600)).toEqual({ start: 12 * 3600 - 450, end: 12 * 3600 + 450, duration: 900 });
  });

  it("clamps a window that exceeds the recording and centers outside its bounds", () => {
    expect(recordingViewport(120, 900, 60)).toEqual({ start: 0, end: 120, duration: 120 });
    expect(recordingViewport(3600, 60, -100)).toEqual({ start: 0, end: 60, duration: 60 });
    expect(recordingViewport(3600, 60, 5000)).toEqual({ start: 3540, end: 3600, duration: 60 });
  });

});
