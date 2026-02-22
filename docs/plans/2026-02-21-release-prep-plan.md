# DashReplay Public Release Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prepare DashReplay for public release with cleanup, configurable backend URL, GitHub Pages deployment, and documentation.

**Architecture:** The frontend becomes a standalone static site deployable to GitHub Pages. A `?server=` URL parameter lets it point at any self-hosted backend. The backend enables CORS unconditionally so cross-origin frontends can connect.

**Tech Stack:** Vite (static build), GitHub Actions (CI/CD), Hono (CORS config)

---

### Task 1: Delete test artifacts

**Files:**
- Delete: `player-loaded.png`, `rapid-advance.png`, `seek-test-1.png`, `seek-test-2.png`, `segment-2.png`, `segment-23.png`, `segment-24.png`, `sentry-clip-test.png`, `test-recent-navigated.png`, `test-recent-player-with-timeline.png`, `test-recent-timeline.png`, `test-sentry-player.png`
- Delete: `.playwright-mcp/` directory (all console log files)

**Step 1: Delete all PNG screenshots and playwright logs**

```bash
rm -f player-loaded.png rapid-advance.png seek-test-1.png seek-test-2.png \
      segment-2.png segment-23.png segment-24.png sentry-clip-test.png \
      test-recent-navigated.png test-recent-player-with-timeline.png \
      test-recent-timeline.png test-sentry-player.png
rm -rf .playwright-mcp/
```

**Step 2: Update .gitignore**

Add to `.gitignore`:

```
*.png
.playwright-mcp/
```

**Step 3: Commit**

```bash
git add .gitignore
git commit -m "Clean up test artifacts and update .gitignore"
```

---

### Task 2: Configurable API base URL

**Files:**
- Modify: `src/api.ts` (entire file — replace hardcoded `BASE` with `getApiBase()`)

**Step 1: Rewrite `src/api.ts`**

Replace the entire file with:

```ts
import type { DashcamEvent, TelemetryData } from "./types";

const STORAGE_KEY = "dashreplay:api-url";

function initApiBase(): string {
  const params = new URLSearchParams(window.location.search);
  const serverParam = params.get("server");
  if (serverParam) {
    // Normalize: strip trailing slash, ensure /api suffix
    const base = serverParam.replace(/\/+$/, "");
    const url = base.endsWith("/api") ? base : `${base}/api`;
    localStorage.setItem(STORAGE_KEY, url);
    // Remove ?server= from URL to keep it clean
    params.delete("server");
    const clean = params.toString();
    const newUrl = window.location.pathname + (clean ? `?${clean}` : "") + window.location.hash;
    window.history.replaceState(null, "", newUrl);
    return url;
  }
  return localStorage.getItem(STORAGE_KEY) || "/api";
}

const API_BASE = initApiBase();

export function getApiBase(): string {
  return API_BASE;
}

export async function fetchEvents(): Promise<DashcamEvent[]> {
  const res = await fetch(`${API_BASE}/events`);
  if (!res.ok) throw new Error(`Failed to fetch events: ${res.status}`);
  return res.json();
}

export async function refreshEvents(): Promise<DashcamEvent[]> {
  const res = await fetch(`${API_BASE}/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to refresh: ${res.status}`);
  return res.json();
}

export function thumbnailUrl(type: string, id: string): string {
  return `${API_BASE}/events/${type}/${id}/thumbnail`;
}

export async function fetchTelemetry(
  type: string,
  eventId: string,
  segment: string
): Promise<TelemetryData | null> {
  try {
    const res = await fetch(`${API_BASE}/video/${type}/${eventId}/${segment}/telemetry`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.hasSei ? data : null;
  } catch {
    return null;
  }
}

export function hlsManifestUrl(
  type: string,
  eventId: string,
  segment: string,
  camera: string
): string {
  return `${API_BASE}/hls/${type}/${eventId}/${segment}/${camera}/stream.m3u8`;
}
```

**Step 2: Verify the build compiles**

```bash
npx tsc --noEmit && npx vite build
```

Expected: clean build, no errors.

**Step 3: Commit**

```bash
git add src/api.ts
git commit -m "Make API base URL configurable via ?server= parameter

Reads from URL param, persists to localStorage, falls back to /api.
Enables GitHub Pages frontend to connect to any self-hosted backend."
```

---

### Task 3: Enable CORS unconditionally on server

**Files:**
- Modify: `server/index.ts:34-37`

**Step 1: Change CORS to always-on**

Replace lines 34-37 in `server/index.ts`:

```ts
// CORS for dev (not needed in production since we serve the SPA)
if (process.env.NODE_ENV !== "production") {
  app.use("/api/*", cors());
}
```

With:

```ts
// CORS: allow cross-origin requests so the frontend can be hosted separately
// (e.g., GitHub Pages pointing at a self-hosted backend)
app.use("/api/*", cors());
```

**Step 2: Verify server starts**

```bash
NODE_ENV=production node --import tsx/esm -e "
  import { Hono } from 'hono';
  import { cors } from 'hono/cors';
  const app = new Hono();
  app.use('/api/*', cors());
  console.log('CORS middleware attached OK');
"
```

Expected: prints "CORS middleware attached OK"

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "Enable CORS unconditionally for cross-origin frontend support"
```

---

### Task 4: Configure Vite for relative asset paths

**Files:**
- Modify: `vite.config.ts`

**Step 1: Add `base: './'` to Vite config**

Replace `vite.config.ts` with:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
```

**Step 2: Build and verify assets use relative paths**

