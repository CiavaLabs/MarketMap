import { describe, expect, it } from "vitest";
import {
  MARKET_SCHEMA_VERSION,
  SEMANTIC_REVISION,
  marketCacheKey,
  validateDataQuality,
  validateHistorySeries,
  validateInstrumentDescriptor,
  validateInstrumentDetails,
  validateProvenance,
  validateQuoteSnapshot,
} from "../../../server/contracts/market/index.js";
import {
  ERROR_CODES,
  SCHEMA_VERSION,
} from "../../../server/contracts/core/constants.js";
import { MarketDataError } from "../../../server/errors/MarketDataError.js";
import { ALL_DESCRIPTORS, FX_DESCRIPTOR } from "../fixtures/market/descriptors.js";
import {
  ALL_QUOTES,
  CRYPTO_QUOTE,
  EQUITY_QUOTE,
  FX_QUOTE,
  RATE_QUOTE,
} from "../fixtures/market/quotes.js";
import {
  ALL_HISTORIES,
  ETF_ADJUSTED_HISTORY,
  ETF_PARTIAL_ADJUSTED_HISTORY,
  FX_RAW_HISTORY,
} from "../fixtures/market/histories.js";
import { ALL_DETAILS, COMPANY_DETAILS, FUND_DETAILS } from "../fixtures/market/details.js";

const mutate = (fixture, apply) => {
  const copy = structuredClone(fixture);
  apply(copy);
  return copy;
};

function expectSchemaInvalid(validate, value) {
  expect(() => validate(value)).toThrowError(MarketDataError);
  try {
    validate(value);
  } catch (error) {
    expect(error.code).toBe(ERROR_CODES.SCHEMA_INVALID);
  }
}

describe("schema-2 versioning and cache separation", () => {
  it("keeps the current schema distinct from legacy internal records", () => {
    expect(MARKET_SCHEMA_VERSION).toBe(2);
    expect(MARKET_SCHEMA_VERSION).not.toBe(SCHEMA_VERSION);
  });

  it("namespaces v2 cache keys away from v1 keys and by semantics", () => {
    const key = marketCacheKey("history", "ARCX:SPY", "1y:1d:provider_adjusted");
    expect(key.startsWith("v2:")).toBe(true);
    expect(key).toContain(SEMANTIC_REVISION);
    expect(key).not.toBe("history:ARCX:SPY:1y:1d");
    expect(marketCacheKey("history", "ARCX:SPY", "1y:1d:raw"))
      .not.toBe(marketCacheKey("history", "ARCX:SPY", "1y:1d:provider_adjusted"));
    expect(marketCacheKey("quote", "XNAS:AAPL", "", "fetching-v2@2"))
      .not.toBe(marketCacheKey("quote", "XNAS:AAPL", ""));
  });
});

describe("InstrumentDescriptor v2", () => {
  it.each(ALL_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]))(
    "accepts %s",
    (_, descriptor) => {
      expect(validateInstrumentDescriptor(descriptor)).toBe(descriptor);
    },
  );

  const invalidCases = [
    ["legacy asset class", (d) => { d.assetClass = "commodity_proxy"; }],
    ["unknown subtype", (d) => { d.assetSubtype = "warrant"; }],
    ["missing display symbol", (d) => { delete d.displaySymbol; }],
    ["resolved without verified mapping", (d) => {
      for (const mapping of Object.values(d.providerSymbols)) {
        mapping.verified = false;
        delete mapping.verifiedAt;
      }
    }],
    ["verified without timestamp", (d) => { delete d.providerSymbols.yahoo.verifiedAt; }],
    ["unknown provider mapping", (d) => { d.providerSymbols.bloomberg = { symbol: "AAPL US", verified: false }; }],
    ["empty provider mappings", (d) => { d.providerSymbols = {}; }],
    ["invalid currency", (d) => { d.currency = "US"; }],
    ["invalid mapping status", (d) => { d.mappingStatus = "guessed"; }],
    ["invalid venue kind", (d) => { d.venue.kind = "otc"; }],
  ];
  it.each(invalidCases)("rejects a descriptor with %s", (_, apply) => {
    const base = ALL_DESCRIPTORS[0];
    expectSchemaInvalid(validateInstrumentDescriptor, mutate(base, apply));
  });

  it("requires pair currencies for fx and forbids MIC on non-exchange venues", () => {
    expectSchemaInvalid(validateInstrumentDescriptor, mutate(FX_DESCRIPTOR, (d) => { delete d.baseCurrency; }));
    expectSchemaInvalid(validateInstrumentDescriptor, mutate(FX_DESCRIPTOR, (d) => { d.venue.mic = "XNYS"; }));
  });
});

