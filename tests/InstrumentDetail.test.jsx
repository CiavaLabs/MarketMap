// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountInstrumentDetail } from "../src/react/instrumentDetail.entry.jsx";

const mounted = [];

afterEach(() => {
  while (mounted.length) mounted.pop().root.unmount();
  document.body.replaceChildren();
});

function island(callbacks = {}) {
  const app = document.createElement("div");
  app.className = "marketmap-app";
  const overlay = document.createElement("div");
  overlay.id = "mm-overlay-root";
  const host = document.createElement("div");
  app.append(host, overlay);
  document.body.append(app);

  const api = mountInstrumentDetail(host, callbacks);
  mounted.push(api);
  return { api, app, overlay };
}

const dialog = () => document.querySelector(".mm-instrument-detail");
const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
const all = (selector) => [...document.querySelectorAll(selector)];

function open(api, model = {}) {
  api.setModel(model);
  api.setOpen(true);
}

const section = (id, title, items = [{ id: `${id}-a`, label: "Field", value: "1" }]) => ({
  id,
  title,
  items,
});

describe("instrument detail island", () => {
  it("mounts nothing without a container", () => {
    expect(mountInstrumentDetail(null)).toBeNull();
  });

  it("stays closed until it is opened", () => {
    island();
    expect(dialog()).toBeNull();
  });

  it("publishes the model the controller handed over", () => {
    const { api } = island();
    api.setModel({ header: { symbol: "AAPL", name: "Apple Inc.", value: "$317.31" } });
    expect(api.getModel().header.symbol).toBe("AAPL");
  });

  it("renders the header the model describes", () => {
    const { api } = island();
    open(api, {
      header: {
        symbol: "AAPL",
        name: "Apple Inc.",
        value: "$317.31",
        changeLabel: "+0.63%",
        changePercent: 0.63,
        badges: ["NASDAQ", "Equity"],
      },
    });

    expect(text(".mm-instrument-detail__ticker")).toBe("AAPL");
    expect(all(".mm-instrument-detail__badges span").map((node) => node.textContent))
      .toEqual(expect.arrayContaining(["NASDAQ", "Equity"]));
  });

  it("reports an empty board position when the instrument is filtered out", () => {
    const { api } = island();
    open(api);
    expect(text(".mm-instrument-detail__navigation p")).toBe("Not in current filter");
  });

  it("reports the position within the current filter", () => {
    const { api } = island();
    open(api, { navigation: { position: 3, total: 12, canPrevious: true, canNext: true } });
    expect(text(".mm-instrument-detail__navigation p")).toBe("3 of 12 in current filter");
  });
});

describe("instrument detail navigation", () => {
  const navigable = (patch = {}) => ({
    navigation: { position: 2, total: 4, canPrevious: true, canNext: true, ...patch },
  });

  it("moves through the board from its buttons", () => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, navigable());

    const [previous, next] = all(".mm-instrument-detail__navigation button");
    previous.click();
    next.click();

    expect(onNavigate.mock.calls.map(([offset]) => offset)).toEqual([-1, 1]);
  });

  it("disables the edge the board has no room for", () => {
    const { api } = island();
    open(api, navigable({ canPrevious: false, canNext: false }));
    const [previous, next] = all(".mm-instrument-detail__navigation button");
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
  });

  it.each([
    ["ArrowLeft", -1],
    ["ArrowRight", 1],
  ])("moves on %s", (key, offset) => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, navigable());

    dialog().closest("[id='instrument-detail-dialog']")
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

    expect(onNavigate).toHaveBeenCalledWith(offset);
  });

  it("ignores a key that does not move the board", () => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, navigable());

    dialog().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each([
    ["canPrevious", "ArrowLeft", { canPrevious: false }],
    ["canNext", "ArrowRight", { canNext: false }],
  ])("does not move past the edge when %s is false", (_label, key, patch) => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, navigable(patch));

    dialog().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("leaves an arrow key alone while an interactive element has focus", () => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, navigable());

    const button = all(".mm-instrument-detail__navigation button")[0];
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("still moves from a control when the caller holds Alt", () => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, navigable());

    const button = all(".mm-instrument-detail__navigation button")[0];
    button.dispatchEvent(new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      bubbles: true,
    }));
    expect(onNavigate).toHaveBeenCalledWith(-1);
  });

  it.each([
    ["Ctrl", { altKey: true, ctrlKey: true }],
    ["Meta", { altKey: true, metaKey: true }],
    ["Shift", { altKey: true, shiftKey: true }],
  ])("treats Alt combined with %s as the control's own shortcut", (_label, modifiers) => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, navigable());

    const button = all(".mm-instrument-detail__navigation button")[0];
    button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, ...modifiers }));
    expect(onNavigate).not.toHaveBeenCalled();
  });
});

