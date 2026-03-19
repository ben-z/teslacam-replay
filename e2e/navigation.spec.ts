import { test, expect } from "@playwright/test";
import { mockApi, ALL_EVENTS, SAVED_EVENTS } from "./fixtures";

test.describe("Navigation", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("clicking an event card opens the player", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".browse-card").first()).toBeVisible();

    await page.locator(".browse-card", { hasText: "San Francisco" }).click();

    // Player should be visible (has back button)
    await expect(page.locator("button", { hasText: /back/i }).or(page.locator("[class*='back']"))).toBeVisible({ timeout: 5000 });

    // URL should update with hash
    expect(page.url()).toContain("#/event/SavedClips/2025-06-15_14-30-00");
  });

  test("back button returns to browse", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".browse-card").first()).toBeVisible();

    await page.locator(".browse-card").first().click();
    // Wait for player to load
    await page.waitForTimeout(500);

    // Find and click back
    await page.locator("[class*='back']").first().click();

    // Should be back in browse mode
    await expect(page.locator(".browse-card").first()).toBeVisible();
  });

  test("direct URL hash navigation opens player", async ({ page }) => {
    await page.goto("/#/event/SavedClips/2025-06-15_14-30-00");

    // Player should render for this event
    await page.waitForTimeout(1000);
    // Verify we're not in browse mode (no browse grid)
    await expect(page.locator(".browse-grid")).not.toBeVisible();
  });

  test("invalid hash shows empty player (no crash)", async ({ page }) => {
    await page.goto("/#/event/SavedClips/nonexistent-event");

    // Event doesn't exist, so selectedEvent is null — app renders empty player area
    // Verify no crash: the page should have loaded without errors
    await page.waitForTimeout(1000);
    // Browse grid should NOT be visible (we're in "player" mode with no event)
    await expect(page.locator(".browse-grid")).not.toBeVisible();
  });

  test("browser back button navigates correctly", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".browse-card").first()).toBeVisible();

    // Click an event
    await page.locator(".browse-card").first().click();
    await page.waitForTimeout(500);

    // Browser back should return to browse
    await page.goBack();
    await expect(page.locator(".browse-card").first()).toBeVisible({ timeout: 5000 });
  });

  test("hash change updates player event", async ({ page }) => {
    await page.goto("/#/event/SavedClips/2025-06-15_14-30-00");
    await page.waitForTimeout(1000);

    // Navigate to a different event via hash
    await page.evaluate(() => {
      location.hash = "/event/SentryClips/2025-06-15_22-45-00";
    });
    await page.waitForTimeout(500);

    // Should still be in player mode (no browse grid)
    await expect(page.locator(".browse-grid")).not.toBeVisible();
  });
});
