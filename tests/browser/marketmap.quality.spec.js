import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { CRITICAL_TOKENS, MEASURE_COMPOSITED_TEXT_CONTRAST, axeSummary, openMarketMap } from "./support/marketMapPage.js";

const detailDialog = (page) => page.locator("#instrument-detail-dialog");

for (const theme of ["dark", "light"]) {
  test(`resolves the ${theme} token and computed-style contract`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const root = await openMarketMap(page, { theme });
    const contract = await root.evaluate((element, tokens) => {
      const styles = getComputedStyle(element);
      return {
        unresolved: tokens.filter((token) => !styles.getPropertyValue(token).trim()),
        bodyMargin: getComputedStyle(document.body).margin,
        colorScheme: styles.colorScheme,
        toolbar: getComputedStyle(element.querySelector(".mm-toolbar")).display,
        grid: getComputedStyle(element.querySelector(".marketmap-grid")).display,
      };
    }, CRITICAL_TOKENS);
    expect(contract.unresolved).toEqual([]);
    expect(contract.bodyMargin).toBe("0px");
    expect(contract.colorScheme).toContain(theme);
    expect(contract.toolbar).toBe("flex");
    expect(contract.grid).toBe("grid");
  });
}

for (const theme of ["dark", "light"]) {
  test(`keeps every ${theme} change pill above 4.5:1 through the board's own surfaces`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const root = await openMarketMap(page, { theme });
    const pills = await root.evaluate(MEASURE_COMPOSITED_TEXT_CONTRAST, '.asset-tile span[class*="pill"]');

    expect(pills.length).toBe(40);
    expect(pills.every((pill) => pill.fontSize < 14)).toBe(true);
    expect(pills.filter((pill) => pill.ratio < 4.5)).toEqual([]);
  });
}

test("renders the 40-name board as six detailed desktop columns with room to add", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const root = await openMarketMap(page, { theme: "light" });
  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(40);
  await expect(page.locator(".add-tile")).toHaveCount(0);
  await expect(page.locator("#add-instrument-btn")).toBeVisible();
  const contract = await root.evaluate((element) => ({
    columns: getComputedStyle(element.querySelector(".marketmap-grid")).gridTemplateColumns.split(" ").filter(Boolean).length,
    tileRadius: Number.parseFloat(getComputedStyle(element.querySelector(".asset-tile:not(.add-tile)")).borderRadius),
    titleSize: Number.parseFloat(getComputedStyle(element.querySelector(".mm-masthead__title")).fontSize),
    news: (() => {
      const grid = element.querySelector(".marketmap-grid").getBoundingClientRect();
      const rail = element.querySelector('[data-cell="news"]');
      const bounds = rail.getBoundingClientRect();
      const styles = getComputedStyle(rail);
      return {
        anchorsTopLeft: bounds.left < grid.left + grid.width / 2
          && bounds.top - grid.top < bounds.height,
        overflowY: styles.overflowY,
        maxBlockSize: styles.maxBlockSize,
        hasNestedScroll: rail.scrollHeight - rail.clientHeight > 1,
      };
    })(),
  }));
  expect(contract.columns).toBe(6);
  expect(contract.tileRadius).toBeGreaterThanOrEqual(8);
  expect(contract.titleSize).toBe(54);
  expect(contract.news).toEqual({
    anchorsTopLeft: true,
    overflowY: "visible",
    maxBlockSize: "none",
    hasNestedScroll: false,
  });
});