describe("QuoteSnapshot", () => {
  it.each(ALL_QUOTES.map((quote) => [`${quote.instrumentId}@${quote.value}`, quote]))(
    "accepts %s",
    (_, quote) => {
      expect(validateQuoteSnapshot(quote)).toBe(quote);
    },
  );

  const invalidCases = [
    ["a null field without availability", EQUITY_QUOTE, (q) => {
      q.volume = null;
      delete q.fieldAvailability.volume;
    }],
    ["availability certifying a null field", EQUITY_QUOTE, (q) => { q.volume = null; }],
    ["a negative equity price", EQUITY_QUOTE, (q) => { q.value = -317.31; q.price = -317.31; }],
    ["a zero bid placeholder on equity", EQUITY_QUOTE, (q) => { q.bid = 0; }],
    ["price diverging from value", EQUITY_QUOTE, (q) => { q.price = q.value + 1; }],
    ["ask below bid", EQUITY_QUOTE, (q) => { q.ask = q.bid - 1; }],
    ["dayHigh below dayLow", EQUITY_QUOTE, (q) => { q.dayHigh = q.dayLow - 1; }],
    ["volume on an FX pair", FX_QUOTE, (q) => {
      q.volume = 0;
      q.fieldAvailability.volume = { status: "available" };
    }],
    ["bid on a rate index", RATE_QUOTE, (q) => {
      q.bid = 4.5;
      q.fieldAvailability.bid = { status: "available" };
    }],
    ["a currency price unit on a rate index", RATE_QUOTE, (q) => { q.priceUnit = "currency"; }],
    ["an equity session on crypto", CRYPTO_QUOTE, (q) => {
      q.session = { ...q.session, model: "exchange_hours", phase: "closed" };
    }],
    ["a closed phase on a 24x7 session", CRYPTO_QUOTE, (q) => { q.session.phase = "closed"; }],
    ["an unknown availability reason format", EQUITY_QUOTE, (q) => {
      q.fieldAvailability.volume = { status: "not_applicable", reason: "Not Applicable!" };
    }],
    ["a non-canonical instrument ID", EQUITY_QUOTE, (q) => { q.instrumentId = "aapl"; }],
    ["an unknown data quality issue", EQUITY_QUOTE, (q) => {
      q.dataQuality.issues = [{ code: "mystery", severity: "info", field: null }];
    }],
    ["a fallback without semantic match", EQUITY_QUOTE, (q) => {
      q.provenance = { source: "finnhub", providerSymbol: "AAPL", fallback: true, fallbackFrom: "yahoo", fallbackReason: "timeout" };
    }],
    ["fallback metadata on a primary response", EQUITY_QUOTE, (q) => {
      q.provenance = { ...q.provenance, fallbackFrom: "finnhub" };
    }],
  ];
  it.each(invalidCases.map(([name, base, apply]) => [name, base, apply]))(
    "rejects %s",
    (_, base, apply) => {
      expectSchemaInvalid(validateQuoteSnapshot, mutate(base, apply));
    },
  );

  it("accepts a complete fallback provenance", () => {
    const quote = mutate(EQUITY_QUOTE, (q) => {
      q.provenance = {
        source: "finnhub",
        providerSymbol: "AAPL",
        fallback: true,
        fallbackFrom: "yahoo",
        fallbackReason: "timeout",
        semanticMatch: "raw_quote",
      };
      q.dataQuality = {
        status: "usable_with_warnings",
        issues: [{ code: "fallback_provider_used", severity: "info", field: null }],
      };
    });
    expect(validateQuoteSnapshot(quote)).toBe(quote);
  });
});

