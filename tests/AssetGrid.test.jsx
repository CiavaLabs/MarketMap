// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountAssetGrid } from "../src/react/assetGrid.entry.jsx";

const mounted = [];

afterEach(() => {
  while (mounted.length) mounted.pop().unmount();
  document.body.replaceChildren();
});

function stubBoardGeometry(island, boxes) {
  for (const [layoutId, box] of Object.entries(boxes)) {
    const cell = island.querySelector(`[data-layout-id="${layoutId}"]`);
    if (!cell) throw new Error(`No layout cell rendered for ${layoutId}`);
    cell.getBoundingClientRect = () => ({
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON() {},
    });
  }
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function pointer(type, { clientX = 0, clientY = 0, pointerType = "mouse", pointerId = 1 } = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  return event;
}

function mount(options = {}) {
  document.body.innerHTML = '<div id="react-asset-grid" data-mm-react-root></div>';
  const island = document.querySelector("#react-asset-grid");
  const api = mountAssetGrid(island, options);
  mounted.push(api.root);
  return { island, ...api };
}

function paint(api, instrumentId, overrides = {}) {
  api.applyBatch([{
    instrumentId,
    viewModel: {
      displaySymbol: overrides.displaySymbol || "AAPL",
      name: overrides.name || "Apple Inc.",
      formattedValue: overrides.formattedValue || "$232.40",
      changePercent: overrides.changePercent ?? 1.2,
      assetClass: overrides.assetClass || "equity",
      footerLabel: overrides.footerLabel || "Technology",
    },
    quality: overrides.quality || "fresh",
    designSystemQuality: overrides.designSystemQuality || "current",
    derivedState: overrides.derivedState || "gaining",
    ariaLabel: overrides.ariaLabel
      || "Open Apple Inc. (AAPL) details. Price $232.40. up 1.20 percent. Data current.",
    sparklineData: overrides.sparklineData || [],
  }]);
}

describe("AssetGrid React island", () => {
  it("renders a tile once its data arrives, with the public data-instrument-id/data-index/data-tier contract", () => {
    const { island, setOrder, setIndexById, setTiers, ...api } = mount();
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    setTiers(new Map([["aapl", "hero"]]));
    paint(api, "aapl");

    const tile = island.querySelector('[data-instrument-id="aapl"]');
    expect(tile).not.toBeNull();
    expect(tile.dataset.index).toBe("0");
    expect(tile.dataset.tier).toBe("hero");
    expect(tile.dataset.quality).toBe("fresh");
    expect(tile.textContent).toContain("AAPL");
  });

  it("defaults an instrument to compact until the controller supplies its ranked tier", () => {
    const { island, setOrder, setIndexById, ...api } = mount();
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    paint(api, "aapl");
    expect(island.querySelector('[data-instrument-id="aapl"]').dataset.tier).toBe("compact");
  });

  it("routes a tile click to onSelectTile with its board index", () => {
    const onSelectTile = vi.fn();
    const { island, setOrder, setIndexById, ...api } = mount({ onSelectTile });
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 3]]));
    paint(api, "aapl");

    island.querySelector('[data-instrument-id="aapl"]').click();
    expect(onSelectTile).toHaveBeenCalledWith(3, {
      instrumentId: "aapl",
      sourceElement: island.querySelector('[data-layout-id="aapl"]'),
    });
  });

  it("does not render a tile before its first applyBatch, even if listed in order", () => {
    const { island, setOrder, setIndexById } = mount();
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    expect(island.querySelector('[data-instrument-id="aapl"]')).toBeNull();
  });

  it("does not duplicate the primary Add instrument action inside the grid", () => {
    const { island } = mount();
    expect(island.querySelector(".add-tile")).toBeNull();
  });

  it("renders nothing for the news cell until instruments are known, then wires retry to onNewsRetry", () => {
    const onNewsRetry = vi.fn();
    const { island, setNewsState } = mount({ onNewsRetry });
    expect(island.querySelector('[data-cell="news"]')).toBeNull();

    setNewsState({ status: "error", articles: [], instrumentLabels: new Map([["aapl", "AAPL"]]) });
    const retryButton = island.querySelector(".mm-news__retry");
    expect(retryButton).not.toBeNull();
    retryButton.click();
    expect(onNewsRetry).toHaveBeenCalledOnce();
  });

  it("names the instruments an article covers, counting the ones past the cap", () => {
    const { island, setNewsState } = mount();
    setNewsState({
      status: "ready",
      articles: [{
        id: "yahoo:story-1",
        title: "Markets rise",
        url: "https://news.example/story",
        publisher: "Reuters",
        publishedAt: "2026-07-15T16:10:00.000Z",
        instrumentIds: ["XNAS:AAPL", "XNAS:MSFT", "XNAS:NVDA", "XNYS:JPM", "XNYS:V"],
        provider: "yahoo",
      }],
      sources: ["yahoo"],
      lastUpdatedAt: "2026-07-15T16:15:00.000Z",
      instrumentLabels: new Map([
        ["XNAS:AAPL", "AAPL"],
        ["XNAS:MSFT", "MSFT"],
        ["XNAS:NVDA", "NVDA"],
        ["XNYS:JPM", "JPM"],
        ["XNYS:V", "V"],
      ]),
    });

    const cell = island.querySelector('[data-cell="news"]');
    const link = cell.querySelector("a");
    expect(link.href).toBe("https://news.example/story");
    expect(link.rel).toBe("noopener noreferrer");
    expect(cell.textContent).toContain("AAPL, MSFT, NVDA +2");
    expect(cell.textContent).toContain("News coverage from Yahoo Finance");
  });

  it("publishes explicit spans and freezes them during a keyboard reorder gesture", async () => {
    const onReorder = vi.fn();
    const { island, setOrder, setIndexById, setTiers, ...api } = mount({
      onReorder,
      initialLayout: { newsPosition: 2 },
    });
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    setTiers(new Map([["aapl", "compact"], ["msft", "compact"]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });

    const cell = island.querySelector('[data-layout-id="aapl"]');
    const handle = island.querySelector('[data-reorder-handle="aapl"]');
    expect(cell.style.gridColumnStart).toBe("1");
    expect(cell.style.gridColumnEnd).toBe("span 1");

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await Promise.resolve();
    expect(cell.dataset.grabbed).toBe("true");
    setTiers(new Map([["aapl", "hero"], ["msft", "compact"]]));
    expect(cell.style.gridColumnEnd).toBe("span 1");
    expect(cell.querySelector(".asset-tile").dataset.tier).toBe("compact");

    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await Promise.resolve();

    expect(onReorder).toHaveBeenCalledWith({
      itemId: "aapl",
      beforeId: "__marketmap_news__",
    });
    expect(cell.style.gridColumnEnd).toBe("span 2");
    expect(cell.querySelector(".asset-tile").dataset.tier).toBe("hero");
  });

  it("announces the grabbed tile by its ticker, never by its internal instrument id", async () => {
    const { island, setOrder, setIndexById, ...api } = mount();
    setOrder(["XNAS:AAPL"]);
    setIndexById(new Map([["XNAS:AAPL", 0]]));
    paint(api, "XNAS:AAPL");

    island.querySelector('[data-reorder-handle="XNAS:AAPL"]')
      .dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await Promise.resolve();

    const live = island.querySelector('[aria-live="assertive"]').textContent;
    expect(live).toContain("AAPL grabbed");
    expect(live).not.toContain("XNAS:");
  });

  it("grabs on a plain handle click and releases the gesture when the handle loses focus", async () => {
    const onReorder = vi.fn();
    const { island, setOrder, setIndexById, ...api } = mount({ onReorder });
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });

    const cell = island.querySelector('[data-layout-id="aapl"]');
    const handle = island.querySelector('[data-reorder-handle="aapl"]');
    handle.click();
    await Promise.resolve();
    expect(cell.dataset.grabbed).toBe("true");

    handle.click();
    await Promise.resolve();
    expect(cell.dataset.grabbed).toBeUndefined();
    expect(onReorder).toHaveBeenCalledTimes(1);

    handle.click();
    await Promise.resolve();
    expect(cell.dataset.grabbed).toBe("true");
    handle.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await Promise.resolve();
    expect(cell.dataset.grabbed).toBeUndefined();
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it("collapses the news sequence block without removing its reorder affordance", async () => {
    const onNewsOpenChange = vi.fn();
    const { island, setOrder, setIndexById, ...api } = mount({ onNewsOpenChange });
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    paint(api, "aapl");

    const news = island.querySelector('[data-cell="news"]');
    news.querySelector(".mm-news-cell__toggle").click();
    await Promise.resolve();

    expect(onNewsOpenChange).toHaveBeenCalledWith(false);
    expect(island.querySelector('[data-cell="news"]').dataset.open).toBe("false");
    expect(island.querySelector('[data-reorder-handle="news"]')).not.toBeNull();
  });

  it("leaves the board empty when a filter matches nothing, rather than one news card on its own", () => {
    const { island, setOrder, setIndexById, setNewsState, ...api } = mount();
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    setNewsState({ status: "ready", articles: [], instrumentLabels: new Map([["aapl", "AAPL"]]) });
    paint(api, "aapl");
    expect(island.querySelector('[data-cell="news"]')).not.toBeNull();

    setOrder([]);
    expect(island.querySelector('[data-cell="news"]')).toBeNull();
    expect(island.querySelector(".asset-tile")).toBeNull();

    setOrder(["aapl"]);
    expect(island.querySelector('[data-cell="news"]')).not.toBeNull();
  });

  it("opens the gap live: a tile the drag reaches gives up its place instead of waiting behind a marker", async () => {
    const { island, setOrder, setIndexById, setTiers, ...api } = mount({
      initialLayout: { newsPosition: 2 },
    });
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    setTiers(new Map([["aapl", "compact"], ["msft", "compact"]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });

    const cell = island.querySelector('[data-layout-id="aapl"]');
    const target = island.querySelector('[data-layout-id="msft"]');
    expect([cell.style.gridColumnStart, target.style.gridColumnStart]).toEqual(["1", "2"]);
    stubBoardGeometry(island, {
      aapl: { left: 0, top: 0, width: 100, height: 100 },
      msft: { left: 120, top: 0, width: 100, height: 100 },
    });

    cell.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 170, clientY: 50 }));
    await settle();

    expect([cell.style.gridColumnStart, target.style.gridColumnStart]).toEqual(["2", "1"]);

    cell.dispatchEvent(pointer("pointerup", { clientX: 170, clientY: 50 }));
    await settle();
    expect([cell.style.gridColumnStart, target.style.gridColumnStart]).toEqual(["2", "1"]);

    setOrder(["msft", "aapl"]);
    await settle();
    expect([cell.style.gridColumnStart, target.style.gridColumnStart]).toEqual(["2", "1"]);
    expect(cell.dataset.grabbed).toBeUndefined();
  });

  it("holds its arrangement when the pointer lingers on the seam between two tiles", async () => {
    const onReorder = vi.fn();
    const { island, setOrder, setIndexById, setTiers, ...api } = mount({
      onReorder,
      initialLayout: { newsPosition: 2 },
    });
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    setTiers(new Map([["aapl", "compact"], ["msft", "compact"]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });

    const cell = island.querySelector('[data-layout-id="aapl"]');
    const target = island.querySelector('[data-layout-id="msft"]');
    stubBoardGeometry(island, {
      aapl: { left: 0, top: 0, width: 100, height: 100 },
      msft: { left: 100, top: 0, width: 100, height: 100 },
    });

    cell.dispatchEvent(pointer("pointerdown", { clientX: 50, clientY: 50 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 104, clientY: 50 }));
    await settle();
    const swapped = [cell.style.gridColumnStart, target.style.gridColumnStart];
    expect(swapped).toEqual(["2", "1"]);

    for (const clientX of [103, 105, 102, 106, 104, 101]) {
      cell.dispatchEvent(pointer("pointermove", { clientX, clientY: 50 }));
      await settle();
      expect([cell.style.gridColumnStart, target.style.gridColumnStart]).toEqual(swapped);
    }
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("decides one reorder at a time, never against the arrangement the last one replaced", async () => {
    const { island, setOrder, setIndexById, setTiers, ...api } = mount({
      initialLayout: { newsPosition: 2 },
    });
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    setTiers(new Map([["aapl", "compact"], ["msft", "compact"]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });

    const cell = island.querySelector('[data-layout-id="aapl"]');
    const target = island.querySelector('[data-layout-id="msft"]');
    stubBoardGeometry(island, {
      aapl: { left: 0, top: 0, width: 100, height: 100 },
      msft: { left: 100, top: 0, width: 100, height: 100 },
    });

    cell.dispatchEvent(pointer("pointerdown", { clientX: 50, clientY: 50 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 150, clientY: 50 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 190, clientY: 50 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 50 }));
    await settle();
    expect([cell.style.gridColumnStart, target.style.gridColumnStart]).toEqual(["2", "1"]);
  });

  it("picks a tile up anywhere on its face, carries it under the pointer, and swallows the click the drop emits", async () => {
    const onReorder = vi.fn();
    const onSelectTile = vi.fn();
    const { island, setOrder, setIndexById, ...api } = mount({ onReorder, onSelectTile });
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });

    const cell = island.querySelector('[data-layout-id="aapl"]');

    cell.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 60, clientY: 90 }));
    await settle();
    expect(cell.dataset.grabbed).toBe("true");
    expect(cell.style.transform).toContain("translate3d(50px, 80px, 0)");

    cell.dispatchEvent(pointer("pointerup", { clientX: 60, clientY: 90 }));
    await settle();
    expect(cell.style.transform).toBe("");
    expect(onReorder).toHaveBeenCalledWith({ itemId: "aapl", beforeId: "msft" });

    island.querySelector('[data-instrument-id="aapl"]').click();
    expect(onSelectTile).not.toHaveBeenCalled();
    island.querySelector('[data-instrument-id="aapl"]').click();
    expect(onSelectTile).toHaveBeenCalledTimes(1);
  });

  it("makes a finger hold the tile before it moves, so a swipe across the board still scrolls it", async () => {
    const { island, setOrder, setIndexById, ...api } = mount();
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    paint(api, "aapl");
    const cell = island.querySelector('[data-layout-id="aapl"]');

    cell.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, pointerType: "touch" }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 10, clientY: 120, pointerType: "touch" }));
    await settle(500);
    expect(cell.dataset.grabbed).toBeUndefined();

    cell.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, pointerType: "touch" }));
    await settle(120);
    expect(cell.dataset.grabbed).toBeUndefined();
    await settle(320);
    expect(cell.dataset.grabbed).toBe("true");
  });

  it("keeps the news block's grip as an immediate handle — no hold, and the panel itself is not a drag surface", async () => {
    const { island, setOrder, setIndexById, ...api } = mount();
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    paint(api, "aapl");
    const news = island.querySelector('[data-cell="news"]');
    const grip = news.querySelector('[data-reorder-handle="news"]');

    news.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, pointerType: "touch" }));
    news.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 90, pointerType: "touch" }));
    await settle();
    expect(news.dataset.grabbed).toBeUndefined();

    grip.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10, pointerType: "touch" }));
    grip.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 90, pointerType: "touch" }));
    await settle();
    expect(news.dataset.grabbed).toBe("true");
  });

  it("reports what is waiting behind the fold in every state the feed can be in", async () => {
    const { island, setOrder, setIndexById, setNewsState, ...api } = mount();
    const instrumentLabels = new Map([["aapl", "AAPL"]]);
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    paint(api, "aapl");
    island.querySelector(".mm-news-cell__toggle").click();
    await settle();

    const summary = () => island.querySelector(".mm-news-cell__summary").textContent;
    expect(summary()).toBe("Loading coverage…");

    setNewsState({ status: "error", articles: [], instrumentLabels });
    expect(summary()).toBe("Coverage unavailable");

    setNewsState({ status: "ready", articles: [], instrumentLabels });
    expect(summary()).toBe("No recent coverage");

    const article = { id: "1", title: "One", url: "https://news.test/1", publishedAt: "2026-07-15T14:30:00.000Z" };
    setNewsState({ status: "ready", articles: [article], instrumentLabels });
    expect(summary()).toBe("1story");

    setNewsState({ status: "ready", articles: [article, { ...article, id: "2" }], instrumentLabels });
    expect(summary()).toBe("2stories");
  });

  it("unmounts cleanly and leaves the island free for a remount", () => {
    const { island, root, setOrder, setIndexById, ...api } = mount();
    setOrder(["aapl"]);
    setIndexById(new Map([["aapl", 0]]));
    paint(api, "aapl");
    root.unmount();
    expect(island.children).toHaveLength(0);

    const again = mountAssetGrid(island);
    expect(again.applyBatch).toBeInstanceOf(Function);
    again.root.unmount();
  });
});

