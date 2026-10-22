import { execFile, spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { watch, type FSWatcher } from "fs";
import { mkdir, readFile, writeFile, rename, rm, lstat } from "fs/promises";
import path from "path";
import { promisify } from "util";
import { HLS_CACHE_DIR } from "./paths.js";
import { HLS_CACHE_VERSION } from "../src/types.js";

const execFileAsync = promisify(execFile);
const HLS_CONFIG = {
  segmentDurationSeconds: 1,
  processTimeoutMs: 120_000,
  encoderDetectionTimeoutMs: 5_000,
};

// Re-encoding and scaling are optional; an empty bitrate preserves source video.
const HLS_BITRATE = process.env.HLS_BITRATE || "";
const HLS_WIDTH = process.env.HLS_WIDTH || "";

async function detectEncoder(): Promise<string | null> {
  if (!HLS_BITRATE) return null;
  const { stdout } = await execFileAsync("ffmpeg", ["-encoders"], {
    timeout: HLS_CONFIG.encoderDetectionTimeoutMs,
  });
  if (stdout.includes("h264_videotoolbox")) return "h264_videotoolbox";
  if (stdout.includes("libx264")) return "libx264";
  throw new Error("ffmpeg has no supported H.264 encoder");
}

const hlsEncoder = await detectEncoder();
const HLS_ENCODING_LABEL = HLS_BITRATE
  ? `${HLS_BITRATE}${HLS_WIDTH ? `_${HLS_WIDTH}` : ""}`
  : "copy";

export function hlsCacheDir(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return path.join(HLS_CACHE_DIR, `v${HLS_CACHE_VERSION}`, HLS_ENCODING_LABEL, type, eventId, segment, camera);
}

export function hlsManifestPath(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return path.join(hlsCacheDir(type, eventId, segment, camera), "stream.m3u8");
}

function codecArgs(): string[] {
  if (!HLS_BITRATE) return ["-c", "copy"];
  const scale = HLS_WIDTH ? ["-vf", `scale=${HLS_WIDTH}:-2`] : [];
  if (hlsEncoder === "h264_videotoolbox") {
    return [...scale, "-c:v", "h264_videotoolbox", "-b:v", HLS_BITRATE, "-c:a", "aac", "-b:a", "64k"];
  }
  return [...scale, "-c:v", "libx264", "-preset", "fast", "-b:v", HLS_BITRATE, "-c:a", "aac", "-b:a", "64k"];
}

export interface HlsSource {
  url: string;
  headers: Record<string, string>;
  identity: string;
}

interface HlsJob {
  sourceHash: string;
  ready: Promise<boolean>;
  failed: boolean;
}

const activeJobs = new Map<string, HlsJob>();

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

interface HlsChunk {
  name: string;
  size: number;
}

// Only the local MPEG-TS media playlist emitted by our ffmpeg command is supported.
function completedChunkNames(manifest: string, sourceHash: string): string[] | null {
  const lines = manifest.trimEnd().split(/\r?\n/);
  if (lines.shift() !== "#EXTM3U" || lines.pop() !== "#EXT-X-ENDLIST") return null;
  const names: string[] = [];
  const filename = new RegExp(`^chunk_${sourceHash}_\\d{3,}\\.ts$`);
  let needsUri = false;
  for (const line of lines) {
    if (needsUri) {
      if (!filename.test(line) || names.includes(line)) return null;
      names.push(line);
      needsUri = false;
    } else if (line.startsWith("#EXTINF:")) {
      const duration = /^#EXTINF:([0-9]+(?:\.[0-9]+)?),$/.exec(line);
      if (!duration || !Number.isFinite(Number(duration[1])) || Number(duration[1]) <= 0) return null;
      needsUri = true;
    } else if (!/^#EXT-X-(?:VERSION|TARGETDURATION|MEDIA-SEQUENCE):\d+$/.test(line)
      && line !== "#EXT-X-PLAYLIST-TYPE:EVENT") {
      return null;
    }
  }
  return names.length > 0 && !needsUri ? names : null;
}

async function chunkReceipt(cacheDir: string, names: string[]): Promise<HlsChunk[] | null> {
  const chunks = await Promise.all(names.map(async (name) => {
    const file = await lstat(path.join(cacheDir, name));
    return file.isFile() && Number.isSafeInteger(file.size) && file.size > 0
      ? { name, size: file.size } : null;
  }));
  return chunks.every((chunk) => chunk !== null) ? chunks : null;
}

async function isCompleteCache(cacheDir: string, sourceHash: string): Promise<boolean> {
  try {
    const [manifest, receipt] = await Promise.all([
      readFile(path.join(cacheDir, "stream.m3u8"), "utf-8"),
      readFile(path.join(cacheDir, "source.json"), "utf-8"),
    ]);
    const source = JSON.parse(receipt) as { sourceHash?: string; chunks?: HlsChunk[] } | null;
    const names = completedChunkNames(manifest, sourceHash);
    if (source?.sourceHash !== sourceHash || !names || !Array.isArray(source.chunks)
      || source.chunks.length !== names.length) return false;
    const chunks = await chunkReceipt(cacheDir, names);
    return chunks !== null && chunks.every((chunk, index) => {
      const recorded = source.chunks![index];
      return recorded?.name === chunk.name && recorded.size === chunk.size;
    });
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function runSegmentation(
  source: HlsSource,
  cacheDir: string,
  cacheKey: string,
  job: HlsJob,
  ready: (value: boolean) => void,
): Promise<void> {
  let watcher: FSWatcher | undefined;
  let child: ChildProcess | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let observationError: unknown;
  let timedOut = false;
  const manifestFile = path.join(cacheDir, "stream.m3u8");

  try {
    if (await isCompleteCache(cacheDir, job.sourceHash)) {
      ready(true);
      return;
    }
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });

    const observeManifest = () => {
      void readFile(manifestFile, "utf-8").then(
        (content) => {
          if (!job.failed && content.includes("#EXTINF:")) ready(true);
        },
        (error: unknown) => {
          if (isMissing(error)) return;
          observationError = error;
          job.failed = true;
          child?.kill("SIGKILL");
        },
      );
    };
    watcher = watch(cacheDir, (_event, filename) => {
      if (filename === "stream.m3u8") observeManifest();
    });
    watcher.on("error", (error) => {
      observationError = error;
      job.failed = true;
      child?.kill("SIGKILL");
    });

    const args: string[] = [];
    const headers = Object.entries(source.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n");
    if (headers) args.push("-headers", `${headers}\r\n`);
    args.push(
      "-seekable", "1",
      "-reconnect", "1",
      "-reconnect_on_network_error", "1",
      "-reconnect_delay_max", "5",
      "-i", source.url,
      ...codecArgs(),
      "-hls_time", String(HLS_CONFIG.segmentDurationSeconds),
      "-hls_segment_filename", path.join(cacheDir, `chunk_${job.sourceHash}_%03d.ts`),
      "-hls_playlist_type", "event",
      "-hls_list_size", "0",
      "-hls_flags", "temp_file+omit_endlist",
      "-f", "hls",
      "-v", "error",
      manifestFile,
    );
    console.log(`HLS: segmenting ${cacheKey}`);
    child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = new Promise<number | null>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("close", resolve);
    });
    killTimer = setTimeout(() => {
      timedOut = true;
      job.failed = true;
      child!.kill("SIGKILL");
    }, HLS_CONFIG.processTimeoutMs);
    observeManifest();

    const exitCode = await exited;
    if (observationError) throw observationError;
    if (timedOut) throw new Error(`ffmpeg exceeded ${HLS_CONFIG.processTimeoutMs}ms`);
    if (exitCode !== 0 || stderr.trim()) {
      throw new Error(`ffmpeg failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    const manifest = await readFile(manifestFile, "utf-8");
    const finalManifest = `${manifest.trimEnd()}\n#EXT-X-ENDLIST\n`;
    const names = completedChunkNames(finalManifest, job.sourceHash);
    if (!names) throw new Error("ffmpeg produced an invalid or empty HLS media playlist");
    const chunks = await chunkReceipt(cacheDir, names);
    if (!chunks) throw new Error("ffmpeg produced an empty or non-file HLS segment");
    await writeFile(path.join(cacheDir, "source.json"), JSON.stringify({ sourceHash: job.sourceHash, chunks }));
    await writeFile(`${manifestFile}.tmp`, finalManifest);
    await rename(`${manifestFile}.tmp`, manifestFile);
    ready(true);
  } catch (error) {
    job.failed = true;
    ready(false);
    await rm(cacheDir, { recursive: true, force: true });
    throw error;
  } finally {
    watcher?.close();
    clearTimeout(killTimer);
  }
}

/** Return as soon as ffmpeg publishes the first playable segment. */
export function ensureHlsSegments(
  source: HlsSource,
  type: string,
  eventId: string,
  segment: string,
  camera: string
): Promise<boolean> {
  const cacheKey = `${type}/${eventId}/${segment}/${camera}`;
  const sourceHash = createHash("sha256").update(source.identity).digest("hex").slice(0, 16);
  const existing = activeJobs.get(cacheKey);
  if (existing) {
    return existing.failed || existing.sourceHash !== sourceHash
      ? Promise.resolve(false)
      : existing.ready;
  }

  let ready!: (value: boolean) => void;
  const job: HlsJob = {
    sourceHash,
    ready: new Promise<boolean>((resolve) => { ready = resolve; }),
    failed: false,
  };
  activeJobs.set(cacheKey, job);
  void runSegmentation(source, hlsCacheDir(type, eventId, segment, camera), cacheKey, job, ready)
    .catch((error: unknown) => {
      job.failed = true;
      ready(false);
      console.error(`HLS: failed ${cacheKey}:`, error);
    })
    .finally(() => activeJobs.delete(cacheKey));
  return job.ready;
}
