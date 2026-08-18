// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { BoardSwitcher } from "../src/react/BoardSwitcher.jsx";

const BOARDS = [
  { id: "default", name: "US Equities", instrumentCount: 40, isDefault: true },
  { id: "board-2", name: "Semis", instrumentCount: 8, isDefault: false },
];

const roots = [];

afterEach(() => {
  while (roots.length) roots.pop().unmount();
  document.body.replaceChildren();
});

function mount(props = {}) {
  document.body.innerHTML = '<div id="host"></div><div id="overlay"></div>';
  const host = document.querySelector("#host");
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(
    <BoardSwitcher
      boards={BOARDS}
      activeBoardId="default"
      portalContainer={document.querySelector("#overlay")}
      {...props}
    />,
  ));
  return { host };
}

const byName = (name) => [...document.querySelectorAll("[role='menuitem'], button")]
  .find((node) => node.textContent.trim() === name);

function openMenu() {
  flushSync(() => document.querySelector('[aria-label="Manage boards"]').click());
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function submitName(value) {
  const field = document.querySelector('input[aria-label="Board name"]');
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setValue.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  flushSync(() => field.closest("form").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  ));
  await settle();
}

describe("BoardSwitcher", () => {
  it("renders nothing until it has a board to name", () => {
    const { host } = mount({ boards: [], activeBoardId: null });
    expect(host.textContent).toBe("");
  });

  it("switches boards through the selector", async () => {
    const onSwitch = vi.fn();
    mount({ onSwitch });
    flushSync(() => document.querySelector('[aria-label="Board"]').click());
    flushSync(() => [...document.querySelectorAll("[role='option']")]
      .find((option) => option.textContent.includes("Semis")).click());
    await settle();
    expect(onSwitch).toHaveBeenCalledWith("board-2");
  });

  it("protects the default board from being renamed or deleted", () => {
    mount();
    openMenu();
    expect(byName("Rename board").getAttribute("data-disabled")).not.toBeNull();
    expect(byName("Delete board").getAttribute("data-disabled")).not.toBeNull();
  });

  it("offers rename and delete once a board of the user's own is active", async () => {
    const onDelete = vi.fn();
    mount({ activeBoardId: "board-2", onDelete });
    openMenu();
    expect(byName("Rename board").getAttribute("data-disabled")).toBeNull();
    flushSync(() => byName("Delete board").click());
    await settle();
    expect(onDelete).toHaveBeenCalledWith("board-2");
  });

  it("duplicates the active board", async () => {
    const onDuplicate = vi.fn();
    mount({ activeBoardId: "board-2", onDuplicate });
    openMenu();
    flushSync(() => byName("Duplicate board").click());
    await settle();
    expect(onDuplicate).toHaveBeenCalledWith("board-2");
  });

  it("creates a board under a normalised name and reports the dialog's open state", async () => {
    const onCreate = vi.fn(() => ({ ok: true }));
    const onDialogOpenChange = vi.fn();
    mount({ onCreate, onDialogOpenChange });
    onDialogOpenChange.mockClear();

    openMenu();
    flushSync(() => byName("Create board").click());
    expect(onDialogOpenChange).toHaveBeenCalledWith(true);

    await submitName("  Growth   names  ");
    expect(onCreate).toHaveBeenCalledWith("Growth names");
    expect(document.querySelector('input[aria-label="Board name"]')).toBeNull();
  });

  it("keeps the dialog open on a refusal and shows the reason beside the field", async () => {
    const onCreate = vi.fn(() => ({ ok: false, message: "Choose a distinct board name." }));
    mount({ onCreate });
    openMenu();
    flushSync(() => byName("Create board").click());
    await submitName("Semis");

    expect(document.querySelector("[role='alert']").textContent)
      .toBe("Choose a distinct board name.");
    expect(document.querySelector('input[aria-label="Board name"]')).not.toBeNull();
  });

  it("renames the active board and seeds the field with its current name", async () => {
    const onRename = vi.fn(() => ({ ok: true }));
    mount({ activeBoardId: "board-2", onRename });
    openMenu();
    flushSync(() => byName("Rename board").click());
    expect(document.querySelector('input[aria-label="Board name"]').value).toBe("Semis");

    await submitName("Semiconductors");
    expect(onRename).toHaveBeenCalledWith("board-2", "Semiconductors");
  });

  it("abandons the dialog on cancel without asking the host for anything", async () => {
    const onCreate = vi.fn();
    const onDialogOpenChange = vi.fn();
    mount({ onCreate, onDialogOpenChange });
    openMenu();
    flushSync(() => byName("Create board").click());
    onDialogOpenChange.mockClear();

    flushSync(() => byName("Cancel").click());
    await settle();
    expect(onCreate).not.toHaveBeenCalled();
    expect(onDialogOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('input[aria-label="Board name"]')).toBeNull();
  });
});
