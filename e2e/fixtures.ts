import type { Page, Route } from "@playwright/test";

// --- Mock event data ---

export interface MockEvent {
  id: string;
  type: "SavedClips" | "SentryClips" | "RecentClips";
  timestamp: string;
  city?: string;
  lat?: number;
  lon?: number;
  reason?: string;
  camera?: string;
  hasThumbnail: boolean;
  clips: {
    timestamp: string;
    cameras: string[];
    durationSec: number;
    subfolder?: string;
  }[];
  totalDurationSec: number;
}

export const SAVED_EVENTS: MockEvent[] = [
  {
    id: "2025-06-15_14-30-00",
    type: "SavedClips",
    timestamp: "2025-06-15T14:30:00",
    city: "San Francisco",
    lat: 37.7749,
    lon: -122.4194,
    reason: "user_interaction_dashcam_icon_tapped",
    camera: "front",
    hasThumbnail: true,
    clips: [
      { timestamp: "2025-06-15_14-29-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      { timestamp: "2025-06-15_14-30-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      { timestamp: "2025-06-15_14-31-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
    ],
    totalDurationSec: 180,
  },
  {
    id: "2025-06-14_09-15-00",
    type: "SavedClips",
    timestamp: "2025-06-14T09:15:00",
    city: "Palo Alto",
    lat: 37.4419,
    lon: -122.143,
    reason: "user_interaction_dashcam_icon_tapped",
    hasThumbnail: true,
    clips: [
      { timestamp: "2025-06-14_09-14-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      { timestamp: "2025-06-14_09-15-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
    ],
    totalDurationSec: 120,
  },
  {
    id: "2025-06-14_08-00-00",
    type: "SavedClips",
    timestamp: "2025-06-14T08:00:00",
    city: "Mountain View",
    hasThumbnail: false,
    clips: [
      { timestamp: "2025-06-14_08-00-00", cameras: ["front", "back"], durationSec: 60 },
    ],
    totalDurationSec: 60,
  },
];

export const SENTRY_EVENTS: MockEvent[] = [
  {
    id: "2025-06-15_22-45-00",
    type: "SentryClips",
    timestamp: "2025-06-15T22:45:00",
    city: "San Jose",
    lat: 37.3382,
    lon: -121.8863,
    reason: "sentry_aware_object_detection",
    camera: "front",
    hasThumbnail: true,
    clips: [
      { timestamp: "2025-06-15_22-44-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      { timestamp: "2025-06-15_22-45-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
    ],
    totalDurationSec: 120,
  },
  {
    id: "2025-06-13_03-20-00",
    type: "SentryClips",
    timestamp: "2025-06-13T03:20:00",
    city: "Fremont",
    reason: "sentry_aware_object_detection",
    hasThumbnail: true,
    clips: [
      { timestamp: "2025-06-13_03-19-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      { timestamp: "2025-06-13_03-20-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      { timestamp: "2025-06-13_03-21-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      { timestamp: "2025-06-13_03-22-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
    ],
    totalDurationSec: 240,
  },
];

export const RECENT_EVENTS: MockEvent[] = [
  {
    id: "2025-06-15_17-00-00",
    type: "RecentClips",
    timestamp: "2025-06-15T17:00:00",
    hasThumbnail: false,
    clips: [
      { timestamp: "2025-06-15_17-00-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60, subfolder: "2025-06-15" },
      { timestamp: "2025-06-15_17-01-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60, subfolder: "2025-06-15" },
      { timestamp: "2025-06-15_17-02-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60, subfolder: "2025-06-15" },
    ],
    totalDurationSec: 180,
  },
];

export const ALL_EVENTS: MockEvent[] = [
  ...SENTRY_EVENTS,
  ...SAVED_EVENTS,
  ...RECENT_EVENTS,
].sort((a, b) => b.id.localeCompare(a.id));

export const MOCK_STATUS = {
  connected: true,
  storageBackend: "Local",
  storagePath: "/test/teslacam",
  eventCount: ALL_EVENTS.length,
  scanning: false,
};

export const MOCK_CACHES = {
  caches: [
    { id: "events-disk", label: "Event scan cache", path: "./cache/events.json", sizeBytes: 4096 },
    { id: "events-memory", label: "Event scan (memory)", path: null, entryCount: ALL_EVENTS.length },
    { id: "hls", label: "HLS segments", path: "./cache/hls", sizeBytes: 1048576 },
    { id: "gdrive-downloads", label: "Drive file downloads", path: "./cache/downloads", sizeBytes: 0 },
    { id: "gdrive-dirs", label: "Drive directory listings (memory)", path: null, entryCount: 0 },
    { id: "telemetry", label: "Telemetry (memory)", path: null, entryCount: 5 },
    { id: "oauth-token", label: "OAuth token", path: "./cache/token.json", sizeBytes: 256 },
  ],
};

// 1x1 red PNG pixel for thumbnail mocking
const RED_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * Set up API route mocking for all standard endpoints.
 * Returns helpers to modify mock state during tests.
 */
export async function mockApi(page: Page, options?: {
  events?: MockEvent[];
  status?: typeof MOCK_STATUS;
}) {
  const state = {
    events: options?.events ?? ALL_EVENTS,
    status: options?.status ?? MOCK_STATUS,
    refreshCount: 0,
  };

  // Mock /api/status
  await page.route("**/api/status", async (route: Route) => {
    await route.fulfill({
      json: { ...state.status, eventCount: state.events.length },
    });
  });

  // Mock /api/events
  await page.route("**/api/events", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: state.events });
    } else {
      await route.continue();
    }
  });

  // Mock /api/events/:type/:id (single event)
  await page.route(/\/api\/events\/(SavedClips|SentryClips|RecentClips)\/[\w-]+$/, async (route: Route) => {
    const url = route.request().url();
    // Check if it's a thumbnail request (has /thumbnail suffix)
    if (url.endsWith("/thumbnail")) {
      await route.continue();
      return;
    }
    const match = url.match(/\/api\/events\/([\w]+)\/([\w-]+)$/);
    if (match) {
      const event = state.events.find(e => e.type === match[1] && e.id === match[2]);
      if (event) {
        await route.fulfill({ json: event });
      } else {
        await route.fulfill({ status: 404, json: { error: "Event not found" } });
      }
    }
  });

  // Mock /api/events/:type/:id/thumbnail
  await page.route(/\/api\/events\/.*\/thumbnail$/, async (route: Route) => {
    await route.fulfill({
      contentType: "image/png",
      body: RED_PIXEL_PNG,
    });
  });

  // Mock /api/refresh
  await page.route("**/api/refresh", async (route: Route) => {
    state.refreshCount++;
    await route.fulfill({ json: state.events });
  });

  // Mock /api/debug/caches
  await page.route("**/api/debug/caches", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: MOCK_CACHES });
    }
  });

  // Mock /api/debug/caches/:id/clear
  await page.route("**/api/debug/caches/*/clear", async (route: Route) => {
    await route.fulfill({ json: { ok: true } });
  });

  // Mock telemetry (no SEI data)
  await page.route("**/api/video/*/telemetry", async (route: Route) => {
    await route.fulfill({ json: { hasSei: false } });
  });

  // Mock HLS manifest (minimal valid manifest)
  await page.route("**/*.m3u8", async (route: Route) => {
    await route.fulfill({
      contentType: "application/vnd.apple.mpegurl",
      body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:4.0,\nchunk_000.ts\n#EXT-X-ENDLIST\n",
    });
  });

  return state;
}
