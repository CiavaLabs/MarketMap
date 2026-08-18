// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";
import { BoardSnapshotView } from "../src/ui/views/BoardSnapshotView.js";

const assets = [
  { id: "AAPL", symbol: "AAPL", name: "Apple", group: "Technology" },
  { id: "JPM", symbol: "JPM", name: "JPMorgan", group: "Financials" },
  { id: "BAD", symbol: "BAD", name: "Unavailable", group: "Technology" },
];

function quote(over) {
  return { price: 100, changePercent: 0, quality: "fresh", source: "yahoo", asOf: "2026-07-13T10:00:00.000Z", ...over };
}

function mount(states, helpers = {}, instruments = assets) {
  document.body.innerHTML = '<main class="marketmap-app" data-shell></main>';
  const root = document.querySelector("[data-shell]");
  renderMarketMapShell(root, { footer: false });
  const app = { assets: instruments, state: { getTile: (id) => states.get(id) } };
  const view = new BoardSnapshotView(app, instruments, {
    formatRelativeTime: () => "10:00:00",
    ...helpers,
  }, { root });
  view.init();
  return { app, root, view };
}

afterEach(() => document.body.replaceChildren());

const mixed = () => new Map([
  ["AAPL", quote({ price: 210, changePercent: 2 })],
  ["JPM", quote({ price: 190, changePercent: -1, quality: "stale" })],
  ["BAD", quote({ price: null, changePercent: null, quality: "unavailable", hasInfo: false })],
]);

