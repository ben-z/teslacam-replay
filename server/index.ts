import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createReadStream } from "fs";
import { readFile, writeFile, stat, mkdir, readdir, rm, unlink } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import {
  scanTeslacamFolder,
  getVideoPath,
  getThumbnailPath,
  type DashcamEvent,
} from "./scan.js";
import { extractTelemetry, type TelemetryData } from "./sei.js";
import { ensureHlsSegments, hlsManifestPath, hlsCacheDir, HLS_CACHE_DIR } from "./hls.js";
import { LocalStorage, type StorageBackend } from "./storage.js";
import { GoogleDriveStorage, DOWNLOAD_CACHE_DIR } from "./google-drive.js";

// --- Storage backend selection ---
const STORAGE_BACKEND = process.env.STORAGE_BACKEND || "local";

let storage: StorageBackend;

async function initStorage(): Promise<StorageBackend> {
  let backend: StorageBackend;

  if (STORAGE_BACKEND === "googledrive") {
    const credentialsFile = process.env.GOOGLE_DRIVE_CREDENTIALS_FILE;
    if (!credentialsFile) {
      console.error("Error: GOOGLE_DRIVE_CREDENTIALS_FILE is required when STORAGE_BACKEND=googledrive");
      console.error("This should point to a JSON file with OAuth or service account credentials.");
      process.exit(1);
    }
    backend = await GoogleDriveStorage.fromCredentialsFile(credentialsFile);
    console.log(`Using Google Drive storage (credentials: ${credentialsFile})`);
  } else {
    const teslacamPath = process.env.TESLACAM_PATH ?? "";
    if (!teslacamPath) {
      console.error("Error: TESLACAM_PATH environment variable is required.");
      console.error("Usage: TESLACAM_PATH=/path/to/teslacam npm run dev:server");
      process.exit(1);
    }
    backend = new LocalStorage(teslacamPath);
    console.log(`Using local storage (${teslacamPath})`);
  }

  // Startup sanity check: verify we can list the root and find TeslaCam folders
  try {
    const rootEntries = await backend.readdir("");
    const expected = ["SavedClips", "SentryClips", "RecentClips"];
    const found = expected.filter((e) => rootEntries.includes(e));
    if (found.length === 0) {
      console.warn("Warning: No TeslaCam folders (SavedClips, SentryClips, RecentClips) found.");
      console.warn("Check that your storage path/folder contains TeslaCam data.");
    } else {
      console.log(`Found TeslaCam folders: ${found.join(", ")}`);
    }
  } catch (err) {
    console.error("Error: Failed to access storage:", err instanceof Error ? err.message : err);
    process.exit(1);
  }

  return backend;
}

storage = await initStorage();

const CACHE_DIR = path.join(
  process.env.HOME || "/tmp",
  ".cache",
  "teslacam-replay"
);
const CACHE_FILE = path.join(CACHE_DIR, "events.json");

const app = new Hono();

// CORS: allow cross-origin requests so the frontend can be hosted separately
// (e.g., GitHub Pages pointing at a self-hosted backend)
app.use("/api/*", cors());

// --- Event cache (memory + disk, with deduplication) ---
let cachedEvents: DashcamEvent[] | null = null;
let scanPromise: Promise<DashcamEvent[]> | null = null;

async function loadDiskCache(): Promise<DashcamEvent[] | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!data || data.version !== 4 || !Array.isArray(data.events)) {
      console.log("Disk cache outdated (version mismatch), re-scanning");
      return null;
    }
    console.log(`Loaded ${data.events.length} events from disk cache`);
    return data.events;
  } catch {
    return null;
  }
}

async function saveDiskCache(events: DashcamEvent[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ version: 4, events }));
    console.log(`Saved ${events.length} events to disk cache`);
  } catch (err) {
    console.error("Failed to save disk cache:", err);
  }
}

async function getEvents(forceRefresh = false): Promise<DashcamEvent[]> {
  if (cachedEvents && !forceRefresh) return cachedEvents;

  // Deduplicate: if a scan is already in-flight, wait for it
  if (scanPromise) return scanPromise;

  scanPromise = (async () => {
    try {
      // Try disk cache first (skip for refresh)
      if (!forceRefresh) {
        const diskCached = await loadDiskCache();
        if (diskCached) {
          cachedEvents = diskCached;
          return cachedEvents;
        }
      }

      console.log(
        "Scanning teslacam folder (this may take a few minutes on cloud drives)..."
      );
      const start = performance.now();
      cachedEvents = await scanTeslacamFolder(storage);
      const elapsed = (performance.now() - start) / 1000;
      console.log(
        `Found ${cachedEvents.length} events in ${elapsed.toFixed(1)}s`
      );
      await saveDiskCache(cachedEvents);
      return cachedEvents;
    } finally {
      scanPromise = null;
    }
  })();

  return scanPromise;
}

