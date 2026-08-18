import { describe, expect, it, vi } from "vitest";
import { BoardNewsView } from "../src/ui/views/BoardNewsView.js";

const AAPL = { id: "XNAS:AAPL", symbol: "AAPL" };
const MSFT = { id: "XNAS:MSFT", symbol: "MSFT" };

describe("BoardNewsView", () => {
  it("forwards render(state) to gridApi.setNewsState with instrumentLabels built from the board", () => {
    const gridApi = { setNewsState: vi.fn() };
    const view = new BoardNewsView([AAPL], { gridApi });
    view.init();

    view.render({
      status: "ready",
      articles: [{ title: "Apple introduces a new platform" }],
      errors: [{ instrumentId: "XNAS:MSFT" }],
      sources: ["yahoo"],
      quality: "fresh",
      lastUpdatedAt: "2026-07-15T16:15:00.000Z",
    });

    expect(gridApi.setNewsState).toHaveBeenCalledWith({
      status: "ready",
      articles: [{ title: "Apple introduces a new platform" }],
      errors: [{ instrumentId: "XNAS:MSFT" }],
      sources: ["yahoo"],
      quality: "fresh",
      lastUpdatedAt: "2026-07-15T16:15:00.000Z",
      instrumentLabels: new Map([[AAPL.id, "AAPL"]]),
    });
    view.destroy();
  });

  it("defaults status to idle and articles to an empty array when state fields are missing", () => {
    const gridApi = { setNewsState: vi.fn() };
    const view = new BoardNewsView([AAPL], { gridApi });
    view.render();
    expect(gridApi.setNewsState).toHaveBeenCalledWith(expect.objectContaining({
      status: "idle",
      articles: [],
    }));
  });

  it("rebuilds instrumentLabels when the board changes", () => {
    const gridApi = { setNewsState: vi.fn() };
    const view = new BoardNewsView([AAPL], { gridApi });
    view.setInstruments([MSFT]);
    view.render({ status: "ready", articles: [] });
    const [call] = gridApi.setNewsState.mock.calls.at(-1);
    expect(call.instrumentLabels).toEqual(new Map([[MSFT.id, "MSFT"]]));
  });

  it("labels from the identity's symbol when a board instrument has no symbol", () => {
    const gridApi = { setNewsState: vi.fn() };
    const view = new BoardNewsView([{ id: "XNAS:ZZZ" }, { id: "INDEX:^ZZZ" }], { gridApi });
    view.render({ status: "ready", articles: [] });
    const [call] = gridApi.setNewsState.mock.calls.at(-1);
    expect(call.instrumentLabels.get("XNAS:ZZZ")).toBe("ZZZ");
    expect(call.instrumentLabels.get("INDEX:^ZZZ")).toBe("ZZZ");
  });

  it("is a safe no-op without a gridApi (e.g. the React bundle failed to load)", () => {
    const view = new BoardNewsView([AAPL]);
    expect(() => view.render({ status: "ready", articles: [] })).not.toThrow();
  });

  it("init and destroy are safe no-ops", () => {
    const view = new BoardNewsView([AAPL]);
    expect(() => {
      view.init();
      view.destroy();
    }).not.toThrow();
  });
});
