import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
import { google } from "googleapis";
import { createReadStream } from "fs";
import { readFile, writeFile, stat, mkdir, readdir, rename, rm, unlink } from "fs/promises";
import path from "path";
import { Readable } from "stream";
import {
  scanTeslacamFolder,
  getVideoPath,
  getThumbnailPath,
  type DashcamEvent,
} from "./scan.js";
import { extractTelemetry, type TelemetryData } from "./sei.js";
import { ensureHlsSegments, hlsManifestPath, hlsCacheDir } from "./hls.js";
import { LocalStorage, type StorageBackend } from "./storage.js";
import { GoogleDriveStorage } from "./google-drive.js";
import { loadSavedAuth, saveAuth } from "./oauth.js";
import { TOKEN_PATH, EVENTS_CACHE_PATH, HLS_CACHE_DIR, DOWNLOAD_CACHE_DIR } from "./paths.js";

// --- Storage backend selection ---
const STORAGE_BACKEND = process.env.STORAGE_BACKEND || "local";
const isGoogleDrive = STORAGE_BACKEND === "googledrive";

let storage: StorageBackend | null = null;

// Google Drive OAuth config (available at module level for route handlers)
const gdClientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
const gdClientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;

async function activateStorage(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  folderId: string,
  accessToken?: string,
  expiryDate?: number,
): Promise<void> {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({
    refresh_token: refreshToken,
    access_token: accessToken,
    expiry_date: expiryDate,
  });
  oauth2Client.on("tokens", async (tokens) => {
    const saved = await loadSavedAuth();
    if (saved) {
      await saveAuth({
        ...saved,
        accessToken: tokens.access_token ?? undefined,
        expiryDate: tokens.expiry_date ?? undefined,
      });
    }
  });
  const drive = google.drive({ version: "v3", auth: oauth2Client });
  storage = await GoogleDriveStorage.fromDriveClient(drive, folderId);
  console.log(`Google Drive storage activated (folder: ${folderId})`);
}

async function verifyStorage(backend: StorageBackend): Promise<void> {
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
}

async function initStorage(): Promise<void> {
  if (isGoogleDrive) {
    if (!gdClientId || !gdClientSecret) {
      console.error("Error: GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET are required when STORAGE_BACKEND=googledrive");
      process.exit(1);
    }

    const saved = await loadSavedAuth();
    const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN || saved?.refreshToken;
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || saved?.folderId;

    if (refreshToken && folderId) {
      await activateStorage(gdClientId, gdClientSecret, refreshToken, folderId, saved?.accessToken, saved?.expiryDate);
      await verifyStorage(storage!);
    } else {
      console.log("Google Drive storage: waiting for OAuth setup via browser");
    }
  } else {
    const teslacamPath = process.env.TESLACAM_PATH ?? "";
    if (!teslacamPath) {
      console.error("Error: TESLACAM_PATH environment variable is required.");
      console.error("Usage: TESLACAM_PATH=/path/to/teslacam npm run dev:server");
      process.exit(1);
    }
    storage = new LocalStorage(teslacamPath);
    console.log(`Using local storage (${teslacamPath})`);
    await verifyStorage(storage);
  }
}

// --- Event cache (memory + disk, with deduplication) ---
let cachedEvents: DashcamEvent[] | null = null;
let scanPromise: Promise<DashcamEvent[]> | null = null;
let scanIsRefresh = false;

// --- Background auto-refresh ---
const AUTO_REFRESH_INTERVAL = Math.max(0, parseInt(process.env.AUTO_REFRESH_INTERVAL || "300") || 0);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshStarted = false;

await initStorage();

const app = new Hono();

// CORS: allow cross-origin requests so the frontend can be hosted separately
// (e.g., GitHub Pages pointing at a self-hosted backend)
app.use("/api/*", cors());
app.use("/api/*", compress());

// Guard: return 503 when storage is not yet configured (skip status + oauth routes)
app.use("/api/*", async (c, next) => {
  const p = c.req.path;
  if (p === "/api/status" || p.startsWith("/api/oauth/") || p.startsWith("/api/debug/")) {
    return next();
  }
  if (!storage) {
    return c.json({ error: "Storage not configured. Complete setup first." }, 503);
  }
  return next();
});

const CACHE_VERSION = 5;

