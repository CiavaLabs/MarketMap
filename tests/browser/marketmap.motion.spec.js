import { expect, test } from "@playwright/test";
import { openMarketMap } from "./support/marketMapPage.js";

const cell = (page, instrumentId) => page.locator(`[data-layout-id="${instrumentId}"]`);
const handle = (page, instrumentId) => page.locator(`[data-reorder-handle="${instrumentId}"]`);

async function observeMotion(page) {
  await page.addInitScript(() => {
    const nativeAnimate = Element.prototype.animate;
    window.__marketMapMotion = { flips: [], detail: [] };
    Element.prototype.animate = function animate(keyframes, options) {
      if (this.matches?.("[data-layout-id]")) {
        window.__marketMapMotion.flips.push({ keyframes, options, itemId: this.dataset.layoutId });
      }
      return nativeAnimate.call(this, keyframes, options);
    };
    document.startViewTransition = (update) => {
      const source = document.querySelector('[style*="view-transition-name"]');
      const record = {
        sourceName: source?.style.viewTransitionName || "",
        destinationName: "",
      };
      const updateResult = update();
      const destination = document.querySelector(".mm-instrument-detail-dialog");
      record.destinationName = destination ? getComputedStyle(destination).viewTransitionName : "";
      window.__marketMapMotion.detail.push(record);
      const finished = Promise.resolve(updateResult);
      return { ready: finished, updateCallbackDone: finished, finished };
    };
  });
}

test("animates committed layout changes and shares the clicked tile with the detail dialog", async ({ page }) => {
  await observeMotion(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.evaluate(() => { window.__marketMapMotion.flips = []; });

  await handle(page, "XNAS:AAPL").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");

  await expect.poll(() => page.evaluate(() => window.__marketMapMotion.flips.length))
    .toBeGreaterThan(0);
  const flip = await page.evaluate(() => window.__marketMapMotion.flips[0]);
  expect(flip.options).toMatchObject({ duration: 190 });
  expect(flip.keyframes[0].transform).toContain("translate(");
  await expect(cell(page, "XNAS:AAPL")).not.toHaveAttribute("data-layout-animating", "true", {
    timeout: 2_000,
  });

  await page.locator('.asset-tile[data-instrument-id="XNAS:AAPL"]').click();
  await expect(page.locator("#instrument-detail-dialog")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__marketMapMotion.detail.length)).toBe(1);
  expect(await page.evaluate(() => window.__marketMapMotion.detail[0])).toEqual({
    sourceName: "marketmap-instrument-detail",
    destinationName: "marketmap-instrument-detail",
  });
  await expect(page.locator(".marketmap-app")).not.toHaveAttribute(
    "data-detail-view-transition",
    "true",
  );
});

test("keeps reorder and detail opening static with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await observeMotion(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.evaluate(() => { window.__marketMapMotion.flips = []; });

  await handle(page, "XNAS:AAPL").focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect.poll(() => cell(page, "XNAS:AAPL").getAttribute("data-grabbed")).toBeNull();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__marketMapMotion.flips)).toEqual([]);

  await page.locator('.asset-tile[data-instrument-id="XNAS:AAPL"]').click();
  await expect(page.locator("#instrument-detail-dialog")).toBeVisible();
  expect(await page.evaluate(() => window.__marketMapMotion.detail)).toEqual([]);
});
