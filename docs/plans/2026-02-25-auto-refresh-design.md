# Auto-Refresh Design

## Problem

Events are only discovered when the user manually clicks "Refresh". Since the app is opened on-demand to review footage, the initial scan can take minutes (especially on Google Drive). The user shouldn't have to wait.

## Solution

Two changes:

### Server-side: Background periodic scan

A `setInterval` in `server/index.ts` calls `getEvents(true)` (incremental scan) on a fixed interval. Events are always warm in the memory cache when the frontend requests them.

- Default interval: 5 minutes
- Configurable via `AUTO_REFRESH_INTERVAL` env var (seconds, `0` to disable)
- Skips if scan already in-flight (existing `scanPromise` dedup handles this)
- Logs when new events are discovered

### Frontend: Lightweight cache polling

The frontend polls `GET /api/events` (returns from memory cache, no scan) every ~30s while on the browse view.

- Skips polling while in the player view
- Compares event count to avoid unnecessary re-renders
- No UI controls — works silently

## What we're NOT building

- No new API endpoints
- No SSE/websockets
- No adaptive intervals
- No UI toggle for auto-refresh
