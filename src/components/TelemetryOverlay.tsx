import type { TelemetryFrame } from "../types";
import "./TelemetryOverlay.css";

interface Props {
  frame: TelemetryFrame;
}

const GEAR_LABELS = ["P", "D", "R", "N"];
const AP_LABELS = ["", "FSD", "Autosteer", "TACC"];
const MPS_TO_MPH = 2.23694;
const MAX_STEER_DISPLAY = 90;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function TelemetryOverlay({ frame }: Props) {
  const mph = Math.round(frame.vehicleSpeedMps * MPS_TO_MPH);
  const gear = Object.hasOwn(frame.raw, "gearState") ? GEAR_LABELS[frame.gearState] ?? "?" : "?";
  const ap = AP_LABELS[frame.autopilotState] ?? "";
  const steerDeg = Math.round(frame.steeringWheelAngle);
  const throttlePct = Math.round(frame.acceleratorPedalPosition);
  const hasPedal = Object.hasOwn(frame.raw, "acceleratorPedalPosition");
  const hasBrake = Object.hasOwn(frame.raw, "brakeApplied");
  const hasSteering = Object.hasOwn(frame.raw, "steeringWheelAngle");
  const hasGps = Object.hasOwn(frame.raw, "latitudeDeg") && Object.hasOwn(frame.raw, "longitudeDeg");
  let brakeLabel = "—";
  if (hasBrake) brakeLabel = frame.brakeApplied ? "On" : "Off";

  return (
    <div className="telem-hud">
      <div className="telem-speed-row">
        <span className="telem-gear" data-gear={gear}>{gear}</span>
        <span className="telem-speed">{Object.hasOwn(frame.raw, "vehicleSpeedMps") ? mph : "—"}</span>
        <span className="telem-unit">mph</span>
      </div>

      <div className="telem-indicators">
        {frame.blinkerOnLeft && <span className="telem-blinker telem-blinker-l" />}
        {ap && <span className="telem-ap">{ap}</span>}
        {frame.blinkerOnRight && <span className="telem-blinker telem-blinker-r" />}
      </div>

      <div className="telem-pedals">
        <div className="telem-pedal">
          <span className="telem-pedal-label">Pedal</span>
          <div className="telem-pedal-track">
            <div
              className="telem-pedal-fill telem-pedal-thr"
              style={{ width: `${hasPedal ? throttlePct : 0}%` }}
            />
          </div>
          <span className="telem-pedal-val" title={hasPedal ? "Accelerator pedal position" : "Not recorded"}>{hasPedal ? `${throttlePct}%` : "—"}</span>
        </div>
        <div className="telem-pedal">
          <span className="telem-pedal-label">Brake</span>
          <div className="telem-pedal-track">
            <div
              className={`telem-pedal-fill telem-pedal-brk${hasBrake && frame.brakeApplied ? " active" : ""}`}
              style={{ width: hasBrake && frame.brakeApplied ? "100%" : "0%" }}
            />
          </div>
          <span className="telem-pedal-val" title={hasBrake ? "Recorded brake flag" : "Not recorded"}>{brakeLabel}</span>
        </div>
      </div>

      <div className="telem-steer">
        <svg className="telem-steer-icon" viewBox="0 0 24 24" width="14" height="14">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <line
            x1="12" y1="12" x2="12" y2="4"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            transform={`rotate(${clamp(steerDeg, -MAX_STEER_DISPLAY, MAX_STEER_DISPLAY)}, 12, 12)`}
          />
        </svg>
        <span className="telem-steer-val">{hasSteering ? `${steerDeg > 0 ? "+" : ""}${steerDeg}°` : "—"}</span>
      </div>

      {hasGps && (
        <div className="telem-gps">
          {frame.latitudeDeg.toFixed(5)}, {frame.longitudeDeg.toFixed(5)}
        </div>
      )}
    </div>
  );
}
