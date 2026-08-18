import { describe, expect, it, vi } from "vitest";
import { ModalView } from "../src/ui/views/ModalView.js";

const AAPL = Object.freeze({ id: "XNAS:AAPL", symbol: "AAPL", name: "Apple", assetClass: "equity", currency: "USD" });
const MSFT = Object.freeze({ ...AAPL, id: "XNAS:MSFT", symbol: "MSFT", name: "Microsoft" });
function tile(asset) { return { instrumentId: asset.id, price: 200, previousClose: 198, dayLow: 197, dayHigh: 201, currency: "USD", asOf: "2026-07-15T16:00:00.000Z" }; }
function history() { return { bars: [{ timestamp: "2026-07-15T15:55:00.000Z", close: 199 }, { timestamp: "2026-07-15T16:00:00.000Z", close: 200 }] }; }
function details() { return { kind: "company", sections: [{ id: "equity_fundamentals", status: "available", fields: { marketCap: 3_000_000_000_000 }, fieldAvailability: {} }] }; }
function envelope(asset, count = 1) { return { data: { articles: Array.from({ length: count }, (_, i) => ({ id: `${asset.id}-${i}`, title: `${asset.symbol} coverage ${i + 1}`, url: `https://news.example/${asset.symbol}/${i}`, publisher: "Reuters", publishedAt: "2026-07-15T16:00:00.000Z" })), source: "yahoo", fetchedAt: "2026-07-15T16:01:00.000Z" }, sources: { news: ["yahoo"] } }; }
async function flush() { await Promise.resolve(); await Promise.resolve(); }

describe("ModalView news state", () => {
  it("loads at most four articles beside the details and history requests", async () => {
    const detailApi = { setOpen: vi.fn(), setModel: vi.fn() };
    const app = { state: { getTile: vi.fn(() => tile(AAPL)) }, getDetails: vi.fn(async () => details()), getHistory: vi.fn(async () => history()), getNews: vi.fn(async () => envelope(AAPL, 8)) };
    const view = new ModalView([AAPL], {}, { detailApi });
    view.setApp(app);
    view.showAssetDetails(0);
    await flush();
    expect(app.getDetails).toHaveBeenCalledOnce();
    expect(app.getHistory).toHaveBeenCalledOnce();
    expect(app.getNews).toHaveBeenCalledWith(AAPL.id, { limit: 4, signal: expect.any(AbortSignal) });
    const model = detailApi.setModel.mock.lastCall[0];
    expect(model.news.articles).toHaveLength(4);
    expect(model.news.articles[0].title).toContain("AAPL");
  });

  it("aborts and ignores the previous instrument's pending news response", async () => {
    const requests = [];
    const detailApi = { setOpen: vi.fn(), setModel: vi.fn() };
    const app = { state: { getTile: vi.fn((id) => tile(id === MSFT.id ? MSFT : AAPL)) }, getDetails: vi.fn(async () => details()), getHistory: vi.fn(async () => history()), getNews: vi.fn((id, options) => new Promise((resolve) => requests.push({ id, options, resolve }))) };
    const view = new ModalView([AAPL, MSFT], {}, { detailApi });
    view.setApp(app);
    view.showAssetDetails(0);
    view.showAssetDetails(1);
    expect(requests[0].options.signal.aborted).toBe(true);
    requests[1].resolve(envelope(MSFT));
    await flush();
    requests[0].resolve(envelope(AAPL));
    await flush();
    const model = detailApi.setModel.mock.lastCall[0];
    expect(model.header.symbol).toBe("MSFT");
    expect(model.news.articles[0].title).toContain("MSFT");
  });

  it("keeps an empty/error news response local to the news section", async () => {
    const detailApi = { setOpen: vi.fn(), setModel: vi.fn() };
    const app = { state: { getTile: vi.fn(() => tile(AAPL)) }, getDetails: vi.fn(async () => details()), getHistory: vi.fn(async () => history()), getNews: vi.fn(async () => envelope(AAPL, 0)) };
    const view = new ModalView([AAPL], {}, { detailApi });
    view.setApp(app);
    view.showAssetDetails(0);
    await flush();
    const model = detailApi.setModel.mock.lastCall[0];
    expect(model.news.message).toContain("No coverage was published");
    expect(model.details.sections[0].title).toBe("Fundamentals");
  });
});
