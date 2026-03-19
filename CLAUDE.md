# CLAUDE.md

## Project Overview

TeslaCam Replay is a full-stack TypeScript application for browsing and replaying Tesla dashcam footage with synchronized multi-camera playback. It supports local disk and Google Drive storage backends, on-demand HLS streaming via ffmpeg, and telemetry overlay from H.264 SEI metadata.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite 7, HLS.js
- **Backend**: Node.js, Hono, tsx (TypeScript runtime)
- **Testing**: Vitest
- **Video**: ffmpeg (HLS segmentation), protobufjs (telemetry parsing)
- **Storage**: Local filesystem or Google Drive (googleapis)
- **Deployment**: Docker (Node 22 Alpine + ffmpeg), GitHub Pages (frontend only)

## Repository Structure

```
src/                    # Frontend (React + TypeScript)
  App.tsx               # Root component, hash-based routing, event state
  api.ts                # API client (events, HLS, telemetry, OAuth)
  types.ts              # Shared TypeScript interfaces
  useTelemetry.ts       # Custom hook for telemetry frame syncing
  components/
    Player.tsx          # Multi-camera synchronized video player
    EventBrowser.tsx    # Event list with filtering, search, pagination
    Timeline.tsx        # Zoomable/pannable timeline visualization
    TelemetryOverlay.tsx # Speed, GPS, steering overlay
    SetupScreen.tsx     # Google Drive OAuth onboarding
server/                 # Backend (Hono + Node.js)
  index.ts              # Main server, API routes, caching, middleware
  scan.ts               # Folder scanner (SavedClips, SentryClips, RecentClips)
  hls.ts                # On-demand HLS segmentation via ffmpeg
  sei.ts                # Telemetry extraction from H.264 SEI metadata
  storage.ts            # StorageBackend interface + LocalStorage impl
  google-drive.ts       # Google Drive storage backend
  oauth.ts              # OAuth token persistence
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
docker run -p 3001:3001 -v /path/to/teslacam:/data teslacam-replay
```

## Architecture

### Frontend
- **State management**: React hooks only (no external state library)
- **Routing**: Hash-based (`#/event/SavedClips/...`), parsed in App.tsx
- **Caching**: localStorage for events, auto-refresh polling (30s interval)
- **Styling**: Component-scoped CSS files + global CSS variables in `index.css` (dark theme)
- **Error handling**: React ErrorBoundary class component in App.tsx

### Backend
- **Storage abstraction**: `StorageBackend` interface in `storage.ts` — local and Google Drive implementations are interchangeable
- **Event caching**: In-memory + disk cache at `~/.cache/teslacam-replay/events.json` with version tracking (CACHE_VERSION)
- **HLS streaming**: On-demand ffmpeg transcoding/remuxing with segment caching at `~/.cache/teslacam-replay/hls/`
- **Incremental scanning**: Tracks cutoff timestamps to skip already-scanned folders on refresh
- **Auto-refresh**: Background scan loop configurable via `AUTO_REFRESH_INTERVAL` env var

### Multi-Camera Sync
- 6 cameras: front, back, left_repeater, right_repeater, left_pillar, right_pillar
- HLS.js per camera with 150ms sync threshold and 200ms drift check interval
- Layout modes: grid (3x2) and focus (single camera)

## Development Notes

### Dev Server Proxy
Vite proxies `/api` requests to `http://localhost:3001` during development (configured in `vite.config.ts`).

### Environment Setup
Copy `.env.example` to `.env` and configure:
- `STORAGE_BACKEND`: `local` (default) or `googledrive`
- `TESLACAM_PATH`: Path to dashcam folder (required for local storage)
- `PORT`: Server port (default 3001)
- Google Drive OAuth credentials if using Drive backend

### Testing Patterns
- Tests use Vitest with `vi.fn()` for mocking
- Mock storage backends for integration tests
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
- Scan batch size: 50 folders
- Auto-refresh default: 300 seconds (5 minutes)