async function loadDiskCache(): Promise<DashcamEvent[] | null> {
  try {
    const raw = await readFile(EVENTS_CACHE_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!data || data.version !== CACHE_VERSION || !Array.isArray(data.events)) {
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
    await mkdir(path.dirname(EVENTS_CACHE_PATH), { recursive: true });
    await writeFile(EVENTS_CACHE_PATH, JSON.stringify({ version: CACHE_VERSION, events }));
    console.log(`Saved ${events.length} events to disk cache`);
  } catch (err) {
    console.error("Failed to save disk cache:", err);
  }
}

async function getEvents(forceRefresh = false): Promise<DashcamEvent[]> {
  if (cachedEvents && !forceRefresh) return cachedEvents;

  // If a scan is already in-flight...
  if (scanPromise) {
    // If we want a refresh but the in-flight scan is NOT a refresh,
    // wait for it to finish, then start a fresh refresh scan
    if (forceRefresh && !scanIsRefresh) {
      await scanPromise;
      return getEvents(true);
    }
    return scanPromise;
  }

  scanIsRefresh = forceRefresh;
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

      const isIncremental = forceRefresh && cachedEvents !== null;
      console.log(
        isIncremental
          ? "Refreshing events (incremental scan)..."
          : "Scanning teslacam folder (this may take a few minutes on cloud drives)..."
      );
      const start = performance.now();
      // Incremental: pass existing events so only new folders are scanned
      const newEvents = await scanTeslacamFolder(
        storage!,
        isIncremental ? cachedEvents! : undefined
      );
      const elapsed = (performance.now() - start) / 1000;
      console.log(
        `Found ${newEvents.length} events in ${elapsed.toFixed(1)}s`
      );
      // Only update cache after successful scan (errors propagate, keeping old cache intact)
      cachedEvents = newEvents;
      await saveDiskCache(cachedEvents);
      return cachedEvents;
    } finally {
      scanPromise = null;
      scanIsRefresh = false;
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

app.get("/api/status", async (c) => {
  if (!storage) {
    // Determine which setup step the user is on
    const saved = await loadSavedAuth();
    const setupStep = saved?.refreshToken ? "folder" : "oauth";
    return c.json({ connected: false, setupStep });
  }
  return c.json({
    connected: true,
    storageBackend: isGoogleDrive ? "Google Drive" : "Local",
    storagePath: isGoogleDrive
      ? `Drive folder ${process.env.GOOGLE_DRIVE_FOLDER_ID || "(cached)"}`
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
    const stream = await storage!.createReadStream(thumbRelPath);
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

  const events = await getEvents();
  const event = events.find((e) => e.type === type && e.id === eventId);
  if (!event) return c.json({ error: "Event not found" }, 404);

  const clip = event.clips.find((cl) => cl.timestamp === segment);
  if (!clip) return c.json({ error: "Segment not found" }, 404);

  const camera = clip.cameras.includes("front") ? "front" : clip.cameras[0];
  if (!camera) return c.json({ error: "No camera available" }, 404);

  const videoRelPath = getVideoPath(type, eventId, segment, camera, clip.subfolder);

  try {
    const localPath = await storage!.getLocalPath(videoRelPath);
    const data = await extractTelemetry(localPath);
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
  const streamUrl = await storage!.getStreamUrl?.(videoRelPath) ?? null;

  // Get local file path as fallback (or primary for local storage)
  let localPath: string;
  try {
    localPath = streamUrl
      ? videoRelPath // placeholder — won't be used by ffmpeg when streamUrl is set
      : await storage!.getLocalPath(videoRelPath);
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
  const [diskStat, hlsSize, gdriveSize, tokenStat] = await Promise.all([
    stat(EVENTS_CACHE_PATH).then((s) => ({ path: EVENTS_CACHE_PATH, sizeBytes: s.size })).catch(() => ({ path: null, sizeBytes: 0 })),
    dirSizeBytes(HLS_CACHE_DIR),
    dirSizeBytes(DOWNLOAD_CACHE_DIR),
    stat(TOKEN_PATH).then((s) => ({ path: TOKEN_PATH, sizeBytes: s.size })).catch(() => ({ path: null, sizeBytes: 0 })),
  ]);

  return c.json({
    caches: [
      { id: "events-disk", label: "Event scan cache", path: diskStat.path, sizeBytes: diskStat.sizeBytes },
      { id: "events-memory", label: "Event scan (memory)", path: null, entryCount: cachedEvents?.length ?? 0 },
      { id: "hls", label: "HLS segments", path: HLS_CACHE_DIR, sizeBytes: hlsSize },
      { id: "gdrive-downloads", label: "Drive file downloads", path: DOWNLOAD_CACHE_DIR, sizeBytes: gdriveSize },
      { id: "gdrive-dirs", label: "Drive directory listings (memory)", path: null, entryCount: storage?.cacheEntryCount() ?? 0 },
      { id: "telemetry", label: "Telemetry (memory)", path: null, entryCount: telemetryCache.size },
      { id: "oauth-token", label: "OAuth token", path: tokenStat.path, sizeBytes: tokenStat.sizeBytes },
    ],
  });
});

app.post("/api/debug/caches/:id/clear", async (c) => {
  const { id } = c.req.param();
  switch (id) {
    case "events-disk":
      try { await unlink(EVENTS_CACHE_PATH); } catch {}
      cachedEvents = null;
      break;
    case "events-memory":
      cachedEvents = null;
      break;
    case "hls": {
      // Rename first (atomic), then delete in background to avoid race with new ffmpeg writes
      const tmp = `${HLS_CACHE_DIR}_del_${Date.now()}`;
      try { await rename(HLS_CACHE_DIR, tmp); rm(tmp, { recursive: true, force: true }).catch(() => {}); } catch {}
      break;
    }
    case "gdrive-downloads": {
      const tmp = `${DOWNLOAD_CACHE_DIR}_del_${Date.now()}`;
      try { await rename(DOWNLOAD_CACHE_DIR, tmp); rm(tmp, { recursive: true, force: true }).catch(() => {}); } catch {}
      break;
    }
    case "gdrive-dirs":
      if (storage instanceof GoogleDriveStorage) storage.clearAllCaches();
      break;
    case "telemetry":
      telemetryCache.clear();
      break;
    case "oauth-token":
      try { await unlink(TOKEN_PATH); } catch {}
      storage = null;
      cachedEvents = null;
      break;
    default:
      return c.json({ error: "Unknown cache id" }, 400);
  }
  return c.json({ ok: true });
});

// --- OAuth setup routes (Google Drive) ---

// Guard: all OAuth routes require Google Drive credentials
app.use("/api/oauth/*", async (c, next) => {
  if (!gdClientId || !gdClientSecret) {
    return c.json({ error: "Google Drive not configured" }, 400);
  }
  return next();
});

app.get("/api/oauth/start", (c) => {
  const redirectUri = new URL("/api/oauth/callback", c.req.url).toString();
  const oauth2Client = new google.auth.OAuth2(gdClientId!, gdClientSecret!, redirectUri);
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive.readonly"],
  });
  return c.json({ url });
});

app.get("/api/oauth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) return c.json({ error: "Missing code parameter" }, 400);

  const redirectUri = new URL("/api/oauth/callback", c.req.url);
  redirectUri.search = "";
  const oauth2Client = new google.auth.OAuth2(gdClientId!, gdClientSecret!, redirectUri.toString());

  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      return c.json({ error: "No refresh token received. Try revoking app access and retrying." }, 400);
    }

    const existing = await loadSavedAuth();
    await saveAuth({
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token ?? undefined,
      expiryDate: tokens.expiry_date ?? undefined,
      folderId: existing?.folderId,
    });

    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || existing?.folderId;
    if (folderId) {
      await activateStorage(gdClientId!, gdClientSecret!, tokens.refresh_token, folderId, tokens.access_token ?? undefined, tokens.expiry_date ?? undefined);
    }

    console.log("OAuth tokens saved successfully");
    return c.html("<h1>Authorized</h1><p>You can close this tab and return to the app.</p>");
  } catch (err) {
    console.error("OAuth token exchange failed:", err);
    return c.json({ error: "Token exchange failed" }, 500);
  }
});

app.post("/api/oauth/select-folder", async (c) => {
  const body = await c.req.json<{ folderUrl: string }>();
  const folderUrl = body.folderUrl?.trim();
  if (!folderUrl) return c.json({ error: "Missing folderUrl" }, 400);

  const match = folderUrl.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  const folderId = match ? match[1] : folderUrl;
  if (!folderId || !/^[a-zA-Z0-9_-]+$/.test(folderId)) {
    return c.json({ error: "Could not extract a valid folder ID" }, 400);
  }

  const saved = await loadSavedAuth();
  if (!saved?.refreshToken) {
    return c.json({ error: "No OAuth token found. Complete OAuth first." }, 400);
  }

  await saveAuth({ ...saved, folderId });
  await activateStorage(gdClientId!, gdClientSecret!, saved.refreshToken, folderId, saved.accessToken, saved.expiryDate);
  startAutoRefresh();

  return c.json({ ok: true });
});

app.post("/api/refresh", async (c) => {
  await storage?.refreshCache?.();
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

function startAutoRefresh(): void {
  if (autoRefreshStarted) return;
  autoRefreshStarted = true;

  // Load from disk cache immediately, then kick off a background refresh
  getEvents()
    .then(() => getEvents(true))
    .catch((err) =>
      console.error("Initial scan failed:", err instanceof Error ? err.message : err)
    );

  if (AUTO_REFRESH_INTERVAL <= 0) return;
  autoRefreshTimer = setInterval(async () => {
    if (!storage || scanPromise) return;
    try {
      const before = cachedEvents?.length ?? 0;
      // Incrementally refresh dir cache (cheap: only queries for new entries since last check).
      await storage.refreshCache?.();
      const events = await getEvents(true);
      const added = events.length - before;
      if (added > 0) {
        console.log(`Auto-refresh: found ${added} new event${added !== 1 ? "s" : ""} (${events.length} total)`);
      } else {
        console.log(`Auto-refresh: no new events (${events.length} total)`);
      }
    } catch (err) {
      console.error("Auto-refresh failed:", err instanceof Error ? err.message : err);
    }
  }, AUTO_REFRESH_INTERVAL * 1000);
  console.log(`Auto-refresh enabled (every ${AUTO_REFRESH_INTERVAL}s)`);
}

if (storage) startAutoRefresh();

const port = parseInt(process.env.PORT || "3001");
console.log(`TeslaCam Replay server starting on http://localhost:${port}`);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
});

function shutdown() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshStarted = false;
  server.close();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
