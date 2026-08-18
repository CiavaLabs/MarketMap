import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { MIXED_ASSET_INSTRUMENTS } from "./fixtures/marketApi.js";
import { movementAnalyticsRecord } from "../fixtures/movementAnalyticsRecord.js";
import { axeSummary, openMarketMap } from "./support/marketMapPage.js";

const tileFor = (page, instrumentId) => page.locator(
  `.asset-tile:not(.add-tile)[data-instrument-id="${instrumentId}"]`,
);

const decodedPath = ({ url }) => decodeURIComponent(new URL(url).pathname);

async function openMixedBoard(page, requests = []) {
  return openMarketMap(page, {
    theme: "dark",
    persistedInstruments: MIXED_ASSET_INSTRUMENTS,
    pause: false,
    marketApi: {
      requests,
      partialSnapshot: false,
      unavailableIds: ["ARCX:SPY"],
    },
  });
}

test("hydrates, formats, filters, and extends a mixed v2 board", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const requests = [];
  await openMixedBoard(page, requests);

  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(8);
  await expect(page.locator(".mm-pulse"))
    .toHaveAttribute("aria-label", "Equity pulse — 2 of 2 equities");
  await expect(page.locator("#snap-mover")).toHaveText("AAPL +4.20%");
  await expect(page.locator("#feed-status-copy")).toContainText("Partial update");

  await expect(tileFor(page, "INDEX:^GSPC")).toContainText("6,318.72 pts");
  await expect(tileFor(page, "FX:EURUSD")).toContainText("1.0842");
  await expect(tileFor(page, "CRYPTO:BTC-USD")).toContainText("$118,412.55");
  await expect(tileFor(page, "FUTURE:CMX.GC.CONTINUOUS.1")).toContainText("$3,352.40");
  await expect(tileFor(page, "RATE:^TNX")).toContainText("4.545%");
  await expect(tileFor(page, "ARCX:SPY")).toContainText("—");

  await page.locator('[aria-label="Asset class"]').click();
  await page.getByRole("option", { name: "FX", exact: true }).click();
  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(1);
  await expect(page.locator("#result-count")).toHaveText("1 of 8 shown");
  await page.locator('[aria-label="Asset class"]').click();
  await page.getByRole("option", { name: "All", exact: true }).click();

  const addButton = page.locator("#add-instrument-btn");
  await addButton.focus();
  await page.keyboard.press("Enter");
  const addDialog = page.locator("#add-instrument-dialog");
  await expect(addDialog).toBeVisible();
  await addDialog.getByLabel("Asset class").click();
  await page.getByRole("option", { name: "ETF", exact: true }).click();
  await addDialog.locator("#add-ticker-input").fill("bnd");
  const bndResult = addDialog.locator(".mm-search-result");
  await expect(bndResult).toContainText("BND");
  await bndResult.getByRole("button", { name: "Add" }).click();

  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(9);
  await expect(tileFor(page, "XNAS:BND")).toContainText("$73.14");
  await expect(tileFor(page, "XNAS:BND")).toHaveAttribute("data-tier", "compact");
  expect(requests.some((request) => (
    request.apiVersion === "v1"
    && decodedPath(request).endsWith("/instruments/XNAS:BND")
  ))).toBe(true);

  await page.locator("#add-instrument-btn").click();
  await expect(addDialog).toBeVisible();
  await addDialog.getByLabel("Asset class").click();
  await page.getByRole("option", { name: "Commodity future", exact: true }).click();
  await addDialog.locator("#add-ticker-input").fill("silver");
  const silverResult = addDialog.locator(".mm-search-result");
  await expect(silverResult).toContainText("SI");
  await expect(silverResult.getByRole("button", { name: "Unavailable" })).toBeDisabled();
  await expect(silverResult)
    .toContainText("Identity unconfirmed");
  await page.keyboard.press("Escape");
  await expect(addDialog).toHaveCount(0);

  expect(requests.some(({ apiVersion, path }) => (
    apiVersion === "v1" && path === "/instruments/search"
  ))).toBe(true);
  expect(requests.some(({ apiVersion }) => apiVersion === "v2")).toBe(false);
});

