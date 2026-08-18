// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DETAIL_VIEW_TRANSITION_NAME,
  animateBoardFlip,
  measureBoardCells,
  openWithDetailTransition,
} from "../src/ui/motion/boardMotion.js";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function rect({ left = 0, top = 0, width = 100, height = 100 } = {}) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {},
  };
}

describe("board motion", () => {
  it("measures reliable cells and animates their inverse translation and scale", () => {
    document.body.innerHTML = '<div id="grid"><div data-layout-id="aapl"></div></div>';
    const grid = document.querySelector("#grid");
    const cell = grid.firstElementChild;
    cell.getBoundingClientRect = vi.fn(() => rect({ left: 20, top: 40, width: 200, height: 100 }));
    const before = measureBoardCells(grid);

    cell.getBoundingClientRect = vi.fn(() => rect({ left: 120, top: 100, width: 100, height: 100 }));
    const after = measureBoardCells(grid);
    const animation = { finished: Promise.resolve(), cancel: vi.fn() };
    cell.animate = vi.fn(() => animation);

    expect(animateBoardFlip(before, after)).toEqual([{ element: cell, animation }]);
    expect(cell.animate).toHaveBeenCalledWith([
      {
        transform: "translate(-100px, -60px) scale(2, 1)",
        transformOrigin: "top left",
      },
      {
        transform: "translate(0, 0) scale(1, 1)",
        transformOrigin: "top left",
      },
    ], {
      duration: 240,
      easing: "cubic-bezier(.2, .8, .2, 1)",
    });
  });

  it("skips an inverse frame that would overflow the resized board", () => {
    document.body.innerHTML = '<div data-layout-id="aapl"></div>';
    const element = document.body.firstElementChild;
    element.animate = vi.fn();
    const before = new Map([["aapl", {
      element,
      left: 700,
      top: 0,
      width: 200,
      height: 100,
    }]]);
    const after = new Map([["aapl", {
      element,
      left: 300,
      top: 0,
      width: 100,
      height: 100,
    }]]);

    expect(animateBoardFlip(before, after, {
      bounds: { left: 0, right: 800 },
    })).toEqual([]);
    expect(element.animate).not.toHaveBeenCalled();
  });

  it("uses one shared name across the source tile and destination dialog snapshot", async () => {
    document.body.innerHTML = `
      <main class="marketmap-app">
        <div data-layout-id="aapl"></div>
      </main>`;
    const scopeElement = document.querySelector("main");
    const sourceElement = scopeElement.firstElementChild;
    sourceElement.getBoundingClientRect = vi.fn(() => rect());
    const update = vi.fn();
    let sourceNameDuringCapture;
    let sourceNameDuringUpdate;
    let scopeDuringUpdate;
    const finished = Promise.resolve();
    document.startViewTransition = vi.fn((callback) => {
      sourceNameDuringCapture = sourceElement.style.viewTransitionName;
      callback();
      sourceNameDuringUpdate = sourceElement.style.viewTransitionName;
      scopeDuringUpdate = scopeElement.dataset.detailViewTransition;
      return { finished };
    });

    expect(openWithDetailTransition({
      document,
      scopeElement,
      sourceElement,
      update,
    })).toEqual({ finished });
    expect(sourceNameDuringCapture).toBe(DETAIL_VIEW_TRANSITION_NAME);
    expect(sourceNameDuringUpdate).toBe("");
    expect(scopeDuringUpdate).toBe("true");
    expect(update).toHaveBeenCalledOnce();

    await finished;
    await Promise.resolve();
    expect(scopeElement.dataset.detailViewTransition).toBeUndefined();
    expect(sourceElement.style.viewTransitionName).toBe("");
  });

  it("keeps the static opening path when reduced motion is requested", () => {
    document.body.innerHTML = `
      <main class="marketmap-app">
        <div data-layout-id="aapl"></div>
      </main>`;
    const scopeElement = document.querySelector("main");
    const sourceElement = scopeElement.firstElementChild;
    sourceElement.getBoundingClientRect = vi.fn(() => rect());
    window.matchMedia = vi.fn(() => ({ matches: true }));
    document.startViewTransition = vi.fn();
    const update = vi.fn();

    expect(openWithDetailTransition({
      document,
      scopeElement,
      sourceElement,
      update,
    })).toBeNull();
    expect(update).toHaveBeenCalledOnce();
    expect(document.startViewTransition).not.toHaveBeenCalled();
    expect(scopeElement.dataset.detailViewTransition).toBeUndefined();
  });
});
