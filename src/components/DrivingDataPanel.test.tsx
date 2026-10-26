import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

describe("driving data details", () => {
  it("shows all sixteen fields and signed measured acceleration", () => {
    const frame: TelemetryFrame = { ...values, raw: values };
    const markup = renderToStaticMarkup(<DrivingDataPanel frame={frame} />);
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
    const markup = renderToStaticMarkup(<DrivingDataPanel frame={{ ...values, raw }} />);
    expect(markup).toContain('<dt>Accelerator pedal</dt><dd><span class="driving-data-unrecorded">Not recorded</span>');
    expect(markup).toContain('<dt>Brake flag</dt><dd><span class="driving-data-unrecorded">Not recorded</span>');
    expect(markup).toContain('&quot;autopilotState&quot;: 1');
    expect(markup).not.toContain('&quot;brakeApplied&quot;');
    expect(markup).not.toContain('&quot;acceleratorPedalPosition&quot;');
    const explicit = renderToStaticMarkup(<DrivingDataPanel frame={{ ...values, raw: { acceleratorPedalPosition: 0, brakeApplied: false } }} />);
    expect(explicit).toContain('<dt>Accelerator pedal</dt><dd>0.0%</dd>');
    expect(explicit).toContain('<dt>Brake flag</dt><dd>Off</dd>');
    expect(explicit).toContain('&quot;acceleratorPedalPosition&quot;: 0');
    expect(explicit).toContain('&quot;brakeApplied&quot;: false');
    expect(markup).not.toContain("NaN");
  });

  it("offers a native raw JSON toggle even while no current frame is available", () => {
    const markup = renderToStaticMarkup(<DrivingDataPanel frame={null} />);
    expect(markup).toContain('<details class="driving-data-json"><summary>Raw JSON</summary>');
    expect(markup).toContain("No driving data at this playback position.");
    expect(markup).toContain("No recorded frame to display.");
    expect(markup).not.toContain("<pre");
  });
});
