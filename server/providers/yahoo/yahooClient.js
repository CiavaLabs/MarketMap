import { ERROR_CODES } from "../../contracts/core/constants.js";
import { MarketDataError } from "../../errors/MarketDataError.js";
import { YahooCookieJar } from "./yahooCookieJar.js";
import { YAHOO_USER_AGENT, YahooSession, YahooSessionError } from "./yahooSession.js";

const API_ORIGIN = "https://query1.finance.yahoo.com";
const EPOCH_MILLISECOND_FLOOR = 1e12;
const MAX_PAYLOAD_DEPTH = 32;
const CRUMB_REJECTION_STATUSES = new Set([401, 403]);

const QUOTE_DATE_FIELDS = new Set([
  "dividendDate",
  "earningsCallTimestampEnd",
  "earningsCallTimestampStart",
  "earningsTimestamp",
  "earningsTimestampEnd",
  "earningsTimestampStart",
  "expireDate",
  "postMarketTime",
  "preMarketTime",
  "regularMarketTime",
  "startDate",
]);

const QUOTE_MILLISECOND_DATE_FIELDS = new Set(["firstTradeDateMilliseconds"]);

const QUOTE_ISO_DATE_FIELDS = new Set(["expireIsoDate", "nameChangeDate"]);

const QUOTE_RANGE_FIELDS = new Set([
  "fiftyTwoWeekRange",
  "postMarketDayRange",
  "preMarketDayRange",
  "regularMarketDayRange",
]);

const SUMMARY_DATE_FIELDS = new Set([
  "compensationAsOfEpochDate",
  "dateShortInterest",
  "dividendDate",
  "earningsCallDate",
  "earningsDate",
  "exDividendDate",
  "expireDate",
  "firstTradeDateEpochUtc",
  "fundInceptionDate",
  "governanceEpochDate",
  "lastDividendDate",
  "lastFiscalYearEnd",
  "lastSplitDate",
  "launchDate",
  "mostRecentQuarter",
  "nextFiscalYearEnd",
  "postMarketTime",
  "preMarketTime",
  "regularMarketTime",
  "sharesShortPreviousMonthDate",
  "startDate",
]);

const CHART_META_DATE_FIELDS = new Set(["firstTradeDate", "regularMarketTime"]);
const TRADING_PERIOD_DATE_FIELDS = new Set(["start", "end"]);

export class YahooApiError extends Error {
  constructor(message, { status = null, code = null, endpoint, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "YahooApiError";
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }
}

function epochDate(value) {
  if (value instanceof Date) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return new Date(Math.abs(value) >= EPOCH_MILLISECOND_FLOOR ? value : value * 1_000);
}

function millisecondDate(value) {
  if (value instanceof Date) return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return new Date(value);
}

function unwrapRaw(value, dateFields, key = null, depth = 0) {
  if (depth > MAX_PAYLOAD_DEPTH) {
    throw new YahooApiError("Yahoo quoteSummary nested past the depth this client will walk", {
      endpoint: "quoteSummary",
    });
  }
  if (Array.isArray(value)) {
    return value.map((entry) => unwrapRaw(entry, dateFields, key, depth + 1));
  }
  if (value === null || typeof value !== "object") {
    return key && dateFields.has(key) ? epochDate(value) : value;
  }
  if (Object.hasOwn(value, "raw")) {
    const raw = value.raw;
    return key && dateFields.has(key) ? epochDate(raw) : raw;
  }
  const unwrapped = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    unwrapped[childKey] = unwrapRaw(childValue, dateFields, childKey, depth + 1);
  }
  return unwrapped;
}

function coerceDateFields(source, fields) {
  if (!source || typeof source !== "object") return source;
  const coerced = { ...source };
  for (const field of fields) {
    if (Object.hasOwn(coerced, field)) coerced[field] = epochDate(coerced[field]);
  }
  return coerced;
}

