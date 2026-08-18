import { expect, test } from "@playwright/test";
import { movementAnalyticsRecord } from "../fixtures/movementAnalyticsRecord.js";
import { openMarketMap } from "./support/marketMapPage.js";

async function openStatisticalContext(page, theme, hostWidth, { expand = true } = {}) {
  await openMarketMap(page, {
    theme,
    hostWidth,
    marketApi: { analyticsRecords: { "XNAS:AAPL": movementAnalyticsRecord() } },
  });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const section = page.locator("#instrument-detail-dialog .mm-instrument-detail__statistical-context");
  const methodology = section.locator(".mm-instrument-detail__context-methodology");
  if (expand) {
    await section.getByRole("button", { name: "Method & data" }).click();
    await expect(methodology).toBeVisible();
  } else {
    await expect(methodology).toBeHidden();
  }
  await section.scrollIntoViewIfNeeded();
  return section;
}

for (const theme of ["dark", "light"]) {
  test(`matches the ${theme} desktop board`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    const root = await openMarketMap(page, { theme });
    await expect(root).toHaveScreenshot(`marketmap-${theme}-desktop.png`);
  });
}

test("matches the medium dark board at the first multi-column control threshold", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 1000 });
  const root = await openMarketMap(page, { theme: "dark", hostWidth: 600 });
  await expect(root).toHaveScreenshot("marketmap-dark-medium.png");
});

test("matches the compact light board", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 1000 });
  const root = await openMarketMap(page, { theme: "light", hostWidth: 390 });
  await expect(root).toHaveScreenshot("marketmap-light-compact.png");
});

test("matches composed pulse filters in the compact toolbar", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 1000 });
  const root = await openMarketMap(page, { theme: "light", hostWidth: 390 });
  await page.locator("#snap-advancing").click();
  await page.locator("#snap-leading").click();
  await expect(root.locator(".mm-toolbar")).toHaveScreenshot(
    "marketmap-light-compact-active-filters.png",
  );
});

test("matches the dark editorial board-news section", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openMarketMap(page, { theme: "dark" });
  const news = page.locator('[data-cell="news"]');
  await news.scrollIntoViewIfNeeded();
  await expect(news).toHaveScreenshot("marketmap-news-board-dark.png");
});

test("matches the populated detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = page.locator("#instrument-detail-dialog");
  await expect(dialog.getByText("Fundamentals", { exact: true })).toBeVisible();
  await expect(dialog).toHaveScreenshot("marketmap-detail-dialog-dark.png");
});

test("matches the populated compact detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openMarketMap(page, { theme: "dark", hostWidth: 390 });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = page.locator("#instrument-detail-dialog");
  await expect(dialog.getByText("Fundamentals", { exact: true })).toBeVisible();
  await expect(dialog).toHaveScreenshot("marketmap-detail-dialog-dark-compact.png");
});

test("matches the populated light detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "light" });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = page.locator("#instrument-detail-dialog");
  await expect(dialog.getByText("Fundamentals", { exact: true })).toBeVisible();
  await expect(dialog).toHaveScreenshot("marketmap-detail-dialog-light.png");
});

test("matches the populated compact light detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openMarketMap(page, { theme: "light", hostWidth: 390 });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = page.locator("#instrument-detail-dialog");
  await expect(dialog.getByText("Fundamentals", { exact: true })).toBeVisible();
  await expect(dialog).toHaveScreenshot("marketmap-detail-dialog-light-compact.png");
});

test("matches the dark statistical context section", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const section = await openStatisticalContext(page, "dark");
  await expect(section).toHaveScreenshot("marketmap-statistical-context-dark.png");
});

test("matches the compact light statistical context section", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  const section = await openStatisticalContext(page, "light", 390, { expand: false });
  await expect(section).toHaveScreenshot("marketmap-statistical-context-light-compact.png");
});

test("matches the instrument news inside the dark detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = page.locator("#instrument-detail-dialog");
  const news = dialog.getByRole("heading", { name: "Latest news", exact: true }).locator("xpath=../..");
  await expect(news.locator("li")).toHaveCount(4);
  await news.scrollIntoViewIfNeeded();
  await expect(news).toHaveScreenshot("marketmap-news-modal-dark.png");
});

test("matches the instrument news inside the compact light detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openMarketMap(page, { theme: "light", hostWidth: 390 });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = page.locator("#instrument-detail-dialog");
  const news = dialog.getByRole("heading", { name: "Latest news", exact: true }).locator("xpath=../..");
  await expect(news.locator("li")).toHaveCount(4);
  await news.scrollIntoViewIfNeeded();
  await expect(news).toHaveScreenshot("marketmap-news-modal-light-compact.png");
});

test("matches the populated compact add-instrument dialog", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await openMarketMap(page, { theme: "light", hostWidth: 390 });
  await page.locator("#btn-clear-all").click();
  await expect(page.locator(".add-tile")).toHaveCount(0);
  await page.locator("#add-instrument-btn").click();
  await page.locator("#add-ticker-input").fill("adobe");
  const addDialog = page.locator("#add-instrument-dialog");
  await expect(addDialog.locator(".mm-search-result")).toContainText("ADBE");
  await expect(addDialog).toHaveScreenshot("marketmap-add-dialog-light-compact.png");
});

test("matches the populated dark add-instrument dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator("#btn-clear-all").click();
  await expect(page.locator(".add-tile")).toHaveCount(0);
  await page.locator("#add-instrument-btn").click();
  await page.locator("#add-ticker-input").fill("adobe");
  const addDialog = page.locator("#add-instrument-dialog");
  const result = addDialog.locator(".mm-search-result");
  await expect(result).toContainText("ADBE");
  await result.hover();
  await expect(addDialog).toHaveScreenshot("marketmap-add-dialog-dark.png");
});
