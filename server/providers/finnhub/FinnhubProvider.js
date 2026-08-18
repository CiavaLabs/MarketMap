import { ERROR_CODES } from "../../contracts/core/constants.js";
import { NEWS_WINDOW_DAYS } from "../../contracts/core/news.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import {
  ProviderAdapter,
  normalizeProviderError,
} from "../ProviderAdapter.js";
import {
  normalizeFinnhubNews,
  normalizeFinnhubQuote,
} from "./normalizers.js";

const QUOTE_ASSET_CLASSES = Object.freeze(["equity"]);
const NEWS_ASSET_CLASSES = Object.freeze(["equity"]);
const US_EQUITY_QUOTE_MICS = new Set([
  "ARCX",
  "BATS",
  "XASE",
  "XNAS",
  "XNYS",
]);
const FINNHUB_SYMBOL_PATTERN = /^[A-Z0-9._:-]{1,80}$/i;
const NORTH_AMERICAN_NEWS_MICS = new Set([
  "ARCX", "BATS", "NEOE", "XASE", "XCNQ", "XNAS", "XNYS", "XTSE", "XTSX",
]);
function clockEpochSeconds(clock) {
  let value;
  if (typeof clock === "function") value = clock();
  else if (clock && typeof clock.now === "function") value = clock.now();
  else value = Date.now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Provider clock must return a valid date");
  return Math.floor(date.getTime() / 1000);
}

function utcDate(epochSecondsValue) {
  return new Date(epochSecondsValue * 1_000).toISOString().slice(0, 10);
}

function verifiedProviderSymbol(descriptor, provider) {
  const mapping = descriptor?.providerSymbols?.[provider];
  const symbol = `${mapping?.symbol || ""}`.trim();
  return symbol && mapping?.verified === true ? symbol.toUpperCase() : null;
}

function supportsCompanyNews(descriptor) {
  if (descriptor?.assetClass !== "equity") return false;
  return NORTH_AMERICAN_NEWS_MICS.has(`${descriptor.venue?.mic || ""}`.trim().toUpperCase());
}

function responseErrorCode(status) {
  if (status === 401) return ERROR_CODES.AUTH_FAILED;
  if (status === 403) return ERROR_CODES.ENTITLEMENT_MISSING;
  if (status === 404) return ERROR_CODES.INSTRUMENT_NOT_FOUND;
  if (status === 429) return ERROR_CODES.RATE_LIMITED;
  return ERROR_CODES.UPSTREAM_UNAVAILABLE;
}

function payloadErrorCode(message) {
  const normalized = `${message || ""}`.toLowerCase();
  if (normalized.includes("api key") || normalized.includes("authentication")) return ERROR_CODES.AUTH_FAILED;
  if (normalized.includes("premium") || normalized.includes("access") || normalized.includes("entitlement")) {
    return ERROR_CODES.ENTITLEMENT_MISSING;
  }
  if (normalized.includes("not found") || normalized.includes("no data")) return ERROR_CODES.INSTRUMENT_NOT_FOUND;
  if (normalized.includes("limit")) return ERROR_CODES.RATE_LIMITED;
  return ERROR_CODES.UPSTREAM_UNAVAILABLE;
}

function quoteEligibilityError(descriptor) {
  const instrumentId = typeof descriptor?.id === "string" && descriptor.id.trim()
    ? descriptor.id
    : null;
  if (!instrumentId) {
    return new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Finnhub quote requires an instrument descriptor", {
      provider: "finnhub",
      capability: "quote",
      retryable: false,
    });
  }
  if (descriptor.assetClass !== "equity") {
    return new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, `Finnhub v2 quote is unsupported for ${instrumentId}`, {
      provider: "finnhub",
      capability: "quote",
      instrumentId,
      retryable: false,
      details: { reason: "asset_class_not_supported" },
    });
  }
  const mic = `${descriptor.venue?.mic || descriptor.mic || ""}`.trim().toUpperCase();
  if (!US_EQUITY_QUOTE_MICS.has(mic)) {
    return new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, `Finnhub v2 quote is unsupported for ${instrumentId}`, {
      provider: "finnhub",
      capability: "quote",
      instrumentId,
      retryable: false,
      details: { reason: "venue_not_allowlisted" },
    });
  }
  const mapping = descriptor.providerSymbols?.finnhub;
  const providerSymbol = `${mapping?.symbol || ""}`.trim();
  if (mapping?.verified !== true || !FINNHUB_SYMBOL_PATTERN.test(providerSymbol)) {
    return new MarketDataError(ERROR_CODES.MAPPING_AMBIGUOUS, `No verified Finnhub v2 quote mapping for ${instrumentId}`, {
      provider: "finnhub",
      capability: "quote",
      instrumentId,
      retryable: false,
    });
  }
  return null;
}

