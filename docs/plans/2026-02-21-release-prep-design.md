# DashReplay Public Release Design

## Overview

Prepare DashReplay for public release: cleanup, configurable deployment, GitHub Pages hosting, documentation, and MIT licensing.

## 1. Cleanup

- Delete 13 test screenshot PNGs from project root
- Delete `.playwright-mcp/` directory (Playwright console logs)
- Update `.gitignore`: add `*.png`, `.playwright-mcp/`
- No sensitive info found in source (`.env` already gitignored)
- Console.log statements are appropriate operational logging — no changes

## 2. Configurable Backend URL

**Problem:** Frontend hardcodes `const BASE = "/api"` which only works when backend serves the frontend. GitHub Pages needs to point to a remote backend.

**Solution:** `?server=http://host:port` URL parameter.
- If `?server=` param present, save to `localStorage("dashreplay:api-url")` and use as API base
- If localStorage has a saved URL, use it
- Otherwise default to `/api` (same-origin, works for local `npm start`)
- All `api.ts` functions use `getApiBase()` instead of hardcoded constant
- HLS manifest URLs must also be absolute when pointing to a remote server

**Server CORS:** Enable CORS always (remove the `NODE_ENV !== "production"` guard) so GitHub Pages frontend can reach any backend.

## 3. GitHub Actions → GitHub Pages

- `.github/workflows/deploy.yml`: on push to `main`, build Vite frontend, deploy to Pages
- `vite.config.ts`: add `base: './'` for relative asset paths
- Only the static frontend is deployed; backend is always self-hosted

## 4. Documentation

**README.md rewrite:**
- Project description
- Quick start: local (npm) and hosted (GitHub Pages + remote server)
- Environment variables reference (TESLACAM_PATH, PORT, NODE_ENV)
- Architecture overview
- License

**New files:**
- `LICENSE` (MIT)
- `.github/workflows/deploy.yml`

**package.json updates:**
- Add `license: "MIT"`
- Add `repository`, `description`, `homepage` fields

## 5. No Major Refactors

Codebase is clean: no dead code, no TODOs, no commented-out code, proper error handling throughout. Player.tsx is large (1150 lines) but cohesive — not worth splitting for its own sake.

## Non-goals

- Docker support (can add later)
- Authentication / rate limiting (local tool, not a SaaS)
- API versioning
- Breaking up Player.tsx
