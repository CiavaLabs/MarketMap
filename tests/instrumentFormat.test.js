import { describe, expect, it } from "vitest";

import { displaySymbolOf, formatInstrumentValue, presentationSymbol, supportsPriceUnit } from "../src/ui/models/instrumentFormat.js";

describe("formatInstrumentValue", () => {
  it.each([
    [317.31, "currency", "USD", "$317.31"],
    [6318.72, "index_points", "USD", "6,318.72 pts"],
    [1.0842, "currency_per_unit", "USD", "1.0842"],
    [4.545, "percent_yield", "USD", "4.545%"],
    [-0.125, "percent_yield", "USD", "-0.125%"],
  ])("formats %s as %s", (value, unit, currency, expected) => {
    expect(formatInstrumentValue(value, unit, currency, "en-US")).toBe(expected);
  });

  it("never adds a currency symbol to index points or FX rates", () => {
    expect(formatInstrumentValue(100, "index_points", "USD", "en-US")).not.toContain("$");
    expect(formatInstrumentValue(1.25, "currency_per_unit", "USD", "en-US")).not.toContain("$");
  });

  it("renders non-values as an em dash and tolerates invalid locales/currencies", () => {
    expect(formatInstrumentValue(null, "currency", "USD")).toBe("—");
    expect(formatInstrumentValue(Number.NaN, "currency", "USD")).toBe("—");
    expect(formatInstrumentValue(12.3, "currency", "?", "not_a_locale")).toBe("12.30");
  });
});

describe("supportsPriceUnit", () => {
  it("exposes formatter coverage to the capability guardrail", () => {
    expect(["currency", "currency_per_unit", "index_points", "percent_yield"]
      .every(supportsPriceUnit)).toBe(true);
    expect(supportsPriceUnit("total_return_points")).toBe(false);
  });
});

describe("displaySymbolOf", () => {
  it("prefers a curated display symbol over anything derivable", () => {
    expect(displaySymbolOf({ displaySymbol: "SPX", symbol: "^GSPC", id: "INDEX:^GSPC" })).toBe("SPX");
    expect(displaySymbolOf({ displaySymbol: "  GC  ", symbol: "GC=F" })).toBe("GC");
  });

  it("drops the provider caret when nothing curated exists", () => {
    expect(displaySymbolOf({ symbol: "^VIX" })).toBe("VIX");
    expect(displaySymbolOf({ id: "INDEX:^GSPC" })).toBe("GSPC");
    expect(displaySymbolOf({ providerSymbol: "^TNX" })).toBe("TNX");
  });

  it("keeps an exchange suffix, which distinguishes two listings", () => {
    expect(displaySymbolOf({ symbol: "FTSEMIB.MI" })).toBe("FTSEMIB.MI");
    expect(displaySymbolOf({ symbol: "VOD.L" })).toBe("VOD.L");
    expect(displaySymbolOf({ symbol: "BRK-B" })).toBe("BRK-B");
  });

  it("falls back through ticker and id, and tolerates nothing at all", () => {
    expect(displaySymbolOf({ ticker: "AAPL" })).toBe("AAPL");
    expect(displaySymbolOf({ id: "XNAS:AAPL" })).toBe("AAPL");
    expect(displaySymbolOf({})).toBe("");
    expect(displaySymbolOf(null)).toBe("");
  });

  it("strips only a leading caret, never one inside the symbol", () => {
    expect(presentationSymbol("A^B")).toBe("A^B");
    expect(presentationSymbol("^A^B")).toBe("A^B");
  });
});
