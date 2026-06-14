import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { createReadStream } from "fs";
import { readFile, stat, readdir, rename, rm } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import {
  scanEventFolder,
  scanRecentClipsPage,
  getClipSource,
  type DashcamEvent,
  type EventType,
} from "./scan.js";
import { extractTelemetryFromBuffer, type TelemetryData } from "./sei.js";
import { ensureHlsSegments, hlsManifestPath, hlsCacheDir } from "./hls.js";
import { createGDriveLiteFromEnv, type DriveEntry } from "./gdrive-lite.js";
import { HLS_CACHE_DIR } from "./paths.js";

const drive = createGDriveLiteFromEnv();

async function verifyDrive(): Promise<void> {
  try {
    await drive.healthCheck();
    const rootEntries = (await drive.listRoot()).files.map((entry) => entry.name);
    const expected = ["SavedClips", "SentryClips", "RecentClips"];
    const found = expected.filter((e) => rootEntries.includes(e));
    if (found.length === 0) {
      console.warn("Warning: No TeslaCam folders (SavedClips, SentryClips, RecentClips) found.");
      console.warn("Check that gdrive-serve-lite is serving the TeslaCam folder root.");
    } else {
      console.log(`Found TeslaCam folders: ${found.join(", ")}`);
    }
  } catch (err) {
    console.error("Error: Failed to access gdrive-serve-lite:", err instanceof Error ? err.message : err);
    console.error("Set GDRIVE_BASE_URL, GDRIVE_USER, and GDRIVE_PASS to match gdrive-serve-lite.");
    process.exit(1);
  }
}

await verifyDrive();

const app = new Hono();

// CORS: allow cross-origin requests so the frontend can be hosted separately
// (e.g., GitHub Pages pointing at a self-hosted backend)
app.use("/api/*", cors({
  origin: "*",
  allowHeaders: ["Content-Type"],
}));
app.use("/api/*", compress());

const EVENT_PAGE_SIZE = positiveInt(process.env.EVENT_PAGE_SIZE, 48);
const EVENT_PAGE_SCAN_CONCURRENCY = positiveInt(process.env.EVENT_PAGE_SCAN_CONCURRENCY, 8);
const EVENT_FOLDER_ORDER_BY = process.env.GDRIVE_EVENT_ORDER_BY ?? "name desc";
const EVENT_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;

const eventIndex = new Map<string, DashcamEvent>();
const typeFolders = new Map<EventType, DriveEntry>();

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function eventKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function mergeEvent(existing: DashcamEvent, incoming: DashcamEvent): DashcamEvent {
  const clipsByTimestamp = new Map(existing.clips.map((clip) => [clip.timestamp, clip]));
  for (const clip of incoming.clips) {
    const prev = clipsByTimestamp.get(clip.timestamp);
    if (!prev) {
      clipsByTimestamp.set(clip.timestamp, clip);
      continue;
    }
    clipsByTimestamp.set(clip.timestamp, {
      ...prev,
      ...clip,
      cameras: Array.from(new Set([...prev.cameras, ...clip.cameras])),
      sourceByCamera: {
        ...prev.sourceByCamera,
        ...clip.sourceByCamera,
      },
      durationSec: Math.max(prev.durationSec, clip.durationSec),
      subfolder: prev.subfolder ?? clip.subfolder,
    });
  }
  const clips = Array.from(clipsByTimestamp.values())
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const cameraCount = new Set(clips.flatMap((clip) => clip.cameras)).size;
  return {
    ...existing,
    ...incoming,
    hasThumbnail: existing.hasThumbnail || incoming.hasThumbnail,
    thumbnailSource: existing.thumbnailSource ?? incoming.thumbnailSource,
    clips,
    totalDurationSec: clips.reduce((sum, clip) => sum + clip.durationSec, 0),
    cameraCount,
  };
}

function rememberEvents(events: DashcamEvent[]): void {
  for (const event of events) {
    const key = eventKey(event.type, event.id);
    const existing = eventIndex.get(key);
    eventIndex.set(key, existing ? mergeEvent(existing, event) : event);
  }
}

function publicEvent(event: DashcamEvent): DashcamEvent {
  return {
    ...event,
    thumbnailSource: undefined,
    clips: event.clips.map((clip) => ({
      timestamp: clip.timestamp,
      cameras: clip.cameras,
      durationSec: clip.durationSec,
      subfolder: clip.subfolder,
    })),
  };
}

function publicEvents(events: DashcamEvent[]): DashcamEvent[] {
  return events.map(publicEvent);
}