describe("instrument detail chart", () => {
  const series = (count = 4) => Array.from({ length: count }, (_, index) => ({
    value: 100 + index,
    label: `Point ${index}`,
  }));

  it("shows the empty state below two points", () => {
    const { api } = island();
    open(api, { chart: { series: [{ value: 1, label: "only" }], state: "empty", summary: "No data" } });

    const empty = document.querySelector(".mm-detail-chart-empty");
    expect(empty.dataset.chartState).toBe("empty");
    expect(empty.textContent).toContain("No data");
  });

  it("marks the chart busy while it loads", () => {
    const { api } = island();
    open(api, { chart: { state: "loading", series: [] } });
    expect(document.querySelector(".mm-instrument-detail__chart").getAttribute("aria-busy"))
      .toBe("true");
  });

  it("flags a range change in flight", () => {
    const { api } = island();
    open(api, { chart: { state: "ready", series: series(), transitioning: true } });
    expect(document.querySelector(".mm-instrument-detail__chart").dataset.chartTransitioning)
      .toBe("true");
  });

  it.each([
    ["gain", "positive"],
    ["loss", "negative"],
    ["flat", "neutral"],
    [undefined, "neutral"],
  ])("renders a %s period as %s", (tone, expected) => {
    const { api } = island();
    open(api, { chart: { series: series(), tone, changeLabel: "+1.2%", heading: "Past month" } });
    expect(document.querySelector(".mm-instrument-detail__chart-heading strong").className)
      .toContain(expected);
  });

  it("falls back to an em dash with no change to show", () => {
    const { api } = island();
    open(api, { chart: { series: [] } });
    expect(text(".mm-instrument-detail__chart-heading strong")).toBe("—");
  });

  it("reports a range change to the controller", () => {
    const onRangeChange = vi.fn();
    const { api } = island({ onRangeChange });
    open(api, {
      chart: {
        series: series(),
        range: "1m",
        ranges: [{ value: "1m", label: "1M" }, { value: "1y", label: "1Y" }],
      },
    });

    const option = all(".mm-instrument-detail__range-selector button")
      .find((node) => node.textContent.trim() === "1Y");
    option?.click();
    expect(onRangeChange).toHaveBeenCalled();
  });

  it("prefers the controller's hovered point over its own", () => {
    const { api } = island();
    open(api, {
      chart: {
        series: series(),
        hoveredIndex: 2,
        formatPrice: (value) => `$${value}`,
        changeLabel: "+1.2%",
      },
    });

    expect(text(".mm-instrument-detail__chart-heading strong")).toBe("$102");
    expect(text(".mm-instrument-detail__chart-heading em")).toBe("Point 2");
  });

  it("shows a hovered value the model cannot format", () => {
    const { api } = island();
    open(api, { chart: { series: series(), hoveredIndex: 1 } });
    expect(text(".mm-instrument-detail__chart-heading strong")).toBe("101");
  });

  it("ignores a hovered index the series does not reach", () => {
    const { api } = island();
    open(api, { chart: { series: series(), hoveredIndex: 99, changeLabel: "+1.2%" } });
    expect(text(".mm-instrument-detail__chart-heading strong")).toBe("+1.2%");
  });
});