// --- Validation ---
const SAFE_PARAM = /^[\w-]+$/;
function validateParams(...params: string[]): boolean {
  return params.every((p) => SAFE_PARAM.test(p));
}

// --- API Routes ---

app.get("/api/status", (c) => {
  return c.json({
    storageBackend: STORAGE_BACKEND === "googledrive" ? "Google Drive" : "Local",
    storagePath: STORAGE_BACKEND === "googledrive"
      ? `Drive folder ${process.env.GOOGLE_DRIVE_FOLDER_ID || "(from credentials)"}`
      : process.env.TESLACAM_PATH,
    eventCount: cachedEvents?.length ?? null,
    scanning: scanPromise !== null,
  });
});

app.get("/api/events", async (c) => {
  const events = await getEvents();
  return c.json(events);
});

app.get("/api/events/:type/:id", async (c) => {
  const { type, id } = c.req.param();
  if (!validateParams(type, id)) return c.json({ error: "Invalid params" }, 400);
  const events = await getEvents();
  const event = events.find((e) => e.type === type && e.id === id);
  if (!event) return c.json({ error: "Event not found" }, 404);
  return c.json(event);
});

app.get("/api/events/:type/:id/thumbnail", async (c) => {
  const { type, id } = c.req.param();
  if (!validateParams(type, id)) return c.json({ error: "Invalid params" }, 400);
  const thumbRelPath = getThumbnailPath(type, id);
  try {
    const stream = await storage.createReadStream(thumbRelPath);
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "public, max-age=86400");
    return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
      headers: c.res.headers,
    });
  } catch {
    return c.json({ error: "Thumbnail not found" }, 404);
  }
});

// --- Telemetry (SEI extraction with in-memory cache) ---
// Must be registered before the video streaming route (which has :camera wildcard)
type TelemetryResult =
  | { hasSei: true; frameTimesMs: number[]; frames: TelemetryData["frames"] }
  | { hasSei: false };

const telemetryCache = new Map<string, TelemetryResult>();
const NO_SEI: TelemetryResult = { hasSei: false };

app.get("/api/video/:type/:eventId/:segment/telemetry", async (c) => {
  const { type, eventId, segment } = c.req.param();
  if (!validateParams(type, eventId, segment)) {
    return c.json({ error: "Invalid params" }, 400);
  }

  const cacheKey = `${type}/${eventId}/${segment}`;
  const cached = telemetryCache.get(cacheKey);
  if (cached) return c.json(cached);

  const events = await getEvents();
  const event = events.find((e) => e.type === type && e.id === eventId);
  if (!event) return c.json({ error: "Event not found" }, 404);

  const clip = event.clips.find((cl) => cl.timestamp === segment);
  if (!clip) return c.json({ error: "Segment not found" }, 404);

  const camera = clip.cameras.includes("front") ? "front" : clip.cameras[0];
  if (!camera) return c.json({ error: "No camera available" }, 404);

  const videoRelPath = getVideoPath(type, eventId, segment, camera, clip.subfolder);

  try {
    const localPath = await storage.getLocalPath(videoRelPath);
    const data = await extractTelemetry(localPath);
    const result: TelemetryResult = data
      ? { hasSei: true, frameTimesMs: data.frameTimesMs, frames: data.frames }
      : NO_SEI;
    telemetryCache.set(cacheKey, result);
    return c.json(result);
  } catch {
    return c.json(NO_SEI);
  }
});

// --- HLS streaming ---

