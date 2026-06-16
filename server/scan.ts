import type { DriveEntry, DriveFileSource, DriveFolderRef, DriveList } from "./gdrive-lite.js";

export interface EventClip {
  timestamp: string; // e.g. "2025-06-01_18-07-09"
  cameras: string[]; // available camera angles
  durationSec: number; // estimated from timestamp gaps, ~60s
  subfolder?: string; // for RecentClips: date subfolder if files are in one (e.g. "2025-12-19")
  sourceByCamera?: Record<string, DriveFileSource>;
}

export type EventType = "SavedClips" | "SentryClips" | "RecentClips";

export interface DashcamEvent {
  id: string; // folder name (trigger timestamp) or first clip timestamp for RecentClips
  type: EventType;
  timestamp: string; // from event.json or folder name
  city?: string;
  lat?: number;
  lon?: number;
  reason?: string;
  camera?: string;
  hasThumbnail: boolean;
  thumbnailSource?: DriveFileSource;
  clips: EventClip[];
  totalDurationSec: number; // estimated from number of segments
  cameraCount: number;
}

export interface TeslacamDrive {
  listFolder(folder: DriveFolderRef): Promise<DriveList>;
  readText(file: DriveEntry): Promise<string>;
  fileSource(file: DriveEntry): DriveFileSource;
  folderRef(file: DriveEntry): DriveFolderRef;
  isFolder(file: DriveEntry): boolean;
}

const CLIP_REGEX = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)\.mp4$/;
const CAMERA_ORDER = ["front", "left_repeater", "right_repeater", "back", "left_pillar", "right_pillar"];

// Date-only folder pattern for RecentClips subfolders: "YYYY-MM-DD"
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Max gap between consecutive clips before splitting into separate events (seconds)
const SESSION_GAP_THRESHOLD = 120;