function abortedRequestError(capability, instrumentId) {
  return new MarketDataError(ERROR_CODES.TIMEOUT, "Finnhub upstream request was aborted", {
    provider: "finnhub",
    capability,
    instrumentId,
    retryable: true,
  });
}

async function settleBounded(items, maxConcurrency, task) {
  if (!items.length) return [];
  const settled = new Array(items.length);
  let nextTask = 0;
  const worker = async () => {
    while (nextTask < items.length) {
      const index = nextTask;
      nextTask += 1;
      try {
        settled[index] = { status: "fulfilled", value: await task(items[index], index) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, items.length) }, () => worker()),
  );
  return settled;
}

function sanitizedFinnhubTransportError(error, context) {
  const normalized = normalizeProviderError(error, {
    code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
    ...context,
  });
  return new MarketDataError(normalized.code, "Finnhub upstream request failed", {
    status: normalized.status,
    retryable: normalized.retryable,
    provider: "finnhub",
    capability: context.capability,
    instrumentId: context.instrumentId,
  });
}

export class FinnhubProvider extends ProviderAdapter {
  constructor({
    apiKey = "",
    fetch: fetchImplementation = globalThis.fetch,
    baseUrl = "https://finnhub.io/api/v1",
    clock = Date.now,
    maxConcurrency = 5,
  } = {}) {
    const enabled = Boolean(`${apiKey || ""}`.trim());
    super({
      id: "finnhub",
      capabilities: {
        quote: { enabled, assetClasses: QUOTE_ASSET_CLASSES },
        news: { enabled, assetClasses: NEWS_ASSET_CLASSES },
      },
    });
    if (typeof fetchImplementation !== "function") {
      throw new TypeError("FinnhubProvider requires a fetch implementation");
    }
    this.apiKey = `${apiKey || ""}`.trim();
    this.fetch = fetchImplementation;
    this.baseUrl = `${baseUrl}`.replace(/\/+$/, "");
    this.clock = clock;
    this.maxConcurrency = Math.max(1, Math.min(Number(maxConcurrency) || 5, 10));
  }

  supportsInstrument(capability, instrument) {
    if (!super.supportsInstrument(capability, instrument)) return false;
    if (capability === "quote") return quoteEligibilityError(instrument) === null;
    if (capability !== "news") return true;
    return supportsCompanyNews(instrument) && Boolean(verifiedProviderSymbol(instrument, this.id));
  }

