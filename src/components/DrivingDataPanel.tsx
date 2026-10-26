import { useMemo, type ReactNode } from "react";
import type { TelemetryData, TelemetryFrame, TelemetryValues } from "../types";
import "./DrivingDataPanel.css";

interface Props {
  frame: TelemetryFrame | null;
  data: TelemetryData | null;
  loading: boolean;
  error: string | null;
  available: boolean | null;
}

const GEAR_LABELS = ["Park", "Drive", "Reverse", "Neutral"];
const AP_LABELS = ["Off", "FSD", "Autosteer", "TACC"];
const ACCELERATION_AXES = [
  ["X", "linearAccelerationMps2X"],
  ["Y", "linearAccelerationMps2Y"],
  ["Z", "linearAccelerationMps2Z"],
] as const;

function value(frame: TelemetryFrame | null, field: keyof TelemetryValues, formatted: ReactNode) {
  if (!frame) return <span className="driving-data-unrecorded">—</span>;
  return Object.hasOwn(frame.raw, field)
    ? formatted
    : <span className="driving-data-unrecorded">Not recorded</span>;
}

function statusMessage({ frame, loading, error, available }: Props): string {
  if (error) return `Driving data could not be loaded: ${error}`;
  if (loading) return "Loading driving data…";
  if (available === false) return "No driving data in this clip.";
  if (!frame) return "No driving data at this playback position.";
  return "Showing the current recorded frame.";
}

export function DrivingDataPanel(props: Props) {
  const { frame, data, error } = props;
  const peakAcceleration = useMemo(() => {
    let peak = 0;
    if (data) {
      for (const recorded of data.frames) {
        for (const [, field] of ACCELERATION_AXES) {
          if (Object.hasOwn(recorded.raw, field)) peak = Math.max(peak, Math.abs(recorded[field]));
        }
      }
    }
    return peak;
  }, [data]);
  const fields: [keyof TelemetryValues, string, ReactNode][] = [
    ["vehicleSpeedMps", "Speed", frame && <>{(frame.vehicleSpeedMps * 2.23694).toFixed(1)} mph<br />{frame.vehicleSpeedMps.toFixed(2)} m/s</>],
    ["gearState", "Gear", frame && (GEAR_LABELS[frame.gearState] ?? `Unknown (${frame.gearState})`)],
    ["autopilotState", "Driving assistance", frame && (AP_LABELS[frame.autopilotState] ?? `Unknown (${frame.autopilotState})`)],
    ["steeringWheelAngle", "Steering angle", frame && `${frame.steeringWheelAngle.toFixed(1)}°`],
    ["acceleratorPedalPosition", "Accelerator pedal", frame && `${frame.acceleratorPedalPosition.toFixed(1)}%`],
    ["brakeApplied", "Brake flag", frame && (frame.brakeApplied ? "On" : "Off")],
    ["blinkerOnLeft", "Left indicator", frame && (frame.blinkerOnLeft ? "On" : "Off")],
    ["blinkerOnRight", "Right indicator", frame && (frame.blinkerOnRight ? "On" : "Off")],
    ["headingDeg", "Heading", frame && `${frame.headingDeg.toFixed(1)}°`],
    ["latitudeDeg", "Latitude", frame && `${frame.latitudeDeg.toFixed(6)}°`],
    ["longitudeDeg", "Longitude", frame && `${frame.longitudeDeg.toFixed(6)}°`],
    ["version", "Data version", frame && String(frame.version)],
    ["frameSeqNo", "Frame sequence", frame && String(frame.frameSeqNo)],
  ];

  return (
    <section className="driving-data-panel" aria-label="Driving data">
      <div className="driving-data-heading">
        <h2>Driving data</h2>
        <span>Current frame</span>
      </div>
      <p className="driving-data-status" role={error ? "alert" : "status"} tabIndex={error ? 0 : undefined} onKeyDown={(event) => event.stopPropagation()}>{statusMessage(props)}</p>
      <div className="driving-data-acceleration">
        <div>
          <h3>Measured acceleration</h3>
          <p>m/s² · One scale throughout this clip.</p>
        </div>
        <div className="driving-data-axes">
          {ACCELERATION_AXES.map(([axis, field]) => {
            const acceleration = frame && Object.hasOwn(frame.raw, field) ? frame[field] : 0;
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
      <details className="driving-data-json" onKeyDown={(event) => event.stopPropagation()}>
        <summary>Raw JSON</summary>
        <p>Decoded recorded fields for the current frame. Omitted fields stay omitted. Pause playback to inspect a frame.</p>
        <pre tabIndex={0} aria-label="Recorded driving data JSON">{frame ? JSON.stringify(frame.raw, null, 2) : "null"}</pre>
      </details>
    </section>
  );
}
