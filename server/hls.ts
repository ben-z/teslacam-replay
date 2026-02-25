import { execFile, spawn } from "child_process";
import { stat, mkdir, readFile, writeFile, rm } from "fs/promises";
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

// --- Job tracking and concurrency ---

/** Tracks an in-flight ffmpeg job. Callers await `manifestReady`. */
const activeJobs = new Map<string, Promise<boolean>>();

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
  if (next) next();
  else activeCount--;
}

/** Check if a manifest is complete (has #EXT-X-ENDLIST). */
async function isCompleteManifest(manifestPath: string): Promise<boolean> {
  try {
    const content = await readFile(manifestPath, "utf-8");
    return content.includes("#EXT-X-ENDLIST");
  } catch {
    return false;
  }
}

/** Poll for manifest file to appear on disk. */
async function waitForManifest(manifestPath: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await stat(manifestPath);
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  return false;
}

export interface HlsSource {
  localPath: string;
  streamUrl?: { url: string; headers: Record<string, string> };
}

/**
 * Run ffmpeg to produce HLS segments. Resolves true once the manifest
 * file appears on disk (progressive serving), even though ffmpeg may
 * still be writing additional segments.
 */
async function runSegmentation(
  source: HlsSource,
  cacheDir: string,
  manifestFile: string,
  cacheKey: string,
  timeoutMs: number,
): Promise<boolean> {
  await acquireSlot();
  const queued = waitQueue.length;
  console.log(`HLS: segmenting ${cacheKey} [${activeCount}/${MAX_CONCURRENT} active${queued > 0 ? `, ${queued} queued` : ""}]`);
  const start = performance.now();

  try {
    await mkdir(cacheDir, { recursive: true });

    const args: string[] = [];

    if (source.streamUrl) {
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
      "-hls_playlist_type", "event",
      "-hls_list_size", "0",
      "-hls_flags", "temp_file",
      "-f", "hls",
      "-v", "error",
      manifestFile,
    );

    const ffmpeg = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderrOutput = "";
    ffmpeg.stderr!.on("data", (chunk: Buffer) => { stderrOutput += chunk.toString(); });

    const killTimer = setTimeout(() => ffmpeg.kill("SIGKILL"), timeoutMs);

    // Wait for ffmpeg to exit
    const exitCode = await new Promise<number | null>(resolve => {
      ffmpeg.on("close", resolve);
    });
    clearTimeout(killTimer);

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);

    if (exitCode === 0) {
      console.log(`HLS: done ${cacheKey} in ${elapsed}s`);
      return true;
    }

    const msg = stderrOutput.split("\n").filter(Boolean)[0] || `exit ${exitCode}`;
    console.error(`HLS: failed ${cacheKey} after ${elapsed}s: ${msg}`);
    // Append ENDLIST so hls.js stops polling and plays what we have
    try {
      const content = await readFile(manifestFile, "utf-8");
      if (!content.includes("#EXT-X-ENDLIST")) {
        await writeFile(manifestFile, content + "#EXT-X-ENDLIST\n");
      }
    } catch {
      // Manifest may not exist if ffmpeg failed before writing any segment
    }
    return false;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.error(`HLS: error ${cacheKey}: ${msg}`);
    return false;
  } finally {
    releaseSlot();
    activeJobs.delete(cacheKey);
  }
}

/**
 * Ensure HLS segments are available for a given camera stream.
 * Returns true as soon as the first segment is ready (progressive serving).
 * ffmpeg continues producing segments in the background.
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
  const cacheKey = `${type}/${eventId}/${segment}/${camera}`;

  // Complete manifest on disk = fully cached
  if (await isCompleteManifest(manifestFile)) return true;

  // ffmpeg already running for this stream -- wait for its manifest
  const existing = activeJobs.get(cacheKey);
  if (existing) return existing;

  // Stale incomplete manifest from a crashed ffmpeg -- clean up
  try {
    await stat(manifestFile);
    await rm(cacheDir, { recursive: true, force: true });
  } catch {
    // No manifest -- fresh start
  }

  // Start ffmpeg in the background. The returned promise resolves true once
  // the manifest appears (for progressive serving) or false on failure.
  // We race manifest appearance against process completion so callers don't
  // have to wait for the entire encode.
  const timeoutMs = (source.streamUrl || HLS_BITRATE) ? 120000 : 30000;
  const processComplete = runSegmentation(source, cacheDir, manifestFile, cacheKey, timeoutMs);

  const manifestReady = Promise.race([
    waitForManifest(manifestFile, timeoutMs),
    processComplete,
  ]);

  activeJobs.set(cacheKey, manifestReady);

  return manifestReady;
}