export async function scanEventFolder(
  drive: TeslacamDrive,
  type: "SavedClips" | "SentryClips",
  folder: DriveEntry
): Promise<DashcamEvent | null> {
  let files: DriveEntry[];
  try {
    files = (await drive.listFolder(drive.folderRef(folder))).files;
  } catch {
    return null;
  }

  // Parse event.json if present
  let eventMeta: Record<string, string> = {};
  const eventJson = files.find((file) => file.name === "event.json");
  if (eventJson) {
    try {
      const raw = await drive.readText(eventJson);
      eventMeta = JSON.parse(raw);
    } catch {
      // ignore malformed event.json
    }
  }

  // Group MP4 files by timestamp segment
  const segmentMap = new Map<string, Map<string, DriveEntry>>();
  for (const file of files) {
    const match = file.name.match(CLIP_REGEX);
    if (!match) continue;
    const [, timestamp, camera] = match;
    if (!segmentMap.has(timestamp)) {
      segmentMap.set(timestamp, new Map());
    }
    segmentMap.get(timestamp)!.set(camera, file);
  }

  const thumbnail = files.find((file) => file.name === "thumb.png");

  if (segmentMap.size === 0 && !eventJson && !thumbnail) return null;

  // Build clips array sorted by timestamp, with estimated durations
  const sorted = Array.from(segmentMap.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  const clips: EventClip[] = sorted.map(([timestamp, cameraFiles], i) => ({
    timestamp,
    cameras: sortCameras(Array.from(cameraFiles.keys())),
    sourceByCamera: sourceByCamera(drive, cameraFiles),
    durationSec: estimateDuration(timestamp, sorted[i + 1]?.[0]),
  }));

  return {
    id: folder.name,
    type,
    timestamp: eventMeta.timestamp || folderNameToISO(folder.name),
    city: eventMeta.city || undefined,
    lat: eventMeta.est_lat ? parseFloat(eventMeta.est_lat) : undefined,
    lon: eventMeta.est_lon ? parseFloat(eventMeta.est_lon) : undefined,
    reason: eventMeta.reason || undefined,
    camera: eventMeta.camera || undefined,
    hasThumbnail: Boolean(thumbnail),
    thumbnailSource: thumbnail ? drive.fileSource(thumbnail) : undefined,
    clips,
    totalDurationSec: clips.reduce((sum, c) => sum + c.durationSec, 0),
    cameraCount: countUniqueCameras(clips),
  };
}

function estimateDuration(timestamp: string, nextTimestamp?: string): number {
  if (!nextTimestamp) return 60;
  const cur = segmentTimestampToEpoch(timestamp);
  const next = segmentTimestampToEpoch(nextTimestamp);
  if (cur > 0 && next > 0) {
    const diff = next - cur;
    if (diff >= 1 && diff <= 120) return diff;
  }
  return 60;
}

function segmentTimestampToEpoch(ts: string): number {
  // "2025-06-01_18-07-09" -> epoch seconds
  const iso = folderNameToISO(ts);
  const d = new Date(iso);
  return isNaN(d.getTime()) ? 0 : d.getTime() / 1000;
}

function folderNameToISO(name: string): string {
  // "2025-06-01_18-17-49" -> "2025-06-01T18:17:49"
  const match = name.match(
    /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/
  );
  if (!match) return name;
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
}

function countUniqueCameras(clips: EventClip[]): number {
  const cameras = new Set<string>();
  for (const clip of clips) {
    for (const camera of clip.cameras) cameras.add(camera);
  }
  return cameras.size;
}

export async function scanRecentClipsPage(
  drive: TeslacamDrive,
  entries: DriveEntry[]
): Promise<DashcamEvent[]> {
  const segmentMap = new Map<string, { cameras: Map<string, DriveEntry>; subfolder?: string }>();

  for (const file of entries) {
    const match = file.name.match(CLIP_REGEX);
    if (!match) continue;
    const [, timestamp, camera] = match;
    addSegment(segmentMap, timestamp, camera, file);
  }

  const dateFolders = entries.filter((f) =>
    drive.isFolder(f) && DATE_FOLDER_PATTERN.test(f.name)
  );
  for (const folder of dateFolders) {
    let files: DriveEntry[];
    try {
      files = (await drive.listFolder(drive.folderRef(folder))).files;
    } catch {
      continue;
    }
    for (const file of files) {
      const match = file.name.match(CLIP_REGEX);
      if (!match) continue;
      const [, timestamp, camera] = match;
      addSegment(segmentMap, timestamp, camera, file, folder.name);
    }
  }

  if (segmentMap.size === 0) return [];

  return recentEventsFromSegmentMap(drive, segmentMap);
}

function recentEventsFromSegmentMap(
  drive: TeslacamDrive,
  segmentMap: Map<string, { cameras: Map<string, DriveEntry>; subfolder?: string }>
): DashcamEvent[] {
  // Sort all segments by timestamp
  const sorted = Array.from(segmentMap.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  // Group into driving sessions (split on gaps > SESSION_GAP_THRESHOLD)
  const sessions: typeof sorted[] = [];
  let current: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevEpoch = segmentTimestampToEpoch(sorted[i - 1][0]);
    const curEpoch = segmentTimestampToEpoch(sorted[i][0]);
    if (prevEpoch > 0 && curEpoch > 0 && curEpoch - prevEpoch > SESSION_GAP_THRESHOLD) {
      sessions.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  sessions.push(current);

  // Convert sessions to events
  return sessions.map((session) => {
    const clips: EventClip[] = session.map(([timestamp, { cameras, subfolder }], i) => ({
      timestamp,
      cameras: sortCameras(Array.from(cameras.keys())),
      sourceByCamera: sourceByCamera(drive, cameras),
      durationSec: estimateDuration(timestamp, session[i + 1]?.[0]),
      subfolder,
    }));

    const firstTimestamp = session[0][0];
    return {
      id: firstTimestamp,
      type: "RecentClips" as const,
      timestamp: folderNameToISO(firstTimestamp),
      hasThumbnail: false,
      clips,
      totalDurationSec: clips.reduce((sum, c) => sum + c.durationSec, 0),
      cameraCount: countUniqueCameras(clips),
    };
  });
}

function addSegment(
  segmentMap: Map<string, { cameras: Map<string, DriveEntry>; subfolder?: string }>,
  timestamp: string,
  camera: string,
  file: DriveEntry,
  subfolder?: string
): void {
  if (!segmentMap.has(timestamp)) {
    segmentMap.set(timestamp, { cameras: new Map(), subfolder });
  }
  const segment = segmentMap.get(timestamp)!;
  segment.cameras.set(camera, file);
  if (subfolder) segment.subfolder = subfolder;
}

function sortCameras(cameras: string[]): string[] {
  return cameras.sort((a, b) => cameraRank(a) - cameraRank(b) || a.localeCompare(b));
}

function cameraRank(camera: string): number {
  const rank = CAMERA_ORDER.indexOf(camera);
  return rank === -1 ? CAMERA_ORDER.length : rank;
}

function sourceByCamera(
  drive: TeslacamDrive,
  cameraFiles: Map<string, DriveEntry>
): Record<string, DriveFileSource> {
  return Object.fromEntries(
    Array.from(cameraFiles.entries()).map(([camera, file]) => [camera, drive.fileSource(file)])
  );
}

export function getClipSource(
  event: DashcamEvent,
  segment: string,
  camera: string
): DriveFileSource | null {
  const clip = event.clips.find((cl) => cl.timestamp === segment);
  return clip?.sourceByCamera?.[camera] ?? null;
}
