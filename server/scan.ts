import type { DriveEntry, DriveFileSource, DriveFolderRef, DriveList, DriveThumbnailSource } from "./gdrive-lite.js";
import { CAPTURE_CONFIG } from "./gdrive-lite.js";
import { mapLimit } from "./map-limit.js";
import { recordingOffsetMs, recordingWallTimeMs } from "../src/playback.js";
import { ALL_CAMERAS, type DashcamEvent as PublicDashcamEvent, type EventClip as PublicEventClip } from "../src/types.js";

export interface EventClip extends PublicEventClip {
  sourceByCamera?: Record<string, DriveFileSource>;
  thumbnailSource?: DriveThumbnailSource;
}

export type EventType = PublicDashcamEvent["type"];

export interface DashcamEvent extends Omit<PublicDashcamEvent, "hasThumbnail" | "thumbnailVersion"> {
  thumbnailSource?: DriveThumbnailSource;
  clips: EventClip[];
  cameraCount: number;
}

export interface TeslacamDrive {
  listFolder(folder: DriveFolderRef): Promise<DriveList>;
  readText(file: DriveEntry): Promise<string>;
  captureTime(file: DriveEntry): Promise<number>;
  fileSource(file: DriveEntry): DriveFileSource;
  thumbnailSource(file: DriveEntry): DriveThumbnailSource | undefined;
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

  const clips = await readSegments(drive, segmentMap);

  return {
    id: folder.name,
    type,
    timestamp: eventMeta.timestamp || folderNameToISO(folder.name),
    city: eventMeta.city || undefined,
    lat: eventMeta.est_lat ? Number(eventMeta.est_lat) : undefined,
    lon: eventMeta.est_lon ? Number(eventMeta.est_lon) : undefined,
    reason: eventMeta.reason || undefined,
    camera: eventMeta.camera || undefined,
    thumbnailSource: thumbnail ? drive.fileSource(thumbnail) : undefined,
    clips,
    totalDurationSec: clips.reduce((sum, c) => sum + c.durationSec, 0),
    cameraCount: countUniqueCameras(clips),
  };
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

export async function scanRecentClips(
  drive: Pick<TeslacamDrive, "fileSource" | "thumbnailSource" | "captureTime">,
  entries: DriveEntry[]
): Promise<DashcamEvent[]> {
  const segmentMap = groupClips(entries);
  if (segmentMap.size === 0) return [];

  const sorted = await readSegments(drive, segmentMap);

  // Group consecutive segments into driving sessions.
  const sessions: typeof sorted[] = [];
  let current: typeof sorted = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i].captureTimeMs - sorted[i - 1].captureTimeMs) / 1000 > SCAN_CONFIG.sessionGapThresholdSec) {
      sessions.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  sessions.push(current);

  // Convert sessions to events
  return sessions.map((session) => {
    const clips = session;
    const firstTimestamp = session[0].timestamp;
    return {
      id: firstTimestamp,
      type: "RecentClips" as const,
      timestamp: folderNameToISO(firstTimestamp),
      clips,
      totalDurationSec: clips.reduce((sum, c) => sum + c.durationSec, 0),
      cameraCount: countUniqueCameras(clips),
    };
  });
}

async function readSegments(
  drive: Pick<TeslacamDrive, "fileSource" | "thumbnailSource" | "captureTime">,
  segments: Map<string, Map<string, DriveEntry>>,
): Promise<EventClip[]> {
  const entries = [...segments.entries()];
  // One camera's movie header establishes the capture clock for its segment.
  // Bounded workers stop scheduling this scan after a header fails. The Drive
  // client also limits concurrent header reads across recording pages.
  const clips = await mapLimit(entries, CAPTURE_CONFIG.concurrency, async ([timestamp, cameraFiles]): Promise<EventClip> => {
    recordingWallTimeMs(timestamp);
    const cameras = sortCameras([...cameraFiles.keys()]);
    const captureTimeMs = await drive.captureTime(cameraFiles.get(cameras[0])!);
    if (!Number.isSafeInteger(captureTimeMs)) throw new Error(`Invalid capture time: ${timestamp}`);
    const clip: EventClip = {
      timestamp, captureTimeMs, cameras,
      sourceByCamera: sourceByCamera(drive, cameraFiles),
      thumbnailSource: cameraFiles.has("front") ? drive.thumbnailSource(cameraFiles.get("front")!) : undefined,
      durationSec: SCAN_CONFIG.clipDurationEstimateSec,
    };
    recordingOffsetMs(clip);
    return clip;
  });
  clips.sort((a, b) => a.captureTimeMs - b.captureTimeMs);
  for (let index = 0; index < clips.length - 1; index++) {
    const gap = (clips[index + 1].captureTimeMs - clips[index].captureTimeMs) / 1000;
    if (gap <= 0) throw new Error(`Recording segments have the same capture time: ${clips[index].timestamp} and ${clips[index + 1].timestamp}`);
    clips[index].durationSec = Math.min(gap, SCAN_CONFIG.clipDurationEstimateSec);
  }
  return clips;
}

export function getEventThumbnail(event: DashcamEvent): DriveThumbnailSource | undefined {
  if (event.type !== "RecentClips") return event.thumbnailSource;
  return event.clips.find((clip) => clip.thumbnailSource)?.thumbnailSource;
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
