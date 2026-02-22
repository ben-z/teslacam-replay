import { execFile } from "child_process";
import { promisify } from "util";
import { stat, mkdir } from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

export const HLS_CACHE_DIR = "/tmp/teslacam-replay-hls";
const HLS_SEGMENT_DURATION = 4; // seconds per chunk

/**
 * Get the cache directory for a specific camera stream.
 * Structure: /tmp/teslacam-replay-hls/{type}/{eventId}/{segment}/{camera}/
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

export interface HlsSource {
  localPath: string;
  streamUrl?: { url: string; headers: Record<string, string> };
}

/**
 * Ensure HLS segments exist for a given camera stream.
 * If already cached, returns immediately. If not, runs ffmpeg to segment.
 * When streamUrl is provided, ffmpeg streams directly from the URL with Range
 * requests instead of reading from a local file — dramatically reducing latency
 * for remote storage backends like Google Drive.
 * Deduplicates concurrent requests for the same stream.
 * Returns true if segments are ready, false if segmentation failed.
 */
export async function ensureHlsSegments(
  source: HlsSource,
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

      const args: string[] = [];

      if (source.streamUrl) {
        // Stream from remote URL — ffmpeg uses Range requests for seeking
        const headerStr = Object.entries(source.streamUrl.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") + "\r\n";
        args.push(
          "-headers", headerStr,
          "-seekable", "1",
          "-reconnect", "1",
          "-reconnect_on_network_error", "1",
          "-reconnect_delay_max", "5",
          "-i", source.streamUrl.url,
        );
      } else {
        args.push("-i", source.localPath);
      }

      args.push(
        "-c", "copy",
        "-hls_time", String(HLS_SEGMENT_DURATION),
        "-hls_segment_filename", path.join(cacheDir, "chunk_%03d.ts"),
        "-hls_playlist_type", "vod",
        "-f", "hls",
        "-v", "error",
        manifestFile,
      );

      // Longer timeout for remote streaming (network latency)
      const timeout = source.streamUrl ? 120000 : 30000;
      await execFileAsync("ffmpeg", args, { timeout });

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