function isoDate(value) {
  if (value instanceof Date || typeof value !== "string") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : value;
}

function priceRange(value) {
  if (typeof value !== "string") return value;
  const [low, high] = value.split(" - ").map((part) => Number(part.trim()));
  if (!Number.isFinite(low) || !Number.isFinite(high)) return value;
  return { low, high };
}

function shapeQuote(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const shaped = coerceDateFields(entry, QUOTE_DATE_FIELDS);
  for (const field of QUOTE_MILLISECOND_DATE_FIELDS) {
    if (Object.hasOwn(shaped, field)) shaped[field] = millisecondDate(shaped[field]);
  }
  for (const field of QUOTE_ISO_DATE_FIELDS) {
    if (Object.hasOwn(shaped, field)) shaped[field] = isoDate(shaped[field]);
  }
  for (const field of QUOTE_RANGE_FIELDS) {
    if (Object.hasOwn(shaped, field)) shaped[field] = priceRange(shaped[field]);
  }
  return shaped;
}

function coerceTradingPeriod(period) {
  if (!period || typeof period !== "object") return period;
  if (Array.isArray(period)) return period.map(coerceTradingPeriod);
  const coerced = {};
  for (const [key, value] of Object.entries(period)) {
    coerced[key] = TRADING_PERIOD_DATE_FIELDS.has(key) ? epochDate(value) : coerceTradingPeriod(value);
  }
  return coerced;
}

function chartMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const coerced = coerceDateFields(meta, CHART_META_DATE_FIELDS);
  if (coerced.currentTradingPeriod) {
    coerced.currentTradingPeriod = coerceTradingPeriod(coerced.currentTradingPeriod);
  }
  return coerced;
}

function chartRows(result) {
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const series = result?.indicators?.quote?.[0] || {};
  const adjclose = result?.indicators?.adjclose?.[0]?.adjclose;
  const column = (values) => (Array.isArray(values) ? values : []);
  const open = column(series.open);
  const high = column(series.high);
  const low = column(series.low);
  const close = column(series.close);
  const volume = column(series.volume);
  const adjusted = column(adjclose);

  return timestamps.map((timestamp, index) => {
    const row = {
      date: epochDate(timestamp),
      high: high[index] ?? null,
      volume: volume[index] ?? null,
      open: open[index] ?? null,
      low: low[index] ?? null,
      close: close[index] ?? null,
    };
    if (adjusted.length) row.adjclose = adjusted[index] ?? null;
    return row;
  });
}

function chartEvents(events) {
  if (!events || typeof events !== "object") return undefined;
  const collected = {};
  if (events.dividends && typeof events.dividends === "object") {
    collected.dividends = Object.values(events.dividends)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({ amount: entry.amount ?? null, date: epochDate(entry.date) }));
  }
  if (events.splits && typeof events.splits === "object") {
    collected.splits = Object.values(events.splits)
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        date: epochDate(entry.date),
        numerator: entry.numerator ?? null,
        denominator: entry.denominator ?? null,
        splitRatio: entry.splitRatio ?? null,
      }));
  }
  return Object.keys(collected).length ? collected : undefined;
}

function envelopeError(envelope, endpoint) {
  const error = envelope?.error;
  if (!error) return null;
  const description = typeof error === "string" ? error : error.description || error.code || "unknown";
  return new YahooApiError(`Yahoo ${endpoint} reported ${description}`, {
    code: typeof error === "string" ? null : error.code || null,
    endpoint,
  });
}

function sessionRejected(cause) {
  return new MarketDataError(
    ERROR_CODES.UPSTREAM_UNAVAILABLE,
    "Yahoo rejected the session rather than the request",
    {
      provider: "yahoo",
      retryable: true,
      cause,
      details: { reason: "session_rejected_twice", status: cause.status },
    },
  );
}

function isoDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("A chart period must be a valid date");
  return Math.floor(date.getTime() / 1_000);
}

