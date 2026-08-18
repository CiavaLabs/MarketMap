// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../src/services/AppController.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("AppController#applyInstrumentEnrichment", () => {
  function buildApp() {
    document.body.innerHTML = '<main data-marketmap-root></main>';
    const root = document.querySelector("[data-marketmap-root]");
    const instrument = { id: "XNAS:SNDK", symbol: "SNDK", name: "SanDisk Corporation", assetClass: "equity" };
    const app = new AppController([instrument], { root, client: {}, pauseWhenHidden: false });
    return app;
  }

  it("fills in sector/category/group once known and notifies board listeners", () => {
    const app = buildApp();
    const updated = vi.fn();
    app.state.on("board:updated", updated);

    const changed = app.applyInstrumentEnrichment("XNAS:SNDK", { sector: "Technology", category: "Computer Hardware" });

    expect(changed).toBe(true);
    const asset = app.assets.find((candidate) => candidate.id === "XNAS:SNDK");
    expect(asset).toMatchObject({ sector: "Technology", category: "Computer Hardware", assetClass: "equity" });
    expect(updated).toHaveBeenCalledOnce();
    expect(updated.mock.calls[0][0].instruments.find((i) => i.id === "XNAS:SNDK")).toMatchObject({ sector: "Technology" });
  });

  it("is a no-op when the patch adds nothing new", () => {
    const app = buildApp();
    const updated = vi.fn();
    app.state.on("board:updated", updated);

    expect(app.applyInstrumentEnrichment("XNAS:SNDK", {})).toBe(false);
    expect(app.applyInstrumentEnrichment("XNAS:SNDK", { assetClass: "etf" })).toBe(false);
    expect(app.applyInstrumentEnrichment("does-not-exist", { sector: "Technology" })).toBe(false);
    expect(updated).not.toHaveBeenCalled();
  });

  it("does not overwrite an already-known field with an equal or empty value", () => {
    const app = buildApp();
    app.applyInstrumentEnrichment("XNAS:SNDK", { sector: "Technology" });

    const changed = app.applyInstrumentEnrichment("XNAS:SNDK", { sector: "Technology", category: "" });

    expect(changed).toBe(false);
  });
});
