import { test, expect } from "@playwright/test";
import { mockApi, ALL_EVENTS, SAVED_EVENTS, SENTRY_EVENTS, RECENT_EVENTS } from "./fixtures";

test.describe("Event Browser", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
  });

  test("shows all events on load with correct counts", async ({ page }) => {
    // Wait for events to render
    await expect(page.locator(".browse-card")).toHaveCount(ALL_EVENTS.filter(e => e.type !== "RecentClips").length);

    // Check the Events button shows correct count (SavedClips + SentryClips)
    const eventsBtn = page.locator(".browse-view-btn", { hasText: "Events" });
    await expect(eventsBtn).toContainText(`${SAVED_EVENTS.length + SENTRY_EVENTS.length}`);

    // Check Recent button shows correct count
    const recentBtn = page.locator(".browse-view-btn", { hasText: "Recent" });
    await expect(recentBtn).toContainText(`${RECENT_EVENTS.length}`);
  });

  test("shows correct filter counts", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    const savedBtn = page.locator(".browse-filter-btn", { hasText: "Saved" });
    await expect(savedBtn).toContainText(`${SAVED_EVENTS.length}`);

    const sentryBtn = page.locator(".browse-filter-btn", { hasText: "Sentry" });
    await expect(sentryBtn).toContainText(`${SENTRY_EVENTS.length}`);
  });

  test("filters by SavedClips", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    await page.locator(".browse-filter-btn", { hasText: "Saved" }).click();
    await expect(page.locator(".browse-card")).toHaveCount(SAVED_EVENTS.length);

    // All visible cards should be Saved type
    for (const card of await page.locator(".browse-card-badge").all()) {
      await expect(card).toHaveText("Saved");
    }
  });

  test("filters by SentryClips", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    await page.locator(".browse-filter-btn", { hasText: "Sentry" }).click();
    await expect(page.locator(".browse-card")).toHaveCount(SENTRY_EVENTS.length);

    for (const card of await page.locator(".browse-card-badge").all()) {
      await expect(card).toHaveText("Sentry");
    }
  });

  test("filters back to All", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();
    const totalNonRecent = SAVED_EVENTS.length + SENTRY_EVENTS.length;

    await page.locator(".browse-filter-btn", { hasText: "Saved" }).click();
    await expect(page.locator(".browse-card")).toHaveCount(SAVED_EVENTS.length);

    await page.locator(".browse-filter-btn", { hasText: "All" }).click();
    await expect(page.locator(".browse-card")).toHaveCount(totalNonRecent);
  });

  test("search filters by city", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    await page.locator(".browse-search").fill("San Francisco");
    // Debounce wait
    await expect(page.locator(".browse-card")).toHaveCount(1);
    await expect(page.locator(".browse-card-city")).toHaveText("San Francisco");
  });

  test("search filters by reason", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    await page.locator(".browse-search").fill("sentry");
    await expect(page.locator(".browse-card")).toHaveCount(SENTRY_EVENTS.length);
  });

  test("search clear button works", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();
    const totalNonRecent = SAVED_EVENTS.length + SENTRY_EVENTS.length;

    await page.locator(".browse-search").fill("San Francisco");
    await expect(page.locator(".browse-card")).toHaveCount(1);

    await page.locator(".browse-search-clear").click();
    await expect(page.locator(".browse-card")).toHaveCount(totalNonRecent);
  });

  test("sort toggle changes order", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    // Default is newest first - get first card's date
    const firstCardDateNewest = await page.locator(".browse-card-date").first().textContent();

    // Toggle to oldest
    await page.locator(".browse-sort-btn").click();
    await expect(page.locator(".browse-sort-btn")).toContainText("Oldest");

    const firstCardDateOldest = await page.locator(".browse-card-date").first().textContent();
    expect(firstCardDateNewest).not.toBe(firstCardDateOldest);

    // Toggle back to newest
    await page.locator(".browse-sort-btn").click();
    await expect(page.locator(".browse-sort-btn")).toContainText("Newest");
  });

  test("switches to Recent view", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    await page.locator(".browse-view-btn", { hasText: "Recent" }).click();

    // Recent view shows Timeline component, not cards
    // The filter buttons should not be visible in recent view
    await expect(page.locator(".browse-filter-btn")).toHaveCount(0);
  });

  test("event cards show correct metadata", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    // Find the San Francisco event card
    const sfCard = page.locator(".browse-card", { hasText: "San Francisco" });
    await expect(sfCard).toBeVisible();

    // Check segments count
    await expect(sfCard.locator(".browse-card-meta")).toContainText("3 segments");

    // Check cameras count
    await expect(sfCard.locator(".browse-card-meta")).toContainText("4 cameras");

    // Check GPS link exists
    await expect(sfCard.locator(".browse-card-gps")).toBeVisible();

    // Check duration badge
    await expect(sfCard.locator(".browse-card-duration")).toContainText("3 min");
  });

  test("event cards with thumbnails load images", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    // Cards with hasThumbnail=true should have img elements
    const sfCard = page.locator(".browse-card", { hasText: "San Francisco" });
    await expect(sfCard.locator("img.browse-card-img")).toBeVisible();
  });

  test("event cards without thumbnails show placeholder", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    // Mountain View event has hasThumbnail=false
    const mvCard = page.locator(".browse-card", { hasText: "Mountain View" });
    await expect(mvCard.locator(".browse-card-placeholder")).toHaveText("No preview");
  });

  test("date headers group events correctly", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    // Should have date group headers
    const headers = page.locator(".browse-date-header");
    expect(await headers.count()).toBeGreaterThan(0);

    // Each header should show a date count
    for (const header of await headers.all()) {
      await expect(header.locator(".browse-date-count")).toContainText("event");
    }
  });

  test("reason badges are formatted", async ({ page }) => {
    await expect(page.locator(".browse-card").first()).toBeVisible();

    // Sentry event has reason "sentry_aware_object_detection"
    // formatReason should format it nicely
    const sentryCard = page.locator(".browse-card", { hasText: "San Jose" });
    await expect(sentryCard.locator(".browse-card-reason")).toBeVisible();
  });
});
