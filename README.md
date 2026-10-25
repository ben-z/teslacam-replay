# TeslaCam Replay

Web app for browsing and replaying Tesla dashcam footage with synchronized multi-camera playback.

## Features

- **Multi-camera player** — Recordings open with a single active camera in Focus. Choose Grid for synchronized playback of all 6 cameras. Switching cameras preserves playback position and speed.
- **Recording browser** — Browse Saved, Sentry, and Recent recordings or view loaded recordings on a timeline. Search loaded recordings by displayed date, time, city, or reason.
- **Timeline view** — A common loaded date range across Recent, Saved, and Sentry footage; loading older history prioritizes sources that have not reached the same archive day
- **HLS streaming** — ffmpeg segments footage on demand so the browser loads video in chunks
- **Driving data on demand** — Select Driving data or press T to show speed, GPS coordinates, and other data extracted from H.264 SEI metadata
- **Zoomable seek bar** — Scroll to zoom, drag to pan, minimap for orientation
- **Keyboard shortcuts** — Space (play/pause), arrows (seek), F (layout), T (driving data), 1-6 (camera select), [ ] (previous/next recording)
- **URL routing** — Hash-based deep links, browser back/forward support

## Architecture

```
┌──────────────────┐         ┌────────────────────┐
│  Static Frontend │  HTTP   │  Node.js Server    │
│  (React + Vite)  │ ──────> │  Hono + ffmpeg     │
│                  │         │                    │
│  Same origin /  │         │  Reads dashcam     │
│  any static host │         │  files via         │
│                  │         │  gdrive-serve-lite │
└──────────────────┘         └────────────────────┘
```

The frontend is a static SPA that can be hosted anywhere. The backend serves the API, pages through TeslaCam folders via `gdrive-serve-lite`, and streams video via HLS. `gdrive-serve-lite` owns Google Drive auth, pagination, path resolution, and range-capable file reads.

## Quick Start

### Prerequisites

- Node.js 22+
- ffmpeg installed and on PATH
- `gdrive-serve-lite` serving the TeslaCam folder root

### Local Development

```bash
# Clone and install
git clone https://github.com/ben-z/teslacam-replay.git
cd teslacam-replay
npm install

# Start gdrive-serve-lite separately, for example:
/path/to/gdrive-serve-lite --remote gdrive-ro:/TeslaCam --addr 127.0.0.1:8765

# Configure this app
cp .env.example .env
# Edit .env if your gdrive-serve-lite URL or credentials differ

# Run (starts both frontend dev server and backend)
npm run dev
```

Opens at http://localhost:5173. The backend runs on port 3001.

### Production

```bash
npm run build
npm start
```

This builds the frontend to `dist/` and starts the server (which also serves the static files).

### Docker

The Docker image includes both the API server and the frontend. It's automatically built and pushed to `ghcr.io/ben-z/teslacam-replay` on every push to `main`.

**All-in-one** (serves frontend + API on a single port — the default):

```bash
docker run -d \
  -p 3001:3001 \
  -e GDRIVE_BASE_URL=http://host.docker.internal:8765 \
  ghcr.io/ben-z/teslacam-replay
```

The production frontend and API use the same HTTPS origin. Local development uses the Vite proxy to the API on port 3001.

Tags available: `latest` and full commit SHA (e.g., `sha-a1b2c3d4e5f6...`).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GDRIVE_BASE_URL` | No | Base URL for `gdrive-serve-lite`, including `--baseurl` if configured. Defaults to `http://127.0.0.1:8765` |
| `GDRIVE_USER` | No | Basic Auth username when `gdrive-serve-lite` uses `--user` |
| `GDRIVE_PASS` | No | Basic Auth password when `gdrive-serve-lite` uses `--pass` |
| `BASIC_AUTH_USER` | No | HTTP Basic Auth username for the frontend and API; must be set with `BASIC_AUTH_PASSWORD` |
| `BASIC_AUTH_PASSWORD` | No | HTTP Basic Auth password for the frontend and API; must be set with `BASIC_AUTH_USER` |
| `GDRIVE_LIST_TIMEOUT_MS` | No | Timeout for each Drive-lite listing page (default: `120000`) |
| `GDRIVE_METADATA_TIMEOUT_MS` | No | Timeout for small metadata reads such as `event.json` (default: `30000`) |
| `GDRIVE_READ_TIMEOUT_MS` | No | Timeout for larger file proxy reads used by thumbnails/telemetry (default: `300000`) |
| `EVENT_PAGE_SIZE` | No | Number of Saved/Sentry event folders requested per browse page (default: `48`; the app requests `24`) |
| `EVENT_PAGE_SCAN_CONCURRENCY` | No | Number of event folders scanned concurrently while building one page (default: `8`) |
| `GDRIVE_EVENT_ORDER_BY` | No | Must be `name desc` so archive-day paging can advance chronologically |
| `PORT` | No | Server port (default: `3001`) |
| `SERVE_FRONTEND` | No | Set to `true` to serve the frontend from `dist/` (default: `true` in Docker) |

The production Kubernetes deployment and release procedure are documented in
[`deploy/README.md`](deploy/README.md).

## Dashcam Folder Structure

TeslaCam Replay reads the standard Tesla dashcam folders and TeslaUSB archives:

```
TeslaCam/
├── SavedClips/
│   └── 2026-01-15_10-30-00/
│       ├── 2026-01-15_10-30-00-front.mp4
│       ├── 2026-01-15_10-30-00-back.mp4
│       ├── 2026-01-15_10-30-00-left_repeater.mp4
│       └── ...
├── SentryClips/
│   └── 2026-01-15_14-20-00/
│       └── ...
└── RecentClips/
    ├── 2026-01-15/
    │   └── 2026-01-15_10-30-00-front.mp4
    └── 2026-01-16/
        └── 2026-01-16_10-30-00-front.mp4
```

Recent footage lives in `RecentClips/YYYY-MM-DD/`, using each video filename's
recording date. Each Recent page loads one complete day of file metadata; Drive
pagination is handled internally. Videos are downloaded only for playback. The
root-level `metadata` folder is excluded from recording discovery. Flat files,
duplicate date folders, and videos in the wrong day fail with an explicit error.
Historical `RecentClips-before-YYYY-MM-DD` folders are not recording sources.
Migrate their videos into the dated layout before deploying this reader.

## Related

- [gdrive-serve-lite](https://github.com/ben-z/gdrive-serve-lite) — Lightweight Google Drive HTTP server with pagination and range-capable file reads
- [teslausb-ng](https://github.com/ben-z/teslausb-ng) — Runs onboard the vehicle to offload dashcam data automatically

## License

MIT
