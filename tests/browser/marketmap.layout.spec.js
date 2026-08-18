import { expect, test } from "@playwright/test";
import { MIXED_ASSET_INSTRUMENTS } from "./fixtures/marketApi.js";
import { openMarketMap } from "./support/marketMapPage.js";

const tile = (page, instrumentId) => page.locator(
  `.asset-tile[data-instrument-id="${instrumentId}"]`,
);
const cell = (page, instrumentId) => page.locator(
  `[data-layout-id="${instrumentId}"]`,
);
const handle = (page, instrumentId) => page.locator(
  `[data-reorder-handle="${instrumentId}"]`,
);

async function choose(page, label, option) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("packs explicit, non-overlapping cells at every responsive column count", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const root = await openMarketMap(page, { theme: "dark" });

  const observedColumns = new Set();
  for (const width of [1280, 940, 780, 620, 400]) {
    await root.evaluate((element, nextWidth) => {
      element.style.width = `${nextWidth}px`;
      element.style.maxWidth = "100%";
    }, width);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const layout = await page.locator("#marketmap").evaluate((grid) => {
      const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length;
      const cells = [...grid.querySelectorAll("[data-layout-id]")].map((node) => {
        const column = Number.parseInt(node.style.gridColumnStart, 10);
        const row = Number.parseInt(node.style.gridRowStart, 10);
        const columnSpan = Number.parseInt(node.style.gridColumnEnd.replace("span", ""), 10);
        const rowSpan = Number.parseInt(node.style.gridRowEnd.replace("span", ""), 10);
        return { id: node.dataset.layoutId, column, row, columnSpan, rowSpan };
      });
      return { columns, cells };
    });

    observedColumns.add(layout.columns);
    expect(layout.cells.length).toBeGreaterThan(40);
    const occupied = new Set();
    for (const placement of layout.cells) {
      expect(Number.isInteger(placement.column)).toBe(true);
      expect(Number.isInteger(placement.row)).toBe(true);
      expect(placement.column + placement.columnSpan - 1).toBeLessThanOrEqual(layout.columns);
      for (let row = placement.row; row < placement.row + placement.rowSpan; row += 1) {
        for (let column = placement.column; column < placement.column + placement.columnSpan; column += 1) {
          const key = `${column}:${row}`;
          expect(occupied.has(key), `${placement.id} overlaps ${key} at ${width}px`).toBe(false);
          occupied.add(key);
        }
      }
    }
    const lastOccupiedIndex = Math.max(...[...occupied].map((key) => {
      const [column, row] = key.split(":").map(Number);
      return (row - 1) * layout.columns + column - 1;
    }));
    const holes = [];
    for (let index = 0; index <= lastOccupiedIndex; index += 1) {
      const column = index % layout.columns + 1;
      const row = Math.floor(index / layout.columns) + 1;
      if (!occupied.has(`${column}:${row}`)) holes.push(`${column}:${row}`);
    }
    expect(holes, `unfilled cells at ${width}px`).toEqual([]);
  }
  expect([...observedColumns].sort()).toEqual([2, 3, 4, 5, 6]);
});

test("maps filtered pointer and touch drops into the complete board and clears active sorting", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, {
    theme: "dark",
    persistedInstruments: MIXED_ASSET_INSTRUMENTS,
    pause: false,
    marketApi: { partialSnapshot: false },
  });
  await choose(page, "Asset class", "Equity");
  await choose(page, "Sort", "Ticker A–Z");
  await expect(page.locator(".asset-tile")).toHaveCount(2);

  const source = await cell(page, "XNAS:AAPL").boundingBox();
  const target = await cell(page, "XNAS:MSFT").boundingBox();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  const slots = () => page.locator("#marketmap [data-layout-id]").evaluateAll((nodes) => (
    Object.fromEntries(nodes.map((node) => [
      node.dataset.layoutId,
      `${node.style.gridColumnStart}/${node.style.gridRowStart}`,
    ]))
  ));
  const before = await slots();
  await page.mouse.move(target.x + target.width * 0.75, target.y + target.height * 0.75, { steps: 8 });
  await expect(cell(page, "XNAS:AAPL")).toHaveAttribute("data-grabbed", "true");
  expect(await cell(page, "XNAS:AAPL").evaluate((node) => node.style.transform))
    .toContain("translate3d");
  const during = await slots();
  expect(during["XNAS:MSFT"]).toBe(before["XNAS:AAPL"]);
  expect(during["XNAS:AAPL"]).toBe(before["XNAS:MSFT"]);
  await page.mouse.up();
  expect(await slots()).toEqual(during);
  expect(await cell(page, "XNAS:AAPL").evaluate((node) => node.style.transform)).toBe("");
  await expect(page.locator("#instrument-detail-dialog")).toHaveCount(0);

  await expect(page.getByRole("combobox", { name: "Sort" })).toContainText("Curated order");
  await expect(page.getByText("Custom order restored; calculated sorting was cleared.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (
    (() => {
      const collection = JSON.parse(localStorage.getItem("marketmap-boards-v3"));
      return collection.boards.find(({ id }) => id === collection.activeBoardId);
    })().instruments
      .map(({ id }) => id)
  ))).toEqual([
    "XNAS:MSFT",
    "ARCX:SPY",
    "INDEX:^GSPC",
    "FX:EURUSD",
    "CRYPTO:BTC-USD",
    "FUTURE:CMX.GC.CONTINUOUS.1",
    "RATE:^TNX",
    "XNAS:AAPL",
  ]);
  expect(await page.locator(".asset-tile").evaluateAll((nodes) => (
    nodes.map((node) => node.dataset.instrumentId)
  ))).toEqual(["XNAS:MSFT", "XNAS:AAPL"]);

  const touchSource = await cell(page, "XNAS:MSFT").boundingBox();
  const touch = {
    pointerId: 42,
    pointerType: "touch",
    button: 0,
    bubbles: true,
  };
  await cell(page, "XNAS:MSFT").dispatchEvent("pointerdown", {
    ...touch,
    clientX: touchSource.x + touchSource.width / 2,
    clientY: touchSource.y + touchSource.height / 2,
  });
  await expect(cell(page, "XNAS:MSFT")).toHaveAttribute("data-grabbed", "true");
  const touchTarget = await cell(page, "XNAS:AAPL").boundingBox();
  await cell(page, "XNAS:MSFT").dispatchEvent("pointermove", {
    ...touch,
    clientX: touchTarget.x + touchTarget.width * 0.75,
    clientY: touchTarget.y + touchTarget.height * 0.75,
  });
  await cell(page, "XNAS:MSFT").dispatchEvent("pointerup", {
    ...touch,
    clientX: touchTarget.x + touchTarget.width * 0.75,
    clientY: touchTarget.y + touchTarget.height * 0.75,
  });
  await expect.poll(() => page.evaluate(() => (
    (() => {
      const collection = JSON.parse(localStorage.getItem("marketmap-boards-v3"));
      return collection.boards.find(({ id }) => id === collection.activeBoardId);
    })().instruments
      .slice(-3)
      .map(({ id }) => id)
  ))).toEqual(["RATE:^TNX", "XNAS:AAPL", "XNAS:MSFT"]);
});

