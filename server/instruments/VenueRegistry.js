export const VENUE_REGISTRY_VERSION = 1;

const YAHOO_VENUES = Object.freeze({
  NMS: { name: "NasdaqGS", mic: "XNAS", kind: "exchange" },
  NGM: { name: "NasdaqGM", mic: "XNAS", kind: "exchange" },
  NCM: { name: "NasdaqCM", mic: "XNAS", kind: "exchange" },
  NAS: { name: "Nasdaq", mic: "XNAS", kind: "exchange" },
  NASDAQ: { name: "Nasdaq", mic: "XNAS", kind: "exchange" },
  NYQ: { name: "NYSE", mic: "XNYS", kind: "exchange" },
  NYSE: { name: "NYSE", mic: "XNYS", kind: "exchange" },
  ASE: { name: "NYSE American", mic: "XASE", kind: "exchange" },
  AMEX: { name: "NYSE American", mic: "XASE", kind: "exchange" },
  PCX: { name: "NYSE Arca", mic: "ARCX", kind: "exchange" },
  ARCA: { name: "NYSE Arca", mic: "ARCX", kind: "exchange" },
  ARCX: { name: "NYSE Arca", mic: "ARCX", kind: "exchange" },
  BATS: { name: "Cboe BZX", mic: "BATS", kind: "exchange" },
  LSE: { name: "London Stock Exchange", mic: "XLON", kind: "exchange", symbolSuffix: ".L" },
  AMS: { name: "Euronext Amsterdam", mic: "XAMS", kind: "exchange", symbolSuffix: ".AS" },
  CCY: { name: "Global FX", mic: null, kind: "fx_network" },
  CCC: { name: "Crypto Aggregate", mic: null, kind: "crypto_network" },
  SNP: { name: "S&P Dow Jones Indices", mic: null, kind: "index_publisher" },
  CGI: { name: "Cboe Global Indices", mic: null, kind: "index_publisher" },
  DJI: { name: "Dow Jones Indices", mic: null, kind: "index_publisher" },
  NIM: { name: "Nasdaq Indices", mic: null, kind: "index_publisher" },
  CMX: { name: "COMEX", mic: "XCEC", kind: "futures_exchange" },
  NYM: { name: "NYMEX", mic: "XNYM", kind: "futures_exchange" },
  CBT: { name: "CBOT", mic: "XCBT", kind: "futures_exchange" },
  CME: { name: "CME", mic: "XCME", kind: "futures_exchange" },
});

const REGISTRY_BY_PROVIDER = Object.freeze({ yahoo: YAHOO_VENUES });

const MIC_INDEX = (() => {
  const byMic = new Map();
  for (const [code, venue] of Object.entries(YAHOO_VENUES)) {
    if (venue.mic && !byMic.has(venue.mic)) byMic.set(venue.mic, { code, ...venue });
  }
  return byMic;
})();

function cleanCode(value) {
  return `${value ?? ""}`.trim().toUpperCase();
}

export function resolveVenue({ provider = "yahoo", code, fullName } = {}) {
  const normalizedCode = cleanCode(code);
  const registry = REGISTRY_BY_PROVIDER[provider] || {};
  const known = registry[normalizedCode];
  if (known) {
    return {
      code: normalizedCode,
      name: known.name,
      mic: known.mic,
      kind: known.kind,
      confidence: "exact",
    };
  }
  return {
    code: normalizedCode || "UNKNOWN",
    name: `${fullName ?? ""}`.trim() || normalizedCode || "Unknown venue",
    mic: null,
    kind: "unknown",
    confidence: "unknown",
  };
}

export function venueForMic(mic) {
  const found = MIC_INDEX.get(cleanCode(mic));
  return found
    ? { code: found.code, name: found.name, mic: found.mic, kind: found.kind, confidence: "exact" }
    : null;
}

export function providerSymbolCandidatesForVenue({ provider = "yahoo", symbol, mic } = {}) {
  const normalizedSymbol = cleanCode(symbol);
  if (provider !== "yahoo" || !normalizedSymbol) return [];
  const venue = MIC_INDEX.get(cleanCode(mic));
  const suffixed = venue?.symbolSuffix && !normalizedSymbol.endsWith(venue.symbolSuffix)
    ? `${normalizedSymbol}${venue.symbolSuffix}`
    : null;
  return suffixed ? [suffixed, normalizedSymbol] : [normalizedSymbol];
}

export function isResolvedExchangeVenue(venue) {
  return Boolean(venue
    && (venue.kind === "exchange" || venue.kind === "futures_exchange")
    && venue.mic
    && venue.confidence === "exact");
}
