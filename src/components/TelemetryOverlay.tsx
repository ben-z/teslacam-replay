import type { TelemetryFrame } from "../types";
import "./TelemetryOverlay.css";

interface Props {
  frame: TelemetryFrame;
}

const GEAR_LABELS = ["P", "D", "R", "N"];
const AP_LABELS = ["", "FSD", "Autosteer", "TACC"];
const MPS_TO_MPH = 2.23694;

export function TelemetryOverlay({ frame }: Props) {
  const mph = Math.round(frame.vehicleSpeedMps * MPS_TO_MPH);
  const gear = GEAR_LABELS[frame.gearState] ?? "?";
  const ap = AP_LABELS[frame.autopilotState] ?? "";
  const steerDeg = Math.round(frame.steeringWheelAngle);

  return (
    <div className="telem-hud">
      {/* Speed + gear row */}
      <div className="telem-speed-row">
        <span className="telem-gear" data-gear={gear}>{gear}</span>
        <span className="telem-speed">{mph}</span>
        <span className="telem-unit">mph</span>
      </div>

      {/* Indicators row */}
      <div className="telem-indicators">
        {frame.blinkerOnLeft && <span className="telem-blinker telem-blinker-l" />}
        {frame.brakeApplied && <span className="telem-brake">BRK</span>}
        {ap && <span className="telem-ap">{ap}</span>}
        {frame.blinkerOnRight && <span className="telem-blinker telem-blinker-r" />}
      </div>

      {/* Steering */}
      <div className="telem-steer">
        <svg className="telem-steer-icon" viewBox="0 0 24 24" width="14" height="14">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="12" y1="12" x2="12" y2="4"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            transform={`rotate(${Math.max(-90, Math.min(90, steerDeg))}, 12, 12)`}
          />
        </svg>
        <span className="telem-steer-val">{steerDeg > 0 ? "+" : ""}{steerDeg}&deg;</span>
      </div>

      {/* GPS */}
      {(frame.latitudeDeg !== 0 || frame.longitudeDeg !== 0) && (
        <div className="telem-gps">
          {frame.latitudeDeg.toFixed(5)}, {frame.longitudeDeg.toFixed(5)}
        </div>
      )}
    </div>
  );
}
