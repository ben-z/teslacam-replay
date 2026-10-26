import type { TelemetryFrame, TelemetryValues } from "../types";
import "./DrivingDataPanel.css";

interface Props {
  frame: TelemetryFrame | null;
}

const GEAR_LABELS = ["Park", "Drive", "Reverse", "Neutral"];
const AP_LABELS = ["Off", "FSD", "Autosteer", "TACC"];
const ACCELERATION_AXES = [
  ["X", "linearAccelerationMps2X"],
  ["Y", "linearAccelerationMps2Y"],
  ["Z", "linearAccelerationMps2Z"],
] as const;

function value(frame: TelemetryFrame, field: keyof TelemetryValues, formatted: string) {
  return Object.hasOwn(frame.raw, field)
    ? formatted
    : <span className="driving-data-unrecorded">Not recorded</span>;
}

export function DrivingDataPanel({ frame }: Props) {
  const peakAcceleration = frame
    ? Math.max(...ACCELERATION_AXES.map(([, field]) => Object.hasOwn(frame.raw, field) ? Math.abs(frame[field]) : 0))
    : 0;
  const fields: [keyof TelemetryValues, string, string][] = frame ? [
    ["vehicleSpeedMps", "Speed", `${(frame.vehicleSpeedMps * 2.23694).toFixed(1)} mph · ${frame.vehicleSpeedMps.toFixed(2)} m/s`],
    ["gearState", "Gear", GEAR_LABELS[frame.gearState] ?? `Unknown (${frame.gearState})`],
    ["autopilotState", "Driving assistance", AP_LABELS[frame.autopilotState] ?? `Unknown (${frame.autopilotState})`],
    ["steeringWheelAngle", "Steering angle", `${frame.steeringWheelAngle.toFixed(1)}°`],
    ["acceleratorPedalPosition", "Accelerator pedal", `${frame.acceleratorPedalPosition.toFixed(1)}%`],
    ["brakeApplied", "Brake flag", frame.brakeApplied ? "On" : "Off"],
    ["blinkerOnLeft", "Left indicator", frame.blinkerOnLeft ? "On" : "Off"],
    ["blinkerOnRight", "Right indicator", frame.blinkerOnRight ? "On" : "Off"],
    ["headingDeg", "Heading", `${frame.headingDeg.toFixed(1)}°`],
    ["latitudeDeg", "Latitude", `${frame.latitudeDeg.toFixed(6)}°`],
    ["longitudeDeg", "Longitude", `${frame.longitudeDeg.toFixed(6)}°`],
    ["version", "Data version", String(frame.version)],
    ["frameSeqNo", "Frame sequence", String(frame.frameSeqNo)],
  ] : [];

  return (
    <section className="driving-data-panel" aria-label="Driving data">
      <div className="driving-data-heading">
        <h2>Driving data</h2>
        <span>Current frame</span>
      </div>
      {frame ? (
        <>
          <div className="driving-data-acceleration">
            <div>
              <h3>Measured acceleration</h3>
              <p>m/s² · Bars compare axes in this frame.</p>
            </div>
            <div className="driving-data-axes">
              {ACCELERATION_AXES.map(([axis, field]) => {
                const acceleration = Object.hasOwn(frame.raw, field) ? frame[field] : 0;
                const width = peakAcceleration === 0 ? 0 : Math.abs(acceleration) / peakAcceleration * 50;
                return (
                  <div className="driving-data-axis" key={axis}>
                    <span className="driving-data-axis-label">{axis}</span>
                    <span className="driving-data-axis-track" aria-hidden="true">
                      <span className="driving-data-axis-fill" data-direction={acceleration < 0 ? "negative" : "positive"} style={{ width: `${width}%`, left: acceleration < 0 ? `${50 - width}%` : "50%" }} />
                    </span>
                    <span className="driving-data-axis-value">{value(frame, field, `${acceleration > 0 ? "+" : ""}${acceleration.toFixed(2)}`)}</span>
                  </div>
                );
              })}
            </div>
          </div>
          <p className="driving-data-note">Acceleration is measured vehicle motion. Pedal position and the brake flag do not show FSD’s commanded power or braking.</p>
          <dl className="driving-data-values">
            {fields.map(([field, label, formatted]) => (
              <div key={field}>
                <dt>{label}</dt>
                <dd>{value(frame, field, formatted)}</dd>
              </div>
            ))}
          </dl>
          <p className="driving-data-note">Fields marked “Not recorded” were omitted. The recording cannot distinguish zero from an unavailable value.</p>
        </>
      ) : <p className="driving-data-note">No driving data at this playback position.</p>}
      <details className="driving-data-json" onKeyDown={(event) => event.stopPropagation()}>
        <summary>Raw JSON</summary>
        <p>Decoded recorded fields for the current frame. Omitted fields stay omitted.</p>
        {frame ? <pre tabIndex={0} aria-label="Recorded driving data JSON">{JSON.stringify(frame.raw, null, 2)}</pre> : <p>No recorded frame to display.</p>}
      </details>
    </section>
  );
}