describe("BoardSnapshotView", () => {
  it("renders whole-board pulse metrics from application state", () => {
    const { root } = mount(mixed());
    expect(root.querySelector("#snap-average").textContent).toBe("+0.50%");
    expect(root.querySelector("#snap-dispersion").textContent).toBe("1.50%");
    expect(root.querySelector("#snap-breadth").textContent).toBe("0%");
    expect(root.querySelector("#snap-leading").textContent).toBe("Technology +2.00%");
    expect(root.querySelector("#snap-average").classList.contains("positive")).toBe(true);
  });

  it("keeps the pulse equity-only while whole-board status includes quote-capable assets", () => {
    const instruments = [
      { id: "AAPL", symbol: "AAPL", assetClass: "equity", group: "Technology" },
      { id: "JPM", symbol: "JPM", assetClass: "equity", group: "Financials" },
      { id: "SPY", symbol: "SPY", assetClass: "etf", category: "Large Blend" },
      { id: "TNX", symbol: "US10Y", assetClass: "rate_index" },
    ].map((instrument) => ({
      ...instrument,
      capabilities: { quote: { status: "supported" } },
    }));
    const states = new Map([
      ["AAPL", quote({ changePercent: 2 })],
      ["JPM", quote({ changePercent: -1 })],
      ["SPY", quote({ changePercent: 50 })],
      ["TNX", quote({ price: null, changePercent: null, quality: "unavailable", hasInfo: false })],
    ]);
    const { root } = mount(states, {}, instruments);

    expect(root.querySelector("#snap-average").textContent).toBe("+0.50%");
    expect(root.querySelector("#snap-mover").textContent).toBe("AAPL +2.00%");
    expect(root.querySelector(".mm-pulse").getAttribute("aria-label"))
      .toBe("Equity pulse — 2 of 2 equities");
    expect(root.querySelector(".mm-status").dataset.state).toBe("partial");
  });

  it("treats a numeric but unusable quote as unavailable in whole-board status", () => {
    const states = new Map([
      ["AAPL", quote({ dataQuality: { status: "unusable" } })],
      ["JPM", quote({ price: 190, quality: "fresh" })],
      ["BAD", quote({ price: null, quality: "unavailable", hasInfo: false })],
    ]);
    const { root } = mount(states);

    expect(root.querySelector(".mm-status").dataset.state).toBe("partial");
  });

  it("renders the advance/decline spread with a proportional mix bar", () => {
    const { root } = mount(mixed());
    expect(root.querySelector("#snap-advancing").textContent).toBe("1");
    expect(root.querySelector("#snap-declining").textContent).toBe("1");
    expect(root.querySelector("#snap-spread").getAttribute("aria-label"))
      .toBe("1 advancing, 1 declining, 0 unchanged");

    const bar = root.querySelector("#snap-bar");
    expect(bar.hidden).toBe(false);
    const growth = Object.fromEntries([...bar.querySelectorAll("[data-side]")]
      .map((segment) => [segment.dataset.side, { grow: segment.style.flexGrow, hidden: segment.hidden }]));
    expect(growth).toEqual({
      up: { grow: "1", hidden: false },
      flat: { grow: "0", hidden: true },
      down: { grow: "1", hidden: false },
    });
  });

  it("hides the mix bar and dashes the spread when nothing is comparable", () => {
    const { root } = mount(new Map());
    expect(root.querySelector("#snap-bar").hidden).toBe(true);
    expect(root.querySelector("#snap-advancing").textContent).toBe("—");
    expect(root.querySelector("#snap-declining").textContent).toBe("—");
    expect(root.querySelector("#snap-mover").disabled).toBe(true);
    expect(root.querySelector("#snap-mover").textContent).toBe("—");
  });

  it("offers the top mover as a button that opens the instrument's details", () => {
    const openInstrumentDetails = vi.fn();
    const { root } = mount(mixed(), { openInstrumentDetails });
    const mover = root.querySelector("#snap-mover");
    expect(mover.textContent).toBe("AAPL +2.00%");
    expect(mover.disabled).toBe(false);
    expect(mover.classList.contains("positive")).toBe(true);
    expect(mover.classList.contains("mm-stat__value--action")).toBe(true);
    mover.click();
    expect(openInstrumentDetails).toHaveBeenCalledWith("AAPL");
  });

  it("turns pulse movement and leading sector values into filter commands", () => {
    const applyPulseFilters = vi.fn();
    const { root } = mount(mixed(), { applyPulseFilters });
    const advancing = root.querySelector("#snap-advancing");
    const declining = root.querySelector("#snap-declining");
    const leading = root.querySelector("#snap-leading");

    expect(advancing.disabled).toBe(false);
    expect(declining.disabled).toBe(false);
    expect(leading.disabled).toBe(false);
    expect(advancing.getAttribute("aria-label")).toContain("advancing equities; filter to them");
    expect(leading.getAttribute("aria-label")).toContain("Technology");

    advancing.click();
    declining.click();
    leading.click();

    expect(applyPulseFilters.mock.calls).toEqual([
      [{ assetClass: "equity", movement: "advancing" }],
      [{ assetClass: "equity", movement: "declining" }],
      [{ assetClass: "equity", category: "Technology" }],
    ]);
  });

  it("shows an aggregate status line without 'stale' or a source, with the right dot state", () => {
    const { root } = mount(mixed());
    const copy = root.querySelector("#feed-status-copy").textContent;
    expect(copy).toBe("Partial update 10:00:00");
    expect(copy.toLowerCase()).not.toContain("stale");
    expect(copy.toLowerCase()).not.toContain("source");
    expect(root.querySelector(".mm-status").dataset.state).toBe("partial");
  });

  it("announces the state a screen reader needs, and stays silent while only the clock moves", () => {
    const { app, root, view } = mount(mixed());
    const announcement = root.querySelector("#feed-status-announcement");
    expect(announcement.textContent).toBe("Partial update");

    app.feed = { lastUpdatedAt: "2026-07-13T10:05:00.000Z" };
    view.update();
    expect(root.querySelector("#feed-status-copy").textContent).toContain("10:00:00");
    expect(announcement.textContent).toBe("Partial update");

    app.state.getTile = () => quote({ price: 210, changePercent: 2 });
    view.update();
    expect(root.querySelector(".mm-status").dataset.state).toBe("current");
    expect(announcement.textContent).toBe("Last updated");
  });

  it("prefers the completed feed refresh time over an instrument's trade timestamp", () => {
    const { app, root, view } = mount(mixed(), {
      formatRelativeTime: (value) => value.toISOString(),
    });
    app.feed = { lastUpdatedAt: "2026-07-13T10:05:00.000Z" };
    view.update();

    expect(root.querySelector("#feed-status-copy").textContent)
      .toBe("Partial update 2026-07-13T10:05:00.000Z");
  });

  it("owns both chrome popovers: opens on click, closes on Escape", () => {
    const { root } = mount(mixed());
    for (const [infoId, panelId] of [
      ["feed-status-info", "feed-status-popover"],
      ["board-guide-info", "board-guide-popover"],
    ]) {
      const info = root.querySelector(`#${infoId}`);
      const panel = root.querySelector(`#${panelId}`);
      expect(panel.hidden).toBe(true);
      info.click();
      expect(panel.hidden).toBe(false);
      expect(info.getAttribute("aria-expanded")).toBe("true");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(panel.hidden).toBe(true);
    }
  });

  it("keeps the result count separate from the pulse", () => {
    const { root, view } = mount(new Map(assets.map((a) => [a.id, quote({})])));
    expect(root.querySelector("#result-count").textContent).toBe("0 instruments");
    view.setResultCount(24, 24, false);
    expect(root.querySelector("#result-count").textContent).toBe("24 instruments");
    view.setResultCount(1, 24, true);
    expect(root.querySelector("#result-count").textContent).toBe("1 of 24 shown");
    view.setResultCount(0, 24, true);
    expect(root.querySelector("#result-count").textContent).toBe("No instruments match these filters");
  });
});