describe("HistorySeries", () => {
  it.each(ALL_HISTORIES.map((history) => [
    `${history.instrumentId} ${history.range}/${history.interval} ${history.priceBasis}`,
    history,
  ]))("accepts %s", (_, history) => {
    expect(validateHistorySeries(history)).toBe(history);
  });

  const invalidCases = [
    ["a silent basis downgrade", ETF_ADJUSTED_HISTORY, (h) => { h.priceBasis = "raw"; }],
    ["raw close filling an adjusted gap", ETF_ADJUSTED_HISTORY, (h) => {
      h.bars[1].adjustedClose = null;
      h.bars[1].displayClose = h.bars[1].close;
      h.bars[1].fieldAvailability = { adjustedClose: { status: "temporarily_unavailable" } };
    }],
    ["an unexplained adjusted gap", ETF_ADJUSTED_HISTORY, (h) => {
      h.bars[1].adjustedClose = null;
      h.bars[1].displayClose = null;
    }],
    ["a wrong missing-adjusted counter", ETF_PARTIAL_ADJUSTED_HISTORY, (h) => {
      h.dataQuality.missingAdjustedCloseRows = 0;
    }],
    ["a missing partial_adjusted_series issue", ETF_PARTIAL_ADJUSTED_HISTORY, (h) => {
      h.dataQuality.issues = [];
    }],
    ["displayClose diverging from close on raw", FX_RAW_HISTORY, (h) => {
      h.bars[0].displayClose = h.bars[0].close + 0.01;
    }],
    ["corporate actions on FX", FX_RAW_HISTORY, (h) => {
      h.events = [{ type: "dividend", timestamp: "2026-07-14T00:00:00.000Z", amount: 1, currency: "USD", source: "yahoo" }];
    }],
    ["an adjusted basis on FX", FX_RAW_HISTORY, (h) => {
      h.priceBasis = "provider_adjusted";
      h.requestedPriceBasis = "provider_adjusted";
      h.adjustment.status = "provider_defined";
    }],
    ["unordered timestamps", ETF_ADJUSTED_HISTORY, (h) => {
      h.bars[1].timestamp = h.bars[0].timestamp;
    }],
    ["incoherent OHLC", ETF_ADJUSTED_HISTORY, (h) => { h.bars[0].high = h.bars[0].low - 1; }],
    ["negative equity-style prices", ETF_ADJUSTED_HISTORY, (h) => {
      h.bars[0].close = -1;
      h.bars[0].displayClose = -1;
      h.bars[0].adjustedClose = -1;
    }],
    ["a null volume without explanation", ETF_ADJUSTED_HISTORY, (h) => { h.bars[0].volume = null; }],
    ["a continuous continuity on an ETF", ETF_ADJUSTED_HISTORY, (h) => {
      h.continuity = {
        kind: "provider_continuous_front",
        activeContract: "X",
        expirationDate: null,
        rollover: "provider_managed",
        backAdjustment: "unknown",
        comparableAcrossRollover: false,
      };
    }],
    ["a comparable continuous series", ETF_ADJUSTED_HISTORY, (h) => {
      h.assetClass = "commodity_future";
      h.continuity = {
        kind: "provider_continuous_front",
        activeContract: "GCQ26.CMX",
        expirationDate: null,
        rollover: "provider_managed",
        backAdjustment: "unknown",
        comparableAcrossRollover: true,
      };
    }],
    ["a row count that ignores returned bars", ETF_ADJUSTED_HISTORY, (h) => { h.dataQuality.rowCount = 99; }],
    ["an unsupported range/interval combination", ETF_ADJUSTED_HISTORY, (h) => { h.interval = "5m"; }],
  ];
  it.each(invalidCases.map(([name, base, apply]) => [name, base, apply]))(
    "rejects %s",
    (_, base, apply) => {
      expectSchemaInvalid(validateHistorySeries, mutate(base, apply));
    },
  );
});

describe("InstrumentDetails", () => {
  it.each(ALL_DETAILS.map((details) => [`${details.instrument.id} (${details.kind})`, details]))(
    "accepts %s",
    (_, details) => {
      expect(validateInstrumentDetails(details)).toBe(details);
    },
  );

  const invalidCases = [
    ["a kind that contradicts the asset class", COMPANY_DETAILS, (d) => { d.kind = "fund"; }],
    ["a section outside the kind", FUND_DETAILS, (d) => { d.sections[0].id = "equity_fundamentals"; }],
    ["a null field without availability", COMPANY_DETAILS, (d) => {
      d.sections[1].fieldAvailability = {};
    }],
    ["an available section without data", COMPANY_DETAILS, (d) => {
      d.sections[0].fields = { sector: null };
      d.sections[0].fieldAvailability = { sector: { status: "temporarily_unavailable" } };
    }],
    ["populated fields on an unavailable section", COMPANY_DETAILS, (d) => {
      d.sections[0].status = "temporarily_unavailable";
    }],
    ["duplicate sections", COMPANY_DETAILS, (d) => { d.sections[1].id = d.sections[0].id; }],
    ["duplicate metrics", COMPANY_DETAILS, (d) => {
      const metric = {
        id: "pe_ttm",
        value: 31.2,
        unit: "ratio",
        period: "ttm",
        asOf: d.asOf,
        source: "yahoo",
        quality: "fresh",
      };
      d.metrics = [metric, { ...metric }];
    }],
  ];
  it.each(invalidCases.map(([name, base, apply]) => [name, base, apply]))(
    "rejects %s",
    (_, base, apply) => {
      expectSchemaInvalid(validateInstrumentDetails, mutate(base, apply));
    },
  );
});

describe("data quality and provenance primitives", () => {
  it("rejects a usable status with error issues", () => {
    expectSchemaInvalid(validateDataQuality, {
      status: "usable",
      issues: [{ code: "missing_required_field", severity: "error", field: "price" }],
    });
  });

  it("rejects negative counters", () => {
    expectSchemaInvalid(validateDataQuality, { status: "usable", issues: [], droppedRows: -1 });
  });

  it("keeps the last-known-good chain without erasing the origin", () => {
    const provenance = {
      source: "yahoo",
      providerSymbol: "SPY",
      fallback: false,
      originalSource: "yahoo",
    };
    expect(validateProvenance(provenance)).toBe(provenance);
    expectSchemaInvalid(validateProvenance, { ...provenance, originalSource: "last-known-good" });
  });
});
