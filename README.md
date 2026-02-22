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
│  any static host │         │  files from disk   │
└──────────────────┘         └──────────────────┘
```

The frontend is a static SPA that can be hosted anywhere. The backend serves the API and streams video via HLS. They can run on the same machine or separately — the frontend can point to any backend URL.

## Quick Start

### Prerequisites

- Node.js 22+
- ffmpeg installed and on PATH
- Tesla dashcam footage (USB drive or synced folder)

### Local Development

```bash
# Clone and install
git clone https://github.com/ben-z/teslacam-replay.git
cd teslacam-replay
npm install

# Configure
cp .env.example .env
# Edit .env and set TESLACAM_PATH to your dashcam folder

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
  -v /path/to/TeslaCam:/data:ro \
  -e TESLACAM_PATH=/data \
  ghcr.io/ben-z/teslacam-replay
```

**API-only** (use with GitHub Pages or another frontend host):

```bash
docker run -d \
  -p 3001:3001 \
  -v /path/to/TeslaCam:/data:ro \
  -e TESLACAM_PATH=/data \
  -e SERVE_FRONTEND=false \
  ghcr.io/ben-z/teslacam-replay
```

Tags available: `latest` and full commit SHA (e.g., `sha-a1b2c3d4e5f6...`).

### GitHub Pages + Remote Backend

The frontend is automatically deployed to GitHub Pages on push to `main`. To connect it to your backend:

1. Start the backend on your machine:
   ```bash
   TESLACAM_PATH=/path/to/teslacam npm start
   ```

2. Open the GitHub Pages URL with a `?server=` parameter:
   ```
   https://your-username.github.io/teslacam-replay/?server=http://your-server:3001
   ```

The server URL is saved to localStorage, so you only need the `?server=` parameter once. To change it later, add the parameter again with a new URL.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `TESLACAM_PATH` | Yes | Path to Tesla dashcam folder (e.g., `/mnt/usb/TeslaCam`) |
| `PORT` | No | Server port (default: `3001`) |
| `SERVE_FRONTEND` | No | Set to `true` to serve the frontend from `dist/` (default: `true` in Docker) |

## Dashcam Folder Structure

DashReplay expects the standard Tesla dashcam folder layout:

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
