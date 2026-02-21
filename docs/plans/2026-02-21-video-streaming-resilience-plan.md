# Video Streaming Resilience Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace raw MP4 file serving with lazy on-demand HLS streaming, add ffprobe validation at scan time, and make the client resilient to camera stalls.

**Architecture:** Server validates MP4s during scan (ffprobe) and lazily segments them into HLS chunks on first request (cached in `/tmp/dash-replay-hls/`). Client uses hls.js per camera with stall detection and a resilient sync loop that doesn't let one bad camera freeze everything.

**Tech Stack:** Node.js `child_process` for ffmpeg/ffprobe, hls.js for client-side HLS playback, Hono HTTP framework, React.

---

### Task 1: Add ffprobe validation to scan.ts

**Files:**
- Modify: `server/scan.ts:1-2` (imports)
- Modify: `server/scan.ts:107-125` (duration estimation in `scanEventFolder`)

**Step 1: Add `probeDuration` helper function**

Add these imports at the top of `server/scan.ts`:

```typescript
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
```

Add this function after the constants (after line 28):

```typescript
/**
 * Probe an MP4 file with ffprobe. Returns duration in seconds, or null if invalid/corrupt.
 */
async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      filePath,
    ], { timeout: 5000 });
    const dur = parseFloat(stdout.trim());
    return isFinite(dur) && dur > 0 ? dur : null;
  } catch {
    return null;
  }
}
```

**Step 2: Add `probeSegmentCameras` to validate cameras in a segment**

Add this function after `probeDuration`:

```typescript
/**
 * Probe all cameras in a segment. Returns only valid cameras and the max duration.
 */
async function probeSegmentCameras(
  rootPath: string,
  type: string,
  eventId: string,
  timestamp: string,
  cameras: string[]
): Promise<{ validCameras: string[]; durationSec: number }> {
  const results = await Promise.all(
    cameras.map(async (cam) => {
      const filePath = path.join(rootPath, type, eventId, `${timestamp}-${cam}.mp4`);
      const dur = await probeDuration(filePath);
      return { cam, dur };
    })
  );
  const valid = results.filter((r) => r.dur !== null);
  const maxDur = valid.reduce((max, r) => Math.max(max, r.dur!), 0);
  return {
    validCameras: valid.map((r) => r.cam),
    durationSec: maxDur || 60,
  };
}
```

**Step 3: Replace timestamp-diff duration estimation with ffprobe**

In `scanEventFolder`, replace the clips-building block (lines 103-125) with:

```typescript
  // Build clips array sorted by timestamp, with validated cameras and real durations
  const sorted = Array.from(segmentMap.entries())
    .sort(([a], [b]) => a.localeCompare(b));

  const clips: EventClip[] = [];
  for (const [timestamp, cameras] of sorted) {
    const sortedCams = Array.from(cameras).sort((a, b) =>
      CAMERA_ORDER.indexOf(a) - CAMERA_ORDER.indexOf(b)
    );
    const { validCameras, durationSec } = await probeSegmentCameras(
      rootPath, type, folder, timestamp, sortedCams
    );
    if (validCameras.length === 0) continue; // skip entirely corrupt segments
    clips.push({ timestamp, cameras: validCameras, durationSec });
  }
```

Note: This replaces the `sorted.map(...)` with a for-loop because we need `await` and we filter out empty segments.

**Step 4: Run the dev server and verify scan works**

Run: `TESLACAM_PATH=/path/to/teslacam npm run dev:server`

Expected: Server starts, scan completes, console shows event count. Verify with:

```bash
curl http://localhost:3001/api/events | jq '.[0].clips[0]'
```

Should show `durationSec` matching actual video length and `cameras` only listing valid files.

**Step 5: Commit**

```bash
git add server/scan.ts
git commit -m "feat: validate MP4s with ffprobe at scan time

Probe each camera file during scan to get real duration and exclude
corrupt files. Replaces timestamp-diff duration estimation."
```