describe("AssetGrid click suppression after a drag", () => {
  const board = (options = {}) => {
    const { island, setOrder, setIndexById, setTiers, ...api } = mount(options);
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    setTiers(new Map([["aapl", "compact"], ["msft", "compact"]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });
    stubBoardGeometry(island, {
      aapl: { left: 0, top: 0, width: 100, height: 100 },
      msft: { left: 120, top: 0, width: 100, height: 100 },
    });
    return { island, setOrder, setIndexById };
  };

  const dragTileBody = async (island, setOrder, setIndexById) => {
    const cell = island.querySelector('[data-layout-id="aapl"]');
    cell.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 170, clientY: 50 }));
    await settle();
    cell.dispatchEvent(pointer("pointerup", { clientX: 170, clientY: 50 }));
    await settle();
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await settle();
    setOrder(["msft", "aapl"]);
    setIndexById(new Map([["msft", 0], ["aapl", 1]]));
    await settle();
  };

  it("answers the first grip press after a tile-body drag", async () => {
    const { island, setOrder, setIndexById } = board();
    await dragTileBody(island, setOrder, setIndexById);

    island.querySelector('[data-reorder-handle="msft"]').click();
    await settle();

    expect(island.querySelector('[data-layout-id="msft"]').dataset.grabbed).toBe("true");
  });

  it("still swallows the click the drag itself generated", async () => {
    const onSelectTile = vi.fn();
    const { island, setOrder, setIndexById } = board({ onSelectTile });
    await dragTileBody(island, setOrder, setIndexById);

    expect(onSelectTile).not.toHaveBeenCalled();
  });

  it("still consumes the grip's own post-drag click", async () => {
    const { island } = board();
    const handle = island.querySelector('[data-reorder-handle="aapl"]');
    const cell = island.querySelector('[data-layout-id="aapl"]');

    handle.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    handle.dispatchEvent(pointer("pointermove", { clientX: 170, clientY: 50 }));
    await settle();
    handle.dispatchEvent(pointer("pointerup", { clientX: 170, clientY: 50 }));
    await settle();
    handle.click();
    await settle();

    expect(cell.dataset.grabbed).toBeUndefined();
  });
});

