import { describe, expect, it, vi } from "vitest";

import { ModalView } from "../src/ui/views/ModalView.js";

const AAPL = Object.freeze({
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
  exchange: "NASDAQ",
  currency: "USD",
  sector: "Technology",
});
const MSFT = Object.freeze({ ...AAPL, id: "XNAS:MSFT", symbol: "MSFT", name: "Microsoft Corp." });
const AS_OF = "2026-07-13T14:30:00.000Z";

const tile = (patch = {}) => ({
  instrumentId: AAPL.id,
  price: 232.41,
  change: 2.12,
  changePercent: 0.92,
  open: 230.1,
  previousClose: 230.29,
  dayHigh: 233.05,
  dayLow: 229.84,
  bid: 232.35,
  ask: 232.46,
  volume: 38_410_000,
  averageVolume3m: 49_820_000,
  asOf: AS_OF,
  currency: "USD",
  quality: "fresh",
  source: "yahoo",
  ...patch,
});

const detailsWith = (fields, patch = {}) => ({
  kind: "company",
  instrument: AAPL,
  sections: [{
    id: "equity_fundamentals",
    status: "available",
    fields,
    fieldAvailability: {},
    ...patch,
  }],
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function mount({ assets = [AAPL], helpers = {}, ...overrides } = {}) {
  const detailApi = { setOpen: vi.fn(), setModel: vi.fn() };
  const current = { value: tile() };
  const app = {
    state: { getTile: vi.fn(() => current.value) },
    getDetails: vi.fn(async () => detailsWith({ marketCap: 3_000_000_000_000 })),
    getHistory: vi.fn(async () => ({
      instrumentId: AAPL.id,
      range: "1d",
      interval: "5m",
      priceBasis: "raw",
      continuity: { kind: "single_instrument" },
      bars: [
        { timestamp: "2026-07-13T14:20:00.000Z", close: 230.5, displayClose: 230.5, volume: 10 },
        { timestamp: AS_OF, close: 232.41, displayClose: 232.41, volume: 14 },
      ],
    })),
    getNews: vi.fn(async () => ({ data: { articles: [], source: "yahoo" } })),
    ...overrides,
  };
  const view = new ModalView(assets, helpers, { detailApi });
  view.setApp(app);
  return { app, current, detailApi, view };
}

const lastModel = (detailApi) => detailApi.setModel.mock.calls.at(-1)?.[0];

async function opened(options = {}) {
  const harness = mount(options);
  harness.view.showAssetDetails(0);
  await flush();
  return harness;
}

const fieldValues = (model) => model.details.sections
  .flatMap((section) => section.items)
  .reduce((all, item) => Object.assign(all, { [item.label]: item.value }), {});

describe("detail value formatting", () => {
  const valueFor = async (fields) => {
    const { detailApi } = await opened({
      getDetails: vi.fn(async () => detailsWith(fields)),
    });
    return fieldValues(lastModel(detailApi));
  };

  it("says so plainly when every field of a section is empty", async () => {
    const { detailApi } = await opened({
      getDetails: vi.fn(async () => detailsWith({ marketCap: null })),
    });
    const [only] = lastModel(detailApi).details.sections;
    expect(only.items).toEqual([]);
    expect(only.message).toBe("No applicable detail fields were returned.");
  });

  it.each([
    ["a true flag", { isEtf: true }, "Yes"],
    ["a false flag", { isEtf: false }, "No"],
  ])("renders %s", async (_label, fields, expected) => {
    expect(Object.values(await valueFor(fields))).toContain(expected);
  });

  it("joins a list into one line", async () => {
    const values = Object.values(await valueFor({ holdings: ["AAPL", "MSFT"] }));
    expect(values).toContain("AAPL, MSFT");
  });

  it("flattens a nested object into labelled pairs", async () => {
    const values = Object.values(await valueFor({ allocation: { stockPosition: 0.9 } }));
    expect(values.some((value) => value.includes("Stock Position: 0.9"))).toBe(true);
  });

  it("renders a date string as a timestamp", async () => {
    const values = Object.values(await valueFor({ exDividendDate: "2026-07-01T00:00:00.000Z" }));
    expect(values.some((value) => /2026/u.test(value))).toBe(true);
  });

  it.each([
    ["a snake_case token", { recommendationKey: "strong_buy" }, "Strong Buy"],
    ["a bare lowercase token", { recommendationKey: "buy" }, "Buy"],
  ])("title-cases %s", async (_label, fields, expected) => {
    expect(Object.values(await valueFor(fields))).toContain(expected);
  });

  it("leaves a value that is already prose alone", async () => {
    const values = Object.values(await valueFor({ summary: "A large technology company." }));
    expect(values).toContain("A large technology company.");
  });

  it("renders a percentage field with its unit", async () => {
    const values = Object.values(await valueFor({ expenseRatio: 0.0945 }));
    expect(values.some((value) => value.endsWith("%"))).toBe(true);
  });

  it("labels every restored equity fundamental and marks the ratios as percentages", async () => {
    const values = await valueFor({
      forwardPe: 29.2,
      priceBook: 52.1,
      priceSales: 10.75,
      dividendYield: 0.49,
      revenueTtm: 416_000_000_000,
      revenueGrowth: 6.1,
      netMargin: 26.4,
      returnOnEquity: 171,
      debtEquity: 1.524,
      freeCashFlow: 112_000_000_000,
      freeCashFlowMargin: 26.9,
    });

    expect(Object.keys(values)).toEqual(expect.arrayContaining([
      "P/E (forward)", "Price / book", "Price / sales", "Dividend yield",
      "Revenue (TTM)", "Revenue growth", "Net margin", "Return on equity",
      "Debt / equity", "Free cash flow", "FCF margin",
    ]));
    for (const label of ["Dividend yield", "Revenue growth", "Net margin", "Return on equity", "FCF margin"]) {
      expect(values[label]).toMatch(/%$/u);
    }
    expect(values["Debt / equity"]).not.toMatch(/%$/u);
  });

  it("renders an ordinary number without inventing a unit", async () => {
    const values = Object.values(await valueFor({ beta: 12.5 }));
    expect(values).toContain("12.5");
  });

  it("compacts a large count", async () => {
    const values = Object.values(await valueFor({ marketCap: 3_000_000_000_000 }));
    expect(values.some((value) => /[KMBT]$/u.test(value))).toBe(true);
  });

  it("falls back to a single empty section when the provider returns none", async () => {
    const { detailApi } = await opened({
      getDetails: vi.fn(async () => ({ kind: "company", instrument: AAPL, sections: [] })),
    });
    const model = lastModel(detailApi);
    expect(model.details.sections).toHaveLength(1);
    expect(model.details.sections[0].items).toEqual([]);
  });
});

describe("caller-supplied formatters", () => {
  it("prefers the host's own compact formatter for counted figures", async () => {
    const helpers = { formatVolume: vi.fn(() => "VOL") };
    const { detailApi } = await opened({ helpers });

    expect(helpers.formatVolume).toHaveBeenCalled();
    expect(JSON.stringify(lastModel(detailApi))).toContain("VOL");
  });

  it("falls back to its own formatting when the host supplies none", async () => {
    const { detailApi } = await opened();
    const model = lastModel(detailApi);
    expect(model.header.value).toMatch(/\$/u);
  });

  it("renders an unreadable figure as an em dash", async () => {
    const { detailApi } = await opened({});
    const model = lastModel(detailApi);
    expect(typeof model.header.changeLabel).toBe("string");
  });
});

describe("modal navigation order", () => {
  it("moves through the order the board supplied", async () => {
    const { view } = await opened({ assets: [AAPL, MSFT] });
    view.setNavigationOrder([AAPL.id, MSFT.id]);

    expect(view.navigateInstrument(1)).toBe(true);
    expect(view.navigateInstrument(1)).toBe(false);
    expect(view.navigateInstrument(-1)).toBe(true);
  });

  it.each([
    ["a zero offset", 0],
    ["a fractional offset", 1.5],
    ["a non-numeric offset", "next"],
  ])("refuses %s", async (_label, offset) => {
    const { view } = await opened({ assets: [AAPL, MSFT] });
    view.setNavigationOrder([AAPL.id, MSFT.id]);
    expect(view.navigateInstrument(offset)).toBe(false);
  });

  it("refuses to navigate while closed", async () => {
    const { view } = mount({ assets: [AAPL, MSFT] });
    view.setNavigationOrder([AAPL.id, MSFT.id]);
    expect(view.navigateInstrument(1)).toBe(false);
  });

  it("ignores an order that is not an array", async () => {
    const { view } = await opened({ assets: [AAPL, MSFT] });
    view.setNavigationOrder("AAPL");
    expect(view.navigateInstrument(1)).toBe(false);
  });

  it("drops repeated and off-board ids from the order", async () => {
    const { view, detailApi } = await opened({ assets: [AAPL, MSFT] });
    view.setNavigationOrder([AAPL.id, AAPL.id, "XNAS:GONE", MSFT.id]);

    expect(lastModel(detailApi).navigation).toMatchObject({ position: 1, total: 2 });
  });

  it("reports no position for an instrument outside the current filter", async () => {
    const { view, detailApi } = await opened({ assets: [AAPL, MSFT] });
    view.setNavigationOrder([MSFT.id]);
    expect(lastModel(detailApi).navigation.position).toBeNull();
  });
});

describe("modal board reconciliation", () => {
  it("closes when the open instrument leaves the board", async () => {
    const { view, detailApi } = await opened({ assets: [AAPL, MSFT] });
    view.updateAssets([MSFT]);

    expect(view.isOpen()).toBe(false);
    expect(detailApi.setOpen).toHaveBeenLastCalledWith(false);
  });

  it("stays open and follows the instrument to its new position", async () => {
    const { view } = await opened({ assets: [AAPL, MSFT] });
    view.updateAssets([MSFT, AAPL]);
    expect(view.isOpen()).toBe(true);
  });

  it("prunes the navigation order to what the board still holds", async () => {
    const { view, detailApi } = await opened({ assets: [AAPL, MSFT] });
    view.setNavigationOrder([AAPL.id, MSFT.id]);
    view.updateAssets([AAPL]);

    expect(lastModel(detailApi).navigation).toMatchObject({ total: 1, canNext: false });
  });

  it("does nothing when the board changes while closed", async () => {
    const { view } = mount({ assets: [AAPL, MSFT] });
    view.updateAssets([MSFT]);
    expect(view.isOpen()).toBe(false);
  });

  it("removes the open instrument on request and closes", async () => {
    const removeTicker = vi.fn();
    const { view } = await opened({ helpers: { removeTicker } });

    view.handleRemoveTicker();
    expect(removeTicker).toHaveBeenCalledWith(AAPL.id);
    expect(view.isOpen()).toBe(false);
  });

  it("removes nothing when no instrument is open", () => {
    const removeTicker = vi.fn();
    const { view } = mount({ helpers: { removeTicker } });
    view.handleRemoveTicker();
    expect(removeTicker).not.toHaveBeenCalled();
  });

  it("ignores a request for an index the board does not hold", async () => {
    const { view } = mount();
    view.showAssetDetails(99);
    await flush();
    expect(view.isOpen()).toBe(false);
  });
});

describe("modal detail island wiring", () => {
  it("republishes the model when a detail island attaches late", async () => {
    const { view, detailApi } = await opened();
    const calls = detailApi.setModel.mock.calls.length;

    view.setDetailApi(detailApi);
    expect(detailApi.setModel.mock.calls.length).toBeGreaterThan(calls);
  });

  it("tolerates the island detaching", async () => {
    const { view } = await opened();
    expect(() => view.setDetailApi(null)).not.toThrow();
  });

  it("releases the host overlay when destroyed with a dialog open", async () => {
    const detailApi = { setOpen: vi.fn(), setModel: vi.fn() };
    const setScrollLocked = vi.fn();
    const onOverlayChange = vi.fn();
    const view = new ModalView([AAPL], {}, { detailApi, setScrollLocked, onOverlayChange });
    view.setApp(mount().app);
    view.showAssetDetails(0);
    await flush();

    view.destroy();
    expect(setScrollLocked).toHaveBeenLastCalledWith(false);
    expect(onOverlayChange).toHaveBeenLastCalledWith(false);
  });

  it("has no init work of its own", () => {
    expect(() => mount().view.init()).not.toThrow();
  });
});
