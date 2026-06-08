import path from "path";
import type { StorageBackend } from "./storage.js";

export interface EventClip {
  timestamp: string; // e.g. "2025-06-01_18-07-09"
  cameras: string[]; // available camera angles
  durationSec: number; // estimated from timestamp gaps, ~60s
  subfolder?: string; // for RecentClips: date subfolder if files are in one (e.g. "2025-12-19")
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
  clips: EventClip[];
  totalDurationSec: number; // estimated from number of segments
  cameraCount: number;
}

const CLIP_REGEX = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)\.mp4$/;
const CAMERA_ORDER = ["front", "left_repeater", "right_repeater", "back", "left_pillar", "right_pillar"];

// Folder names match this pattern: "YYYY-MM-DD_HH-MM-SS"
const FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

// Date-only folder pattern for RecentClips subfolders: "YYYY-MM-DD"
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Max gap between consecutive clips before splitting into separate events (seconds)
const SESSION_GAP_THRESHOLD = 120;

// Re-scan the newest known event folders on incremental refresh. Sync/upload
// tools can expose an event folder before all camera files have arrived, so
// treating the latest folder as immutable can permanently cache partial events.
const INCREMENTAL_RESCAN_EVENT_COUNT = 3;

export async function scanTeslacamFolder(
  storage: StorageBackend,
  existingEvents?: DashcamEvent[]
): Promise<DashcamEvent[]> {
  // Compute cutoffs for incremental scanning (only scan folders newer than latest known)
  const cutoffs = new Map<string, string>();
  const mutableKnownFolders = new Map<string, Set<string>>();
  if (existingEvents) {
    for (const type of ["SavedClips", "SentryClips"] as const) {
      const known = existingEvents
        .filter(e => e.type === type)
        .map(e => e.id)
        .sort((a, b) => b.localeCompare(a));
      const latest = known[0];
      if (latest) {
        cutoffs.set(type, latest);
        mutableKnownFolders.set(
          type,
          new Set(known.slice(0, INCREMENTAL_RESCAN_EVENT_COUNT))
        );
      }
    }
  }

  const events: DashcamEvent[] = [];

  for (const type of ["SavedClips", "SentryClips"] as const) {
    let entries: string[];
    try {
      entries = await storage.readdir(type);
    } catch {
      continue;
    }

    // Filter to only timestamp-patterned folders (skip .DS_Store, etc.)
    let folders = entries.filter((f) => FOLDER_PATTERN.test(f));

    // Incremental: only scan folders newer than latest existing event
    const cutoff = cutoffs.get(type);
    if (cutoff) {
      const mutable = mutableKnownFolders.get(type);
      folders = folders.filter(f => f > cutoff || Boolean(mutable?.has(f)));
    }

    // Process in parallel batches
    const batchSize = 50;
    for (let i = 0; i < folders.length; i += batchSize) {
      const batch = folders.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((folder) => scanEventFolder(storage, type, folder))
      );
      for (const event of results) {
        if (event) events.push(event);
      }
    }
  }

  const recentEvents = await scanRecentClips(storage, existingEvents);
  events.push(...recentEvents);

  // Merge with existing events when doing incremental scan
  if (existingEvents) {
    const newIds = new Set(events.map(e => `${e.type}:${e.id}`));
    for (const existing of existingEvents) {
      if (!newIds.has(`${existing.type}:${existing.id}`)) {
        events.push(existing);
      }
    }
  }

  events.sort((a, b) => b.id.localeCompare(a.id));
  return events;
}