  #requireKey(capability, instrumentId = null) {
    if (this.apiKey) return;
    throw new MarketDataError(ERROR_CODES.AUTH_FAILED, "Finnhub API key is not configured", {
      provider: this.id,
      capability,
      instrumentId,
      retryable: false,
    });
  }

  async #request(path, params, { capability, instrumentId = null, signal } = {}) {
    this.#requireKey(capability, instrumentId);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, `${value}`);
    }
    url.searchParams.set("token", this.apiKey);

    let response;
    try {
      response = await this.fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortedRequestError(capability, instrumentId);
      throw sanitizedFinnhubTransportError(error, {
        capability,
        instrumentId,
      });
    }
    if (!response || typeof response.ok !== "boolean") {
      throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Finnhub fetch returned an invalid response object", {
        provider: this.id,
        capability,
        instrumentId,
      });
    }
    if (!response.ok) {
      const code = responseErrorCode(response.status);
      const retryAfterHeader = response.headers?.get?.("retry-after");
      const retryAfter = retryAfterHeader === null || retryAfterHeader === undefined
        ? null
        : Number(retryAfterHeader);
      throw new MarketDataError(code, `Finnhub request failed with HTTP ${response.status}`, {
        provider: this.id,
        capability,
        instrumentId,
        details: Number.isFinite(retryAfter) && retryAfter >= 0
          ? { retryAfterSeconds: retryAfter }
          : null,
      });
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new MarketDataError(ERROR_CODES.SCHEMA_INVALID, "Finnhub returned a non-JSON payload", {
        cause: error,
        provider: this.id,
        capability,
        instrumentId,
      });
    }
    if (payload && typeof payload === "object" && typeof payload.error === "string") {
      const code = payloadErrorCode(payload.error);
      throw new MarketDataError(code, "Finnhub rejected the upstream request", {
        provider: this.id,
        capability,
        instrumentId,
        retryable: code === ERROR_CODES.RATE_LIMITED || code === ERROR_CODES.UPSTREAM_UNAVAILABLE,
      });
    }
    return payload;
  }

  async quoteMany(descriptors, options = {}) {
    if (!Array.isArray(descriptors)) {
      throw new MarketDataError(ERROR_CODES.INVALID_REQUEST, "Finnhub quoteMany expects an array", {
        provider: this.id,
        capability: "quote",
      });
    }
    if (!descriptors.length) return { data: [], errors: [] };
    this.#requireKey("quote");

    const eligible = [];
    const outcomes = new Array(descriptors.length);
    descriptors.forEach((descriptor, index) => {
      const error = quoteEligibilityError(descriptor);
      if (error) outcomes[index] = { status: "rejected", reason: error };
      else eligible.push({ descriptor, inputIndex: index });
    });

    const settled = await settleBounded(eligible, this.maxConcurrency, async ({ descriptor }) => {
      if (options.signal?.aborted) throw abortedRequestError("quote", descriptor.id);
      const mapping = descriptor.providerSymbols.finnhub;
      const payload = await this.#request("/quote", { symbol: mapping.symbol.trim() }, {
        capability: "quote",
        instrumentId: descriptor.id,
        signal: options.signal,
      });
      const fallback = options.fallbackContextById instanceof Map
        ? options.fallbackContextById.get(descriptor.id)
        : options.fallbackContextById?.[descriptor.id];
      return normalizeFinnhubQuote(payload, {
        descriptor,
        clock: this.clock,
        fallbackFrom: fallback?.fromProvider || "yahoo",
        fallbackReason: fallback?.errorCode || fallback?.reason || "upstream_unavailable",
        semanticMatch: fallback?.semanticMatch || "raw_quote",
      });
    });
    settled.forEach((result, index) => {
      outcomes[eligible[index].inputIndex] = result;
    });

    const data = [];
    const errors = [];
    outcomes.forEach((result, index) => {
      const descriptor = descriptors[index];
      if (result.status === "fulfilled") {
        data.push(result.value);
        return;
      }
      errors.push(normalizeProviderError(result.reason, {
        provider: this.id,
        capability: "quote",
        instrumentId: descriptor?.id || null,
      }));
    });
    return { data, errors };
  }

  async news(descriptor, options = {}) {
    this.#requireKey("news");
    const instrument = descriptor;
    if (!instrument?.id) {
      throw new MarketDataError(ERROR_CODES.MAPPING_AMBIGUOUS, "A resolved instrument is required for Finnhub news", {
        provider: this.id,
        capability: "news",
        retryable: false,
      });
    }
    this.assertCapability("news", instrument.assetClass, instrument.id);
    if (!supportsCompanyNews(instrument)) {
      throw new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, `Finnhub company news is not supported for ${instrument.id}`, {
        provider: this.id,
        capability: "news",
        instrumentId: instrument.id,
        retryable: false,
        details: {
          assetClass: instrument.assetClass,
          mic: instrument.venue?.mic || null,
        },
      });
    }
    const providerSymbol = verifiedProviderSymbol(instrument, this.id);
    if (!providerSymbol) {
      throw new MarketDataError(ERROR_CODES.MAPPING_AMBIGUOUS, `No Finnhub news mapping for ${instrument.id}`, {
        provider: this.id,
        capability: "news",
        instrumentId: instrument.id,
        retryable: false,
      });
    }
    const toEpoch = clockEpochSeconds(this.clock);
    const fromDate = new Date(toEpoch * 1_000);
    fromDate.setUTCDate(fromDate.getUTCDate() - NEWS_WINDOW_DAYS);
    const payload = await this.#request("/company-news", {
      symbol: providerSymbol,
      from: fromDate.toISOString().slice(0, 10),
      to: utcDate(toEpoch),
    }, {
      capability: "news",
      instrumentId: instrument.id,
      signal: options.signal,
    });
    return normalizeFinnhubNews(payload, { instrument, clock: this.clock });
  }
}