test("aligns the pulse metrics and keeps equal-height actions beside Add instrument", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const root = await openMarketMap(page, { theme: "dark" });
  const contract = await root.evaluate((element) => {
    const masthead = element.querySelector(".mm-masthead");
    const band = element.querySelector(".mm-pulse-band");
    const status = element.querySelector(".mm-status");
    const actionGroup = element.querySelector(".mm-actions");
    const controls = ["theme-btn", "btn-clear-all", "btn-restore-defaults", "add-instrument-btn"]
      .map((id) => element.querySelector(`#${id}`));
    const labels = [...element.querySelectorAll(".mm-stat__label")]
      .map((node) => node.getBoundingClientRect().top);
    const values = [...element.querySelectorAll(".mm-stat")]
      .map((node) => node.querySelector(".mm-stat__value").getBoundingClientRect().top);
    return {
      statusIsMastheadChild: status?.parentElement === masthead,
      actionsAreInPulseBand: actionGroup?.parentElement === band,
      actionHeights: controls.map((node) => node?.getBoundingClientRect().height),
      labelSpread: Math.max(...labels) - Math.min(...labels),
      valueSpread: Math.max(...values) - Math.min(...values),
    };
  });
  expect(contract.statusIsMastheadChild).toBe(true);
  expect(contract.actionsAreInPulseBand).toBe(true);
  expect(Math.max(...contract.actionHeights) - Math.min(...contract.actionHeights)).toBeLessThanOrEqual(1);
  expect(contract.labelSpread).toBeLessThanOrEqual(1);
  expect(contract.valueSpread).toBeLessThanOrEqual(1);
});

test("opens the top mover in the design-system detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  const mover = page.locator("#snap-mover");
  const symbol = (await mover.textContent())?.trim().split(/\s+/)[0];
  await mover.click();
  const dialog = detailDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: symbol, exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Remove from board" })).toBeVisible();
});

test("renders every restored equity fundamental with its label and unit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = detailDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Return on equity", { exact: true })).toBeAttached();

  const copy = await dialog.innerText();
  for (const label of [
    "P/E (forward)", "Price / book", "Price / sales", "Dividend yield",
    "Revenue (TTM)", "Revenue growth", "Net margin", "Return on equity",
    "Debt / equity", "Free cash flow", "FCF margin",
  ]) {
    expect(copy, `missing detail label: ${label}`).toContain(label);
  }
  expect(copy).not.toContain("Return On Equity");
  expect(copy).not.toContain("Free Cash Flow Margin");
  expect(copy).toMatch(/Return on equity[\s\S]{0,24}147\.2\s*%/u);
  expect(copy).toMatch(/Debt \/ equity[\s\S]{0,24}1\.48(?!\s*%)/u);
});

test("uses PriceChart ranges and the crosshair heading readout", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = detailDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Fundamentals", { exact: true })).toBeVisible();
  await expect(dialog.locator(".mm-instrument-detail__ticker")).toHaveText("AAPL");
  expect(await dialog.locator(".mm-instrument-detail__ticker").evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBe(46);
  await expect(dialog.locator(".mm-instrument-detail__name-row")).toContainText("Apple Inc.");

  const statsCopy = await dialog.locator(".mm-instrument-detail__stats").innerText();
  const statOffsets = ["OPEN", "PREV CLOSE", "VOLUME", "BID / ASK"].map((label) => statsCopy.indexOf(label));
  expect(statOffsets.every((offset) => offset >= 0)).toBe(true);
  expect(statOffsets).toEqual([...statOffsets].sort((a, b) => a - b));
  expect(statsCopy).not.toContain("DAY HIGH");
  expect(statsCopy).not.toContain("DAY LOW");

  const analystTake = dialog.locator(".mm-instrument-detail__analyst-take");
  await expect(dialog.getByRole("heading", { name: "Analyst outlook", exact: true })).toBeVisible();
  await expect(analystTake).toBeVisible();
  await expect(analystTake).toHaveCSS("grid-column", "1 / -1");

  const containment = await dialog.locator(".mm-instrument-detail").evaluate((article) => {
    const body = article.parentElement;
    const frame = body?.parentElement;
    const popup = frame?.parentElement;
    const bodyBounds = body?.getBoundingClientRect();
    const frameBounds = frame?.getBoundingClientRect();
    return {
      bodyOverflowY: body ? getComputedStyle(body).overflowY : "",
      frameOverflow: frame ? getComputedStyle(frame).overflow : "",
      scrollIsInternal: Boolean(body && body.scrollHeight - body.clientHeight > 1),
      noHorizontalSpill: Boolean(body && article.scrollWidth <= body.clientWidth + 1),
      bodyIsClippedByFrame: Boolean(
        popup && bodyBounds && frameBounds
        && bodyBounds.left >= frameBounds.left - 1
        && bodyBounds.right <= frameBounds.right + 1
        && bodyBounds.top >= frameBounds.top - 1
        && bodyBounds.bottom <= frameBounds.bottom + 1
      ),
    };
  });
  expect(containment).toEqual({
    bodyOverflowY: "auto",
    frameOverflow: "hidden",
    scrollIsInternal: true,
    noHorizontalSpill: true,
    bodyIsClippedByFrame: true,
  });

  const canvas = dialog.locator("canvas");
  for (const expected of [
    { label: "5D", range: "5d", interval: "15m", priceBasis: "raw" },
    { label: "1M", range: "1m", interval: "1d", priceBasis: "provider_adjusted" },
    { label: "6M", range: "6m", interval: "1d", priceBasis: "provider_adjusted" },
    { label: "5Y", range: "5y", interval: "1wk", priceBasis: "provider_adjusted" },
  ]) {
    const requestPromise = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname.endsWith("/history") && url.searchParams.get("range") === expected.range;
    });
    await dialog.getByRole("button", { name: expected.label, exact: true }).click();
    const request = new URL((await requestPromise).url());
    expect(request.searchParams.get("interval")).toBe(expected.interval);
    expect(request.searchParams.get("priceBasis")).toBe(expected.priceBasis);
    await expect(canvas).toBeVisible();
    await expect(dialog.getByText("Price history unavailable", { exact: true })).toHaveCount(0);
  }
  const before = await dialog.locator(".mm-instrument-detail__chart-heading em").textContent();
  await canvas.hover({ position: { x: 180, y: 100 } });
  await expect(dialog.locator(".mm-instrument-detail__chart-heading em")).not.toHaveText(before || "");
  await expect(dialog.getByText("Day range", { exact: true })).toBeVisible();
  await expect(dialog.getByText("52-week range", { exact: true })).toBeVisible();
});