---

### Task 2: Add HLS segmentation module (server/hls.ts)

**Files:**
- Create: `server/hls.ts`

**Step 1: Create the HLS segmentation module**

Create `server/hls.ts`:

```typescript
import { execFile, spawn } from "child_process";
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
        "-hls_flags", "single_file+independent_segments",
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
```

Note on `hls_flags`: `single_file` packs all chunks into one `.ts` file (the manifest uses byte-range offsets). This means fewer files on disk and simpler cleanup. `independent_segments` tells hls.js each segment can be decoded independently.

Actually — `single_file` mode may complicate things since we'd need Range request support on the `.ts` file. Let's keep it simple with separate chunk files:

```typescript
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
```

**Step 2: Verify the module compiles**

Run: `npx tsx --eval "import './server/hls.js'; console.log('ok')"`

Expected: Prints "ok" without errors.

**Step 3: Commit**

```bash
git add server/hls.ts
git commit -m "feat: add HLS segmentation module

Lazy on-demand HLS segmentation with deduplication. Caches
chunks in /tmp/dash-replay-hls/. Copy-mode only, no transcoding."
```

---

### Task 3: Replace video route with HLS routes (server/index.ts)

**Files:**
- Modify: `server/index.ts:1-15` (imports)
- Modify: `server/index.ts:196-253` (replace video route with HLS routes)

**Step 1: Add imports**

Add to the imports at the top of `server/index.ts`:

```typescript
import { ensureHlsSegments, hlsManifestPath, hlsCacheDir } from "./hls.js";
```

**Step 2: Replace the video serving route with HLS manifest + chunk routes**

Replace the entire video route (lines 196-253) with two routes:

```typescript
// --- HLS streaming ---

// Manifest route: triggers lazy segmentation, then serves .m3u8
app.get("/api/hls/:type/:eventId/:segment/:camera/stream.m3u8", async (c) => {
  const { type, eventId, segment, camera } = c.req.param();
  if (!validateParams(type, eventId, segment, camera)) {
    return c.json({ error: "Invalid params" }, 400);
  }
  const videoPath = getVideoPath(TESLACAM_PATH, type, eventId, segment, camera);
  if (!isWithinRoot(videoPath)) return c.json({ error: "Invalid path" }, 400);

  // Verify source file exists
  try {
    await stat(videoPath);
  } catch {
    return c.json({ error: "Video not found" }, 404);
  }

  // Ensure HLS segments are ready (lazy segmentation)
  const ready = await ensureHlsSegments(videoPath, type, eventId, segment, camera);
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
  if (!validateParams(type, eventId, segment, camera)) {
    return c.json({ error: "Invalid params" }, 400);
  }
  if (!chunk.endsWith(".ts")) {
    return c.json({ error: "Invalid chunk" }, 400);
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
```

**Step 3: Update the HLS manifest to use correct chunk URLs**

The default ffmpeg manifest references chunks as relative paths (`chunk_000.ts`). Since we serve them at `/api/hls/:type/:eventId/:segment/:camera/chunk_000.ts`, the browser will resolve relative URLs correctly as long as the manifest is served from the same path prefix. This works because the manifest URL is `.../camera/stream.m3u8` and chunks are at `.../camera/chunk_000.ts` — relative resolution is correct.

No manifest rewriting needed.

**Step 4: Verify HLS manifest route works**

Run: `npm run dev:server`

```bash
curl http://localhost:3001/api/hls/SavedClips/{eventId}/{segment}/front/stream.m3u8
```

Expected: First request takes ~1-2s (segmentation), returns a valid `.m3u8` manifest. Subsequent requests are instant (cached).

**Step 5: Commit**

```bash
git add server/index.ts
git commit -m "feat: replace raw video serving with HLS streaming

Lazy on-demand HLS segmentation on first request, cached in /tmp.
Manifest and chunk routes serve pre-segmented content. Instant
seeking via chunk-based playback."
```