describe("AssetGrid pointer cancellation", () => {
  it("answers the first grip press after a cancelled drag", async () => {
    const { island, setOrder, setIndexById, setTiers, ...api } = mount();
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    setTiers(new Map([["aapl", "compact"], ["msft", "compact"]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });
    stubBoardGeometry(island, {
      aapl: { left: 0, top: 0, width: 100, height: 100 },
      msft: { left: 120, top: 0, width: 100, height: 100 },
    });

    const cell = island.querySelector('[data-layout-id="aapl"]');
    cell.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 170, clientY: 50 }));
    await settle();
    cell.dispatchEvent(pointer("pointercancel", { clientX: 170, clientY: 50 }));
    await settle();

    island.querySelector('[data-reorder-handle="msft"]').click();
    await settle();

    expect(island.querySelector('[data-layout-id="msft"]').dataset.grabbed).toBe("true");
  });

  it("still opens a tile clicked after a cancelled drag", async () => {
    const onSelectTile = vi.fn();
    const { island, setOrder, setIndexById, setTiers, ...api } = mount({ onSelectTile });
    setOrder(["aapl", "msft"]);
    setIndexById(new Map([["aapl", 0], ["msft", 1]]));
    setTiers(new Map([["aapl", "compact"], ["msft", "compact"]]));
    paint(api, "aapl");
    paint(api, "msft", { displaySymbol: "MSFT", name: "Microsoft" });
    stubBoardGeometry(island, {
      aapl: { left: 0, top: 0, width: 100, height: 100 },
      msft: { left: 120, top: 0, width: 100, height: 100 },
    });

    const cell = island.querySelector('[data-layout-id="aapl"]');
    cell.dispatchEvent(pointer("pointerdown", { clientX: 10, clientY: 10 }));
    cell.dispatchEvent(pointer("pointermove", { clientX: 170, clientY: 50 }));
    await settle();
    cell.dispatchEvent(pointer("pointercancel", { clientX: 170, clientY: 50 }));
    await settle();

    island.querySelector('[data-instrument-id="msft"]').click();
    await settle();
    expect(onSelectTile).toHaveBeenCalled();
  });
});