describe("instrument detail panels", () => {
  it("shows the message when the model carries no sections", () => {
    const { api } = island();
    open(api, { details: { sections: [], state: "empty", message: "Nothing to show" } });

    const message = document.querySelector("[data-detail-state='empty']");
    expect(message.textContent).toBe("Nothing to show");
    expect(document.body.textContent).toContain("Analyst take");
  });

  it("renders a panel per section", () => {
    const { api } = island();
    open(api, {
      details: {
        state: "ready",
        sections: [section("profile", "Profile"), section("valuation", "Valuation")],
      },
    });
    expect(all(".mm-detail-sections .mm-instrument-detail__panel")).toHaveLength(2);
  });

  it("gives an odd trailing panel the full width", () => {
    const { api } = island();
    open(api, {
      details: {
        state: "ready",
        sections: [section("a", "A"), section("b", "B"), section("c", "C")],
      },
    });

    const panels = all(".mm-detail-sections .mm-instrument-detail__panel");
    expect(panels.at(-1).className).toContain("mm-instrument-detail__panel--full");
    expect(panels[0].className).not.toContain("mm-instrument-detail__panel--full");
  });

  it("falls back to a default message for an empty section", () => {
    const { api } = island();
    open(api, { details: { state: "ready", sections: [section("empty", "Empty", [])] } });
    expect(document.body.textContent).toContain("No applicable fields were returned.");
  });

  it("prefers the section's own message when it has one", () => {
    const { api } = island();
    open(api, {
      details: {
        state: "ready",
        sections: [{ ...section("empty", "Empty", []), message: "Not published" }],
      },
    });
    expect(document.body.textContent).toContain("Not published");
  });

  it.each([
    ["by id", "analyst_outlook", "Something else"],
    ["by title", "outlook_section", "Outlook"],
  ])("moves the outlook %s to sit after business quality", (_label, id, title) => {
    const { api } = island();
    open(api, {
      details: {
        state: "ready",
        sections: [
          { ...section(id, title) },
          section("profile", "Profile"),
          section("quality", "Business quality"),
        ],
      },
    });

    const titles = all(".mm-detail-sections .mm-instrument-detail__panel h3")
      .map((node) => node.textContent);
    expect(titles.indexOf(title)).toBe(titles.indexOf("Business quality") + 1);
  });

  it("leaves the order alone when the outlook already follows business quality", () => {
    const { api } = island();
    open(api, {
      details: {
        state: "ready",
        sections: [
          section("quality", "Business quality"),
          section("analyst_outlook", "Outlook"),
        ],
      },
    });

    const titles = all(".mm-detail-sections .mm-instrument-detail__panel h3")
      .map((node) => node.textContent);
    expect(titles).toEqual(["Business quality", "Outlook"]);
  });

  it("leaves the order alone when one of the pair is missing", () => {
    const { api } = island();
    open(api, {
      details: {
        state: "ready",
        sections: [section("analyst_outlook", "Outlook"), section("profile", "Profile")],
      },
    });

    const titles = all(".mm-detail-sections .mm-instrument-detail__panel h3")
      .map((node) => node.textContent);
    expect(titles).toEqual(["Outlook", "Profile"]);
  });
});

describe("instrument detail statistics", () => {
  const context = (patch = {}) => ({
    title: "Movement",
    badge: "Daily",
    subtitle: "How unusual today's move is",
    sessionDate: "2026-07-13",
    movement: [{ id: "sigma", label: "Standardized", value: "2.1σ" }],
    rarity: { label: "Rarity", value: "Top 3%", fraction: 0.03, exceedance: "1 in 33 sessions" },
    windows: [{ id: "reference", label: "Reference", value: "756 sessions" }],
    methodology: [{ id: "model", label: "Model", value: "EWMA" }],
    ...patch,
  });

  it("renders nothing without a statistical context", () => {
    const { api } = island();
    open(api);
    expect(document.querySelector(".mm-instrument-detail__statistical-context")).toBeNull();
  });

  it("labels the panel with the session it describes", () => {
    const { api } = island();
    open(api, { statisticalContext: context() });

    const panel = document.querySelector(".mm-instrument-detail__statistical-context");
    expect(panel.getAttribute("aria-label")).toBe("Movement for the 2026-07-13 session");
    expect(panel.textContent).toContain("2.1σ");
    expect(panel.textContent).toContain("1 in 33 sessions");
  });

  it.each([
    ["a note", { note: "Based on 756 prior sessions" }],
    ["an advisory", { advisory: "Provider distributions unknown" }],
  ])("shows %s when the model carries one", (_label, patch) => {
    const { api } = island();
    open(api, { statisticalContext: context(patch) });
    expect(all(".mm-instrument-detail__context-note")).toHaveLength(1);
  });

  it("shows neither note nor advisory when the model has neither", () => {
    const { api } = island();
    open(api, { statisticalContext: context() });
    expect(all(".mm-instrument-detail__context-note")).toHaveLength(0);
  });

  it("renders the stat rail only when there are stats", () => {
    const { api } = island();
    open(api, { stats: [{ id: "cap", label: "Market cap", value: "$3T" }] });
    expect(document.querySelector(".mm-instrument-detail__stats")).not.toBeNull();
  });

  it("renders a meter for a stat that carries one", () => {
    const { api } = island();
    open(api, {
      stats: [{ id: "range", label: "52w", value: "mid", meter: { value: 0.5, label: "half" } }],
    });
    expect(document.querySelector(".mm-instrument-detail__stats").textContent).toContain("52w");
  });

  it("renders the range rails only when there are ranges", () => {
    const { api } = island();
    open(api, {});
    expect(document.querySelector(".mm-instrument-detail__ranges")).toBeNull();

    api.setModel({ ranges: [{ label: "52-week", low: 1, high: 2, value: 1.5 }] });
    expect(document.querySelector(".mm-instrument-detail__ranges")).not.toBeNull();
  });
});

