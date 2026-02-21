export interface EventClip {
  timestamp: string;
  cameras: string[];
  durationSec: number; // estimated from timestamp gaps, ~60s
}

export interface DashcamEvent {
  id: string;
  type: "SavedClips" | "SentryClips";
  timestamp: string;
  city?: string;
  lat?: number;
  lon?: number;
  reason?: string;
  camera?: string;
  hasThumbnail: boolean;
  clips: EventClip[];
  totalDurationSec: number;
}

export type ViewMode = "browse" | "player";

export type CameraAngle =
  | "front"
  | "back"
  | "left_repeater"
  | "right_repeater"
  | "left_pillar"
  | "right_pillar";

export const CAMERA_LABELS: Record<CameraAngle, string> = {
  front: "Front",
  back: "Rear",
  left_repeater: "Left",
  right_repeater: "Right",
  left_pillar: "Left Pillar",
  right_pillar: "Right Pillar",
};

export const ALL_CAMERAS: CameraAngle[] = [
  "front",
  "left_repeater",
  "right_repeater",
  "back",
  "left_pillar",
  "right_pillar",
];

export interface TelemetryFrame {
  vehicleSpeedMps: number;
  steeringWheelAngle: number;
  gearState: number; // 0=P, 1=D, 2=R, 3=N
  autopilotState: number; // 0=none, 1=FSD, 2=autosteer, 3=TACC
  brakeApplied: boolean;
  blinkerOnLeft: boolean;
  blinkerOnRight: boolean;
  latitudeDeg: number;
  longitudeDeg: number;
  headingDeg: number;
}

export interface TelemetryData {
  hasSei: boolean;
  frameTimesMs: number[];
  frames: TelemetryFrame[];
}

export function formatReason(reason?: string): string {
  if (!reason) return "";
  return reason
    .replace(/^user_interaction_dashcam_/, "")
    .replace(/^sentry_/, "Sentry: ")
    .replace(/_/g, " ");
}
