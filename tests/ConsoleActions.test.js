// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountConsoleActions } from "../src/react/consoleActions.entry.jsx";

afterEach(() => document.body.replaceChildren());

function mount(handlers = {}) {
  document.body.innerHTML = '<div id="react-console-actions" data-mm-react-root></div>';
  const island = document.querySelector("#react-console-actions");
  const root = mountConsoleActions(island, handlers);
  return { island, root };
}

describe("ConsoleActions React island", () => {
  it("renders the unified board actions synchronously with their public ids", () => {
    const { island } = mount();
    const buttons = [...island.querySelectorAll("button")];
    expect(buttons.map((button) => button.id))
      .toEqual(["theme-btn", "btn-clear-all", "btn-restore-defaults", "add-instrument-btn"]);
    expect(buttons.map((button) => button.textContent)).toEqual(["", "Clear board", "Restore defaults", "Add instrument"]);
    buttons.forEach((button) => expect(button.type).toBe("button"));
    expect(island.querySelector("#theme-btn .mm-icon-sun")).not.toBeNull();
    expect(island.querySelector("#theme-btn .mm-icon-moon")).not.toBeNull();
    expect(island.querySelector("#add-instrument-btn svg")).not.toBeNull();
  });

  it("omits the theme control when showTheme is false", () => {
    const { island } = mount({ showTheme: false });
    expect(island.querySelector("#theme-btn")).toBeNull();
    expect([...island.querySelectorAll("button")].map((button) => button.id))
      .toEqual(["btn-clear-all", "btn-restore-defaults", "add-instrument-btn"]);
  });

  it("routes clicks to the host callbacks", () => {
    const onAddInstrument = vi.fn();
    const onClearAll = vi.fn();
    const onRestoreDefaults = vi.fn();
    const onToggleTheme = vi.fn();
    const { island } = mount({ onAddInstrument, onClearAll, onRestoreDefaults, onToggleTheme });
    island.querySelector("#theme-btn").click();
    island.querySelector("#btn-clear-all").click();
    island.querySelector("#btn-restore-defaults").click();
    island.querySelector("#add-instrument-btn").click();
    expect(onToggleTheme).toHaveBeenCalledOnce();
    expect(onClearAll).toHaveBeenCalledOnce();
    expect(onRestoreDefaults).toHaveBeenCalledOnce();
    expect(onAddInstrument).toHaveBeenCalledOnce();
  });

  it("unmounts cleanly and leaves the island free for a remount", () => {
    const { island, root } = mount();
    root.unmount();
    expect(island.children).toHaveLength(0);
    const again = mountConsoleActions(island, {});
    expect(island.querySelector("#btn-clear-all")).not.toBeNull();
    again.unmount();
  });
});
