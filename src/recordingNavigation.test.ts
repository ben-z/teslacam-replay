import { describe, expect, it, vi } from "vitest";
import { formatPlaybackTime, recordingTimeOffset, recordingViewport } from "./recordingNavigation";

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

  it("uses the selected recorded date across midnight", () => {
    expect(recordingTimeOffset("2026-10-22T00:05:15", "2026-10-21_23-59-30", 1200)).toBe(345);
    expect(recordingTimeOffset("2026-10-22T20:00:00", "2026-10-21_23-59-30", 21 * 3600)).toBe(20 * 3600 + 30);
  });

  it("accepts both exact recording boundaries and rejects times outside them", () => {
    const base = "2026-10-21_10-00-00";
    expect(recordingTimeOffset("2026-10-21T10:00:00", base, 900)).toBe(0);
    expect(recordingTimeOffset("2026-10-21T10:15:00", base, 900)).toBe(900);
    expect(() => recordingTimeOffset("2026-10-21T09:59:59", base, 900)).toThrow("within this recording");
    expect(() => recordingTimeOffset("2026-10-21T10:15:01", base, 900)).toThrow("within this recording");
    expect(() => recordingTimeOffset("2026-02-30T10:00:00", base, 900)).toThrow("Invalid recording timestamp");
  });

  it("retains filename wall-clock coordinates across daylight-saving changes and browser timezones", () => {
    for (const timezone of ["America/Los_Angeles", "UTC", "Pacific/Auckland"]) {
      vi.stubEnv("TZ", timezone);
      try {
        expect(recordingTimeOffset("2026-11-01T03:00:00", "2026-11-01_00-00-00", 20 * 3600)).toBe(3 * 3600);
        expect(recordingTimeOffset("2026-03-08T03:00:00", "2026-03-08_00-00-00", 20 * 3600)).toBe(3 * 3600);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });
});
