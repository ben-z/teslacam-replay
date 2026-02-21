import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createReadStream } from "fs";
import { readFile, writeFile, stat, mkdir } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import {
  scanTeslacamFolder,
  getVideoPath,
  getThumbnailPath,
  type DashcamEvent,
} from "./scan.js";
import { extractTelemetry, type TelemetryData } from "./sei.js";

const TESLACAM_PATH: string = process.env.TESLACAM_PATH ?? "";
if (!TESLACAM_PATH) {
  console.error("Error: TESLACAM_PATH environment variable is required.");
  console.error("Usage: TESLACAM_PATH=/path/to/teslacam npm run dev:server");
  process.exit(1);
}

const CACHE_DIR = path.join(
  process.env.HOME || "/tmp",
  ".cache",
  "dash-replay"
);
const CACHE_FILE = path.join(CACHE_DIR, "events.json");

const app = new Hono();

// CORS for dev (not needed in production since we serve the SPA)
if (process.env.NODE_ENV !== "production") {
  app.use("/api/*", cors());
}

// --- Event cache (memory + disk, with deduplication) ---
let cachedEvents: DashcamEvent[] | null = null;
let scanPromise: Promise<DashcamEvent[]> | null = null;

async function loadDiskCache(): Promise<DashcamEvent[] | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (
      !Array.isArray(data) ||
      (data.length > 0 && !data[0].id) ||
      (data.length > 0 && data[0].clips?.[0] && !data[0].clips[0].durationSec)
    ) {
      console.log("Disk cache invalid or outdated schema, ignoring");
      return null;
    }
    console.log(`Loaded ${data.length} events from disk cache`);
    return data;
  } catch {
    return null;
  }
}

async function saveDiskCache(events: DashcamEvent[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(events));
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
      cachedEvents = await scanTeslacamFolder(TESLACAM_PATH);
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

function isWithinRoot(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(path.resolve(TESLACAM_PATH) + path.sep);
}

// --- API Routes ---

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
  const thumbPath = getThumbnailPath(TESLACAM_PATH, type, id);
  if (!isWithinRoot(thumbPath)) return c.json({ error: "Invalid path" }, 400);
  try {
    await stat(thumbPath);
    const stream = createReadStream(thumbPath);
    c.header("Content-Type", "image/png");
    c.header("Cache-Control", "public, max-age=86400");
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: c.res.headers,
    });
  } catch {
    return c.json({ error: "Thumbnail not found" }, 404);
  }
});

// --- Telemetry (SEI extraction with in-memory cache) ---
// Must be registered before the video streaming route (which has :camera wildcard)
const telemetryCache = new Map<string, { hasSei: true; frameTimesMs: number[]; frames: TelemetryData["frames"] } | { hasSei: false }>();

app.get("/api/video/:type/:eventId/:segment/telemetry", async (c) => {
  const { type, eventId, segment } = c.req.param();
  if (!validateParams(type, eventId, segment)) {
    return c.json({ error: "Invalid params" }, 400);
  }

  const cacheKey = `${type}/${eventId}/${segment}`;
  const cached = telemetryCache.get(cacheKey);
  if (cached) return c.json(cached);

  // Find the front camera file (or first available)
  const events = await getEvents();
  const event = events.find((e) => e.type === type && e.id === eventId);
  if (!event) return c.json({ error: "Event not found" }, 404);

  const clip = event.clips.find((cl) => cl.timestamp === segment);
  if (!clip) return c.json({ error: "Segment not found" }, 404);

  const camera = clip.cameras.includes("front") ? "front" : clip.cameras[0];
  if (!camera) return c.json({ error: "No camera available" }, 404);

  const videoPath = getVideoPath(TESLACAM_PATH, type, eventId, segment, camera);
  if (!isWithinRoot(videoPath)) return c.json({ error: "Invalid path" }, 400);

  try {
    const data = await extractTelemetry(videoPath);
    if (data) {
      const result = { hasSei: true as const, frameTimesMs: data.frameTimesMs, frames: data.frames };
      telemetryCache.set(cacheKey, result);
      return c.json(result);
    } else {
      const result = { hasSei: false as const };
      telemetryCache.set(cacheKey, result);
      return c.json(result);
    }
  } catch {
    return c.json({ hasSei: false });
  }
});

app.get("/api/video/:type/:eventId/:segment/:camera", async (c) => {
  const { type, eventId, segment, camera } = c.req.param();
  if (!validateParams(type, eventId, segment, camera)) {
    return c.json({ error: "Invalid params" }, 400);
  }
  const videoPath = getVideoPath(TESLACAM_PATH, type, eventId, segment, camera);
  if (!isWithinRoot(videoPath)) return c.json({ error: "Invalid path" }, 400);

  let fileStat;
  try {
    fileStat = await stat(videoPath);
  } catch {
    return c.json({ error: "Video not found" }, 404);
  }

  const fileSize = fileStat.size;
  const range = c.req.header("range");

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (
      isNaN(start) ||
      start < 0 ||
      start >= fileSize ||
      end >= fileSize ||
      end < start
    ) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileSize}` },
      });
    }
    const chunkSize = end - start + 1;
    const stream = createReadStream(videoPath, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(chunkSize),
        "Content-Type": "video/mp4",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  const stream = createReadStream(videoPath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Length": String(fileSize),
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

app.post("/api/refresh", async (c) => {
  // Don't clear cachedEvents until new scan succeeds
  try {
    const events = await getEvents(true);
    return c.json(events);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scan failed";
    return c.json({ error: msg }, 500);
  }
});

// Serve static files in production
if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: "./dist" }));
  // SPA fallback - only for non-API routes
  app.get("*", (c, next) => {
    if (c.req.path.startsWith("/api/")) return next();
    return serveStatic({ path: "./dist/index.html" })(c, next);
  });
}

const port = parseInt(process.env.PORT || "3001");
console.log(`DashReplay server starting on http://localhost:${port}`);
console.log(`Teslacam path: ${TESLACAM_PATH}`);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
});
