# TeslaCam Replay

Web app for browsing and replaying Tesla dashcam footage with synchronized multi-camera playback.

## Features

- **Multi-camera player** — Synchronized playback of all 6 cameras (front, back, left repeater, right repeater, left pillar, right pillar) in grid or focus layout
- **Event browser** — Browse Saved, Sentry, and Recent clips with search, filter, sort, and thumbnail previews
- **Timeline view** — Color-coded timeline showing all recording sessions across days
- **HLS streaming** — On-demand video segmentation via ffmpeg for smooth playback without downloading entire files
- **Telemetry overlay** — Speed, GPS coordinates, and other data extracted from H.264 SEI metadata
- **Zoomable seek bar** — Scroll to zoom, drag to pan, minimap for orientation
- **Keyboard shortcuts** — Space (play/pause), arrows (seek), F (layout), 1-6 (camera select), [ ] (prev/next event)
- **URL routing** — Hash-based deep links, browser back/forward support

## Architecture

```
┌──────────────────┐         ┌──────────────────┐
│  Static Frontend │  HTTP   │   Node.js Server  │
│  (React + Vite)  │ ──────> │   (Hono + ffmpeg) │
│                  │         │                    │
│  GitHub Pages /  │         │  Reads dashcam     │
│  any static host │         │  files via         │
│                  │         │  gdrive-serve-lite │
└──────────────────┘         └──────────────────┘
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
~/Projects/gdrive-serve-lite/gdrive-serve-lite \
  --remote gdrive-ro:/teslacam1 \
  --config ~/Projects/gdrive-serve-lite/rclone-gdrive-ro.conf \
  --metadata-cache-ttl 5m \
  --list-cache-ttl 30s \
  --drive-response-header-timeout 30s \
  --user gdrive-user \
  --pass gdrive-password \
  --allow-origin http://localhost:3000 \
  --baseurl /gdrive \
  --addr 127.0.0.1:8765

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
  -e GDRIVE_BASE_URL=http://host.docker.internal:8765/gdrive \
  -e GDRIVE_USER=gdrive-user \
  -e GDRIVE_PASS=gdrive-password \
  ghcr.io/ben-z/teslacam-replay
```

**API-only** (use with GitHub Pages or another frontend host):

```bash
docker run -d \
  -p 3001:3001 \
  -e GDRIVE_BASE_URL=http://host.docker.internal:8765/gdrive \
  -e GDRIVE_USER=gdrive-user \
  -e GDRIVE_PASS=gdrive-password \
  -e SERVE_FRONTEND=false \
  ghcr.io/ben-z/teslacam-replay
```

Tags available: `latest` and full commit SHA (e.g., `sha-a1b2c3d4e5f6...`).

### GitHub Pages + Remote Backend

The frontend is automatically deployed to GitHub Pages on push to `main`. To connect it to your backend:

1. Start the backend on your machine:
   ```bash
   GDRIVE_BASE_URL=http://127.0.0.1:8765/gdrive \
   GDRIVE_USER=gdrive-user \
   GDRIVE_PASS=gdrive-password \
   npm start
   ```

2. Open the GitHub Pages URL with a `?server=` parameter:
   ```
   https://your-username.github.io/teslacam-replay/?server=http://your-server:3001
   ```

The server URL is saved to localStorage, so you only need the `?server=` parameter once. To change it later, add the parameter again with a new URL.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GDRIVE_BASE_URL` | No | Base URL for `gdrive-serve-lite`, including `--baseurl` if configured. Defaults to `http://127.0.0.1:8765/gdrive` |
| `GDRIVE_USER` | No | Basic Auth username when `gdrive-serve-lite` uses `--user` |
| `GDRIVE_PASS` | No | Basic Auth password when `gdrive-serve-lite` uses `--pass` |
| `GDRIVE_LIST_TIMEOUT_MS` | No | Timeout for each Drive-lite listing page (default: `120000`) |
| `GDRIVE_METADATA_TIMEOUT_MS` | No | Timeout for small metadata reads such as `event.json` (default: `30000`) |
| `GDRIVE_READ_TIMEOUT_MS` | No | Timeout for larger file proxy reads used by thumbnails/telemetry (default: `300000`) |
| `EVENT_PAGE_SIZE` | No | Number of event folders requested per browse page (default: `48`) |
| `EVENT_PAGE_SCAN_CONCURRENCY` | No | Number of event folders scanned concurrently while building one page (default: `8`) |
| `GDRIVE_EVENT_ORDER_BY` | No | Drive order for Saved/Sentry event folders (default: `name desc`; RecentClips uses unsorted file pages for speed) |
| `PORT` | No | Server port (default: `3001`) |
| `SERVE_FRONTEND` | No | Set to `true` to serve the frontend from `dist/` (default: `true` in Docker) |

## Dashcam Folder Structure

TeslaCam Replay expects the standard Tesla dashcam folder layout:

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
    └── 2026-01-15_10-30-00-front.mp4
    └── ...
```

## Related

- [teslausb-ng](https://github.com/ben-z/teslausb-ng) — Runs onboard the vehicle to offload dashcam data automatically

## License

MIT