---

### Task 4: Add hls.js to client and update Player.tsx

**Files:**
- Modify: `package.json` (add hls.js dependency)
- Modify: `src/api.ts` (add HLS manifest URL builder)
- Modify: `src/components/Player.tsx` (use hls.js per camera)

**Step 1: Install hls.js**

```bash
npm install hls.js
```

**Step 2: Add HLS manifest URL builder to api.ts**

In `src/api.ts`, replace the `videoUrl` function (lines 36-43):

```typescript
export function hlsManifestUrl(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return `${BASE}/hls/${type}/${eventId}/${segment}/${camera}/stream.m3u8`;
}
```

**Step 3: Update Player.tsx to use hls.js**

Add import at top of `Player.tsx`:

```typescript
import Hls from "hls.js";
```

Add a ref to track HLS instances (after `videoElsRef`, line 57):

```typescript
const hlsInstancesRef = useRef<Map<CameraAngle, Hls>>(new Map());
```

Replace `videoUrl` with `hlsManifestUrl` in the import from `"../api"` (line 2):

```typescript
import { hlsManifestUrl, fetchTelemetry } from "../api";
```

**Step 4: Create helper to attach/detach HLS to a video element**

Add this function inside the Player component, after the refs:

```typescript
const attachHls = useCallback((cam: CameraAngle, url: string) => {
  const video = videoElsRef.current.get(cam);
  if (!video) return;

  // Destroy previous instance for this camera
  const prev = hlsInstancesRef.current.get(cam);
  if (prev) { prev.destroy(); hlsInstancesRef.current.delete(cam); }

  if (Hls.isSupported()) {
    const hls = new Hls({
      maxBufferLength: 10,
      maxMaxBufferLength: 30,
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data.fatal) {
        console.warn(`HLS fatal error [${cam}]:`, data.type, data.details);
        handleVideoError(cam);
      }
    });
    hlsInstancesRef.current.set(cam, hls);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Safari native HLS
    video.src = url;
    video.load();
  }
}, [handleVideoError]);

const detachHls = useCallback((cam: CameraAngle) => {
  const hls = hlsInstancesRef.current.get(cam);
  if (hls) { hls.destroy(); hlsInstancesRef.current.delete(cam); }
  const video = videoElsRef.current.get(cam);
  if (video) {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}, []);
```

**Step 5: Update `loadSegment` to use HLS**

In `loadSegment` (lines 181-238), replace the video loading block. Change from:

```typescript
videoElsRef.current.forEach((v, cam) => {
  if (seg.cameras.includes(cam)) {
    v.src = videoUrl(event.type, event.id, seg.timestamp, cam);
    v.load();
  } else {
    v.pause();
    v.removeAttribute("src");
    v.load();
  }
});
```

To:

```typescript
for (const cam of allEventCameras) {
  if (seg.cameras.includes(cam)) {
    attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam));
  } else {
    detachHls(cam);
  }
}
```

Also update the `retryCamera` function (Task 5 from previous plan) to use `attachHls`:

```typescript
// In retryCamera, replace v.src = videoUrl(...); v.load(); with:
attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam));
```

**Step 6: Clean up HLS instances on unmount**

Update the cleanup effect (lines 366-376):

```typescript
useEffect(() => {
  return () => {
    clearTimeout(loadTimeoutRef.current);
    hlsInstancesRef.current.forEach((hls) => hls.destroy());
    hlsInstancesRef.current.clear();
    videoElsRef.current.forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
    });
    videoElsRef.current.clear();
  };
}, []);
```

**Step 7: Remove the `preload="metadata"` attribute from video elements**

HLS manages its own preloading. Change the `<video>` element (line 666):

