import { describe, expect, it } from "vitest";

import { buildTileViewModel } from "../src/ui/models/tileViewModel.js";
import {
  CRYPTO_DESCRIPTOR,
  EQUITY_DESCRIPTOR,
  ETF_DESCRIPTOR,
  FUTURE_DESCRIPTOR,
  FX_DESCRIPTOR,
  INDEX_DESCRIPTOR,
  RATE_DESCRIPTOR,
} from "./server/fixtures/market/descriptors.js";
import {
  CRYPTO_QUOTE,
  EQUITY_QUOTE,
  ETF_QUOTE,
  FUTURE_QUOTE,
  FX_QUOTE,
  INDEX_QUOTE,
  RATE_QUOTE,
} from "./server/fixtures/market/quotes.js";

const sections = {
  equity: ["company_profile"],
  etf: ["fund_profile"],
  index: ["index_metadata"],
  fx: ["pair_metadata"],
  crypto: ["crypto_metadata"],
  commodity_future: ["future_contract"],
  rate_index: ["index_metadata"],
};

function capabilities(assetClass, overrides = {}) {
  return {
    quote: { status: "supported" },
    history: { status: "supported", ranges: { "1m": ["1d"] }, priceBases: ["raw"] },
    details: { status: "supported", sections: sections[assetClass] },
    news: { status: "unsupported" },
    analytics: { status: "unsupported" },
    ...overrides,
  };
}

const cases = [
  [EQUITY_DESCRIPTOR, EQUITY_QUOTE, "$317.31"],
  [ETF_DESCRIPTOR, ETF_QUOTE, "$628.42"],
  [INDEX_DESCRIPTOR, INDEX_QUOTE, "6,318.72 pts"],
  [FX_DESCRIPTOR, FX_QUOTE, "1.0842"],
  [CRYPTO_DESCRIPTOR, CRYPTO_QUOTE, "$118,412.55"],
  [FUTURE_DESCRIPTOR, FUTURE_QUOTE, "$3,352.40"],
  [RATE_DESCRIPTOR, RATE_QUOTE, "4.545%"],
];

describe("buildTileViewModel", () => {
  it.each(cases)("renders a %s tile with its normalized unit", (descriptor, quote, expected) => {
    const model = buildTileViewModel({
      instrument: { instrument: descriptor, capabilities: capabilities(descriptor.assetClass) },
      quote,
      requestState: { quote: "success", history: "success" },
    });

    expect(model.assetClass).toBe(descriptor.assetClass);
    expect(model.formattedValue).toBe(expected);
    expect(model.quoteState).toBe("ready");
    expect(model.ariaLabel).toContain(expected);
  });

  it("leaves footerLabel unset rather than repeating the assetClass tag when no sector is known", () => {
    const model = buildTileViewModel({
      instrument: { instrument: EQUITY_DESCRIPTOR, capabilities: capabilities("equity") },
      quote: EQUITY_QUOTE,
      requestState: { quote: "success", history: "success" },
    });
    expect(model.footerLabel).toBeUndefined();
  });

  it("surfaces a real sector once the instrument carries one", () => {
    const model = buildTileViewModel({
      instrument: { instrument: { ...EQUITY_DESCRIPTOR, sector: "Technology" }, capabilities: capabilities("equity") },
      quote: EQUITY_QUOTE,
      requestState: { quote: "success", history: "success" },
    });
    expect(model.footerLabel).toBe("Technology");
  });

  it("does not start a visible loading state for an unsupported quote", () => {
    const model = buildTileViewModel({
      instrument: {
        instrument: EQUITY_DESCRIPTOR,
        capabilities: capabilities("equity", { quote: { status: "unsupported", reason: "disabled" } }),
      },
      quote: EQUITY_QUOTE,
      requestState: { quote: "loading" },
    });

    expect(model.quoteState).toBe("hidden");
    expect(model.state).toBe("unavailable");
    expect(model.formattedValue).toBe("—");
  });

  it("represents an initial supported request as loading", () => {
    const model = buildTileViewModel({
      instrument: { instrument: EQUITY_DESCRIPTOR, capabilities: capabilities("equity") },
      requestState: { quote: { status: "pending" } },
    });
    expect(model).toMatchObject({ quoteState: "loading", state: "loading", formattedValue: "—" });
  });

  it("keeps a stale last-known-good value and labels it in the accessible name", () => {
    const model = buildTileViewModel({
      instrument: { instrument: EQUITY_DESCRIPTOR, capabilities: capabilities("equity") },
      quote: { ...EQUITY_QUOTE, quality: "stale" },
      requestState: { quote: "success" },
    });
    expect(model).toMatchObject({ quoteState: "stale", quality: "stale", formattedValue: "$317.31" });
    expect(model.ariaLabel).toContain("Last confirmed");
  });

  it("does not surface an unusable quote even when it contains a numeric provider value", () => {
    const model = buildTileViewModel({
      instrument: { instrument: EQUITY_DESCRIPTOR, capabilities: capabilities("equity") },
      quote: { ...EQUITY_QUOTE, dataQuality: { status: "unusable" } },
      requestState: { quote: "success" },
    });
    expect(model).toMatchObject({ quoteState: "unavailable", formattedValue: "—", quality: "unavailable" });
  });
});
