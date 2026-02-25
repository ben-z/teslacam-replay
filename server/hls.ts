import { execFile } from "child_process";
import { stat, mkdir } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { HLS_CACHE_DIR } from "./paths.js";

const execFileAsync = promisify(execFile);
const HLS_SEGMENT_DURATION = 4; // seconds per chunk

// Re-encode video at this bitrate (e.g. "800k", "2M"). Empty = remux only (copy mode).
const HLS_BITRATE = process.env.HLS_BITRATE || "";

// Detect available H.264 encoder at startup
async function detectEncoder(): Promise<string> {
  if (!HLS_BITRATE) {
    console.log("HLS: copy mode (no transcoding)");
    return "libx264";
  }
  let encoder = "libx264";
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-encoders"], { timeout: 5000 });
    if (stdout.includes("h264_videotoolbox")) {
      encoder = "h264_videotoolbox";
    }
  } catch {
    // ffmpeg not found or failed — will error later when actually needed
  }
  const label = encoder === "h264_videotoolbox" ? "VideoToolbox (hardware)" : "software";
  console.log(`HLS: transcoding at ${HLS_BITRATE} using ${label} encoder`);
  return encoder;
}

const hlsEncoder = await detectEncoder();

const HLS_ENCODING_LABEL = HLS_BITRATE || "copy";

/**
 * Get the cache directory for a specific camera stream.
 * Includes encoding profile so different bitrates don't serve stale segments.
 */
export function hlsCacheDir(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return path.join(HLS_CACHE_DIR, HLS_ENCODING_LABEL, type, eventId, segment, camera);
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

/**
 * Return ffmpeg codec flags based on detected encoder.
 */
function codecArgs(): string[] {
  if (!HLS_BITRATE) return ["-c", "copy"];
  if (hlsEncoder === "h264_videotoolbox") {
    return ["-c:v", "h264_videotoolbox", "-b:v", HLS_BITRATE, "-c:a", "aac", "-b:a", "64k"];
  }
  return ["-c:v", "libx264", "-preset", "fast", "-b:v", HLS_BITRATE, "-c:a", "aac", "-b:a", "64k"];
}

// Track in-flight segmentation to deduplicate concurrent requests
const segmentingPromises = new Map<string, Promise<boolean>>();

// Limit concurrent ffmpeg processes to prevent I/O exhaustion.
// Hardware encoding uses minimal CPU, so we can run more concurrently.
const DEFAULT_CONCURRENT = hlsEncoder === "h264_videotoolbox" ? 4 : 2;
const MAX_CONCURRENT = parseInt(process.env.HLS_MAX_CONCURRENT ?? "") || DEFAULT_CONCURRENT;
let activeCount = 0;
const waitQueue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeCount < MAX_CONCURRENT) {
    activeCount++;
    return;
  }
  await new Promise<void>(resolve => waitQueue.push(resolve));
}

function releaseSlot(): void {
  const next = waitQueue.shift();
  if (next) next(); // hand slot directly to next waiter
  else activeCount--;
}

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
    await acquireSlot();
    const queued = waitQueue.length;
    console.log(`HLS: segmenting ${cacheKey} [${activeCount}/${MAX_CONCURRENT} active${queued > 0 ? `, ${queued} queued` : ""}]`);
    const start = performance.now();
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

      args.push(...codecArgs());
      args.push(
        "-hls_time", String(HLS_SEGMENT_DURATION),
        "-hls_segment_filename", path.join(cacheDir, "chunk_%03d.ts"),
        "-hls_playlist_type", "vod",
        "-f", "hls",
        "-v", "error",
        manifestFile,
      );

      // Longer timeout for remote streaming or re-encoding
      const timeout = (source.streamUrl || HLS_BITRATE) ? 120000 : 30000;
      await execFileAsync("ffmpeg", args, { timeout });

      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`HLS: done ${cacheKey} in ${elapsed}s`);
      return true;
    } catch (err) {
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      console.error(`HLS: failed ${cacheKey} after ${elapsed}s: ${msg}`);
      return false;
    } finally {
      releaseSlot();
      segmentingPromises.delete(cacheKey);
    }
  })();

  segmentingPromises.set(cacheKey, promise);
  return promise;
}