```tsx
<video
  ref={(el) => setRef(cam, el)}
  muted={cam === "front" ? isMuted : true}
  playsInline
  aria-label={`${CAMERA_LABELS[cam]} camera`}
  onError={(e) => {
    if ((e.target as HTMLVideoElement).currentSrc) handleVideoError(cam);
  }}
  onWaiting={() => handleWaiting(cam)}
  onPlaying={() => handlePlaying(cam)}
/>
```

**Step 8: Verify HLS playback works**

Run: `npm run dev`

Expected: Open the app, navigate to an event. First load of each camera takes ~1-2s (segmentation), then plays. Seeking should be instant (chunk-based). Subsequent visits to the same event load instantly (cached chunks).

**Step 9: Commit**

```bash
git add package.json package-lock.json src/api.ts src/components/Player.tsx
git commit -m "feat: switch to HLS playback with hls.js

Each camera gets an independent hls.js instance. Lazy server-side
segmentation on first request, instant seeking via chunk-based
playback. Safari falls back to native HLS support."
```

---

### Task 5: Add stall detection and resilient sync

**Files:**
- Modify: `src/components/Player.tsx` (buffering state, sync logic)
- Modify: `src/components/Player.css` (buffering indicator style)

**Step 1: Add buffering state**

After the `videoErrors` state (line 47), add:

```typescript
const [bufferingCameras, setBufferingCameras] = useState<Set<CameraAngle>>(new Set());
```

Add a ref (after `telemetryDataRef`, line 65):

```typescript
const bufferingCamerasRef = useRef<Set<CameraAngle>>(new Set());
```

Keep in sync (after line 70):

```typescript
bufferingCamerasRef.current = bufferingCameras;
```

**Step 2: Add event handlers**

After `handleVideoError` (line 178):

```typescript
const handleWaiting = useCallback((cam: CameraAngle) => {
  setBufferingCameras((prev) => new Set(prev).add(cam));
}, []);

const handlePlaying = useCallback((cam: CameraAngle) => {
  setBufferingCameras((prev) => {
    const next = new Set(prev);
    next.delete(cam);
    return next;
  });
}, []);
```

**Step 3: Update syncAll to skip buffering cameras**

Replace `syncAll` (lines 130-140):

```typescript
const syncAll = useCallback(() => {
  const buffering = bufferingCamerasRef.current;
  const pCam = getPrimaryCamera();
  let ref = videoElsRef.current.get(pCam);

  // If primary is buffering, find the first healthy camera as sync reference
  if (ref && buffering.has(pCam)) {
    for (const cam of activeCameras) {
      if (cam === pCam || buffering.has(cam)) continue;
      const v = videoElsRef.current.get(cam);
      if (v?.currentSrc) { ref = v; break; }
    }
  }

  if (!ref || !ref.currentSrc) return;

  videoElsRef.current.forEach((v, cam) => {
    if (v === ref || !v.currentSrc) return;
    if (buffering.has(cam)) return;
    if (Math.abs(v.currentTime - ref!.currentTime) > SYNC_THRESHOLD) {
      v.currentTime = ref!.currentTime;
    }
  });
}, [getPrimaryCamera, activeCameras]);
```

**Step 4: Show buffering indicator + retry button**

After the camera label in the JSX (line 673), add:

```tsx
{bufferingCameras.has(cam) && !videoErrors.has(cam) && (
  <span className="player-video-buffering">Buffering...</span>
)}
{videoErrors.has(cam) && (
  <button
    className="player-video-error player-video-retry"
    onClick={(e) => { e.stopPropagation(); retryCamera(cam); }}
  >
    Failed to load &middot; Retry
  </button>
)}
```

**Step 5: Add retry handler**

After the stall handlers:

