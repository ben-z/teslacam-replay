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

export function formatReason(reason?: string): string {
  if (!reason) return "";
  return reason
    .replace(/^user_interaction_dashcam_/, "")
    .replace(/^sentry_/, "Sentry: ")
    .replace(/_/g, " ");
}
