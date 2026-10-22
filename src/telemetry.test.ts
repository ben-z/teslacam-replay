import { describe, expect, it } from "vitest";
import { telemetryFrameAt } from "./telemetry";
import type { TelemetryFrame } from "./types";

describe("vehicle data playback boundaries", () => {
  const frames = [{ vehicleSpeedMps: 10 }, { vehicleSpeedMps: 20 }] as TelemetryFrame[];
  const data = { frames, frameTimesMs: [100, 200] };

  it("does not display a speed before or after the recorded samples", () => {
    expect(telemetryFrameAt(data, 99)).toBeNull();
    expect(telemetryFrameAt(data, 201)).toBeNull();
    expect(telemetryFrameAt(data, 100)).toBe(frames[0]);
    expect(telemetryFrameAt(data, 199)).toBe(frames[0]);
    expect(telemetryFrameAt(data, 200)).toBe(frames[1]);
  });

  it("rejects inconsistent frame timestamps", () => {
    expect(() => telemetryFrameAt({ frames, frameTimesMs: [100] }, 100)).toThrow("do not match");
  });
});