test("uses discriminated modals and never requests unsupported details or news", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const requests = [];
  await openMixedBoard(page, requests);

  const fxTile = tileFor(page, "FX:EURUSD");
  await fxTile.click();
  const dialog = page.locator("#instrument-detail-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("FX");
  await expect(dialog).toContainText("EUR/USD");
  await expect(dialog.getByText("Pair details", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("Base currency");
  await expect(dialog.getByRole("heading", { name: "Latest news", exact: true })).toHaveCount(0);

  expect(requests.some((request) => (
    request.apiVersion === "v1"
    && decodedPath(request).endsWith("/instruments/FX:EURUSD/details")
  ))).toBe(true);
  expect(requests.some((request) => (
    request.apiVersion === "v1"
    && decodedPath(request).endsWith("/instruments/FX:EURUSD/history")
  ))).toBe(true);
  expect(requests.some((request) => (
    request.apiVersion === "v1"
    && decodedPath(request).endsWith("/instruments/FX:EURUSD/news")
  ))).toBe(false);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  const rateDetailsBefore = requests.filter((request) => (
    decodedPath(request).endsWith("/instruments/RATE:^TNX/details")
  )).length;
  const rateNewsBefore = requests.filter((request) => (
    decodedPath(request).endsWith("/instruments/RATE:^TNX/news")
  )).length;
  await tileFor(page, "RATE:^TNX").click();
  const rateDialog = page.locator("#instrument-detail-dialog");
  await expect(rateDialog).toContainText("No applicable detail fields were returned.");
  await expect(rateDialog.getByRole("heading", { name: "Latest news", exact: true })).toHaveCount(0);
  expect(requests.filter((request) => (
    decodedPath(request).endsWith("/instruments/RATE:^TNX/details")
  ))).toHaveLength(rateDetailsBefore);
  expect(requests.filter((request) => (
    decodedPath(request).endsWith("/instruments/RATE:^TNX/news")
  ))).toHaveLength(rateNewsBefore);
});

test("traverses the filtered board without closing the dialog or resetting its range", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMixedBoard(page);

  await page.getByRole("combobox", { name: "Asset class" }).click();
  await page.getByRole("option", { name: "Equity", exact: true }).click();
  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(2);

  await tileFor(page, "XNAS:AAPL").click();
  const dialog = page.locator("#instrument-detail-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".mm-instrument-detail__navigation")).toContainText("1 of 2 in current filter");
  await expect(dialog.getByRole("button", { name: "Previous", exact: false })).toBeDisabled();

  await dialog.getByRole("button", { name: "5D", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "5D", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Alt+ArrowRight");

  await expect(dialog.locator(".mm-instrument-detail__ticker")).toHaveText("MSFT");
  await expect(dialog.locator(".mm-instrument-detail__navigation")).toContainText("2 of 2 in current filter");
  await expect(dialog.getByRole("button", { name: "5D", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Next", exact: false })).toBeDisabled();

  await page.keyboard.press("Alt+ArrowLeft");
  await expect(dialog.locator(".mm-instrument-detail__ticker")).toHaveText("AAPL");
  await expect(dialog).toBeVisible();
});

test("renders the end-of-day statistical context only from persisted assessments", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  const requests = [];
  await openMarketMap(page, {
    theme: "dark",
    persistedInstruments: MIXED_ASSET_INSTRUMENTS,
    pause: false,
    marketApi: {
      requests,
      partialSnapshot: false,
      analyticsRecords: { "XNAS:AAPL": movementAnalyticsRecord() },
    },
  });

  await tileFor(page, "XNAS:AAPL").click();
  const dialog = page.locator("#instrument-detail-dialog");
  await expect(dialog).toBeVisible();
  const section = dialog.locator(".mm-instrument-detail__statistical-context");
  await expect(section).toBeVisible();
  await expect(section).toContainText("Statistical context");
  await expect(section).toContainText("End of day");
  await expect(section).toContainText("+2.34%");
  await expect(section).toContainText("Empirical percentile");
  await expect(section).toContainText("97.4th");
  await expect(section).toContainText("19 of 756 prior moves were at least as large");
  await expect(section.locator(".mm-instrument-detail__context-figure")).toHaveCount(3);
  const rarity = section.locator(".mm-instrument-detail__context-rarity");
  await expect(rarity).toContainText("97.4th");
  const windows = section.locator(".mm-instrument-detail__context-windows");
  await expect(windows).toBeVisible();
  await expect(windows.locator("dd")).toHaveText([
    "Through 2026-07-24",
    "756 prior scores · 2023-07-25 → 2026-07-24",
  ]);

  const methodology = section.locator(".mm-instrument-detail__context-methodology");
  await expect(methodology).toBeHidden();
  await section.getByRole("button", { name: "Method & data" }).click();
  await expect(methodology).toBeVisible();
  await expect(methodology).toContainText("host-calendar · rev 2026-07-28");
  await expect(methodology).toContainText("20/757 · plus-one correction");
  await expect(methodology).not.toContainText("Reference window");
  for (const width of [1280, 430]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(section).toBeVisible();
    expect(await section.evaluate((node) => {
      const right = node.getBoundingClientRect().right;
      return [
        node.scrollWidth - node.clientWidth,
        ...[...node.querySelectorAll("*")]
          .map((child) => Math.round(child.getBoundingClientRect().right - right)),
      ].filter((overflow) => overflow > 0);
    })).toEqual([]);
  }
  await page.setViewportSize({ width: 1280, height: 1000 });

  const axe = await new AxeBuilder({ page })
    .include("#instrument-detail-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axeSummary(axe.violations)).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await tileFor(page, "XNAS:MSFT").click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("MSFT");
  await expect(dialog.locator(".mm-instrument-detail__statistical-context")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await tileFor(page, "FX:EURUSD").click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".mm-instrument-detail__statistical-context")).toHaveCount(0);
  expect(requests.filter(({ path }) => path === "/analytics/snapshot")).toHaveLength(2);
});

test("@a11y keeps the mixed v2 board and pair modal free of WCAG A/AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMixedBoard(page);

  let results = await new AxeBuilder({ page })
    .include(".marketmap-app")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axeSummary(results.violations)).toEqual([]);

  await tileFor(page, "FX:EURUSD").click();
  await expect(page.locator("#instrument-detail-dialog")).toBeVisible();
  results = await new AxeBuilder({ page })
    .include("#instrument-detail-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axeSummary(results.violations)).toEqual([]);
});
