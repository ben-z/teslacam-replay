import { test, expect } from "@playwright/test";
import { mockApi, ALL_EVENTS, type MockEvent } from "./fixtures";

test.describe("Upload caching fix", () => {
  test("auto-refresh updates event when clip count changes", async ({ page }) => {
    // Start with an event that has only 1 clip (simulating mid-upload scan)
    const partialEvent: MockEvent = {
      id: "2025-06-15_14-30-00",
      type: "SavedClips",
      timestamp: "2025-06-15T14:30:00",
      city: "San Francisco",
      hasThumbnail: false,
      clips: [
        { timestamp: "2025-06-15_14-30-00", cameras: ["front"], durationSec: 60 },
      ],
      totalDurationSec: 60,
    };

    const completeEvent: MockEvent = {
      ...partialEvent,
      hasThumbnail: true,
      clips: [
        { timestamp: "2025-06-15_14-29-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
        { timestamp: "2025-06-15_14-30-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
        { timestamp: "2025-06-15_14-31-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      ],
      totalDurationSec: 180,
    };

    let currentEvents = [partialEvent];

    // Set up API mock with mutable state
    await page.route("**/api/status", async (route) => {
      await route.fulfill({
        json: { connected: true, storageBackend: "Local", storagePath: "/test", eventCount: currentEvents.length, scanning: false },
      });
    });
    await page.route("**/api/events", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: currentEvents });
      }
    });
    await page.route(/\/api\/events\/.*\/thumbnail$/, async (route) => {
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"),
      });
    });
    await page.route("**/api/refresh", async (route) => {
      await route.fulfill({ json: currentEvents });
    });

    await page.goto("/");
    await expect(page.locator(".browse-card")).toHaveCount(1);

    // Verify initial partial state: 1 segment, 1 camera, no thumbnail
    const card = page.locator(".browse-card").first();
    await expect(card.locator(".browse-card-meta")).toContainText("1 segment");
    await expect(card.locator(".browse-card-meta")).toContainText("1 camera");
    await expect(card.locator(".browse-card-placeholder")).toHaveText("No preview");

    // Simulate upload completing: update the mock data
    currentEvents = [completeEvent];

    // Trigger refresh (simulates what auto-refresh or manual refresh does)
    await page.locator(".browse-refresh-btn").click();
    await page.waitForTimeout(500);

    // NOW verify the card is updated with complete data
    await expect(card.locator(".browse-card-meta")).toContainText("3 segments");
    await expect(card.locator(".browse-card-meta")).toContainText("4 cameras");

    // Thumbnail should now show (hasThumbnail changed from false to true)
    await expect(card.locator("img.browse-card-img")).toBeVisible();
    await expect(card.locator(".browse-card-placeholder")).not.toBeVisible();
  });

  test("auto-refresh updates UI when same event count but different content", async ({ page }) => {
    // This tests the specific bug: old code compared data.length === prev.length
    // New code uses eventsEqual which checks clip counts and thumbnail flags

    const eventV1: MockEvent = {
      id: "2025-06-15_14-30-00",
      type: "SavedClips",
      timestamp: "2025-06-15T14:30:00",
      city: "San Francisco",
      hasThumbnail: false,
      clips: [
        { timestamp: "2025-06-15_14-30-00", cameras: ["front"], durationSec: 60 },
      ],
      totalDurationSec: 60,
    };

    const eventV2: MockEvent = {
      ...eventV1,
      hasThumbnail: true,
      clips: [
        { timestamp: "2025-06-15_14-29-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
        { timestamp: "2025-06-15_14-30-00", cameras: ["front", "back", "left_repeater", "right_repeater"], durationSec: 60 },
      ],
      totalDurationSec: 120,
    };

    let version = 1;

    await page.route("**/api/status", async (route) => {
      await route.fulfill({
        json: { connected: true, storageBackend: "Local", storagePath: "/test", eventCount: 1, scanning: false },
      });
    });
    await page.route("**/api/events", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: version === 1 ? [eventV1] : [eventV2] });
      }
    });
    await page.route(/\/api\/events\/.*\/thumbnail$/, async (route) => {
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"),
      });
    });
    await page.route("**/api/refresh", async (route) => {
      await route.fulfill({ json: version === 1 ? [eventV1] : [eventV2] });
    });

    await page.goto("/");
    await expect(page.locator(".browse-card")).toHaveCount(1);

    // Confirm initial state
    await expect(page.locator(".browse-card-meta").first()).toContainText("1 segment");
    await expect(page.locator(".browse-card-placeholder")).toBeVisible();

    // Update to v2 (same number of events, different content)
    version = 2;

    // Click refresh to trigger update
    await page.locator(".browse-refresh-btn").click();
    await page.waitForTimeout(500);

    // The UI should update even though event count is the same
    await expect(page.locator(".browse-card-meta").first()).toContainText("2 segments");
    // Thumbnail should appear
    await expect(page.locator("img.browse-card-img")).toBeVisible();
  });

  test("thumbnail state resets when hasThumbnail changes on re-render", async ({ page }) => {
    // Specifically tests the EventCard useEffect fix
    const eventNoThumb: MockEvent = {
      id: "2025-06-15_14-30-00",
      type: "SavedClips",
      timestamp: "2025-06-15T14:30:00",
      city: "TestCity",
      hasThumbnail: false,
      clips: [
        { timestamp: "2025-06-15_14-30-00", cameras: ["front"], durationSec: 60 },
      ],
      totalDurationSec: 60,
    };

    const eventWithThumb: MockEvent = {
      ...eventNoThumb,
      hasThumbnail: true,
    };

    let hasThumb = false;

    await page.route("**/api/status", async (route) => {
      await route.fulfill({
        json: { connected: true, storageBackend: "Local", storagePath: "/test", eventCount: 1, scanning: false },
      });
    });
    await page.route("**/api/events", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: [hasThumb ? eventWithThumb : eventNoThumb] });
      }
    });
    await page.route(/\/api\/events\/.*\/thumbnail$/, async (route) => {
      await route.fulfill({
        contentType: "image/png",
        body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==", "base64"),
      });
    });
    await page.route("**/api/refresh", async (route) => {
      await route.fulfill({ json: [hasThumb ? eventWithThumb : eventNoThumb] });
    });

    await page.goto("/");
    await expect(page.locator(".browse-card")).toHaveCount(1);

    // No thumbnail initially
    await expect(page.locator(".browse-card-placeholder")).toHaveText("No preview");
    await expect(page.locator("img.browse-card-img")).not.toBeVisible();

    // Simulate thumbnail becoming available
    hasThumb = true;

    await page.locator(".browse-refresh-btn").click();
    await page.waitForTimeout(500);

    // Thumbnail should now appear (useEffect resets thumbState)
    await expect(page.locator("img.browse-card-img")).toBeVisible();
    await expect(page.locator(".browse-card-placeholder")).not.toBeVisible();
  });

  test("refresh button triggers rescan and updates data", async ({ page }) => {
    let refreshCalled = false;

    await page.route("**/api/status", async (route) => {
      await route.fulfill({
        json: { connected: true, storageBackend: "Local", storagePath: "/test", eventCount: 0, scanning: false },
      });
    });
    await page.route("**/api/events", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: refreshCalled ? ALL_EVENTS : [] });
      }
    });
    await page.route("**/api/refresh", async (route) => {
      refreshCalled = true;
      await route.fulfill({ json: ALL_EVENTS });
    });

    await page.goto("/");
    // Initially no events
    await page.waitForTimeout(500);

    // Click refresh
    await page.locator(".browse-refresh-btn").click();
    await page.waitForTimeout(500);

    // Now events should appear
    await expect(page.locator(".browse-card").first()).toBeVisible();
    await expect(page.locator(".browse-card")).toHaveCount(ALL_EVENTS.filter(e => e.type !== "RecentClips").length);
  });
});
