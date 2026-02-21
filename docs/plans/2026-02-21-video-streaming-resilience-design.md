# Design: Server-Side Pipe-Through Remux + Client Resilience

**Date:** 2026-02-21
**Status:** Approved

## Problem

Specific cameras intermittently show "failed to load" or pause mid-playback. When one camera stalls, the sync loop can drag all other cameras down, causing mixed behavior where sometimes everything freezes.

**Root causes identified:**
1. Server serves raw MP4 files with no validation — corrupt/truncated files return 200 OK
2. Client has no stall detection (`stalled`/`waiting` events ignored)
3. `syncAll` forces all cameras to match primary camera's `currentTime`, even when primary is stalled
4. No retry mechanism — once a camera errors, it's permanently failed

## Solution

### 1. Video Serving: Lazy On-Demand HLS (server/hls.ts + server/index.ts)

Replace raw file serving with lazy HLS segmentation:

**Current:** `fs.createReadStream(filePath)` with Range requests → HTTP response

**New:** On first request, ffmpeg segments the MP4 into 4-second `.ts` chunks + `.m3u8` manifest, cached in `/tmp/dash-replay-hls/`. Subsequent requests serve cached chunks as static files.

Key properties:
- **Copy-mode segmentation** (no transcoding) — ~1-2s per file
- **Instant seeking** — client requests only the chunk it needs
- **Per-chunk error isolation** — a corrupt chunk doesn't break the whole stream
- **Cacheable** — chunks served with `Cache-Control: public, max-age=86400`
- **Lazy** — only segments videos people actually watch, not the entire library
- **Deduplication** — concurrent requests for the same stream share one ffmpeg run
- Client uses **hls.js** (~50KB gzipped) for playback; Safari uses native HLS

### 2. Validation at Scan Time (server/scan.ts)

Run `ffprobe -v error -show_entries format=duration` on each MP4 during scan:
- Extract real duration (replacing the current timestamp-diff estimation)
- If ffprobe errors, exclude that camera from `EventClip.cameras[]`
- Fast — ffprobe reads only headers, <100ms per file

### 3. Client-Side Stall Resilience (src/components/Player.tsx)

Minimal changes since server now guarantees stream validity:

- **Stall detection:** Add `waiting`/`playing` event listeners per camera. Show a buffering indicator overlay when a camera is in `waiting` state.
- **Resilient sync:** `syncAll` skips cameras in `waiting` state. If the primary camera (front) stalls, temporarily use the next healthy camera as sync reference.
- **Retry:** If a camera stalls for >5s, show a soft error with a retry button (re-request the stream). On segment change, reset all error states.

### 4. Duration Accuracy (src/types.ts)

`EventClip.durationSec` is now sourced from ffprobe (actual MP4 duration) rather than timestamp-diff estimation. No type changes needed, just more accurate values.

## Files Changed

| File | Change |
|---|---|
| `server/hls.ts` | New — lazy HLS segmentation module |
| `server/index.ts` | Replace raw video route with HLS manifest + chunk routes |
| `server/scan.ts` | Add ffprobe validation + real duration extraction at scan time |
| `src/api.ts` | Replace `videoUrl()` with `hlsManifestUrl()` |
| `src/components/Player.tsx` | Use hls.js per camera, stall detection, resilient sync, retry |
| `src/components/Player.css` | Buffering + retry button styles |
| `package.json` | Add hls.js dependency |

## Trade-offs

- **ffmpeg dependency:** Server now requires ffmpeg/ffprobe installed. Acceptable for a local/self-hosted tool.
- **First-request latency:** ~1-2s on first view of a camera (segmentation). Cached afterward.
- **Disk usage in /tmp:** ~same size as source videos for chunks actually viewed. Auto-cleaned on reboot.
- **hls.js dependency:** ~50KB gzipped. Safari has native HLS support as fallback.
