import { readdir, readFile } from "fs/promises";
import path from "path";

export interface EventClip {
  timestamp: string; // e.g. "2025-06-01_18-07-09"
  cameras: string[]; // available camera angles
  durationSec: number; // estimated from timestamp gaps, ~60s
}

export interface DashcamEvent {
  id: string; // folder name (trigger timestamp)
  type: "SavedClips" | "SentryClips";
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

export async function scanTeslacamFolder(
  rootPath: string
): Promise<DashcamEvent[]> {
  const events: DashcamEvent[] = [];

  for (const type of ["SavedClips", "SentryClips"] as const) {
    const typeDir = path.join(rootPath, type);
    let entries: string[];
    try {
      entries = await readdir(typeDir);
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
        batch.map((folder) => scanEventFolder(rootPath, type, folder))
      );
      for (const event of results) {
        if (event) events.push(event);
      }
    }
  }

  events.sort((a, b) => b.id.localeCompare(a.id));
  return events;
}

async function scanEventFolder(
  rootPath: string,
  type: "SavedClips" | "SentryClips",
  folder: string
): Promise<DashcamEvent | null> {
  const folderPath = path.join(rootPath, type, folder);

  let files: string[];
  try {
    files = await readdir(folderPath);
  } catch {
    return null;
  }

  // Parse event.json if present
  let eventMeta: Record<string, string> = {};
  if (files.includes("event.json")) {
    try {
      const raw = await readFile(path.join(folderPath, "event.json"), "utf-8");
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
        // Sanity: use computed duration only if between 10s and 120s
        if (diff >= 10 && diff <= 120) durationSec = diff;
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

export function getVideoPath(
  rootPath: string,
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return path.join(rootPath, type, eventId, `${segment}-${camera}.mp4`);
}

export function getThumbnailPath(
  rootPath: string,
  type: string,
  eventId: string
): string {
  return path.join(rootPath, type, eventId, "thumb.png");
}
