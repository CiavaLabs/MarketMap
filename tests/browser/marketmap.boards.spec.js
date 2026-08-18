import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { axeSummary, openMarketMap } from "./support/marketMapPage.js";

const DEFAULT_BOARD = "Markets";

const boardSelect = (page) => page.getByRole("combobox", { name: "Board" });
const boardTiles = (page) => page.locator(".asset-tile:not(.add-tile)");

async function openBoardMenu(page) {
  await page.getByRole("button", { name: "Manage boards" }).click();
}

async function createBoard(page, name) {
  await openBoardMenu(page);
  await page.getByRole("menuitem", { name: "Create board" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Board name" }).fill(name);
  await dialog.getByRole("button", { name: "Create board" }).click();
  await expect(boardSelect(page)).toContainText(name);
}

async function chooseBoard(page, name) {
  await boardSelect(page).click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect(boardSelect(page)).toContainText(name);
}

async function addInstrument(page, query, instrumentId) {
  await page.locator("#add-instrument-btn").click();
  const dialog = page.locator("#add-instrument-dialog");
  await dialog.locator("#add-ticker-input").fill(query);
  const result = dialog.locator(`.mm-search-result[data-instrument-id="${instrumentId}"]`);
  await expect(result).toBeVisible();
  await result.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.locator(`.asset-tile[data-instrument-id="${instrumentId}"]`)).toBeVisible();
}

test("creates, arranges, duplicates, renames, deletes and restores independent boards", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMarketMap(page, { theme: "dark" });
  await expect(boardSelect(page)).toContainText(DEFAULT_BOARD);

  const secondInstrument = await boardTiles(page).evaluateAll((tiles) => (
    tiles[1]?.dataset.instrumentId
  ));

  const defaultHandle = page.locator('[data-reorder-handle="XNAS:AAPL"]');
  await defaultHandle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");
  await page.locator(".mm-news-cell__toggle").click();

  await createBoard(page, "Semis");
  await expect(boardTiles(page)).toHaveCount(0);

  await openBoardMenu(page);
  await page.getByRole("menuitem", { name: "Create board" }).click();
  const refusedDialog = page.getByRole("dialog");
  await refusedDialog.getByRole("button", { name: "Create board" }).click();
  await expect(refusedDialog.getByRole("alert")).toHaveText("Enter a board name.");
  await refusedDialog.getByRole("textbox", { name: "Board name" }).fill(DEFAULT_BOARD.toLowerCase());
  await refusedDialog.getByRole("button", { name: "Create board" }).click();
  await expect(refusedDialog.getByRole("alert")).toHaveText("Choose a distinct board name.");
  await refusedDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(boardSelect(page)).toContainText("Semis");

  await addInstrument(page, "bnd", "XNAS:BND");
  await page.locator(".mm-news-cell__toggle").click();
  await page.locator('[data-reorder-handle="news"]').focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Home");
  await page.keyboard.press("Space");

  await openBoardMenu(page);
  await page.getByRole("menuitem", { name: "Duplicate board" }).click();
  await expect(boardSelect(page)).toContainText("Semis copy");
  await openBoardMenu(page);
  await page.getByRole("menuitem", { name: "Rename board" }).click();
  const renameDialog = page.getByRole("dialog");
  await renameDialog.getByRole("textbox", { name: "Board name" }).fill("Watchlist");
  await renameDialog.getByRole("button", { name: "Save name" }).click();
  await expect(boardSelect(page)).toContainText("Watchlist");
  await addInstrument(page, "ftse mib", "INDEX:FTSEMIB.MI");

  await chooseBoard(page, DEFAULT_BOARD);
  expect(await boardTiles(page).evaluateAll((tiles) => (
    tiles.slice(0, 2).map((tile) => tile.dataset.instrumentId)
  ))).toEqual([secondInstrument, "XNAS:AAPL"]);
  await expect(page.locator('[data-cell="news"]')).toHaveAttribute("data-open", "false");

  await chooseBoard(page, "Semis");
  await expect(boardTiles(page)).toHaveCount(1);
  await expect(page.locator('.asset-tile[data-instrument-id="XNAS:BND"]')).toBeVisible();
  await expect(page.locator("#marketmap [data-layout-id]").first())
    .toHaveAttribute("data-layout-id", "__marketmap_news__");
  await expect(page.locator('[data-cell="news"]')).toHaveAttribute("data-open", "false");

  await chooseBoard(page, "Watchlist");
  await expect(boardTiles(page)).toHaveCount(2);
  await expect(page.locator('.asset-tile[data-instrument-id="INDEX:FTSEMIB.MI"]')).toBeVisible();
  await page.reload();
  await expect(boardSelect(page)).toContainText("Watchlist");
  await expect(boardTiles(page)).toHaveCount(2);

  expect(await page.evaluate(() => {
    const collection = JSON.parse(localStorage.getItem("marketmap-boards-v3"));
    return {
      schemaVersion: collection.schemaVersion,
      activeBoardId: collection.activeBoardId,
      names: collection.boards.map(({ name }) => name),
      legacyStillPresent: Boolean(localStorage.getItem("marketmap-board-v2")),
    };
  })).toEqual({
    schemaVersion: 3,
    activeBoardId: "board-2",
    names: [DEFAULT_BOARD, "Semis", "Watchlist"],
    legacyStillPresent: false,
  });

  await openBoardMenu(page);
  await page.getByRole("menuitem", { name: "Delete board" }).click();
  await expect(boardSelect(page)).toContainText("Semis");
  const undo = page.getByRole("button", { name: "Undo" });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(boardSelect(page)).toContainText("Watchlist");
  await expect(boardTiles(page)).toHaveCount(2);
});

test("@a11y keeps board management menu and naming dialog free of WCAG A/AA violations", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openMarketMap(page, { theme: "light" });
  await openBoardMenu(page);
  const menuAudit = await new AxeBuilder({ page })
    .include(".mm-board-switcher__menu")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axeSummary(menuAudit.violations)).toEqual([]);

  await page.getByRole("menuitem", { name: "Create board" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialogAudit = await new AxeBuilder({ page })
    .include(".mm-board-dialog")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axeSummary(dialogAudit.violations)).toEqual([]);
});
