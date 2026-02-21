# DashReplay

Web app for browsing and replaying Tesla dashcam footage.

## Prerequisites

- Node.js 22+
- ffmpeg (used for on-demand HLS segmentation)
- Tesla dashcam footage (local or cloud-synced)

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` to point at your TeslaCam folder:

```
TESLACAM_PATH=/path/to/your/teslacam/folder
```

The folder should contain any combination of `SavedClips/`, `SentryClips/`, and `RecentClips/` directories as written by the Tesla dashcam.

## Development

```bash
npm run dev
```

Opens the frontend at http://localhost:5173 with the API server on port 3001. Both hot-reload on file changes.

## Production

```bash
npm run build
npm run start
```

Serves the built SPA and API together on port 3001.

## How it works

The server scans the TeslaCam folder structure, extracts event metadata (timestamps, locations, trigger reasons), and serves video via on-demand HLS streaming -- ffmpeg segments each MP4 into chunks on first request, then caches the result. The frontend plays back all available camera angles (up to 6) in sync, with a zoomable timeline, segment navigation, keyboard shortcuts, and optional telemetry overlay (speed, steering, autopilot state) extracted from H.264 SEI data.
