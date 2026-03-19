import { test, expect } from "@playwright/test";
import { mockApi, MOCK_CACHES, MOCK_STATUS } from "./fixtures";

test.describe("Debug Panel & Status Bar", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
    await page.goto("/");
    await expect(page.locator(".browse-card").first()).toBeVisible();
  });

  test("status bar shows server info", async ({ page }) => {
    const statusBar = page.locator(".browse-status-bar");
    await expect(statusBar).toBeVisible();
    await expect(statusBar).toContainText("Storage: Local");
    await expect(statusBar).toContainText("events");
  });

  test("debug panel toggle opens and closes", async ({ page }) => {
    // Click wrench icon to open
    await page.locator(".debug-toggle-btn").click();
    await expect(page.locator(".debug-panel")).toBeVisible();

    // Click close button
    await page.locator(".debug-panel-close").click();
    await expect(page.locator(".debug-panel")).not.toBeVisible();
  });

  test("debug panel shows all cache entries", async ({ page }) => {
    await page.locator(".debug-toggle-btn").click();
    await expect(page.locator(".debug-panel")).toBeVisible();

    // Should show all cache rows
    const rows = page.locator(".debug-cache-row");
    await expect(rows).toHaveCount(MOCK_CACHES.caches.length);

    // Check labels
    await expect(page.locator(".debug-cache-label", { hasText: "Event scan cache" })).toBeVisible();
    await expect(page.locator(".debug-cache-label", { hasText: "HLS segments" })).toBeVisible();
    await expect(page.locator(".debug-cache-label", { hasText: "Telemetry" })).toBeVisible();
  });

  test("debug panel clear button works", async ({ page }) => {
    await page.locator(".debug-toggle-btn").click();
    await expect(page.locator(".debug-panel")).toBeVisible();

    // Click first clear button
    const clearBtn = page.locator(".debug-cache-clear-btn").first();
    await clearBtn.click();

    // Should not error (mock returns { ok: true })
    await page.waitForTimeout(300);
    // Panel should still be visible (clear refreshes data)
    await expect(page.locator(".debug-panel")).toBeVisible();
  });

  test("debug panel Clear All button works", async ({ page }) => {
    await page.locator(".debug-toggle-btn").click();
    await expect(page.locator(".debug-panel")).toBeVisible();

    await page.locator(".debug-clear-all-btn").click();
    await page.waitForTimeout(500);

    // Panel should still be visible after clearing
    await expect(page.locator(".debug-panel")).toBeVisible();
  });

  test("clicking overlay outside debug panel closes it", async ({ page }) => {
    await page.locator(".debug-toggle-btn").click();
    await expect(page.locator(".debug-panel")).toBeVisible();

    // Click on the overlay (outside the panel)
    await page.locator(".debug-overlay").click({ position: { x: 10, y: 10 } });
    await expect(page.locator(".debug-panel")).not.toBeVisible();
  });
});
