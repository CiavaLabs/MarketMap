// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountToolbar } from "../src/react/toolbar.entry.jsx";

afterEach(() => document.body.replaceChildren());

function mount(options = {}) {
  document.body.innerHTML = '<div id="react-toolbar" data-mm-react-root></div>';
  const island = document.querySelector("#react-toolbar");
  const api = mountToolbar(island, options);
  return { island, api };
}

describe("Toolbar React island", () => {
  it("renders the filter field and the four selectors synchronously", () => {
    const { island } = mount({
      assetClassOptions: [{ value: "all", label: "All" }, { value: "equity", label: "Equity" }],
      categoryOptions: [{ value: "all", label: "All" }],
    });

    const input = island.querySelector("#board-filter");
    expect(input).not.toBeNull();
    expect(input.type).toBe("search");
    expect(input.getAttribute("placeholder")).toBe("Filter board…");
    expect(input.getAttribute("aria-label")).toBe("Filter board");

    for (const label of ["Asset class", "Category", "Movement", "Sort"]) {
      expect(island.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
    }
  });

  it("emits the merged state and its source when the filter text changes", () => {
    const onChange = vi.fn();
    const { island } = mount({ onChange });
    const input = island.querySelector("#board-filter");
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    nativeSetter.call(input, "apple");
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ search: "apple", assetClass: "all" }),
      "search",
    );
  });

  it("renders and updates the named-board switcher through its imperative state", () => {
    const { island, api } = mount({
      boardState: {
        activeBoardId: "default",
        boards: [
          { id: "default", name: "US Equities", instrumentCount: 40, isDefault: true },
          { id: "semis", name: "Semis", instrumentCount: 8, isDefault: false },
        ],
      },
    });

    expect(island.querySelector('[aria-label="Board"]')?.textContent).toContain("US Equities");
    expect(island.querySelector('[aria-label="Manage boards"]')).not.toBeNull();
    api.setBoards({ activeBoardId: "semis" });
    expect(island.querySelector('[aria-label="Board"]')?.textContent).toContain("Semis");
  });

  it("shows every active criterion as a removable chip with a global reset", () => {
    const onChange = vi.fn();
    const { island } = mount({
      initialState: {
        search: "cloud",
        assetClass: "equity",
        category: "Technology",
        movement: "gaining",
        sort: "change-desc",
      },
      assetClassOptions: [{ value: "all", label: "All" }, { value: "equity", label: "Equity" }],
      categoryOptions: [{ value: "all", label: "All" }, { value: "Technology", label: "Technology" }],
      onChange,
    });

    const chips = island.querySelector('[aria-label="Active filters and sorting"]');
    expect(chips).not.toBeNull();
    for (const label of [
      "Search: “cloud”",
      "Asset: Equity",
      "Category: Technology",
      "Movement: Gainers",
      "Sort: Best performers",
    ]) {
      expect(chips.querySelector(`[aria-label="Remove ${label}"]`)).not.toBeNull();
    }

    chips.querySelector('[aria-label="Remove Movement: Gainers"]').click();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ movement: "all", category: "Technology" }),
      "chip",
    );
    chips.querySelector("button:last-child").click();
    expect(onChange).toHaveBeenLastCalledWith(
      { search: "", assetClass: "all", category: "all", movement: "all", sort: "default" },
      "reset",
    );
  });

  it("drops the contextual category with the asset class chip, as the asset class selector does", async () => {
    const onChange = vi.fn();
    const { island } = mount({
      initialState: { assetClass: "equity", category: "Technology" },
      assetClassOptions: [{ value: "all", label: "All" }, { value: "equity", label: "Equity" }],
      categoryOptions: [{ value: "all", label: "All" }, { value: "Technology", label: "Technology" }],
      onChange,
    });

    island.querySelector('[aria-label="Remove Asset: Equity"]').click();
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ assetClass: "all", category: "all" }),
      "assetClass",
    );
    await Promise.resolve();
    expect(island.querySelector('[aria-label="Remove Category: Technology"]')).toBeNull();
  });

  it("unmounts cleanly and leaves the island free for a remount", () => {
    const { island, api } = mount();
    api.root.unmount();
    expect(island.children).toHaveLength(0);
    const again = mountToolbar(island, {});
    expect(island.querySelector("#board-filter")).not.toBeNull();
    again.root.unmount();
  });
});
