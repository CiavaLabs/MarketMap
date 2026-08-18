import { describe, expect, it } from "vitest";
import { descriptorFromYahooQuote } from "../../../server/instruments/descriptorFactory.js";

function yahooQuote(overrides = {}) {
  return {
    quoteType: "INDEX",
    longName: "FTSE 100",
    currency: "GBP",
    fullExchangeName: "FTSE Index",
    exchange: "FTSE Index",
    regularMarketPrice: 8_100,
    ...overrides,
  };
}

const build = (providerSymbol, quote) =>
  descriptorFromYahooQuote({ providerSymbol, quote: yahooQuote(quote), clock: () => 0 }).descriptor;

describe("descriptorFactory · displayed symbol", () => {
  it("strips Yahoo's caret from indices", () => {
    const descriptor = build("^FTSE");
    expect(descriptor.displaySymbol).toBe("FTSE");
  });

  it("strips the caret from rate indices too", () => {
    const descriptor = build("^TNX", { longName: "CBOE Interest Rate 10 Year T No" });
    expect(descriptor.assetClass).toBe("rate_index");
    expect(descriptor.displaySymbol).toBe("TNX");
  });

  it("leaves the caret in the identity and in the provider symbol", () => {
    const descriptor = build("^FTSE");
    expect(descriptor.id).toBe("INDEX:^FTSE");
    expect(descriptor.symbol).toBe("^FTSE");
    expect(descriptor.providerSymbols.yahoo.symbol).toBe("^FTSE");
  });

  it("does not touch exchange suffixes", () => {
    const descriptor = build("FTSEMIB.MI", { longName: "FTSE MIB Index", currency: "EUR" });
    expect(descriptor.displaySymbol).toBe("FTSEMIB.MI");
  });

  it("leaves an index that has no caret alone", () => {
    const descriptor = build("SPX");
    expect(descriptor.displaySymbol).toBe("SPX");
  });
});
