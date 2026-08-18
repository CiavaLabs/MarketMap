import { expect } from "@playwright/test";
import { installMarketApiFixture } from "../fixtures/marketApi.js";

export const CRITICAL_TOKENS = [
  "--mm-font-sans",
  "--mm-space-3",
  "--mm-radius-md",
  "--mm-control-height",
  "--mm-duration-standard",
  "--mm-z-overlay",
  "--mm-bg",
  "--mm-surface",
  "--mm-ink",
  "--mm-muted",
  "--mm-line",
  "--mm-accent",
  "--mm-gain",
  "--mm-loss",
  "--mm-focus",
  "--mm-shadow-md",
];

export async function openMarketMap(page, options = {}) {
  const {
    theme = "dark",
    hostWidth,
    persistedInstruments = null,
    expectedNewsCount = 12,
    marketApi = {},
    pause = true,
  } = options;
  await installMarketApiFixture(page, marketApi);
  if (Array.isArray(persistedInstruments)) {
    await page.addInitScript((instruments) => {
      window.localStorage.setItem("marketmap-board-v2", JSON.stringify({
        schemaVersion: 2,
        workspaceId: "browser-mixed-assets",
        instruments,
        updatedAt: "2026-07-15T14:30:00.000Z",
      }));
    }, persistedInstruments);
  }
  await page.emulateMedia({ colorScheme: theme });
  await page.goto("/");

  const root = page.locator(".marketmap-app");
  await expect(root).toHaveAttribute("data-marketmap-mounted", "true");
  await expect(root).toHaveAttribute("data-marketmap-theme", theme);
  await expect(page.locator(".asset-tile:not(.add-tile)").first()).not.toHaveAttribute("aria-label", /Price —\./);
  await expect(page.locator("#feed-status-copy")).toContainText(/Partial update|Last updated|Last confirmed/);
  if (expectedNewsCount !== null) {
    await expect(page.locator('[data-cell="news"] li')).toHaveCount(expectedNewsCount);
  }
  if (Array.isArray(persistedInstruments) && persistedInstruments.length) {
    await expect.poll(() => page.evaluate(() => {
      const assets = window.MarketMapStandalone?.getInstance?.()?.assets || [];
      return assets.length > 0 && assets.every((asset) => asset.capabilities?.quote?.status);
    })).toBe(true);
  }
  await page.evaluate(() => document.fonts.ready);

  if (hostWidth) {
    await root.evaluate((element, width) => {
      element.style.width = `${width}px`;
      element.style.maxWidth = "100%";
      element.style.marginInline = "auto";
    }, hostWidth);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }

  if (pause) await page.evaluate(() => window.MarketMapStandalone?.pause?.());
  return root;
}

export const MEASURE_COMPOSITED_TEXT_CONTRAST = (element, selector) => {
  const channels = (colour) => {
    const parts = (colour.match(/[\d.]+/g) || []).map(Number);
    if (/^color\(/.test(colour)) {
      return [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts.length > 3 ? parts[3] : 1];
    }
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const over = (top, alpha, bottom) => top.map((value, index) => value * alpha + bottom[index] * (1 - alpha));
  const luminance = (rgb) => rgb
    .map((value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    })
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (foreground, background) => {
    const a = luminance(foreground);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const painted = (node) => {
    const layers = [];
    for (let current = node; current && current !== document.documentElement; current = current.parentElement) {
      const colour = channels(getComputedStyle(current).backgroundColor);
      if (colour[3] > 0) layers.push(colour);
    }
    let result = [255, 255, 255];
    while (layers.length) {
      const layer = layers.pop();
      result = over(layer.slice(0, 3), layer[3], result);
    }
    return result;
  };

  return [...element.querySelectorAll(selector)].map((node) => {
    const styles = getComputedStyle(node);
    return {
      label: node.className.replace(/_[a-z0-9]{5,}_\d+/g, (match) => match.split("_")[1]),
      text: node.textContent.trim(),
      fontSize: Number.parseFloat(styles.fontSize),
      ratio: Number(contrast(channels(styles.color).slice(0, 3), painted(node)).toFixed(2)),
    };
  });
};

export function axeSummary(violations) {
  return violations.map(({ id, impact, help, nodes }) => ({
    id,
    impact,
    help,
    targets: nodes.map((node) => node.target.join(" ")),
  }));
}