async function getTypeFolder(type: EventType): Promise<DriveEntry> {
  const cached = typeFolders.get(type);
  if (cached) return cached;
  let folder: DriveEntry | undefined;
  try {
    folder = await drive.resolvePath(`/${type}`, "folder");
  } catch {
    folder = (await drive.listRoot()).files.find((entry) =>
      entry.name === type && drive.isFolder(entry)
    );
  }
  if (!folder) {
    throw new Error(`TeslaCam folder not found: ${type}`);
  }
  typeFolders.set(type, folder);
  return folder;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

async function getEventPage(
  type: EventType,
  pageToken: string | undefined,
  limit: number
): Promise<{ events: DashcamEvent[]; nextPageToken?: string }> {
  const folder = await getTypeFolder(type);

  if (type === "RecentClips") {
    const page = await drive.listFolderPage(drive.folderRef(folder), {
      type: "files",
      pageToken,
      pageSize: Math.min(1000, Math.max(limit * 6, limit)),
      limit: Math.min(1000, Math.max(limit * 6, limit)),
    });
    const events = (await scanRecentClipsPage(drive, page.files))
      .sort((a, b) => b.id.localeCompare(a.id));
    rememberEvents(events);
    return { events, nextPageToken: page.nextPageToken };
  }

  const page = await drive.listFolderPage(drive.folderRef(folder), {
    type: "folders",
    pageToken,
    pageSize: Math.min(1000, limit),
    limit: Math.min(1000, limit),
    orderBy: EVENT_FOLDER_ORDER_BY || undefined,
  });
  const folders = page.files.filter((entry) =>
    drive.isFolder(entry) && EVENT_FOLDER_PATTERN.test(entry.name)
  );
  const scanned = await mapLimit(
    folders,
    EVENT_PAGE_SCAN_CONCURRENCY,
    (entry) => scanEventFolder(drive, type, entry)
  );
  const events = scanned
    .filter((event): event is DashcamEvent => Boolean(event))
    .sort((a, b) => b.id.localeCompare(a.id));
  rememberEvents(events);
  return { events, nextPageToken: page.nextPageToken };
}

async function findEvent(type: string, id: string): Promise<DashcamEvent | null> {
  const indexed = eventIndex.get(eventKey(type, id));
  if (indexed) return indexed;

  if (type === "SavedClips" || type === "SentryClips") {
    try {
      const folder = await drive.resolvePath(`/${type}/${id}`, "folder");
      const event = await scanEventFolder(drive, type, folder);
      if (event) rememberEvents([event]);
      return event;
    } catch {
      return null;
    }
  }

  if (type === "RecentClips") {
    try {
      const folder = await drive.resolvePath(`/RecentClips/${id.slice(0, 10)}`, "folder");
      const events = await scanRecentClipsPage(drive, [folder]);
      rememberEvents(events);
      return events.find((event) => event.id === id) ?? null;
    } catch {
      return null;
    }
  }

  return null;
}

// --- Validation ---
const SAFE_PARAM = /^[\w-]+$/;
function validateParams(...params: string[]): boolean {
  return params.every((p) => SAFE_PARAM.test(p));
}

// --- API Routes ---

app.get("/api/status", (c) => {
  return c.json({
    storageBackend: "gdrive-serve-lite",
    storagePath: drive.baseUrl,
    loadedEventCount: eventIndex.size,
  });
});

app.get("/api/events/page", async (c) => {
  const type = c.req.query("type") as EventType | undefined;
  if (type !== "SavedClips" && type !== "SentryClips" && type !== "RecentClips") {
    return c.json({ error: "Invalid event type" }, 400);
  }

  const limit = Math.min(1000, positiveInt(c.req.query("limit"), EVENT_PAGE_SIZE));
  try {
    const page = await getEventPage(type, c.req.query("pageToken") || undefined, limit);
    return c.json({
      type,
      events: publicEvents(page.events),
      nextPageToken: page.nextPageToken ?? null,
      loadedEventCount: eventIndex.size,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to load event page";
    return c.json({ error: msg }, 500);
  }
});

app.get("/api/events/:type/:id", async (c) => {
  const { type, id } = c.req.param();
  if (!validateParams(type, id)) return c.json({ error: "Invalid params" }, 400);
  const event = await findEvent(type, id);
  if (!event) return c.json({ error: "Event not found" }, 404);
  return c.json(publicEvent(event));
});

app.get("/api/events/:type/:id/thumbnail", async (c) => {
  const { type, id } = c.req.param();
  if (!validateParams(type, id)) return c.json({ error: "Invalid params" }, 400);
  const event = await findEvent(type, id);
  const source = event?.thumbnailSource;
  if (!source) return c.json({ error: "Thumbnail not found" }, 404);

  const res = await drive.fetchSource(source);
  if (!res.ok || !res.body) return c.json({ error: "Thumbnail not found" }, 404);

  const headers = readHeaders(res);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "image/png");
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(res.body, { status: res.status, headers });
});

// --- Telemetry (SEI extraction with in-memory cache) ---
// Must be registered before the video streaming route (which has :camera wildcard)
type TelemetryResult =
  | { hasSei: true; frameTimesMs: number[]; frames: TelemetryData["frames"] }
  | { hasSei: false };

const TELEMETRY_CACHE_MAX = 200;
const telemetryCache = new Map<string, TelemetryResult>();
const NO_SEI: TelemetryResult = { hasSei: false };

function telemetryCacheSet(key: string, value: TelemetryResult): void {
  // LRU eviction: Map preserves insertion order, delete oldest if at capacity
  if (telemetryCache.size >= TELEMETRY_CACHE_MAX) {
    const oldest = telemetryCache.keys().next().value!;
    telemetryCache.delete(oldest);
  }
  telemetryCache.set(key, value);
}

app.get("/api/video/:type/:eventId/:segment/telemetry", async (c) => {
  const { type, eventId, segment } = c.req.param();
  if (!validateParams(type, eventId, segment)) {
    return c.json({ error: "Invalid params" }, 400);
  }

  const cacheKey = `${type}/${eventId}/${segment}`;
  const cached = telemetryCache.get(cacheKey);
  if (cached) return c.json(cached);

  const event = await findEvent(type, eventId);
  if (!event) return c.json({ error: "Event not found" }, 404);

  const clip = event.clips.find((cl) => cl.timestamp === segment);
  if (!clip) return c.json({ error: "Segment not found" }, 404);

  const camera = clip.cameras.includes("front") ? "front" : clip.cameras[0];
  if (!camera) return c.json({ error: "No camera available" }, 404);

  const source = getClipSource(event, segment, camera);
  if (!source) return c.json(NO_SEI);

  try {
    const res = await drive.fetchSource(source);
    if (!res.ok) return c.json(NO_SEI);
    const data = await extractTelemetryFromBuffer(Buffer.from(await res.arrayBuffer()));
    const result: TelemetryResult = data
      ? { hasSei: true, frameTimesMs: data.frameTimesMs, frames: data.frames }
      : NO_SEI;
    telemetryCacheSet(cacheKey, result);
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

  const event = await findEvent(type, eventId);
  if (!event) return c.json({ error: "Event not found" }, 404);

  const source = getClipSource(event, segment, camera);
  if (!source) return c.json({ error: "Video not found" }, 404);

  // Ensure HLS segments are ready (lazy segmentation)
  const ready = await ensureHlsSegments(
    drive.streamSource(source),
    type, eventId, segment, camera,
  );
  if (!ready) {
    return c.json({ error: "Failed to process video" }, 500);
  }

  const manifestFile = hlsManifestPath(type, eventId, segment, camera);
  const manifestContent = await readFile(manifestFile, "utf-8");
  const isComplete = manifestContent.includes("#EXT-X-ENDLIST");
  return new Response(manifestContent, {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      // In-progress manifests must not be cached so hls.js can poll for new segments
      "Cache-Control": isComplete ? "public, max-age=86400" : "no-cache",
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
  const hlsSize = await dirSizeBytes(HLS_CACHE_DIR);

  return c.json({
    caches: [
      { id: "hls", label: "HLS segments", path: HLS_CACHE_DIR, sizeBytes: hlsSize },
      { id: "telemetry", label: "Telemetry (memory)", path: null, entryCount: telemetryCache.size },
    ],
  });
});

app.post("/api/debug/caches/:id/clear", async (c) => {
  const { id } = c.req.param();
  switch (id) {
    case "hls": {
      // Rename first (atomic), then delete in background to avoid race with new ffmpeg writes
      const tmp = `${HLS_CACHE_DIR}_del_${Date.now()}`;
      try { await rename(HLS_CACHE_DIR, tmp); rm(tmp, { recursive: true, force: true }).catch(() => {}); } catch {}
      break;
    }
    case "telemetry":
      telemetryCache.clear();
      break;
    default:
      return c.json({ error: "Unknown cache id" }, 400);
  }
  return c.json({ ok: true });
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

function readHeaders(res: Response): Headers {
  const headers = new Headers();
  for (const key of [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
    "Cache-Control",
    "Expires",
  ]) {
    const value = res.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
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