test("disables an empty chart range and switches to the next available history", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, {
    theme: "dark",
    marketApi: { emptyHistoryRanges: ["1d"] },
  });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = detailDialog(page);

  await expect(dialog.getByRole("button", { name: "1D", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "5D", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.locator("canvas")).toBeVisible();
  await expect(dialog.getByText("Price history unavailable", { exact: true })).toHaveCount(0);
});

test("keeps Add instrument available after clear and the first addition", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator("#btn-clear-all").click();
  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(0);
  await page.locator("#add-instrument-btn").click();
  const dialog = page.locator("#add-instrument-dialog");
  await dialog.locator("#add-ticker-input").fill("adobe");
  const result = dialog.locator(".mm-search-result");
  await expect(result).toContainText("ADBE");
  await result.getByRole("button", { name: "Add" }).click();
  await expect(page.locator(".asset-tile:not(.add-tile)")).toHaveCount(1);
  await expect(page.locator(".add-tile")).toHaveCount(0);
  await expect(page.locator("#add-instrument-btn")).toBeVisible();
});

test("opens an instrument detail without a failed request reaching the console", async ({ page }) => {
  const failures = [];
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator('.asset-tile[data-instrument-id="XNAS:AAPL"]').click();
  await expect(detailDialog(page)).toBeVisible();
  await expect(detailDialog(page)).toContainText("Price performance");

  await expect
    .poll(() => page.evaluate(() => window.MarketMapStandalone?.getInstance?.()?.analyticsSupport))
    .toBe(false);
  expect(failures).toEqual([]);
});

test("returns focus to the trigger when the add dialog is dismissed with Escape", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator("#add-instrument-btn").focus();
  await page.keyboard.press("Enter");
  const dialog = page.locator("#add-instrument-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#add-ticker-input")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#add-instrument-btn")).toBeFocused();
});

test("offers a skip link that carries a keyboard visitor past every tile stop", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  const skip = page.locator(".mm-skip-board");
  const resting = await skip.boundingBox();
  expect(resting.height).toBeLessThanOrEqual(1);

  await page.locator("#board-guide-info").focus();
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  const revealed = await skip.boundingBox();
  expect(revealed.height).toBeGreaterThan(resting.height);

  await page.keyboard.press("Enter");
  await expect(page.locator("#marketmap-end")).toBeFocused();

  const stopsSkipped = await page.locator(".marketmap-grid button").count();
  expect(stopsSkipped).toBeGreaterThan(40);
});

