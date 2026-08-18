import { describe, expect, it } from "vitest";

import { buildDetailViewModel } from "../src/ui/models/detailAssetViewModel.js";
import {
  EQUITY_DESCRIPTOR,
  ETF_DESCRIPTOR,
  FX_DESCRIPTOR,
  INDEX_DESCRIPTOR,
  RATE_DESCRIPTOR,
} from "./server/fixtures/market/descriptors.js";
import {
  COMPANY_DETAILS,
  FUND_DETAILS,
  INDEX_DETAILS,
  PAIR_DETAILS,
  RATE_DETAILS,
} from "./server/fixtures/market/details.js";
import {
  ETF_ADJUSTED_HISTORY,
  ETF_PARTIAL_ADJUSTED_HISTORY,
  FX_RAW_HISTORY,
} from "./server/fixtures/market/histories.js";
import {
  EQUITY_QUOTE,
  ETF_QUOTE,
  FX_QUOTE,
  INDEX_QUOTE,
  RATE_QUOTE,
} from "./server/fixtures/market/quotes.js";

const sections = {
  equity: ["company_profile", "equity_fundamentals", "analyst_outlook"],
  etf: ["fund_profile", "fund_composition", "fund_stats"],
  index: ["index_metadata", "market_stats"],
  fx: ["pair_metadata"],
  rate_index: ["index_metadata", "market_stats"],
};

function capabilities(assetClass, overrides = {}) {
  return {
    quote: { status: "supported" },
    history: {
      status: "supported",
      ranges: { "1m": ["1d"], "1y": ["1d"] },
      priceBases: assetClass === "equity" || assetClass === "etf"
        ? ["raw", "provider_adjusted"]
        : ["raw"],
    },
    details: { status: "supported", sections: sections[assetClass] },
    news: { status: assetClass === "equity" ? "supported" : "unsupported" },
    analytics: { status: "unsupported" },
    ...overrides,
  };
}

const inputInstrument = (descriptor, overrides = {}) => ({
  instrument: descriptor,
  capabilities: capabilities(descriptor.assetClass, overrides),
});

describe("buildDetailViewModel", () => {
  it("uses displayClose verbatim and never fills an adjusted gap with raw close", () => {
    const model = buildDetailViewModel({
      instrument: inputInstrument(ETF_DESCRIPTOR),
      quote: ETF_QUOTE,
      details: FUND_DETAILS,
      history: ETF_PARTIAL_ADJUSTED_HISTORY,
      requestState: { quote: "success", details: "success", history: "success" },
    });

    expect(model.chart.priceBasis).toBe("provider_adjusted");
    expect(model.chart.series.map(({ value }) => value)).toEqual([621.9, null, 628.4]);
    expect(model.chart.mayMergeLiveQuote).toBe(false);
    expect(model.chart.volumeDisplay).toBe("supported");
    expect(model.detailSections.map(({ id }) => id)).toEqual(sections.etf);
  });

  it("allows a live quote merge only for raw, single-instrument history", () => {
    const model = buildDetailViewModel({
      instrument: inputInstrument(FX_DESCRIPTOR),
      quote: FX_QUOTE,
      details: PAIR_DETAILS,
      history: FX_RAW_HISTORY,
      requestState: { quote: "success", details: "success", history: "success" },
    });

    expect(model.chart.mayMergeLiveQuote).toBe(true);
    expect(model.chart.volumeDisplay).toBe("hidden");
    expect(model.quote.relativeVolume).toBe(null);
    expect(model.quote.stats.map(({ id }) => id)).not.toContain("volume");
    expect(model.chart.accessibleSummary).toContain("currency_per_unit");
  });

  it("shows relative volume only for exchange-traded equity/ETF semantics", () => {
    const equity = buildDetailViewModel({
      instrument: inputInstrument(EQUITY_DESCRIPTOR),
      quote: EQUITY_QUOTE,
      details: COMPANY_DETAILS,
      requestState: { quote: "success", details: "success" },
    });
    const index = buildDetailViewModel({
      instrument: inputInstrument(INDEX_DESCRIPTOR),
      quote: INDEX_QUOTE,
      details: INDEX_DETAILS,
      requestState: { quote: "success", details: "success" },
    });

    expect(equity.quote.relativeVolume.value).toBeCloseTo(
      EQUITY_QUOTE.volume / EQUITY_QUOTE.averageVolume3m,
    );
    expect(index.quote.relativeVolume).toBe(null);
  });

  it("omits non-applicable/unsupported fields but preserves transient unavailability", () => {
    const equity = buildDetailViewModel({
      instrument: inputInstrument(EQUITY_DESCRIPTOR),
      quote: EQUITY_QUOTE,
      details: COMPANY_DETAILS,
      requestState: { quote: "success", details: "success" },
    });
    const fundamentals = equity.detailSections.find(({ id }) => id === "equity_fundamentals");
    expect(fundamentals.rows.find(({ id }) => id === "beta")).toMatchObject({
      value: null,
      state: "unavailable",
    });

    const index = buildDetailViewModel({
      instrument: inputInstrument(INDEX_DESCRIPTOR),
      quote: INDEX_QUOTE,
      details: INDEX_DETAILS,
      requestState: { quote: "success", details: "success" },
    });
    const metadata = index.detailSections.find(({ id }) => id === "index_metadata");
    expect(metadata.rows.map(({ id }) => id)).not.toContain("launchDate");
    expect(index.quote.stats.map(({ id }) => id)).not.toEqual(expect.arrayContaining(["bid", "ask"]));
  });

  it("drops a section declared not applicable instead of rendering an empty card", () => {
    const model = buildDetailViewModel({
      instrument: inputInstrument(RATE_DESCRIPTOR),
      quote: RATE_QUOTE,
      details: RATE_DETAILS,
      requestState: { quote: "success", details: "success" },
    });
    expect(model.detailSections.map(({ id }) => id)).toEqual(["index_metadata"]);
  });

  it("preserves stale chart data and exposes its basis in the accessible summary", () => {
    const model = buildDetailViewModel({
      instrument: inputInstrument(ETF_DESCRIPTOR),
      quote: { ...ETF_QUOTE, quality: "stale" },
      details: FUND_DETAILS,
      history: { ...ETF_ADJUSTED_HISTORY, quality: "stale" },
      requestState: { quote: "success", details: "success", history: "success" },
    });
    expect(model.resourceStates).toMatchObject({ quote: "stale", history: "stale" });
    expect(model.chart.accessibleSummary).toContain("provider adjusted");
  });

  it("hides unsupported details even if a payload is accidentally present", () => {
    const model = buildDetailViewModel({
      instrument: inputInstrument(EQUITY_DESCRIPTOR, {
        details: { status: "unsupported", reason: "no_provider_coverage" },
      }),
      quote: EQUITY_QUOTE,
      details: COMPANY_DETAILS,
      requestState: { details: "loading", quote: "success" },
    });
    expect(model.resourceStates.details).toBe("hidden");
    expect(model.detailSections).toEqual([]);
  });

  it("combines a supported pending request into loading without inventing content", () => {
    const model = buildDetailViewModel({
      instrument: inputInstrument(EQUITY_DESCRIPTOR),
      requestState: { quote: "loading", details: "pending", history: "loading" },
    });
    expect(model.resourceStates).toMatchObject({ quote: "loading", details: "loading", history: "loading" });
    expect(model.header.formattedValue).toBe("—");
    expect(model.detailSections).toEqual([]);
  });
});