test("sweeps a tile across the board without the arrangement ever flip-flopping", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });

  await page.evaluate(() => {
    const read = () => [...document.querySelectorAll("#marketmap [data-layout-id]")]
      .map((node) => `${node.dataset.layoutId}@${node.style.gridColumnStart},${node.style.gridRowStart}`)
      .join("|");
    window.__arrangements = [read()];
    new MutationObserver(() => {
      const next = read();
      if (next !== window.__arrangements.at(-1)) window.__arrangements.push(next);
    }).observe(document.querySelector("#marketmap"), {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  });

  const source = await cell(page, "XNAS:AAPL").boundingBox();
  const originX = source.x + source.width / 2;
  const originY = source.y + source.height / 2;
  await page.mouse.move(originX, originY);
  await page.mouse.down();
  await page.mouse.move(originX + 380, originY, { steps: 20 });
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(originX + 380 + step * 26, originY);
    await page.waitForTimeout(24);
  }
  await page.mouse.up();
  await expect(cell(page, "XNAS:AAPL")).not.toHaveAttribute("data-grabbed", "true");

  const { total, distinct } = await page.evaluate(() => ({
    total: window.__arrangements.length,
    distinct: new Set(window.__arrangements).size,
  }));
  expect(total).toBeGreaterThan(2);
  expect(distinct).toBe(total);
});

test("persists keyboard order and the news block position/open state across reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });

  const second = await page.locator(".asset-tile").evaluateAll((nodes) => (
    nodes[1]?.dataset.instrumentId
  ));

  await handle(page, "XNAS:AAPL").focus();
  await page.keyboard.press("Space");
  await expect(cell(page, "XNAS:AAPL")).toHaveAttribute("data-grabbed", "true");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => (
    (() => {
      const collection = JSON.parse(localStorage.getItem("marketmap-boards-v3"));
      return collection.boards.find(({ id }) => id === collection.activeBoardId);
    })().instruments
      .slice(0, 2)
      .map(({ id }) => id)
  ))).toEqual([second, "XNAS:AAPL"]);

  await page.locator(".mm-news-cell__toggle").click();
  await expect(page.locator('[data-cell="news"]')).toHaveAttribute("data-open", "false");
  await expect(page.locator(".mm-news-cell__summary")).toHaveText("12stories");
  expect(await page.locator('[data-cell="news"]').evaluate((node) => (
    node.getBoundingClientRect().height
  ))).toBeGreaterThanOrEqual(150);
  await page.locator('[data-reorder-handle="news"]').focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => (
    (() => {
      const collection = JSON.parse(localStorage.getItem("marketmap-boards-v3"));
      return collection.boards.find(({ id }) => id === collection.activeBoardId);
    })().layout
  ))).toEqual({ newsPosition: 0, newsOpen: false });

  await page.reload();
  await expect(page.locator(".marketmap-app")).toHaveAttribute("data-marketmap-mounted", "true");
  await expect(tile(page, second)).toBeVisible();
  expect(await page.locator(".asset-tile").evaluateAll((nodes) => (
    nodes.slice(0, 2).map((node) => node.dataset.instrumentId)
  ))).toEqual([second, "XNAS:AAPL"]);
  await expect(page.locator("#marketmap [data-layout-id]").first())
    .toHaveAttribute("data-layout-id", "__marketmap_news__");
  await expect(page.locator('[data-cell="news"]')).toHaveAttribute("data-open", "false");
});
