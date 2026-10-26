import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TelemetryFrame } from "../types";
import { TelemetryOverlay } from "./TelemetryOverlay";

describe("accelerator percentage display", () => {
  it.each<[number, string]>([
    [0, "0%"],
    [0.4, "0%"],
    [0.5, "1%"],
    [17.600000381469727, "18%"],
    [100, "100%"],
  ])("renders recorded %s as %s in the label and bar", (recorded, displayed) => {
    const frame: TelemetryFrame = {
      version: 1,
      frameSeqNo: 1,
      vehicleSpeedMps: 0,
      acceleratorPedalPosition: recorded,
      steeringWheelAngle: 0,
      gearState: 0,
      autopilotState: 0,
      brakeApplied: false,
      blinkerOnLeft: false,
      blinkerOnRight: false,
      latitudeDeg: 0,
      longitudeDeg: 0,
      headingDeg: 0,
      linearAccelerationMps2X: 0,
      linearAccelerationMps2Y: 0,
      linearAccelerationMps2Z: 0,
      raw: { acceleratorPedalPosition: recorded },
    };
    const markup = renderToStaticMarkup(<TelemetryOverlay frame={frame} />);
    expect(markup).toContain(`title="Accelerator pedal position">${displayed}</span>`);
    expect(markup).toContain(`class="telem-pedal-fill telem-pedal-thr" style="width:${displayed}"`);
  });
});
