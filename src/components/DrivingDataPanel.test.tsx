import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import type { TelemetryFrame, TelemetryValues } from "../types";
import { DrivingDataPanel } from "./DrivingDataPanel";

const values: TelemetryValues = {
  version: 1,
  frameSeqNo: 932,
  vehicleSpeedMps: 10.25,
  acceleratorPedalPosition: 0,
  steeringWheelAngle: -12.5,
  gearState: 1,
  autopilotState: 1,
  brakeApplied: false,
  blinkerOnLeft: false,
  blinkerOnRight: true,
  latitudeDeg: 37.4,
  longitudeDeg: -122.1,
  headingDeg: 91.2,
  linearAccelerationMps2X: -1.5,
  linearAccelerationMps2Y: 3,
  linearAccelerationMps2Z: 0,
};

function renderPanel(frame: TelemetryFrame | null, overrides: Partial<ComponentProps<typeof DrivingDataPanel>>) {
  return renderToStaticMarkup(<DrivingDataPanel frame={frame} data={frame ? { frames: [frame], frameTimesMs: [0] } : null} loading={false} error={null} available={true} {...overrides} />);
}

describe("driving data details", () => {
  it("shows all sixteen fields and signed measured acceleration", () => {
    const frame: TelemetryFrame = { ...values, raw: values };
    const markup = renderPanel(frame, {});
    for (const label of ["Speed", "Gear", "Driving assistance", "Steering angle", "Accelerator pedal", "Brake flag", "Left indicator", "Right indicator", "Heading", "Latitude", "Longitude", "Data version", "Frame sequence", "X", "Y", "Z"]) {
      expect(markup).toContain(`>${label}<`);
    }
    expect(markup).toContain("-1.50");
    expect(markup).toContain("+3.00");
    expect(markup).toContain('data-direction="negative" style="width:25%;left:25%"');
    expect(markup).toContain('data-direction="positive" style="width:50%;left:50%"');
    expect(markup).toContain("m/s²");
    expect(markup).toContain("do not show FSD’s commanded power or braking");
    expect(markup).not.toContain('class="driving-data-unrecorded"');
  });

  it("keeps omitted pedal and brake fields distinct from explicit zero and false", () => {
    const raw = { autopilotState: 1, vehicleSpeedMps: 10.25 };
    const markup = renderPanel({ ...values, raw }, {});
    expect(markup).toContain('<dt>Accelerator pedal</dt><dd><span class="driving-data-unrecorded">Not recorded</span>');
    expect(markup).toContain('<dt>Brake flag</dt><dd><span class="driving-data-unrecorded">Not recorded</span>');
    expect(markup).toContain('&quot;autopilotState&quot;: 1');
    expect(markup).not.toContain('&quot;brakeApplied&quot;');
    expect(markup).not.toContain('&quot;acceleratorPedalPosition&quot;');
    const explicit = renderPanel({ ...values, raw: { acceleratorPedalPosition: 0, brakeApplied: false } }, {});
    expect(explicit).toContain('<dt>Accelerator pedal</dt><dd>0.0%</dd>');
    expect(explicit).toContain('<dt>Brake flag</dt><dd>Off</dd>');
    expect(explicit).toContain('&quot;acceleratorPedalPosition&quot;: 0');
    expect(explicit).toContain('&quot;brakeApplied&quot;: false');
    expect(markup).not.toContain("NaN");
  });

  it("offers a native raw JSON toggle even while no current frame is available", () => {
    const markup = renderPanel(null, {});
    expect(markup).toContain('<details class="driving-data-json"><summary>Raw JSON</summary>');
    expect(markup).toContain("No driving data at this playback position.");
    expect(markup).toContain('<pre tabindex="0" aria-label="Recorded driving data JSON">null</pre>');
    expect((markup.match(/<dt>/g) ?? []).length).toBe(13);
    expect((markup.match(/class="driving-data-axis"/g) ?? []).length).toBe(3);
    expect(markup).not.toContain("932");
  });
  it("retains all fields and the JSON viewport through each unavailable state", () => {
    for (const [state, message] of [
      [{ loading: true }, "Loading driving data…"],
      [{ available: false }, "No driving data in this clip."],
      [{ error: "HTTP 502" }, "Driving data could not be loaded: HTTP 502"],
    ] as const) {
      const markup = renderPanel(null, state);
      expect(markup).toContain(message);
      expect((markup.match(/<dt>/g) ?? []).length).toBe(13);
      expect(markup).toContain('aria-label="Recorded driving data JSON">null</pre>');
    }
    expect(renderPanel(null, { error: "HTTP 502" })).toContain('role="alert"');
  });

  it("keeps an unchanged axis at the same scale throughout the clip", () => {
    const first = { ...values, raw: values };
    const laterValues = { ...values, linearAccelerationMps2Y: 6 };
    const later = { ...laterValues, raw: laterValues };
    const data = { frames: [first, later], frameTimesMs: [0, 40] };
    const unchangedAxis = 'data-direction="negative" style="width:12.5%;left:37.5%"';
    expect(renderPanel(first, { data })).toContain(unchangedAxis);
    expect(renderPanel(later, { data })).toContain(unchangedAxis);
  });
});
