import { ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";
import { validateInstrumentDescriptor } from "../contracts/market/instrument.js";
import { assetPolicyFor } from "./assetPolicies.js";
import {
  continuousFutureIdentityFor,
  curatedEtfClassificationFor,
  curatedIndexDisplaySymbolFor,
  encodeCanonicalId,
} from "./InstrumentCatalog.js";
import { isResolvedExchangeVenue, resolveVenue, venueForMic } from "./VenueRegistry.js";
import { majorCurrencyCode } from "./currencyUnits.js";

const ASSET_CLASS_BY_QUOTE_TYPE = Object.freeze({
  EQUITY: "equity",
  ETF: "etf",
  INDEX: "index",
  CURRENCY: "fx",
  CRYPTOCURRENCY: "crypto",
  FUTURE: "commodity_future",
  BOND: "bond",
});

const RATE_INDEX_SYMBOLS = Object.freeze(new Set(["^IRX", "^FVX", "^TNX", "^TYX"]));

const MIC_ASSET_CLASSES = new Set(["equity", "etf"]);
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function clean(value) {
  return `${value ?? ""}`.trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

export function assetClassFromQuoteType(quoteType, providerSymbol) {
  const mapped = ASSET_CLASS_BY_QUOTE_TYPE[upper(quoteType)] || null;
  if (mapped === "index" && RATE_INDEX_SYMBOLS.has(upper(providerSymbol))) return "rate_index";
  return mapped;
}

function pairCurrencies(assetClass, providerSymbol, quote) {
  if (assetClass === "fx") {
    const pair = upper(providerSymbol).replace(/=X$/, "");
    if (pair.length === 6) {
      return { baseCurrency: pair.slice(0, 3), quoteCurrency: pair.slice(3) };
    }
    return null;
  }
  if (assetClass === "crypto") {
    const [base, quoted] = upper(providerSymbol).split("-");
    const baseCurrency = upper(quote?.fromCurrency) || base;
    if (baseCurrency && quoted && CURRENCY_PATTERN.test(quoted)) {
      return { baseCurrency, quoteCurrency: quoted };
    }
    return null;
  }
  return null;
}

function stripProviderCaret(symbol) {
  return symbol.startsWith("^") ? symbol.slice(1) : symbol;
}

function displaySymbolFor(assetClass, symbol, pair) {
  if (pair && (assetClass === "fx" || assetClass === "crypto")) {
    return `${pair.baseCurrency}/${pair.quoteCurrency}`;
  }
  if (assetClass === "commodity_future") {
    return continuousFutureIdentityFor(symbol)?.displaySymbol || symbol;
  }
  if (assetClass === "index" || assetClass === "rate_index") {
    return curatedIndexDisplaySymbolFor(symbol) || stripProviderCaret(symbol);
  }
  return symbol;
}

function subtypeFor(assetClass, providerSymbol, { curatedSubtype } = {}) {
  if (curatedSubtype) return curatedSubtype;
  if (assetClass === "etf") {
    return curatedEtfClassificationFor(providerSymbol)?.assetSubtype || "unknown";
  }
  if (assetClass === "fx" || assetClass === "crypto") return "spot_pair";
  if (assetClass === "index") return "market_index";
  if (assetClass === "rate_index") return "yield_index";
  if (assetClass === "commodity_future") {
    return upper(providerSymbol).endsWith("=F") ? "continuous_front" : "dated_contract";
  }
  return "unknown";
}

function defaultVenueFor(assetClass, { code, fullName } = {}) {
  if (assetClass === "fx") return resolveVenue({ code: "CCY" });
  if (assetClass === "crypto") return resolveVenue({ code: "CCC" });
  if (assetClass === "index" || assetClass === "rate_index") {
    const resolved = resolveVenue({ code, fullName });
    if (resolved.kind === "index_publisher") return resolved;
    return {
      code: upper(code) || "PUB",
      name: clean(fullName) || upper(code) || "Index publisher",
      mic: null,
      kind: "index_publisher",
      confidence: "unknown",
    };
  }
  return null;
}

export function descriptorFromYahooQuote({ providerSymbol, quote, discovery = null, clock = Date.now }) {
  const symbol = upper(providerSymbol || quote?.symbol);
  if (!symbol || !quote || typeof quote !== "object") {
    throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "A Yahoo quote is required to build a descriptor", {
      provider: "yahoo",
      details: { providerSymbol: symbol || null },
    });
  }

  const assetClass = assetClassFromQuoteType(quote.quoteType, symbol);
  const discoveredClass = discovery
    ? assetClassFromQuoteType(discovery.quoteType, symbol)
    : null;
  const typeConflict = Boolean(discoveredClass && assetClass && discoveredClass !== assetClass);
  if (assetClass === "bond") {
    return {
      descriptor: null,
      typeConflict,
      reasonCode: "single_bond_unsupported",
      candidate: {
        providerSymbol: symbol,
        name: clean(quote.longName || quote.shortName || discovery?.name) || symbol,
        assetClass: "bond",
        currency: majorCurrencyCode(quote.currency),
        mappingStatus: "unsupported",
      },
    };
  }
  if (!assetClass) {
    return {
      descriptor: null,
      typeConflict,
      reasonCode: "unsupported_asset",
      candidate: {
        providerSymbol: symbol,
        name: clean(quote.longName || quote.shortName || discovery?.name) || symbol,
        assetClass: null,
        mappingStatus: "unsupported",
      },
    };
  }

  const venue = MIC_ASSET_CLASSES.has(assetClass) || assetClass === "commodity_future"
    ? resolveVenue({ code: quote.exchange, fullName: quote.fullExchangeName })
    : defaultVenueFor(assetClass, { code: quote.exchange, fullName: quote.fullExchangeName });

  if (assetClass === "commodity_future" && !continuousFutureIdentityFor(symbol)) {
    return {
      descriptor: null,
      typeConflict,
      reasonCode: "future_not_allowlisted",
      candidate: {
        providerSymbol: symbol,
        name: clean(quote.longName || quote.shortName || discovery?.name) || symbol,
        assetClass,
        venue,
        currency: majorCurrencyCode(quote.currency),
        mappingStatus: "unsupported",
      },
    };
  }

  if ((MIC_ASSET_CLASSES.has(assetClass) || assetClass === "commodity_future")
    && !isResolvedExchangeVenue(venue)) {
    return {
      descriptor: null,
      typeConflict,
      reasonCode: "unsupported_venue",
      candidate: {
        providerSymbol: symbol,
        name: clean(quote.longName || quote.shortName || discovery?.name) || symbol,
        assetClass,
        venue,
        currency: majorCurrencyCode(quote.currency),
        mappingStatus: "unsupported",
      },
    };
  }

  const pair = pairCurrencies(assetClass, symbol, quote);
  const currency = majorCurrencyCode(quote.currency) || pair?.quoteCurrency || "";
  if (!CURRENCY_PATTERN.test(currency)) {
    return {
      descriptor: null,
      typeConflict,
      reasonCode: "identity_incomplete",
      candidate: {
        providerSymbol: symbol,
        name: clean(quote.longName || quote.shortName || discovery?.name) || symbol,
        assetClass,
        venue,
        currency: null,
        mappingStatus: "ambiguous",
      },
    };
  }
  let canonicalSymbol = symbol;
  if (assetClass === "fx") canonicalSymbol = symbol.replace(/=X$/, "");
  else if (MIC_ASSET_CLASSES.has(assetClass)) canonicalSymbol = symbol.replace(/\.[A-Z0-9]{1,4}$/, "");
  let id;
  try {
    id = encodeCanonicalId({ assetClass, symbol: canonicalSymbol, mic: venue?.mic });
  } catch (error) {
    return {
      descriptor: null,
      typeConflict,
      reasonCode: "identity_ambiguous",
      candidate: {
        providerSymbol: symbol,
        name: clean(quote.longName || quote.shortName || discovery?.name) || symbol,
        assetClass,
        venue,
        currency: majorCurrencyCode(quote.currency),
        mappingStatus: "ambiguous",
        error: error.message,
      },
    };
  }

  const policy = assetPolicyFor(assetClass);
  const etfClassification = assetClass === "etf"
    ? curatedEtfClassificationFor(symbol)
    : null;
  const descriptor = {
    id,
    displaySymbol: displaySymbolFor(assetClass, canonicalSymbol, pair),
    symbol: canonicalSymbol,
    name: clean(quote.longName || quote.shortName || discovery?.name) || canonicalSymbol,
    assetClass,
    assetSubtype: subtypeFor(assetClass, symbol),
    ...(etfClassification?.category ? { category: etfClassification.category } : {}),
    venue: {
      code: venue.code,
      name: venue.name,
      mic: venue.mic,
      kind: venue.kind,
    },
    exchange: venue.name,
    currency,
    ...(pair || {}),
    priceUnit: policy.priceUnit,
    status: "active",
    providerSymbols: {
      yahoo: {
        symbol,
        verified: true,
        verifiedAt: new Date(typeof clock === "function" ? clock() : Date.now()).toISOString(),
        providerType: upper(quote.quoteType),
      },
    },
    mappingStatus: "resolved",
  };
  validateInstrumentDescriptor(descriptor);
  return { descriptor, typeConflict, reasonCode: null };
}

export function descriptorFromLegacyInstrument(instrument, { verifiedAt } = {}) {
  const legacyClass = clean(instrument?.assetClass);
  const assetClass = legacyClass === "index" && RATE_INDEX_SYMBOLS.has(upper(instrument?.symbol))
    ? "rate_index"
    : legacyClass;
  assetPolicyFor(assetClass);

  const symbol = upper(instrument.symbol);
  const pair = pairCurrencies(assetClass, symbol, null);
  const explicitVenue = instrument.venueCode
    ? (MIC_ASSET_CLASSES.has(assetClass) || assetClass === "commodity_future"
        ? resolveVenue({ code: instrument.venueCode, fullName: instrument.exchange })
        : defaultVenueFor(assetClass, {
            code: instrument.venueCode,
            fullName: instrument.exchange,
          }))
    : null;
  if (explicitVenue?.mic && instrument.mic
    && upper(explicitVenue.mic) !== upper(instrument.mic)) {
    throw new MarketDataError(
      ERROR_CODES.MAPPING_AMBIGUOUS,
      `Venue code and MIC disagree for ${instrument.id}`,
      {
        instrumentId: instrument.id,
        retryable: false,
        details: {
          venueCode: instrument.venueCode,
          expectedMic: explicitVenue.mic,
          actualMic: instrument.mic,
        },
      },
    );
  }
  const venue = explicitVenue
    || (instrument.mic
      ? (venueForMic(instrument.mic) || {
        code: upper(instrument.mic),
        name: clean(instrument.exchange) || upper(instrument.mic),
        mic: upper(instrument.mic),
        kind: assetClass === "commodity_future" ? "futures_exchange" : "exchange",
      })
      : defaultVenueFor(assetClass, { fullName: instrument.exchange })
      || (assetClass === "commodity_future"
        ? {
            code: upper(instrument.exchange) || "FUT",
            name: clean(instrument.exchange) || "Futures exchange",
            mic: null,
            kind: "futures_exchange",
          }
        : null));
  if (!venue) {
    throw new MarketDataError(ERROR_CODES.MAPPING_AMBIGUOUS, `No venue can be derived for ${instrument.id}`, {
      instrumentId: instrument.id,
      retryable: false,
    });
  }

  const mappings = Object.entries(instrument.providerSymbols || {});
  const timestamp = verifiedAt || new Date(0).toISOString();
  const descriptor = {
    id: instrument.id,
    displaySymbol: displaySymbolFor(assetClass, symbol, pair),
    symbol,
    name: instrument.name,
    assetClass,
    assetSubtype: subtypeFor(assetClass, upper(instrument.providerSymbols?.yahoo || symbol), {
      curatedSubtype: instrument.assetSubtype,
    }),
    ...(instrument.category ? { category: clean(instrument.category) } : {}),
    venue: { code: venue.code, name: venue.name, mic: venue.mic ?? null, kind: venue.kind },
    exchange: clean(instrument.exchange) || venue.name,
    currency: upper(instrument.currency),
    ...(pair || {}),
    priceUnit: assetPolicyFor(assetClass).priceUnit,
    status: instrument.status || "active",
    providerSymbols: Object.fromEntries(mappings.map(([provider, symbolValue]) => [
      provider,
      { symbol: `${symbolValue}`, verified: true, verifiedAt: timestamp },
    ])),
    mappingStatus: "resolved",
  };
  validateInstrumentDescriptor(descriptor);
  return descriptor;
}
