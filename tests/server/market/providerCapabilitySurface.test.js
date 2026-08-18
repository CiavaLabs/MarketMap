import { describe, expect, it } from "vitest";
import { PROVIDER_CAPABILITIES } from "../../../server/providers/ProviderAdapter.js";
import { MARKET_ASSET_CLASSES } from "../../../server/contracts/market/constants.js";
import { YahooProvider } from "../../../server/providers/yahoo/YahooProvider.js";
import { FinnhubProvider } from "../../../server/providers/finnhub/FinnhubProvider.js";

const OPERATION_METHODS = Object.freeze({
  quote: "quoteMany",
  search: "discoverInstruments",
  history: "history",
  details: "details",
  news: "news",
});

const PROVIDERS = [
  ["yahoo", () => new YahooProvider({ client: { quote: async () => [] } }), YahooProvider],
  ["finnhub", () => new FinnhubProvider({ apiKey: "k", fetch: async () => ({}) }), FinnhubProvider],
];

describe("provider capability surface", () => {
  it("allows exactly the operations a provider can implement", () => {
    expect([...PROVIDER_CAPABILITIES].sort()).toEqual(Object.keys(OPERATION_METHODS).sort());
  });

  it.each(PROVIDERS)("%s reports a capability only where it has the method", (_id, build, ProviderClass) => {
    const provider = build();
    const declared = provider.capabilities();

    for (const [operation, method] of Object.entries(OPERATION_METHODS)) {
      const implemented = typeof Object.getOwnPropertyDescriptor(ProviderClass.prototype, method)?.value === "function";
      const enabled = declared[operation]?.enabled === true;
      expect(enabled && !implemented, `${_id} advertises ${operation} without ${method}()`).toBe(false);
    }
  });

  it.each(PROVIDERS)("%s does not hide an operation it implements", (_id, build, ProviderClass) => {
    const provider = build();

    for (const [operation, method] of Object.entries(OPERATION_METHODS)) {
      if (typeof Object.getOwnPropertyDescriptor(ProviderClass.prototype, method)?.value !== "function") continue;
      expect(provider.capabilities()[operation]?.enabled, `${_id} implements ${method}() but declares no ${operation}`)
        .toBe(true);
    }
  });

  it("does not advertise a quote for an instrument its implementation would reject", async () => {
    const { curatedDescriptor } = await import("../fixtures/market/curatedDescriptors.js");
    const finnhub = new FinnhubProvider({ apiKey: "k", fetch: async () => ({}) });

    expect(finnhub.supports("quote", "crypto")).toBe(false);
    expect(finnhub.supportsInstrument("quote", curatedDescriptor("CRYPTO:BTC-USD"))).toBe(false);
    expect(finnhub.supportsInstrument("quote", curatedDescriptor("XNAS:AAPL"))).toBe(true);

    const rejected = await finnhub.quoteMany([curatedDescriptor("CRYPTO:BTC-USD")]);
    expect(rejected.data).toEqual([]);
    expect(rejected.errors).toHaveLength(1);
  });

  it.each(PROVIDERS)("%s advertises no asset class outside the taxonomy", (_id, build) => {
    const declared = build().capabilities();

    for (const [operation, spec] of Object.entries(declared)) {
      for (const assetClass of spec?.assetClasses || []) {
        expect(MARKET_ASSET_CLASSES, `${_id} advertises ${operation} for ${assetClass}`)
          .toContain(assetClass);
      }
    }
  });
});
