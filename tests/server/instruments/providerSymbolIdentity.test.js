import { describe, expect, it } from "vitest";
import { InstrumentCatalog } from "../../../server/instruments/InstrumentCatalog.js";

const GOLD_FUTURE_ID = "FUTURE:CMX.GC.CONTINUOUS.1";

describe("provider symbol identity", () => {
  it("attributes a related news ticker only through a real provider mapping", () => {
    const catalog = new InstrumentCatalog();
    expect(catalog.resolveByProviderSymbol("GOLD")).toBeNull();
    expect(catalog.resolveByProviderSymbol("GC=F").id).toBe(GOLD_FUTURE_ID);
  });
});

describe("InstrumentCatalog.resolveByProviderSymbol", () => {
  it("ignores alias and name matches, and empty input", () => {
    const catalog = new InstrumentCatalog();
    expect(catalog.resolveByProviderSymbol("GOLD")).toBeNull();
    expect(catalog.resolveByProviderSymbol("")).toBeNull();
    expect(catalog.resolveByProviderSymbol(null)).toBeNull();
    expect(catalog.resolveByProviderSymbol("NOT-A-SYMBOL")).toBeNull();
  });

  it("declines when two instruments both map the same provider symbol", () => {
    const catalog = new InstrumentCatalog({ instruments: [] });
    const shared = { name: "Shared", assetClass: "equity", currency: "USD", status: "active" };
    catalog.register({ ...shared, id: "XNAS:AAA", symbol: "AAA", mic: "XNAS", exchange: "NASDAQ", providerSymbols: { yahoo: "DUP" } });
    catalog.register({ ...shared, id: "XNYS:BBB", symbol: "BBB", mic: "XNYS", exchange: "NYSE", providerSymbols: { yahoo: "DUP" } });

    expect(catalog.resolveByProviderSymbol("DUP")).toBeNull();
  });

  it("matches case-insensitively on a declared mapping", () => {
    const catalog = new InstrumentCatalog();
    expect(catalog.resolveByProviderSymbol("gc=f").id).toBe(GOLD_FUTURE_ID);
  });
});
