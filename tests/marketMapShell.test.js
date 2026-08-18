// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getMarketMapShell, renderMarketMapShell } from "../src/app/marketMapShell.js";

function shell(options) {
  document.body.innerHTML = '<main data-shell></main>';
  const root = document.querySelector("[data-shell]");
  renderMarketMapShell(root, { footer: false, ...options });
  return root;
}

afterEach(() => document.body.replaceChildren());

describe("marketmap shell", () => {
  it("renders the masthead console, board pulse, grid toolbar and grid", () => {
    const root = shell();
    expect(root.querySelector("#marketmap")).not.toBeNull();

    const masthead = root.querySelector(".mm-masthead");
    expect(masthead.querySelector(":scope > .mm-status #feed-status-copy")).not.toBeNull();
    expect(masthead.querySelector(".mm-masthead__identity .mm-status")).toBeNull();
    expect(masthead.querySelector(".mm-actions")).toBeNull();

    const band = root.querySelector(".mm-pulse-band");
    const actions = [...band.querySelector(".mm-actions").children];
    expect(actions.map((element) => element.id)).toEqual(["react-console-actions"]);
    const island = band.querySelector("#react-console-actions");
    expect(island?.hasAttribute("data-mm-react-root")).toBe(true);
    expect(island?.hasAttribute("data-theme-control")).toBe(false);
    expect(island?.children).toHaveLength(0);
    expect(root.querySelector("#theme-btn")).toBeNull();
    expect(root.querySelector("#btn-clear-all")).toBeNull();
    expect(root.querySelector("#btn-restore-defaults")).toBeNull();
    expect(root.querySelector(".mm-masthead__subtitle")).toBeNull();

    expect(root.querySelector("#refresh-now-btn")).toBeNull();
    expect(root.querySelector("#auto-refresh-toggle")).toBeNull();

    const pulse = root.querySelector("dl.mm-pulse");
    expect(pulse?.getAttribute("aria-label")).toContain("Equity pulse");
    expect(root.querySelector("#equity-pulse-coverage")).toBeNull();
    ["snap-spread", "snap-advancing", "snap-declining", "snap-breadth", "snap-average",
      "snap-dispersion", "snap-mover", "snap-leading"].forEach((id) =>
      expect(pulse.querySelector(`#${id}`), id).not.toBeNull());
    expect(pulse.querySelectorAll("#snap-bar [data-side]")).toHaveLength(3);
    expect(pulse.querySelector("#snap-bar")?.hidden).toBe(true);
    expect(pulse.querySelector("#snap-advancing")?.tagName).toBe("BUTTON");
    expect(pulse.querySelector("#snap-declining")?.tagName).toBe("BUTTON");
    expect(pulse.querySelector("#snap-mover")?.disabled).toBe(true);
    expect(pulse.querySelector("#snap-leading")?.disabled).toBe(true);

    expect(band?.contains(pulse)).toBe(true);
    expect(band?.querySelector("#add-instrument-btn")).toBeNull();

    const toolbar = root.querySelector(".mm-toolbar");
    const toolbarIsland = toolbar.querySelector("#react-toolbar");
    expect(toolbarIsland?.hasAttribute("data-mm-react-root")).toBe(true);
    expect(toolbarIsland?.children).toHaveLength(0);
    expect(toolbar.querySelector(".mm-toolbar__meta #result-count")).not.toBeNull();
    expect(toolbar.querySelector(".mm-toolbar__meta #board-guide-info")).not.toBeNull();
  });

  it("keeps the retired chrome retired: no panels, no snapshot title, no legacy stats bar", () => {
    const root = shell();
    [
      "totalAssets", "gaining", "losing", "neutral", "marketBreadth", "volatility", "avgChange",
      "context-average", "context-group", "context-coverage", "context-feed",
      "status-source", "status-as-of", "status-quality", "asset-search", "snapshot-title",
    ].forEach((id) => expect(root.querySelector(`#${id}`), id).toBeNull());
    [".mm-controls", ".mm-snapshot", ".mm-grid-header"].forEach((selector) =>
      expect(root.querySelector(selector), selector).toBeNull());

    const html = getMarketMapShell({ footer: false });
    expect(html).not.toContain("Market context");
    expect(html).not.toContain("Data status");
    expect(html).not.toContain("Board snapshot");
  });

  it("keeps info popovers accessible: a button + a hidden panel, not hover-only", () => {
    const root = shell();
    const info = root.querySelector("#feed-status-info");
    expect(info?.getAttribute("aria-expanded")).toBe("false");
    expect(info?.getAttribute("aria-controls")).toBe("feed-status-popover");
    expect(root.querySelector("#feed-status-popover")?.hidden).toBe(true);

    const guide = root.querySelector("#board-guide-popover");
    expect(guide?.hidden).toBe(true);
    expect(guide?.textContent).toContain("diamond for delayed");
    expect(guide?.textContent).toContain("5-minute bars");
    expect(guide?.textContent).toContain("advancing − declining");
    expect(guide?.textContent).toContain("−0.5% to +0.5%");
    expect(guide?.textContent).toContain("pulse is equity-only");
    expect(guide?.textContent).toContain("whole quote-capable board");
  });

  it("announces a change of feed state without repeating the clock into a live region", () => {
    const root = shell();
    const copy = root.querySelector("#feed-status-copy");
    const announcement = root.querySelector("#feed-status-announcement");

    expect(copy?.hasAttribute("aria-live")).toBe(false);
    expect(announcement?.getAttribute("aria-live")).toBe("polite");
    expect(announcement?.getAttribute("role")).toBe("status");
    expect(announcement?.classList.contains("sr-only")).toBe(true);
    expect(announcement?.textContent).toBe("");
  });

  it("offers a keyboard visitor a way past the board's per-tile stops", () => {
    const root = shell();
    const link = root.querySelector(".mm-skip-board");
    const grid = root.querySelector("#marketmap");
    const target = root.querySelector("#marketmap-end");

    expect(link?.getAttribute("href")).toBe("#marketmap-end");
    expect(target?.getAttribute("tabindex")).toBe("-1");
    expect(link?.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(grid?.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still lets a host omit the theme control", () => {
    const root = shell({ themeControl: false });
    const island = root.querySelector("#react-console-actions");
    expect(island).not.toBeNull();
    expect(island?.dataset.themeControl).toBe("false");
  });

  it("reserves a scoped React island for the Add instrument dialog", () => {
    const root = shell();
    const html = getMarketMapShell({ footer: false });
    expect(html).not.toContain("Global equity search");
    expect(html).not.toContain("add-ticker-modal");
    expect(root.querySelector("#react-add-instrument")?.hasAttribute("data-mm-react-root")).toBe(true);
    expect(root.querySelector("#react-add-instrument")?.children).toHaveLength(0);
  });

  it("keeps the footer optional and reserves the portalled detail island", () => {
    const root = shell();
    expect(root.querySelector(".page-footer")).toBeNull();
    expect(getMarketMapShell()).toContain("page-footer");
    expect(root.querySelectorAll(".modal-overlay")).toHaveLength(0);
    expect(root.querySelector("#react-instrument-detail")?.hasAttribute("data-mm-react-root")).toBe(true);
    expect(root.querySelector("#react-instrument-detail")?.children).toHaveLength(0);
    expect(root.querySelector("#marketmap")?.hasAttribute("data-mm-react-root")).toBe(true);
  });
});
