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
}

const CLIP_REGEX = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)\.mp4$/;
const CAMERA_ORDER = ["front", "left_repeater", "right_repeater", "back", "left_pillar", "right_pillar"];

// Folder names match this pattern: "YYYY-MM-DD_HH-MM-SS"
const FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

// Date-only folder pattern for RecentClips subfolders: "YYYY-MM-DD"
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Max gap between consecutive clips before splitting into separate events (seconds)
const SESSION_GAP_THRESHOLD = 120;

export async function scanTeslacamFolder(
  storage: StorageBackend
): Promise<DashcamEvent[]> {
  const events: DashcamEvent[] = [];

  for (const type of ["SavedClips", "SentryClips"] as const) {
    let entries: string[];
    try {
      entries = await storage.readdir(type);
    } catch {
      continue;
    }

    // Filter to only timestamp-patterned folders (skip .DS_Store, etc.)
    const folders = entries.filter((f) => FOLDER_PATTERN.test(f));

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

  // Scan RecentClips (flat files + date subfolders)
  const recentEvents = await scanRecentClips(storage);
  events.push(...recentEvents);

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

  const clips: EventClip[] = sorted.map(([timestamp, cameras], i) => {
    let durationSec = 60; // default
    if (i + 1 < sorted.length) {
      const cur = segmentTimestampToEpoch(timestamp);
      const next = segmentTimestampToEpoch(sorted[i + 1][0]);
      if (cur > 0 && next > 0) {
        const diff = next - cur;
        if (diff >= 1 && diff <= 120) durationSec = diff;
      }
    }
    return {
      timestamp,
      cameras: Array.from(cameras).sort((a, b) =>
        CAMERA_ORDER.indexOf(a) - CAMERA_ORDER.indexOf(b)
      ),
      durationSec,
    };
  });

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
  };
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

/**
 * Scan RecentClips: flat MP4 files + date subfolders, grouped into driving sessions.
 */
async function scanRecentClips(storage: StorageBackend): Promise<DashcamEvent[]> {
  let entries: string[];
  try {
    entries = await storage.readdir("RecentClips");
  } catch {
    return [];
  }

  // Collect all clip files: { timestamp, camera, subfolder? }
  const segmentMap = new Map<string, { cameras: Set<string>; subfolder?: string }>();

  // Parse flat MP4 files
  for (const file of entries) {
    const match = file.match(CLIP_REGEX);
    if (!match) continue;
    const [, timestamp, camera] = match;
    if (!segmentMap.has(timestamp)) {
      segmentMap.set(timestamp, { cameras: new Set() });
    }
    segmentMap.get(timestamp)!.cameras.add(camera);
  }

  // Parse date subfolders
  const dateFolders = entries.filter((f) => DATE_FOLDER_PATTERN.test(f));
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
    const clips: EventClip[] = session.map(([timestamp, { cameras, subfolder }], i) => {
      let durationSec = 60;
      if (i + 1 < session.length) {
        const cur = segmentTimestampToEpoch(timestamp);
        const next = segmentTimestampToEpoch(session[i + 1][0]);
        if (cur > 0 && next > 0) {
          const diff = next - cur;
          if (diff >= 1 && diff <= 120) durationSec = diff;
        }
      }
      return {
        timestamp,
        cameras: Array.from(cameras).sort((a, b) =>
          CAMERA_ORDER.indexOf(a) - CAMERA_ORDER.indexOf(b)
        ),
        durationSec,
        subfolder,
      };
    });

    const firstTimestamp = session[0][0];
    return {
      id: firstTimestamp,
      type: "RecentClips" as const,
      timestamp: folderNameToISO(firstTimestamp),
      hasThumbnail: false,
      clips,
      totalDurationSec: clips.reduce((sum, c) => sum + c.durationSec, 0),
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
