// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { renderMarketMapShell } from "../src/app/marketMapShell.js";

afterEach(() => document.body.replaceChildren());

function shell() {
  document.body.innerHTML = '<main class="marketmap-app" data-marketmap-root></main>';
  const root = document.querySelector("[data-marketmap-root]");
  renderMarketMapShell(root, { footer: false });
  return root;
}

describe("container-query scope (defect #1)", () => {
  it("keeps every position:fixed overlay outside the .container query container", () => {
    const root = shell();
    const container = root.querySelector(".container");
    expect(container).toBeTruthy();

    const overlays = root.querySelectorAll("#react-instrument-detail, #react-toast-host, #mm-overlay-root");
    expect(overlays.length).toBe(3);

    for (const overlay of overlays) {
      expect(container.contains(overlay)).toBe(false);
      expect(root.contains(overlay)).toBe(true);
    }
  });

  it("keeps the marketmap grid inside the query container so container queries reach the tiles", () => {
    const root = shell();
    const container = root.querySelector(".container");
    const grid = root.querySelector("#marketmap");
    expect(container.contains(grid)).toBe(true);
  });
});
