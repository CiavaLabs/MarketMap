// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountToastHost } from "../src/react/toastHost.entry.jsx";

afterEach(() => document.body.replaceChildren());

function mount() {
  document.body.innerHTML = '<div id="react-toast-host" data-mm-react-root></div>';
  const island = document.querySelector("#react-toast-host");
  const { root, notify } = mountToastHost(island);
  return { island, root, notify };
}

describe("ToastHost React island", () => {
  it("renders a toast with the notified message inside the island (portal targets its own container)", async () => {
    const { island, notify } = mount();
    notify("20 instruments synced");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(island.textContent).toContain("20 instruments synced");
  });

  it("renders an action and closes the toast after invoking it", async () => {
    const { island, notify } = mount();
    let restored = false;
    notify("Board cleared", 8_000, {
      label: "Undo",
      onClick: () => { restored = true; },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const action = [...island.querySelectorAll("button")]
      .find((button) => button.textContent === "Undo");
    expect(action).not.toBeNull();
    action.click();
    expect(restored).toBe(true);
  });

  it("unmounts cleanly and leaves the island free for a remount", () => {
    const { island, root } = mount();
    root.unmount();
    expect(island.children).toHaveLength(0);
    const again = mountToastHost(island);
    expect(again.notify).toBeInstanceOf(Function);
    again.root.unmount();
  });
});
