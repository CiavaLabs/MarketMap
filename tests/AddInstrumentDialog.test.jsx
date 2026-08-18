// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { mountAddInstrument } from "../src/react/addInstrument.entry.jsx";

const mounted = [];

afterEach(() => {
  while (mounted.length) mounted.pop().root.unmount();
  document.body.replaceChildren();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function island(options = {}) {
  const app = document.createElement("div");
  app.className = "marketmap-app";
  const trigger = document.createElement("button");
  trigger.id = "add-instrument-btn";
  const host = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.id = "mm-overlay-root";
  app.append(trigger, host, overlay);
  document.body.append(app);

  const api = mountAddInstrument(host, { assetClassOptions: [{ value: "all", label: "All classes" }], ...options });
  mounted.push(api);
  return { api, trigger };
}

const dialog = () => document.querySelector("#add-instrument-dialog");

describe("add instrument island", () => {
  it("stays closed until the board opens it", () => {
    island();
    expect(dialog()).toBeNull();
  });

  it("hands focus back to whatever opened it", async () => {
    const { api, trigger } = island();
    trigger.focus();
    api.setOpen(true);
    expect(dialog()).not.toBeNull();

    api.setOpen(false);
    await settle();
    expect(document.activeElement).toBe(trigger);
  });

  it("moves focus nowhere when the opener has gone, rather than to a detached element", async () => {
    const { api, trigger } = island();
    trigger.focus();
    api.setOpen(true);
    trigger.remove();

    api.setOpen(false);
    await settle();
    expect(document.activeElement).toBe(document.body);
  });

  it("carries the board's filters and count through to the caller", () => {
    const { api } = island();
    api.setOpen(true);
    api.setCount("12 instruments");

    expect(document.querySelector("#add-ticker-count").textContent).toBe("12 instruments");
    expect(api.getFilters()).toEqual({ assetClass: "all", venue: "all", currency: "all" });

    api.setFilters({ venue: "XNAS" });
    expect(api.getFilters().venue).toBe("XNAS");
  });
});
