import { describe, expect, it } from "vitest";
import {
  validateEffectiveCapabilities,
  validateProviderCapabilityManifest,
} from "../../../server/contracts/market/capabilities.js";
import { YAHOO_CAPABILITY_MANIFEST } from "../../../server/providers/yahoo/capabilityManifest.js";
import { FINNHUB_CAPABILITY_MANIFEST } from "../../../server/providers/finnhub/capabilityManifest.js";
import { YahooProvider } from "../../../server/providers/yahoo/YahooProvider.js";
import { FinnhubProvider } from "../../../server/providers/finnhub/FinnhubProvider.js";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { MarketDataError } from "../../../server/errors/MarketDataError.js";

const OPERATION_METHODS = Object.freeze({
  search: "discoverInstruments",
  quote: "quoteMany",
  history: "history",
  details: "details",
  news: "news",
});

function implementsOwn(ProviderClass, method) {
  return typeof Object.getOwnPropertyDescriptor(ProviderClass.prototype, method)?.value === "function";
}

function implementedOperationsOf(ProviderClass) {
  return Object.fromEntries(Object.entries(OPERATION_METHODS)
    .map(([operation, method]) => [operation, implementsOwn(ProviderClass, method)]));
}

function expectSchemaInvalid(value, options) {
  expect(() => validateProviderCapabilityManifest(value, options)).toThrowError(MarketDataError);
  try {
    validateProviderCapabilityManifest(value, options);
  } catch (error) {
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
  }
}

const minimalManifest = (assets) => ({ provider: "yahoo", manifestVersion: 1, assets });

describe("provider capability manifests", () => {
  it("accepts the Yahoo manifest against the implemented provider surface", () => {
    expect(validateProviderCapabilityManifest(YAHOO_CAPABILITY_MANIFEST, {
      implementedOperations: implementedOperationsOf(YahooProvider),
    })).toBe(YAHOO_CAPABILITY_MANIFEST);
  });

  it("accepts the conservative Finnhub manifest", () => {
    expect(validateProviderCapabilityManifest(FINNHUB_CAPABILITY_MANIFEST, {
      implementedOperations: implementedOperationsOf(FinnhubProvider),
    })).toBe(FINNHUB_CAPABILITY_MANIFEST);
  });

  it("keeps Finnhub a selective fallback: no non-equity coverage, no adjusted history", () => {
    for (const [assetClass, operations] of Object.entries(FINNHUB_CAPABILITY_MANIFEST.assets)) {
      if (assetClass === "equity") continue;
      for (const entry of Object.values(operations)) {
        expect(entry.support).toBe("unsupported");
      }
    }
    expect(FINNHUB_CAPABILITY_MANIFEST.assets.equity.history.support).toBe("unsupported");
    for (const entry of Object.values(FINNHUB_CAPABILITY_MANIFEST.assets.equity)) {
      if (entry.support === "unsupported") continue;
      expect(entry.fallback?.semanticMatch).toBeTruthy();
    }
  });

  it("rejects unknown asset classes, operations and semantics", () => {
    expectSchemaInvalid(minimalManifest({ warrant: { quote: { support: "supported" } } }));
    expectSchemaInvalid(minimalManifest({ equity: { streaming: { support: "supported" } } }));
    expectSchemaInvalid(minimalManifest({
      equity: {
        history: {
          support: "supported",
          priceBases: ["total_return"],
          intervals: ["1d"],
          corporateActions: true,
        },
      },
    }));
    expectSchemaInvalid(minimalManifest({
      equity: {
        history: {
          support: "supported",
          priceBases: ["raw"],
          intervals: ["2h"],
          corporateActions: true,
        },
      },
    }));
    expectSchemaInvalid(minimalManifest({
      equity: { details: { support: "partial", sections: ["balance_sheet"] } },
    }));
  });

  it("rejects declared support without an implementation", () => {
    expectSchemaInvalid(
      minimalManifest({ equity: { quote: { support: "supported" } } }),
      { implementedOperations: { quote: false } },
    );
  });

  it("rejects fallback declarations without an equivalence policy", () => {
    expectSchemaInvalid(minimalManifest({
      equity: { quote: { support: "supported", fallback: {} } },
    }));
    expectSchemaInvalid(minimalManifest({
      equity: { quote: { support: "unsupported", fallback: { semanticMatch: "raw_quote" } } },
    }));
  });
});

describe("effective capabilities", () => {
  const effective = {
    quote: { status: "supported", fields: { price: "supported", volume: "unsupported" } },
    history: {
      status: "supported",
      ranges: { "1d": ["5m", "15m"], "1m": ["1d"], "1y": ["1d", "1wk"] },
      priceBases: ["raw"],
    },
    details: { status: "partial", sections: ["pair_metadata"] },
    news: { status: "unsupported" },
    analytics: { status: "unsupported", reason: "asset_class" },
  };

  it("accepts the product snapshot shape", () => {
    expect(validateEffectiveCapabilities(effective)).toBe(effective);
  });

  const invalidCases = [
    ["a missing operation", (c) => { delete c.news; }],
    ["an unknown operation", (c) => { c.streaming = { status: "supported" }; }],
    ["an unknown range", (c) => { c.history.ranges["2w"] = ["1d"]; }],
    ["an empty price basis list", (c) => { c.history.priceBases = []; }],
    ["an unknown detail section", (c) => { c.details.sections = ["balance_sheet"]; }],
  ];
  it.each(invalidCases)("rejects %s", (_, apply) => {
    const copy = structuredClone(effective);
    apply(copy);
    expect(() => validateEffectiveCapabilities(copy)).toThrowError(MarketDataError);
  });
});
