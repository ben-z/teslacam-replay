import type { DriveEntry, DriveFileSource, DriveFolderRef, DriveList } from "./gdrive-lite.js";
import { recordingWallTimeMs } from "../src/playback.js";
import { ALL_CAMERAS, type DashcamEvent as PublicDashcamEvent, type EventClip as PublicEventClip } from "../src/types.js";

export interface EventClip extends PublicEventClip {
  sourceByCamera?: Record<string, DriveFileSource>;
}

export type EventType = PublicDashcamEvent["type"];

export interface DashcamEvent extends PublicDashcamEvent {
  thumbnailSource?: DriveFileSource;
  clips: EventClip[];
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

// Max gap between consecutive clips before splitting into separate events (seconds)
const SCAN_CONFIG = { sessionGapThresholdSec: 120, clipDurationEstimateSec: 60 } as const;

export async function scanEventFolder(
  drive: TeslacamDrive,
  type: "SavedClips" | "SentryClips",
  folder: DriveEntry
): Promise<DashcamEvent | null> {
  const files = (await drive.listFolder(drive.folderRef(folder))).files;

  // Parse event.json if present
  let eventMeta: Record<string, string> = {};
  const eventJson = files.find((file) => file.name === "event.json");
  if (eventJson) {
    try {
      const raw = await drive.readText(eventJson);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("event.json must be an object");
      for (const key of ["timestamp", "city", "est_lat", "est_lon", "reason", "camera"] as const) {
        const value = (parsed as Record<string, unknown>)[key];
        if (value !== undefined && typeof value !== "string") throw new Error(`${key} must be a string`);
      }
      eventMeta = parsed as Record<string, string>;
      if (eventMeta.timestamp) recordingWallTimeMs(eventMeta.timestamp);
      for (const [key, bound] of [["est_lat", 90], ["est_lon", 180]] as const) {
        if (eventMeta[key] !== undefined && (!eventMeta[key].trim() || !Number.isFinite(Number(eventMeta[key])) || Math.abs(Number(eventMeta[key])) > bound)) {
          throw new Error(`${key} is not a valid coordinate`);
        }
      }
    } catch (error) {
      throw new Error(`Cannot read metadata for ${type}/${folder.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  const segmentMap = groupClips(files);

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
    lat: eventMeta.est_lat ? Number(eventMeta.est_lat) : undefined,
    lon: eventMeta.est_lon ? Number(eventMeta.est_lon) : undefined,
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
  const cur = segmentTimestampToEpoch(timestamp);
  if (!nextTimestamp) return SCAN_CONFIG.clipDurationEstimateSec;
  const next = segmentTimestampToEpoch(nextTimestamp);
  if (cur > 0 && next > 0) {
    const diff = next - cur;
    if (diff >= 1) return Math.min(diff, SCAN_CONFIG.clipDurationEstimateSec);
  }
  return SCAN_CONFIG.clipDurationEstimateSec;
}

function segmentTimestampToEpoch(ts: string): number {
  // A timezone-neutral coordinate for the recorded calendar fields.
  return recordingWallTimeMs(ts) / 1000;
}

function folderNameToISO(name: string): string {
  recordingWallTimeMs(name);
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

export function scanRecentClips(
  drive: Pick<TeslacamDrive, "fileSource">,
  entries: DriveEntry[]
): DashcamEvent[] {
  const segmentMap = groupClips(entries);
  if (segmentMap.size === 0) return [];

  // Sort all segments by timestamp
  const sorted = Array.from(segmentMap.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  // Group consecutive segments into driving sessions.
  const sessions: typeof sorted[] = [];
  let current: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prevEpoch = segmentTimestampToEpoch(sorted[i - 1][0]);
    const curEpoch = segmentTimestampToEpoch(sorted[i][0]);
    if (prevEpoch > 0 && curEpoch > 0 && curEpoch - prevEpoch > SCAN_CONFIG.sessionGapThresholdSec) {
      sessions.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  sessions.push(current);

  // Convert sessions to events
  return sessions.map((session) => {
    const clips: EventClip[] = session.map(([timestamp, cameras], i) => ({
      timestamp,
      cameras: sortCameras(Array.from(cameras.keys())),
      sourceByCamera: sourceByCamera(drive, cameras),
      durationSec: estimateDuration(timestamp, session[i + 1]?.[0]),
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

function groupClips(entries: DriveEntry[]): Map<string, Map<string, DriveEntry>> {
  const segments = new Map<string, Map<string, DriveEntry>>();
  for (const file of entries) {
    const match = file.name.match(CLIP_REGEX);
    if (!match) continue;
    const [, timestamp, camera] = match;
    let cameras = segments.get(timestamp);
    if (!cameras) {
      cameras = new Map();
      segments.set(timestamp, cameras);
    }
    if (cameras.has(camera)) throw new Error(`Duplicate recording file: ${file.name}`);
    cameras.set(camera, file);
  }
  return segments;
}

function sortCameras(cameras: string[]): string[] {
  return cameras.sort((a, b) => cameraRank(a) - cameraRank(b) || a.localeCompare(b));
}

function cameraRank(camera: string): number {
  const rank = ALL_CAMERAS.findIndex((known) => known === camera);
  return rank === -1 ? ALL_CAMERAS.length : rank;
}

function sourceByCamera(
  drive: Pick<TeslacamDrive, "fileSource">,
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
