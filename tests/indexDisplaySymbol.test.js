import { describe, expect, it } from "vitest";
import {
  curatedIndexDisplaySymbolFor,
} from "../server/instruments/InstrumentCatalog.js";
import { STARTER_INSTRUMENTS } from "../src/data/workspaces.js";
import { buildTileViewModel } from "../src/ui/models/tileViewModel.js";
import { displaySymbolOf } from "../src/ui/models/instrumentFormat.js";
import { curatedDescriptor as descriptorFor } from "./server/fixtures/market/curatedDescriptors.js";

const VERIFIED_AT = "2026-01-01T00:00:00.000Z";


describe("index display symbols", () => {
  it("uses the market ticker where the provider code is not one", () => {
    expect(descriptorFor("INDEX:^GSPC").displaySymbol).toBe("SPX");
    expect(descriptorFor("INDEX:DX-Y.NYB").displaySymbol).toBe("DXY");
  });

  it("falls back to dropping the caret, which is already the market ticker", () => {
    expect(descriptorFor("INDEX:^VIX").displaySymbol).toBe("VIX");
    expect(descriptorFor("RATE:^TNX").displaySymbol).toBe("TNX");
    expect(curatedIndexDisplaySymbolFor("^VIX")).toBeNull();
  });

  it("never lets a display symbol reach identity", () => {
    const spx = descriptorFor("INDEX:^GSPC");
    expect(spx.id).toBe("INDEX:^GSPC");
    expect(spx.symbol).toBe("^GSPC");
    expect(spx.providerSymbols.yahoo.symbol).toBe("^GSPC");
  });

  it("keeps no caret on any starter board tile before the descriptor arrives", () => {
    const carets = STARTER_INSTRUMENTS
      .map((instrument) => buildTileViewModel({
        instrument,
        quote: { instrumentId: instrument.id, value: 1, price: 1, quality: "fresh" },
      }))
      .filter((viewModel) => viewModel.displaySymbol.includes("^"));

    expect(carets).toEqual([]);
  });

  it("presents a provisional search candidate without the provider caret", () => {
    expect(displaySymbolOf({ providerSymbol: "^GSPC", name: "S&P 500" })).toBe("GSPC");
    expect(displaySymbolOf({ providerSymbol: "^VIX", name: "^VIX" })).toBe("VIX");
  });

  it("sorts the board by the symbol it paints, not the one the provider sends", async () => {
    const { selectFilteredInstrumentIds } = await import("../src/ui/models/boardSelectors.js");
    const samples = ["INDEX:^GSPC", "XNAS:AAPL", "INDEX:^VIX"].map((id) => ({
      instrument: descriptorFor(id),
      instrumentId: id,
      quality: "fresh",
      price: 1,
      change: 0,
    }));

    const ordered = selectFilteredInstrumentIds(samples, { sort: "ticker" });

    expect(ordered).toEqual(["XNAS:AAPL", "INDEX:^GSPC", "INDEX:^VIX"]);
  });
});