// Manifest route: triggers lazy segmentation, then serves .m3u8
app.get("/api/hls/:type/:eventId/:segment/:camera/stream.m3u8", async (c) => {
  const { type, eventId, segment, camera } = c.req.param();
  if (!validateParams(type, eventId, segment, camera)) {
    return c.json({ error: "Invalid params" }, 400);
  }

  // Look up clip subfolder for RecentClips
  let subfolder: string | undefined;
  if (type === "RecentClips") {
    const events = await getEvents();
    const event = events.find((e) => e.type === type && e.id === eventId);
    const clip = event?.clips.find((cl) => cl.timestamp === segment);
    subfolder = clip?.subfolder;
  }

  const videoRelPath = getVideoPath(type, eventId, segment, camera, subfolder);

  // Try streaming directly from remote storage (avoids downloading entire file)
  const streamUrl = await storage.getStreamUrl?.(videoRelPath) ?? null;

  // Get local file path as fallback (or primary for local storage)
  let localPath: string;
  try {
    localPath = streamUrl
      ? videoRelPath // placeholder — won't be used by ffmpeg when streamUrl is set
      : await storage.getLocalPath(videoRelPath);
  } catch {
    return c.json({ error: "Video not found" }, 404);
  }

  // Verify source file exists locally (skip for streaming)
  if (!streamUrl) {
    try {
      await stat(localPath);
    } catch {
      return c.json({ error: "Video not found" }, 404);
    }
  }

  // Ensure HLS segments are ready (lazy segmentation)
  const ready = await ensureHlsSegments(
    { localPath, streamUrl: streamUrl ?? undefined },
    type, eventId, segment, camera,
  );
  if (!ready) {
    return c.json({ error: "Failed to process video" }, 500);
  }

  const manifestFile = hlsManifestPath(type, eventId, segment, camera);
  const stream = createReadStream(manifestFile);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// Chunk route: serves .ts segment files from cache
app.get("/api/hls/:type/:eventId/:segment/:camera/:chunk", async (c) => {
  const { type, eventId, segment, camera, chunk } = c.req.param();
  if (!validateParams(type, eventId, segment, camera) || !/^chunk_\d{3}\.ts$/.test(chunk)) {
    return c.json({ error: "Invalid params" }, 400);
  }

  const chunkPath = path.join(
    hlsCacheDir(type, eventId, segment, camera),
    chunk
  );

  let fileStat;
  try {
    fileStat = await stat(chunkPath);
  } catch {
    return c.json({ error: "Chunk not found" }, 404);
  }

  const stream = createReadStream(chunkPath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Length": String(fileStat.size),
      "Content-Type": "video/mp2t",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// --- Debug: cache management ---

async function dirSizeBytes(dirPath: string): Promise<number> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let total = 0;
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await dirSizeBytes(full);
      } else {
        try {
          const s = await stat(full);
          total += s.size;
        } catch {}
      }
    }
    return total;
  } catch {
    return 0;
  }
}

app.get("/api/debug/caches", async (c) => {
  const [diskStat, hlsSize, gdriveSize] = await Promise.all([
    stat(CACHE_FILE).then((s) => ({ path: CACHE_FILE, sizeBytes: s.size })).catch(() => ({ path: null, sizeBytes: 0 })),
    dirSizeBytes(HLS_CACHE_DIR),
    dirSizeBytes(DOWNLOAD_CACHE_DIR),
  ]);

  return c.json({
    caches: [
      { id: "events-disk", label: "Event scan cache", path: diskStat.path, sizeBytes: diskStat.sizeBytes },
      { id: "events-memory", label: "Event scan (memory)", path: null, entryCount: cachedEvents?.length ?? 0 },
      { id: "hls", label: "HLS segments", path: HLS_CACHE_DIR, sizeBytes: hlsSize },
      { id: "gdrive-downloads", label: "Drive file downloads", path: DOWNLOAD_CACHE_DIR, sizeBytes: gdriveSize },
      { id: "gdrive-dirs", label: "Drive directory listings (memory)", path: null, entryCount: storage.cacheEntryCount() },
      { id: "telemetry", label: "Telemetry (memory)", path: null, entryCount: telemetryCache.size },
    ],
  });
});

app.post("/api/debug/caches/:id/clear", async (c) => {
  const { id } = c.req.param();
  switch (id) {
    case "events-disk":
      try { await unlink(CACHE_FILE); } catch {}
      cachedEvents = null;
      break;
    case "events-memory":
      cachedEvents = null;
      break;
    case "hls":
      try { await rm(HLS_CACHE_DIR, { recursive: true, force: true }); } catch {}
      break;
    case "gdrive-downloads":
      try { await rm(DOWNLOAD_CACHE_DIR, { recursive: true, force: true }); } catch {}
      break;
    case "gdrive-dirs":
      storage.clearCache();
      break;
    case "telemetry":
      telemetryCache.clear();
      break;
    default:
      return c.json({ error: "Unknown cache id" }, 400);
  }
  return c.json({ ok: true });
});

app.post("/api/refresh", async (c) => {
  storage.clearCache();
  // Don't clear cachedEvents until new scan succeeds
  try {
    const events = await getEvents(true);
    return c.json(events);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scan failed";
    return c.json({ error: msg }, 500);
  }
});

// Serve static files when SERVE_FRONTEND is enabled
if (process.env.SERVE_FRONTEND === "true") {
  app.use("/*", serveStatic({ root: "./dist" }));
  // SPA fallback - only for non-API routes
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    return serveStatic({ path: "./dist/index.html" })(c, next);
  });
}

const port = parseInt(process.env.PORT || "3001");
console.log(`TeslaCam Replay server starting on http://localhost:${port}`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
});

function shutdown() {
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