export class YahooClient {
  constructor({
    fetchImpl = globalThis.fetch,
    session = null,
    cookieJar = new YahooCookieJar(),
    clock = () => Date.now(),
    origin = API_ORIGIN,
    userAgent = YAHOO_USER_AGENT,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (typeof userAgent !== "string" || !userAgent.trim()) {
      throw new TypeError("userAgent must be a non-empty string");
    }
    this.fetchImpl = fetchImpl;
    this.origin = origin.replace(/\/+$/, "");
    this.userAgent = userAgent;
    this.session = session || new YahooSession({ fetchImpl, cookieJar, clock, userAgent });
    this.pending = new Set();
  }

  close() {
    const closing = new YahooApiError("Yahoo client closed", { endpoint: "close" });
    for (const controller of [...this.pending]) controller.abort(closing);
    this.pending.clear();
    this.session.close?.();
  }

  async quote(symbols, queryOptions = {}, moduleOptions = {}) {
    const scalar = !Array.isArray(symbols);
    const list = (scalar ? [symbols] : symbols)
      .map((symbol) => `${symbol ?? ""}`.trim())
      .filter(Boolean);
    if (!list.length) return scalar ? undefined : [];
    const envelope = await this.#getWithCrumb("/v7/finance/quote", {
      symbols: list.join(","),
      ...queryOptions,
    }, "quoteResponse", moduleOptions);
    const results = (Array.isArray(envelope?.result) ? envelope.result : []).map(shapeQuote);
    return scalar ? results[0] : results;
  }

  async quoteSummary(symbol, queryOptions = {}, moduleOptions = {}) {
    const target = `${symbol ?? ""}`.trim();
    if (!target) throw new TypeError("quoteSummary requires a symbol");
    const modules = Array.isArray(queryOptions.modules) ? queryOptions.modules : [];
    if (!modules.length) throw new TypeError("quoteSummary requires at least one module");
    const envelope = await this.#getWithCrumb(
      `/v10/finance/quoteSummary/${encodeURIComponent(target)}`,
      { modules: modules.join(","), formatted: "false" },
      "quoteSummary",
      moduleOptions,
    );
    const first = Array.isArray(envelope?.result) ? envelope.result[0] : null;
    if (!first) return {};
    return unwrapRaw(first, SUMMARY_DATE_FIELDS);
  }

  async chart(symbol, queryOptions = {}, moduleOptions = {}) {
    const target = `${symbol ?? ""}`.trim();
    if (!target) throw new TypeError("chart requires a symbol");
    const query = {
      interval: queryOptions.interval || "1d",
      includePrePost: queryOptions.includePrePost ? "true" : "false",
      ...(queryOptions.events ? { events: queryOptions.events } : {}),
    };
    if (queryOptions.range) query.range = queryOptions.range;
    else {
      query.period1 = String(isoDay(queryOptions.period1));
      query.period2 = String(isoDay(queryOptions.period2));
    }

    const envelope = await this.#getWithoutCrumb(
      `/v8/finance/chart/${encodeURIComponent(target)}`,
      query,
      "chart",
      moduleOptions,
    );
    const result = Array.isArray(envelope?.result) ? envelope.result[0] : null;
    if (!result) {
      throw new YahooApiError(`Yahoo chart returned no result for ${target}`, { endpoint: "chart" });
    }
    const events = chartEvents(result.events);
    return {
      meta: chartMeta(result.meta),
      quotes: chartRows(result),
      ...(events ? { events } : {}),
    };
  }

  async search(query, queryOptions = {}, moduleOptions = {}) {
    const term = `${query ?? ""}`.trim();
    if (!term) throw new TypeError("search requires a query");
    const payload = await this.#refusingSessionRejection(() => this.#request("/v1/finance/search", {
      q: term,
      quotesCount: String(queryOptions.quotesCount ?? 6),
      newsCount: String(queryOptions.newsCount ?? 0),
      enableFuzzyQuery: "false",
      quotesQueryId: "tss_match_phrase_query",
      multiQuoteQueryId: "multi_quote_single_token_query",
      newsQueryId: "news_cie_vespa",
      enableCb: "true",
      enableNavLinks: "true",
      ...(queryOptions.region ? { region: queryOptions.region } : {}),
      ...(queryOptions.lang ? { lang: queryOptions.lang } : {}),
    }, "search", moduleOptions));
    if (!payload || typeof payload !== "object") return { quotes: [], news: [] };
    return {
      ...payload,
      ...(Array.isArray(payload.news)
        ? {
          news: payload.news.map((article) => coerceDateFields(article, ["providerPublishTime"])),
        }
        : {}),
    };
  }

  async #get(path, query, envelopeKey, moduleOptions) {
    const payload = await this.#request(path, query, envelopeKey, moduleOptions);
    const envelope = payload?.[envelopeKey];
    const failure = envelopeError(envelope, envelopeKey);
    if (failure) throw failure;
    return envelope;
  }

  async #getWithoutCrumb(path, query, envelopeKey, moduleOptions) {
    return this.#refusingSessionRejection(() => this.#get(path, query, envelopeKey, moduleOptions));
  }

  async #refusingSessionRejection(operation) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof YahooApiError) || !CRUMB_REJECTION_STATUSES.has(error.status)) throw error;
      throw sessionRejected(error);
    }
  }

  async #getWithCrumb(path, query, envelopeKey, moduleOptions) {
    const signal = moduleOptions?.fetchOptions?.signal;
    const { crumb, generation } = await this.session.crumbFor({ signal });
    try {
      return await this.#get(path, { ...query, crumb }, envelopeKey, moduleOptions);
    } catch (error) {
      if (!(error instanceof YahooApiError) || !CRUMB_REJECTION_STATUSES.has(error.status)) throw error;
      this.session.invalidate(generation);
      const refreshed = await this.session.crumbFor({ signal });
      try {
        return await this.#get(path, { ...query, crumb: refreshed.crumb }, envelopeKey, moduleOptions);
      } catch (retried) {
        if (!(retried instanceof YahooApiError) || !CRUMB_REJECTION_STATUSES.has(retried.status)) {
          throw retried;
        }
        throw sessionRejected(retried);
      }
    }
  }

  #trackedSignal(callerSignal) {
    const controller = new AbortController();
    if (callerSignal?.aborted) controller.abort(callerSignal.reason);
    const forward = () => controller.abort(callerSignal.reason);
    callerSignal?.addEventListener?.("abort", forward, { once: true });
    this.pending.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        this.pending.delete(controller);
        callerSignal?.removeEventListener?.("abort", forward);
      },
    };
  }

  async #request(path, query, endpoint, moduleOptions) {
    const url = new URL(`${this.origin}${path}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const cookie = this.session.cookieHeaderFor(url);
    const { signal, release } = this.#trackedSignal(moduleOptions?.fetchOptions?.signal);

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": this.userAgent,
          ...(cookie ? { cookie } : {}),
        },
        redirect: "follow",
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      if (error instanceof YahooApiError || error instanceof YahooSessionError) throw error;
      throw new YahooApiError(`Yahoo ${endpoint} request failed`, { endpoint, cause: error });
    } finally {
      release();
    }

    if (!response.ok) {
      let described = null;
      try {
        described = envelopeError((await response.clone().json())?.[endpoint], endpoint);
      } catch {}
      throw new YahooApiError(described?.message || `Yahoo ${endpoint} answered ${response.status}`, {
        status: response.status,
        code: described?.code || null,
        endpoint,
      });
    }

    try {
      return await response.json();
    } catch (error) {
      throw new YahooApiError(`Yahoo ${endpoint} returned a body that is not JSON`, {
        status: response.status,
        endpoint,
        cause: error,
      });
    }
  }
}