async function scanEventFolder(
  storage: StorageBackend,
  type: "SavedClips" | "SentryClips",
  folder: string
): Promise<DashcamEvent | null> {
  const folderPath = `${type}/${folder}`;

  let files: string[];
  try {
    files = await storage.readdir(folderPath);
  } catch {
    return null;
  }

  // Parse event.json if present
  let eventMeta: Record<string, string> = {};
  if (files.includes("event.json")) {
    try {
      const raw = await storage.readFileUtf8(`${folderPath}/event.json`);
      eventMeta = JSON.parse(raw);
    } catch {
      // ignore malformed event.json
    }
  }

  // Group MP4 files by timestamp segment
  const segmentMap = new Map<string, Set<string>>();
  for (const file of files) {
    const match = file.match(CLIP_REGEX);
    if (!match) continue;
    const [, timestamp, camera] = match;
    if (!segmentMap.has(timestamp)) {
      segmentMap.set(timestamp, new Set());
    }
    segmentMap.get(timestamp)!.add(camera);
  }

  if (segmentMap.size === 0) return null;

  // Build clips array sorted by timestamp, with estimated durations
  const sorted = Array.from(segmentMap.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  const clips: EventClip[] = sorted.map(([timestamp, cameras], i) => ({
    timestamp,
    cameras: Array.from(cameras).sort((a, b) =>
      CAMERA_ORDER.indexOf(a) - CAMERA_ORDER.indexOf(b)
    ),
    durationSec: estimateDuration(timestamp, sorted[i + 1]?.[0]),
  }));

  const hasThumbnail = files.includes("thumb.png");

  // Parse timestamp from folder name: "2025-06-01_18-17-49" -> ISO
  const isoTimestamp =
    eventMeta.timestamp || folderNameToISO(folder);

  return {
    id: folder,
    type,
    timestamp: isoTimestamp,
    city: eventMeta.city || undefined,
    lat: eventMeta.est_lat ? parseFloat(eventMeta.est_lat) : undefined,
    lon: eventMeta.est_lon ? parseFloat(eventMeta.est_lon) : undefined,
    reason: eventMeta.reason || undefined,
    camera: eventMeta.camera || undefined,
    hasThumbnail,
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

function recentIncrementalCutoff(existingEvents?: DashcamEvent[]): string | null {
  if (!existingEvents) return null;

  let newestEvent: DashcamEvent | null = null;
  let newestClipTimestamp = "";
  for (const event of existingEvents) {
    if (event.type !== "RecentClips" || event.clips.length === 0) continue;
    const eventNewestClip = event.clips.reduce(
      (max, clip) => clip.timestamp > max ? clip.timestamp : max,
      ""
    );
    if (eventNewestClip > newestClipTimestamp) {
      newestClipTimestamp = eventNewestClip;
      newestEvent = event;
    }
  }

  // Re-scan the newest known driving session from its first segment. This lets
  // a still-growing session merge with newly arrived segments without walking
  // every older RecentClips date folder on each refresh.
  return newestEvent?.clips[0]?.timestamp ?? null;
}

/**
 * Scan RecentClips: flat MP4 files + date subfolders, grouped into driving sessions.
 *
 * On incremental refresh, only segments at or after the newest known session's
 * first timestamp are scanned. Older sessions are merged from existingEvents by
 * scanTeslacamFolder, which avoids re-listing every historical date folder.
 */
async function scanRecentClips(
  storage: StorageBackend,
  existingEvents?: DashcamEvent[]
): Promise<DashcamEvent[]> {
  let entries: string[];
  try {
    entries = await storage.readdir("RecentClips");
  } catch {
    return [];
  }

  const cutoff = recentIncrementalCutoff(existingEvents);
  const cutoffDate = cutoff?.slice(0, 10) ?? null;

  // Collect all clip files: { timestamp, camera, subfolder? }
  const segmentMap = new Map<string, { cameras: Set<string>; subfolder?: string }>();

  // Parse flat MP4 files
  for (const file of entries) {
    const match = file.match(CLIP_REGEX);
    if (!match) continue;
    const [, timestamp, camera] = match;
    if (cutoff && timestamp < cutoff) continue;
    if (!segmentMap.has(timestamp)) {
      segmentMap.set(timestamp, { cameras: new Set() });
    }
    segmentMap.get(timestamp)!.cameras.add(camera);
  }

  // Parse date subfolders
  const dateFolders = entries.filter((f) =>
    DATE_FOLDER_PATTERN.test(f) && (!cutoffDate || f >= cutoffDate)
  );
  for (const folder of dateFolders) {
    let files: string[];
    try {
      files = await storage.readdir(`RecentClips/${folder}`);
    } catch {
      continue;
    }
    for (const file of files) {
      const match = file.match(CLIP_REGEX);
      if (!match) continue;
      const [, timestamp, camera] = match;
      if (cutoff && timestamp < cutoff) continue;
      if (!segmentMap.has(timestamp)) {
        segmentMap.set(timestamp, { cameras: new Set(), subfolder: folder });
      }
      segmentMap.get(timestamp)!.cameras.add(camera);
    }
  }

  if (segmentMap.size === 0) return [];

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
      cameras: Array.from(cameras).sort((a, b) =>
        CAMERA_ORDER.indexOf(a) - CAMERA_ORDER.indexOf(b)
      ),
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

export function getVideoPath(
  type: string,
  eventId: string,
  segment: string,
  camera: string,
  subfolder?: string
): string {
  if (type === "RecentClips") {
    // RecentClips: files are either in a date subfolder or flat in RecentClips/
    if (subfolder) {
      return `${type}/${subfolder}/${segment}-${camera}.mp4`;
    }
    return `${type}/${segment}-${camera}.mp4`;
  }
  return `${type}/${eventId}/${segment}-${camera}.mp4`;
}

export function getThumbnailPath(
  type: string,
  eventId: string
): string {
  return `${type}/${eventId}/thumb.png`;
}

/**
 * Get the directory path for an event (SavedClips/SentryClips only).
 * Returns null for RecentClips since those don't have a single directory.
 */
export function getEventDirPath(type: string, eventId: string): string | null {
  if (type === "RecentClips") return null;
  return `${type}/${eventId}`;
}

/**
 * Get all original file paths for an event's clips.
 * Returns { storagePath, archiveName } tuples for zip creation.
 */
export function getEventFilePaths(event: DashcamEvent): { storagePath: string; archiveName: string }[] {
  const files: { storagePath: string; archiveName: string }[] = [];

  for (const clip of event.clips) {
    for (const camera of clip.cameras) {
      const storagePath = getVideoPath(event.type, event.id, clip.timestamp, camera, clip.subfolder);
      const archiveName = `${clip.timestamp}-${camera}.mp4`;
      files.push({ storagePath, archiveName });
    }
  }

  return files;
}
