import { execFile } from "child_process";
import { promisify } from "util";
import { stat, mkdir } from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

const HLS_CACHE_DIR = "/tmp/dash-replay-hls";
const HLS_SEGMENT_DURATION = 4; // seconds per chunk

/**
 * Get the cache directory for a specific camera stream.
 * Structure: /tmp/dash-replay-hls/{type}/{eventId}/{segment}/{camera}/
 */
export function hlsCacheDir(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return path.join(HLS_CACHE_DIR, type, eventId, segment, camera);
}

/**
 * Get the path to the HLS manifest for a camera stream.
 */
export function hlsManifestPath(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return path.join(hlsCacheDir(type, eventId, segment, camera), "stream.m3u8");
}

// Track in-flight segmentation to deduplicate concurrent requests
const segmentingPromises = new Map<string, Promise<boolean>>();

/**
 * Ensure HLS segments exist for a given camera stream.
 * If already cached, returns immediately. If not, runs ffmpeg to segment.
 * Deduplicates concurrent requests for the same stream.
 * Returns true if segments are ready, false if segmentation failed.
 */
export async function ensureHlsSegments(
  sourcePath: string,
  type: string,
  eventId: string,
  segment: string,
  camera: string
): Promise<boolean> {
  const cacheDir = hlsCacheDir(type, eventId, segment, camera);
  const manifestFile = path.join(cacheDir, "stream.m3u8");

  // Check if already segmented
  try {
    await stat(manifestFile);
    return true;
  } catch {
    // Not cached yet — need to segment
  }

  // Deduplicate: if already segmenting this stream, wait for it
  const cacheKey = `${type}/${eventId}/${segment}/${camera}`;
  const existing = segmentingPromises.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      await mkdir(cacheDir, { recursive: true });

      // Segment with ffmpeg: copy codec, no transcoding
      await execFileAsync("ffmpeg", [
        "-i", sourcePath,
        "-c", "copy",
        "-hls_time", String(HLS_SEGMENT_DURATION),
        "-hls_segment_filename", path.join(cacheDir, "chunk_%03d.ts"),
        "-hls_playlist_type", "vod",
        "-f", "hls",
        "-v", "error",
        manifestFile,
      ], { timeout: 30000 });

      return true;
    } catch (err) {
      console.error(`HLS segmentation failed for ${cacheKey}:`, err);
      return false;
    } finally {
      segmentingPromises.delete(cacheKey);
    }
  })();

  segmentingPromises.set(cacheKey, promise);
  return promise;
}
