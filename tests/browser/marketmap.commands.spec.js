import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { axeSummary, openMarketMap } from "./support/marketMapPage.js";

test("composes pulse commands and reverses every active criterion", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });

  const advancing = page.getByRole("button", { name: /advancing equities; filter to them/i });
  await expect(advancing).toBeEnabled();
  await advancing.click();

  await expect(page.locator('[aria-label="Asset class"]')).toContainText("Equity");
  await expect(page.locator('[aria-label="Movement"]')).toContainText("Advancing");
  await expect(page.getByRole("group", { name: "Active filters and sorting" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Asset: Equity" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Movement: Advancing" })).toBeVisible();
  await expect(page.locator("#result-count")).toContainText("shown");

  const leading = page.locator("#snap-leading");
  const leadingLabel = await leading.getAttribute("aria-label");
  const sector = /^Filter to equities in (.+), the leading sector$/.exec(leadingLabel || "")?.[1];
  expect(sector).toBeTruthy();
  await leading.click();

  await expect(page.locator('[aria-label="Category"]')).toContainText(sector);
  await expect(page.getByRole("button", { name: `Remove Category: ${sector}` })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Movement: Advancing" })).toBeVisible();

  await page.getByRole("button", { name: "Remove Movement: Advancing" }).click();
  await expect(page.locator('[aria-label="Movement"]')).toContainText("All");
  await expect(page.getByRole("button", { name: "Remove Movement: Advancing" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: `Remove Category: ${sector}` })).toBeVisible();

  await page.getByRole("button", { name: "Reset all" }).click();
  await expect(page.getByRole("group", { name: "Active filters and sorting" })).toHaveCount(0);
  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(40);
  await expect(page.locator("#result-count")).toHaveText("40 instruments");
});

test("@a11y keeps actionable pulse values and active chips free of WCAG A/AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 1000 });
  const root = await openMarketMap(page, { theme: "light", hostWidth: 390 });
  await page.getByRole("button", { name: /declining equities; filter to them/i }).click();
  await expect(page.getByRole("group", { name: "Active filters and sorting" })).toBeVisible();
  expect(await root.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  const results = await new AxeBuilder({ page })
    .include(".marketmap-app")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axeSummary(results.violations)).toEqual([]);
});