```bash
npx vite build
grep -o 'src="[^"]*"' dist/index.html
grep -o 'href="[^"]*"' dist/index.html
```

Expected: paths start with `./` not `/`.

**Step 3: Commit**

```bash
git add vite.config.ts
git commit -m "Use relative asset paths for GitHub Pages compatibility"
```

---

### Task 5: Add GitHub Actions workflow for Pages deployment

**Files:**
- Create: `.github/workflows/deploy.yml`

**Step 1: Create the workflow file**

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

**Step 2: Commit**

```bash
mkdir -p .github/workflows
git add .github/workflows/deploy.yml
git commit -m "Add GitHub Actions workflow for Pages deployment"
```

---

### Task 6: Add LICENSE file

**Files:**
- Create: `LICENSE`

**Step 1: Create MIT license**

```
MIT License

Copyright (c) 2026 Ben Zhang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Step 2: Commit**

```bash
git add LICENSE
git commit -m "Add MIT license"
```

---

### Task 7: Update package.json metadata

**Files:**
- Modify: `package.json`

**Step 1: Add license, description, repository, homepage fields**

Update `package.json` — add/change these top-level fields (keep everything else as-is):

```json
{
  "name": "dash-replay",
  "version": "1.0.0",
  "description": "Web app for browsing and replaying Tesla dashcam footage with synchronized multi-camera playback",
  "license": "MIT",
  "homepage": "https://github.com/bzhang/dash-replay",
  "repository": {
    "type": "git",
    "url": "https://github.com/bzhang/dash-replay.git"
  },
  "private": true,
  ...
}
```

Note: The `homepage` and `repository` URLs should be updated to the actual GitHub repo URL once created. Use placeholder for now.

**Step 2: Commit**

```bash
git add package.json
git commit -m "Update package.json with license, description, and repo metadata"
```

---

### Task 8: Rewrite README.md

**Files:**
- Modify: `README.md`

**Step 1: Rewrite README**

```markdown
# DashReplay

Web app for browsing and replaying Tesla dashcam footage with synchronized multi-camera playback.

## Features

- **Multi-camera sync** — Play all 6 Tesla camera angles simultaneously in grid or focus layout
- **Event browser** — Browse SavedClips, SentryClips, and RecentClips with search, filter, and sort
- **Telemetry overlay** — Speed, steering angle, and autopilot state from H.264 SEI metadata
- **Zoomable timeline** — Scroll-wheel zoom, minimap, drag-to-pan, auto-follow playhead
- **Keyboard shortcuts** — Space (play/pause), arrows (seek), F (layout), 1-6 (camera), and more
- **HLS streaming** — On-demand segmentation via ffmpeg, cached for instant replay
- **Wall-clock time** — Real timestamps displayed during playback

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [ffmpeg](https://ffmpeg.org/) (used for on-demand HLS segmentation)
- Tesla dashcam footage (local or cloud-synced)

### Local Setup

```bash
git clone https://github.com/bzhang/dash-replay.git
cd dash-replay
npm install
cp .env.example .env
```

Edit `.env` to point at your TeslaCam folder:

```
TESLACAM_PATH=/path/to/your/teslacam/folder
```

The folder should contain `SavedClips/`, `SentryClips/`, and/or `RecentClips/` directories as written by the Tesla dashcam.

### Development

```bash
npm run dev
```

Opens the frontend at http://localhost:5173 with the API server on port 3001. Both hot-reload.

### Production

```bash
npm run build
npm start
```

Serves the built frontend and API together on port 3001.

### Hosted Frontend

The frontend is deployed to GitHub Pages. To use it with your own server:

1. Start the backend on your machine:
   ```bash
   npm run build && npm start
   ```

2. Open the hosted frontend with your server URL:
   ```
   https://<username>.github.io/dash-replay/?server=http://localhost:3001
   ```

   The server URL is saved in your browser — you only need the `?server=` parameter once.

> **Note:** Your backend must be accessible from your browser. For remote access, consider a reverse proxy or SSH tunnel.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TESLACAM_PATH` | Yes | — | Path to your TeslaCam folder |
| `PORT` | No | `3001` | Server port |
| `NODE_ENV` | No | — | Set to `production` to serve the built frontend |

## How It Works

The server scans the TeslaCam folder structure, extracts event metadata (timestamps, locations, trigger reasons), and caches the result. Video is served via on-demand HLS streaming — ffmpeg segments each MP4 into chunks on first request, then caches them.

The frontend plays all camera angles in sync using a wall-clock time model: a timer advances the display time during playback, and each video element syncs to it independently. This handles cameras with different durations gracefully.

Telemetry data (speed, steering, autopilot state) is extracted from H.264 SEI NAL units embedded by newer Tesla firmware (2025.44.25+, HW3+) and overlaid on the video.

## License

[MIT](LICENSE)
```

**Step 2: Update .env.example to document all variables**

Replace `.env.example`:

```
# Path to your TeslaCam folder (required)
TESLACAM_PATH=/path/to/your/teslacam/folder

# Server port (optional, default: 3001)
# PORT=3001
```

**Step 3: Commit**

```bash
git add README.md .env.example
git commit -m "Rewrite README with deployment guide and full documentation"
```

---

### Task 9: Final verification

**Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

**Step 2: Run Vite build**

```bash
npx vite build
```

Expected: clean build.

**Step 3: Run tests**

```bash
npm test
```

Expected: all tests pass.

**Step 4: Verify no sensitive files**

```bash
git status
# Should show no untracked sensitive files
```

**Step 5: Review git log**

```bash
git log --oneline -10
```

Verify all commits look clean and well-described.
