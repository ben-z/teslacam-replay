# CLAUDE.md

## Project Overview

TeslaCam Replay is a full-stack TypeScript application for browsing and replaying Tesla dashcam footage with synchronized multi-camera playback. It reads Google Drive through `gdrive-serve-lite`, performs on-demand HLS streaming via ffmpeg, and shows telemetry extracted from H.264 SEI metadata.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite 7, HLS.js
- **Backend**: Node.js, Hono, tsx (TypeScript runtime)
- **Testing**: Vitest
- **Video**: ffmpeg (HLS segmentation), protobufjs (telemetry parsing)
- **Storage access**: `gdrive-serve-lite` HTTP API
- **Deployment**: Docker (Node 22 Alpine + ffmpeg), GitHub Pages (frontend only)

## Repository Structure

```
src/                    # Frontend (React + TypeScript)
  App.tsx               # Root component, hash-based routing, event state
  api.ts                # API client (events, HLS, telemetry)
  types.ts              # Shared TypeScript interfaces
  useTelemetry.ts       # Custom hook for telemetry frame syncing
  components/
    Player.tsx          # Multi-camera synchronized video player
    EventBrowser.tsx    # Event list with filtering, search, pagination
    Timeline.tsx        # Zoomable/pannable timeline visualization
    TelemetryOverlay.tsx # Speed, GPS, steering overlay
server/                 # Backend (Hono + Node.js)
  index.ts              # Main server, API routes, caching, middleware
  gdrive-lite.ts        # Thin HTTP client for gdrive-serve-lite
  scan.ts               # Drive listing scanner (SavedClips, SentryClips, RecentClips)
  hls.ts                # On-demand HLS segmentation via ffmpeg
  sei.ts                # Telemetry extraction from H.264 SEI metadata
  paths.ts              # Cache/config path constants
  dashcam.proto         # Protobuf schema for SEI telemetry
  *.test.ts             # Tests co-located with source
docs/                   # Design documents and plans
```

## Commands

```bash
# Install dependencies
npm install

# Development (starts both frontend + backend concurrently)
npm run dev
# Frontend only: http://localhost:5173 (Vite with HMR)
# Backend only: http://localhost:3001 (tsx with --watch)

# Production build
npm run build           # Builds frontend to dist/
npm start               # Runs server + serves frontend

# Run all tests
npm test                # Runs vitest in non-watch mode

# Docker
docker build -t teslacam-replay .
docker run -p 3001:3001 -e GDRIVE_BASE_URL=http://host.docker.internal:8765/gdrive teslacam-replay
```

## Architecture

### Frontend
- **State management**: React hooks only (no external state library)
- **Routing**: Hash-based (`#/event/SavedClips/...`), parsed in App.tsx
- **Caching**: localStorage for loaded event pages
- **Styling**: Component-scoped CSS files + global CSS variables in `index.css` (dark theme)
- **Error handling**: React ErrorBoundary class component in App.tsx

### Backend
- **Drive access**: `gdrive-lite.ts` talks to `gdrive-serve-lite`; file IDs and direct read URLs are retained while building pages so playback does not re-resolve paths
- **Event caching**: In-memory + disk cache at `~/.cache/teslacam-replay/events.json` with version tracking (CACHE_VERSION)
- **HLS streaming**: On-demand ffmpeg transcoding/remuxing with segment caching at `~/.cache/teslacam-replay/hls/`
- **Page-first browsing**: `/api/events/page` scans only the requested Drive page, then the player routes use the in-memory event index or single-folder resolution
- **Legacy full scan**: `/api/events` and `/api/refresh` still exist for full-catalog cache generation; `AUTO_REFRESH_INTERVAL` defaults to `0`

### Multi-Camera Sync
- 6 cameras: front, back, left_repeater, right_repeater, left_pillar, right_pillar
- HLS.js per camera with 150ms sync threshold and 200ms drift check interval
- Layout modes: grid (3x2) and focus (single camera)

## Development Notes

### Dev Server Proxy
Vite proxies `/api` requests to `http://localhost:3001` during development (configured in `vite.config.ts`).

### Environment Setup
Start `gdrive-serve-lite` separately, then copy `.env.example` to `.env` and configure:
- `GDRIVE_BASE_URL`: Base URL for `gdrive-serve-lite`, including its `--baseurl` path if set
- `GDRIVE_USER` / `GDRIVE_PASS`: Basic Auth credentials when Drive-lite is started with `--user` and `--pass`
- `GDRIVE_LIST_TIMEOUT_MS`, `GDRIVE_METADATA_TIMEOUT_MS`, `GDRIVE_READ_TIMEOUT_MS`: Optional request timeout knobs for large/slow Drive roots
- `EVENT_PAGE_SIZE`: Event folders requested per page (default 48)
- `EVENT_PAGE_SCAN_CONCURRENCY`: Event-folder scans per page (default 8)
- `GDRIVE_EVENT_ORDER_BY`: Saved/Sentry folder ordering (default `name desc`)
- `AUTO_REFRESH_INTERVAL`: Optional legacy full-catalog refresh interval (default 0)
- `PORT`: Server port (default 3001)

### Testing Patterns
- Tests use Vitest with `vi.fn()` for mocking
- Mock Drive-lite listings for scanner tests
- Tests are co-located with source in `server/` directory
- Run with `npm test` (non-watch mode)

### Code Conventions
- ES modules throughout (`"type": "module"` in package.json)
- TypeScript strict mode enabled
- No monorepo — single package.json for both frontend and backend
- Component CSS files are co-located with their components in `src/components/`
- Backend runs from TypeScript source via tsx (no separate compile step)

### CI/CD
- **docker.yml**: Builds and pushes Docker image to `ghcr.io/ben-z/teslacam-replay` on push to main
- **deploy.yml**: Builds frontend and deploys to GitHub Pages on push to main

### Key Constants
- HLS segment duration: 4 seconds
- Camera sync threshold: 150ms
- Session gap threshold: 120 seconds
- Events per page: 48
- Page scan concurrency: 8 folders
- Auto-refresh default: off
