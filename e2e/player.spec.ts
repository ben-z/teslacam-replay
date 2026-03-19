import { test, expect } from "@playwright/test";
import { mockApi } from "./fixtures";

test.describe("Player", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    // Navigate directly to a SavedClips event with 3 segments and 4 cameras
    await page.goto("/#/event/SavedClips/2025-06-15_14-30-00");
    await expect(page.locator(".player-container")).toBeVisible({ timeout: 5000 });
  });

  test("renders player header with event info", async ({ page }) => {
    await expect(page.locator(".player-back-btn")).toBeVisible();
    await expect(page.locator(".player-header-title")).toBeVisible();
    await expect(page.locator(".player-badge")).toHaveText("Saved");
  });

  test("shows city and date in header", async ({ page }) => {
    await expect(page.locator(".player-header-title")).toContainText("San Francisco");
    await expect(page.locator(".player-header-date")).toBeVisible();
  });

  test("renders video elements for cameras", async ({ page }) => {
    const videos = page.locator("video");
    expect(await videos.count()).toBeGreaterThan(0);
  });

  test("play/pause button exists and is clickable", async ({ page }) => {
    const playBtn = page.locator(".player-play-btn");
    await expect(playBtn).toBeVisible();
    await playBtn.click();
    // Should not error
  });

  test("mute button exists", async ({ page }) => {
    await expect(page.locator(".player-mute-btn")).toBeVisible();
  });

  test("timeline/scrubber is rendered", async ({ page }) => {
    await expect(page.locator(".player-timeline-wrapper")).toBeVisible();
  });

  test("time display shows current time", async ({ page }) => {
    await expect(page.locator(".player-time")).toBeVisible();
  });

  test("layout toggle buttons exist", async ({ page }) => {
    const layoutToggle = page.locator(".player-layout-toggle");
    await expect(layoutToggle).toBeVisible();
    const buttons = layoutToggle.locator("button");
    expect(await buttons.count()).toBe(2); // Grid and Focus
  });

  test("layout toggle switches view", async ({ page }) => {
    const buttons = page.locator(".player-layout-toggle button");
    // Click second button (Focus)
    await buttons.nth(1).click();
    await page.waitForTimeout(300);
    // Click first button (Grid) to switch back
    await buttons.nth(0).click();
  });

  test("keyboard ? opens shortcuts overlay", async ({ page }) => {
    await page.keyboard.press("?");
    await expect(page.locator(".player-shortcuts-overlay")).toBeVisible();
    await expect(page.locator(".player-shortcuts-title")).toContainText("Keyboard Shortcuts");
  });

  test("keyboard Escape closes shortcuts overlay", async ({ page }) => {
    await page.keyboard.press("?");
    await expect(page.locator(".player-shortcuts-overlay")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".player-shortcuts-overlay")).not.toBeVisible();
  });

  test("shortcuts panel close button works", async ({ page }) => {
    await page.keyboard.press("?");
    await expect(page.locator(".player-shortcuts-overlay")).toBeVisible();

    await page.locator(".player-shortcuts-close").click();
    await expect(page.locator(".player-shortcuts-overlay")).not.toBeVisible();
  });

  test("shortcuts hint is visible", async ({ page }) => {
    await expect(page.locator(".player-shortcuts-hint")).toBeVisible();
    await expect(page.locator(".player-shortcuts-hint")).toContainText("?");
  });

  test("back button returns to browse view", async ({ page }) => {
    await page.locator(".player-back-btn").click();
    await expect(page.locator(".browse-container")).toBeVisible({ timeout: 5000 });
  });

  test("event navigation buttons exist when multiple events", async ({ page }) => {
    // The mock data has multiple events, so navigation should be possible
    const navBtns = page.locator(".player-nav-btn");
    // Should have prev/next event buttons
    expect(await navBtns.count()).toBe(2);
  });

  test("GPS link appears when event has coordinates", async ({ page }) => {
    await expect(page.locator(".player-header-gps")).toBeVisible();
    // Should link to Google Maps
    const href = await page.locator(".player-header-gps").getAttribute("href");
    expect(href).toContain("maps.google.com");
    expect(href).toContain("37.7749");
  });

  test("reason is displayed when available", async ({ page }) => {
    await expect(page.locator(".player-header-reason")).toBeVisible();
  });

  test("camera labels are shown", async ({ page }) => {
    // Should show camera labels like "Front", "Rear", etc.
    await expect(page.locator(".player-cam-label").first()).toBeVisible();
  });

  test("keyboard F toggles layout", async ({ page }) => {
    const activeBtn = () => page.locator(".player-layout-toggle button[aria-pressed='true']");
    const initialText = await activeBtn().textContent();

    await page.keyboard.press("f");
    await page.waitForTimeout(200);

    const newText = await activeBtn().textContent();
    expect(newText).not.toBe(initialText);
  });

  test("sentry event shows correct badge", async ({ page }) => {
    // Navigate to a sentry event
    await page.goto("/#/event/SentryClips/2025-06-15_22-45-00");
    await expect(page.locator(".player-container")).toBeVisible({ timeout: 5000 });
    await expect(page.locator(".player-badge")).toHaveText("Sentry");
  });
});