describe("instrument detail news and footer", () => {
  it("hides the news island for an instrument that has no coverage", () => {
    const { api } = island();
    open(api, { news: { supported: false } });
    expect(document.querySelector(".mm-instrument-detail__news")).toBeNull();
  });

  it("shows the news island and its provenance when coverage exists", () => {
    const { api } = island();
    open(api, {
      news: { supported: true, articles: [], message: "No recent coverage", subtitle: "Past week" },
      provenance: { market: "Market data: Yahoo", news: "News: Yahoo" },
    });

    expect(document.querySelector(".mm-instrument-detail__news")).not.toBeNull();
    const provenance = all(".mm-instrument-detail__provenance p").map((node) => node.textContent);
    expect(provenance).toEqual(["Market data: Yahoo", "News: Yahoo"]);
  });

  it("states that a source is unavailable rather than leaving it blank", () => {
    const { api } = island();
    open(api, { news: { supported: true }, provenance: {} });
    expect(all(".mm-instrument-detail__provenance p").map((node) => node.textContent))
      .toEqual(["Market data: source unavailable", "News data: source unavailable"]);
  });

  it("removes the instrument from the board on request", () => {
    const onRemove = vi.fn();
    const { api } = island({ onRemove });
    open(api);

    all(".mm-instrument-detail__footer button")[0].click();
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

describe("instrument detail lifecycle", () => {
  it("tells the controller when the dialog closes", () => {
    const onClose = vi.fn();
    const { api } = island({ onClose });
    open(api);

    api.setOpen(false);
    expect(dialog()).toBeNull();
  });

  it("forgets its own hover when it closes", () => {
    const { api } = island();
    open(api, { chart: { series: [{ value: 1 }, { value: 2 }], changeLabel: "+1%" } });
    api.setOpen(false);
    api.setOpen(true);
    expect(text(".mm-instrument-detail__chart-heading strong")).toBe("+1%");
  });

  it("replaces the whole model rather than merging into the previous one", () => {
    const { api } = island();
    open(api, { header: { symbol: "AAPL", name: "Apple Inc.", value: "$1" } });
    api.setModel({ header: { symbol: "MSFT", name: "Microsoft", value: "$2" } });

    expect(text(".mm-instrument-detail__ticker")).toBe("MSFT");
    expect(api.getModel().header.name).toBe("Microsoft");
  });
});

describe("instrument detail boundary shortcuts", () => {
  const atEdge = (patch) => ({ navigation: { position: 1, total: 4, ...patch } });

  const press = (key, modifiers = {}) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers });
    dialog().dispatchEvent(event);
    return event;
  };

  it.each([
    ["ArrowLeft", { canPrevious: false, canNext: true }],
    ["ArrowRight", { canPrevious: true, canNext: false }],
  ])("consumes Alt+%s at the edge it cannot cross", (key, patch) => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, atEdge(patch));

    const event = press(key, { altKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it.each([
    ["ArrowLeft", { canPrevious: true, canNext: true }, -1],
    ["ArrowRight", { canPrevious: true, canNext: true }, 1],
  ])("consumes Alt+%s and moves when it can", (key, patch, offset) => {
    const onNavigate = vi.fn();
    const { api } = island({ onNavigate });
    open(api, atEdge(patch));

    const event = press(key, { altKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(onNavigate).toHaveBeenCalledWith(offset);
  });

  it("leaves a plain arrow at the edge to the page", () => {
    const { api } = island();
    open(api, atEdge({ canPrevious: false, canNext: true }));

    expect(press("ArrowLeft").defaultPrevented).toBe(false);
  });
});