test("hydrates an added market index with its first quote", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark", pause: false });
  await page.locator("#add-instrument-btn").click();
  const dialog = page.locator("#add-instrument-dialog");
  await dialog.locator("#add-ticker-input").fill("ftse mib");
  const result = dialog.locator('.mm-search-result[data-instrument-id="INDEX:FTSEMIB.MI"]');
  await expect(result).toContainText("FTSE MIB Index");
  await result.getByRole("button", { name: "Add", exact: true }).click();

  const tile = page.locator('.asset-tile[data-instrument-id="INDEX:FTSEMIB.MI"]');
  await expect(tile).toContainText("51,882.28 pts");
  await expect(tile).toHaveAttribute("data-quality", "delayed");
  await expect(tile).not.toHaveAttribute("aria-label", /Price —\./);
});

test("keeps the control surface and board inside representative host widths", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const root = await openMarketMap(page, { theme: "dark" });
  const failures = [];
  for (const width of [1280, 800, 640, 590, 360]) {
    await root.evaluate((element, value) => { element.style.width = `${value}px`; }, width);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const overflow = await root.evaluate((element) => [...element.querySelectorAll(".container, .mm-masthead, .mm-toolbar, .mm-pulse, .marketmap-grid")]
      .filter((node) => node.scrollWidth - node.clientWidth > 1).map((node) => node.className));
    if (overflow.length) failures.push({ width, overflow });
  }
  expect(failures).toEqual([]);
});

test("keeps status and board-guide popovers inside narrow embed containers", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  const root = await openMarketMap(page, { theme: "dark" });
  for (const width of [590, 360]) {
    await root.evaluate((element, value) => { element.style.width = `${value}px`; }, width);
    for (const [trigger, panel] of [["#feed-status-info", "#feed-status-popover"], ["#board-guide-info", "#board-guide-popover"]]) {
      await page.locator(trigger).click();
      await expect(page.locator(panel)).toBeVisible();
      const within = await page.locator(".container").evaluate((container, selector) => {
        const outer = container.getBoundingClientRect();
        const inner = container.querySelector(selector).getBoundingClientRect();
        return inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
      }, panel);
      expect(within).toBe(true);
      const unobscured = await page.locator(panel).evaluate((popover) => {
        const bounds = popover.getBoundingClientRect();
        const sample = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + 12);
        return Boolean(sample && popover.contains(sample));
      });
      expect(unobscured).toBe(true);
      await page.keyboard.press("Escape");
    }
  }
});

test("matches each open toolbar menu to the selector width", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  const selector = page.getByRole("combobox", { name: "Asset class" });
  await selector.click();
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  const popup = listbox.locator("xpath=..");
  const [triggerBounds, popupBounds] = await Promise.all([selector.boundingBox(), popup.boundingBox()]);
  expect(Math.abs(triggerBounds.width - popupBounds.width)).toBeLessThanOrEqual(1);
});

test("renders a safe board news feed and an instrument-specific dialog news list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await openMarketMap(page, { theme: "dark" });
  const boardNews = page.locator('[data-cell="news"]');
  await expect(boardNews.locator("li")).toHaveCount(12);
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = detailDialog(page);
  const news = dialog.getByRole("heading", { name: "Latest news", exact: true }).locator("xpath=../..");
  await expect(news.locator("li")).toHaveCount(4);
  await expect(news).toContainText("Recent coverage for AAPL");
  await expect(news.locator('a[target="_blank"]')).toHaveCount(4);
});

for (const theme of ["dark", "light"]) {
  test(`@a11y has no automated WCAG A/AA violations on the ${theme} board`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openMarketMap(page, { theme });
    const results = await new AxeBuilder({ page }).include(".marketmap-app").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(axeSummary(results.violations)).toEqual([]);
  });
}

test("@a11y keeps the design-system detail dialog free of automated WCAG A/AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await page.locator(".asset-tile:not(.add-tile)").first().click();
  const dialog = detailDialog(page);
  await expect(dialog).toBeVisible();
  const results = await new AxeBuilder({ page }).include("#instrument-detail-dialog").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  expect(axeSummary(results.violations)).toEqual([]);
});