```typescript
const retryCamera = useCallback((cam: CameraAngle) => {
  const seg = event.clips[segmentIdxRef.current];
  if (!seg || !seg.cameras.includes(cam)) return;

  setVideoErrors((prev) => {
    const next = new Set(prev);
    next.delete(cam);
    return next;
  });

  attachHls(cam, hlsManifestUrl(event.type, event.id, seg.timestamp, cam));

  const pCam = getPrimaryCamera();
  const p = videoElsRef.current.get(pCam);
  const v = videoElsRef.current.get(cam);
  if (p?.currentSrc && v) {
    v.currentTime = p.currentTime;
  }
  if (v) {
    v.playbackRate = playbackRateRef.current;
    if (isPlayingRef.current) v.play().catch(() => {});
  }
}, [event.clips, event.type, event.id, getPrimaryCamera, attachHls]);
```

**Step 6: Clear buffering state on segment change**

In `loadSegment`, after `setVideoErrors(new Set())`:

```typescript
setBufferingCameras(new Set());
```

**Step 7: Add CSS**

In `src/components/Player.css`:

```css
.player-video-buffering {
  position: absolute;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.6);
  color: var(--text-muted);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  pointer-events: none;
}

.player-video-retry {
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.2);
}
.player-video-retry:hover {
  background: rgba(255, 255, 255, 0.15);
}
```

**Step 8: Verify**

Run: `npm run dev`

Expected: When a camera buffers, "Buffering..." appears. Other cameras keep playing. If a camera fails, "Failed to load - Retry" appears and clicking it reloads.

**Step 9: Commit**

```bash
git add src/components/Player.tsx src/components/Player.css
git commit -m "feat: add stall detection, resilient sync, and retry

Per-camera buffering indicator, sync loop skips stalled cameras
and falls back to healthy sync reference, retry button for
failed camera loads."
```

---

### Task 6: Invalidate disk cache when scan logic changes

**Files:**
- Modify: `server/index.ts:42-68` (cache versioning)

**Step 1: Version the disk cache**

Replace `saveDiskCache` (lines 61-69):

```typescript
async function saveDiskCache(events: DashcamEvent[]): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ version: 2, events }));
    console.log(`Saved ${events.length} events to disk cache`);
  } catch (err) {
    console.error("Failed to save disk cache:", err);
  }
}
```

Replace `loadDiskCache` (lines 42-59):

```typescript
async function loadDiskCache(): Promise<DashcamEvent[] | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (!data || data.version !== 2 || !Array.isArray(data.events)) {
      console.log("Disk cache outdated (version mismatch), re-scanning");
      return null;
    }
    console.log(`Loaded ${data.events.length} events from disk cache`);
    return data.events;
  } catch {
    return null;
  }
}
```

**Step 2: Verify**

Run: `npm run dev:server`

Expected: First run logs "Disk cache outdated", re-scans. Second run loads from cache.

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: version disk cache to invalidate stale scan data

Add version marker so changes to scan logic (ffprobe durations,
corrupt file exclusion) trigger a re-scan."
```

---

### Summary of Changes

| Task | File(s) | What |
|------|---------|------|
| 1 | `server/scan.ts` | ffprobe validation + real durations at scan time |
| 2 | `server/hls.ts` (new) | Lazy on-demand HLS segmentation module |
| 3 | `server/index.ts` | Replace raw video route with HLS manifest + chunk routes |
| 4 | `package.json`, `src/api.ts`, `src/components/Player.tsx` | hls.js integration, per-camera HLS playback |
| 5 | `src/components/Player.tsx`, `Player.css` | Stall detection, resilient sync, retry button |
| 6 | `server/index.ts` | Cache versioning |

### Prerequisites

- ffmpeg and ffprobe must be installed (`brew install ffmpeg` on macOS)
- hls.js npm package (added in Task 4)

### Cache Location

HLS chunks cached in `/tmp/dash-replay-hls/` with structure:
```
/tmp/dash-replay-hls/{type}/{eventId}/{segment}/{camera}/
  stream.m3u8
  chunk_000.ts
  chunk_001.ts
  ...
```

Auto-cleaned by OS on reboot. Re-segmentation is fast (~1-2s per file, copy mode).
