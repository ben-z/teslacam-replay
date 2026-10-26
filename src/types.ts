export const HLS_CACHE_VERSION = "2";

export interface EventClip {
  timestamp: string;
  cameras: string[];
  durationSec: number; // estimated from timestamp gaps, ~60s
}

export interface DashcamEvent {
  id: string;
  type: "SavedClips" | "SentryClips" | "RecentClips";
  timestamp: string;
  city?: string;
  lat?: number;
  lon?: number;
  reason?: string;
  camera?: string;
  hasThumbnail: boolean;
  thumbnailVersion?: string;
  clips: EventClip[];
  totalDurationSec: number;
  cameraCount?: number;
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

export interface TelemetryValues {
  version: number;
  frameSeqNo: number;
  vehicleSpeedMps: number;
  acceleratorPedalPosition: number; // percent as recorded
  steeringWheelAngle: number;
  gearState: number; // 0=P, 1=D, 2=R, 3=N
  autopilotState: number; // 0=none, 1=FSD, 2=autosteer, 3=TACC
  brakeApplied: boolean;
  blinkerOnLeft: boolean;
  blinkerOnRight: boolean;
  latitudeDeg: number;
  longitudeDeg: number;
  headingDeg: number;
  linearAccelerationMps2X: number;
  linearAccelerationMps2Y: number;
  linearAccelerationMps2Z: number;
}

export interface TelemetryFrame extends TelemetryValues {
  // Only fields encoded in the protobuf message; omitted fields remain absent.
  raw: Partial<TelemetryValues>;
}

export interface TelemetryData {
  frameTimesMs: number[];
  frames: TelemetryFrame[];
}

export function formatReason(reason?: string): string {
  if (!reason) return "";
  if (["user_interaction_dashcam_launcher_action_tapped", "user_interaction_dashcam_icon_tapped"].includes(reason)) return "Saved manually";
  if (reason === "user_interaction_dashcam_honk") return "Saved by honk";
  if (reason === "sentry_aware_object_detection") return "Object detected";
  return reason
    .replace(/^user_interaction_dashcam_/, "")
    .replace(/^sentry_/, "Sentry: ")
    .replace(/_/g, " ");
}
