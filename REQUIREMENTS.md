# DashReplay

A web application for browsing and reviewing Tesla dashcam footage with synchronized multi-camera playback.

## Motivation

Tesla vehicles record dashcam footage from 6 cameras (front, back, left repeater, right repeater, left pillar, right pillar), saved as separate MP4 files. Reviewing this footage is tedious: the Tesla app only shows a pre-rendered single view, and manually opening individual files provides no synchronization or context.

DashReplay provides a local web interface to browse events, play all camera angles in sync, and (when available) overlay telemetry data extracted from embedded SEI metadata.

## Data Format

### Folder Structure

```
teslacam/
  SavedClips/           # User-triggered saves (honk, dashcam button)
    2025-06-01_18-17-49/
      event.json
      event.mp4          # Pre-rendered single-angle video (optional)
      thumb.png           # Thumbnail (optional)
      2025-06-01_18-07-09-front.mp4
      2025-06-01_18-07-09-back.mp4
      2025-06-01_18-07-09-left_repeater.mp4
      2025-06-01_18-07-09-right_repeater.mp4
      2025-06-01_18-07-09-left_pillar.mp4
      2025-06-01_18-07-09-right_pillar.mp4
      2025-06-01_18-08-10-front.mp4   # Next 1-min segment
      ...
  SentryClips/          # Sentry mode detections
    2025-11-08_16-41-34/
      event.json
      thumb.png
      ...                # Same clip structure as above
  RecentClips/          # Rolling buffer of recent driving footage
    ...                  # Loose MP4 files
```

### Key Details

- Each event folder contains multiple **1-minute segments**, each with **6 camera angles**
- Clip filenames encode the timestamp and camera: `{YYYY-MM-DD_HH-MM-SS}-{camera}.mp4`
- The event folder name is the timestamp of the **trigger** (save button press, sentry detection)
- Clips within an event span ~10 minutes before the trigger
- Front camera clips are ~78 MB; side/rear cameras are ~40 MB each
- `event.json` contains: `timestamp`, `city`, `est_lat`, `est_lon`, `reason`, `camera`

### SEI Metadata

Newer clips (firmware 2025.44.25+, HW3+) embed telemetry in H.264 SEI NAL units:
- Vehicle speed, steering angle, autopilot state
- Defined by `dashcam.proto` in [teslamotors/dashcam](https://github.com/teslamotors/dashcam)
- Extractable via their `dashcam-mp4.js` (browser) or `sei_extractor.py` (CLI)
- **Not present in older clips** — the app must handle both cases gracefully

## Requirements

### v0: Synchronized Multi-Camera Viewer

**Event Browser**
- Scan a configured teslacam folder and list all events (SavedClips + SentryClips)
- Show event metadata: date/time, city, GPS coordinates, trigger reason
- Show thumbnail when available
- Sort by date, filter by type (Saved vs Sentry)

**Synchronized Playback**
- Play all 6 camera angles for an event in sync
- Unified transport controls: play/pause, seek, playback speed
- Automatically advance through 1-minute segments seamlessly
- Layout options: grid view (all 6), single-camera with selector, or focus+context (1 large + 5 small)
- Synchronization strategy:
  - **With SEI data**: use embedded timestamps for frame-accurate sync
  - **Without SEI data**: sync by matching filename timestamps (all clips from the same segment share a timestamp and start simultaneously)

**Video Serving**
- Backend serves MP4 files with HTTP range request support (seeking)
- No transcoding — serve original files directly

### Future Ideas (not in scope for v0)

- Telemetry overlay (speed, steering, GPS on a map) from SEI data
- Timeline scrubber with event markers
- Frame export / screenshot
- Clip trimming and export
- Search across events (by location, date range, trigger type)
- RecentClips support (continuous driving footage, no event structure)
- AI-powered analysis (incident detection, object tracking)

## Tech Considerations

- **This is a local-first tool** — footage stays on disk, served directly by the backend
- Footage folder may be large (499 SavedClips + 309 SentryClips in the sample dataset)
- Files may live on cloud-synced drives (Google Drive) — avoid excessive file scanning
- Browser video playback of 6 simultaneous HD streams requires attention to performance
