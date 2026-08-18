import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../../../server/contracts/core/constants.js";
import { YahooApiError, YahooClient } from "../../../server/providers/yahoo/yahooClient.js";
import { YAHOO_USER_AGENT } from "../../../server/providers/yahoo/yahooSession.js";

const CRUMB = "crumb-1";

function jsonReply(payload, { status = 200, ok = status < 400 } = {}) {
  const body = JSON.stringify(payload);
  const response = {
    ok,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
  response.clone = () => ({ ...response, clone: response.clone });
  return response;
}

function textReply(body, { status = 200 } = {}) {
  const response = {
    ok: status < 400,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  };
  response.clone = () => ({ ...response, clone: response.clone });
  return response;
}

function clientWith(routes, sessionOverrides = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, options = {}) => {
    const target = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: target, options });
    const route = routes[target.pathname]
      || routes[Object.keys(routes).find((key) => target.pathname.startsWith(key)) || ""];
    if (!route) throw new Error(`unexpected fetch ${target.pathname}`);
    return typeof route === "function" ? route(target, options) : route;
  });
  const session = {
    crumbFor: vi.fn(async () => ({ crumb: CRUMB, generation: 1 })),
    invalidate: vi.fn(),
    cookieHeaderFor: () => "A1=live",
    ...sessionOverrides,
  };
  return { client: new YahooClient({ fetchImpl, session }), calls, fetchImpl, session };
}

const QUOTE_RESULT = {
  symbol: "AAPL",
  regularMarketPrice: 308.26,
  regularMarketTime: 1_786_392_002,
  firstTradeDateMilliseconds: 345_479_400_000,
  startDate: 1_278_979_200,
  expireDate: 1_798_502_400,
  expireIsoDate: "2026-12-29T00:00:00.000Z",
  nameChangeDate: "2026-08-10T00:00:00.000Z",
  regularMarketDayRange: "304.63 - 313.58",
  fiftyTwoWeekRange: "169.21 - 320.0",
  currency: "USD",
};

describe("YahooClient wired to its own session", () => {
  const SEED = "https://finance.yahoo.com/quote/AAPL";
  const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";

  function liveish() {
    const calls = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const href = String(url);
      calls.push({ href, headers: options.headers });
      const document = (setCookie = [], body = "") => ({
        status: 200,
        headers: { get: () => null, getSetCookie: () => setCookie },
        text: async () => body,
      });
      if (href === SEED) return document(["A1=live; Domain=.yahoo.com", "A3=live; Domain=.yahoo.com"]);
      if (href === CRUMB_URL) return document([], "crumb-live");
      if (href.startsWith("https://query1.finance.yahoo.com/v7/finance/quote")) {
        return jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } });
      }
      throw new Error(`unexpected fetch ${href}`);
    });
    return { fetchImpl, calls };
  }

  it("acquires its own crumb and carries its own cookies into the quote", async () => {
    const { fetchImpl, calls } = liveish();
    const client = new YahooClient({ fetchImpl });

    const [quote] = await client.quote(["AAPL"]);
    expect(quote.regularMarketPrice).toBe(308.26);
    expect(quote.regularMarketTime).toEqual(new Date("2026-08-10T20:00:02.000Z"));

    expect(calls.map((call) => call.href.split("?")[0])).toEqual([
      SEED,
      CRUMB_URL,
      "https://query1.finance.yahoo.com/v7/finance/quote",
    ]);
    const quoteCall = calls.at(-1);
    expect(new URL(quoteCall.href).searchParams.get("crumb")).toBe("crumb-live");
    expect(quoteCall.headers.cookie).toBe("A1=live; A3=live");
    expect(quoteCall.headers["user-agent"]).toBe(YAHOO_USER_AGENT);
  });

  it("reuses the crumb and the cookies it already holds on a second call", async () => {
    const { fetchImpl, calls } = liveish();
    const client = new YahooClient({ fetchImpl });
    await client.quote(["AAPL"]);
    await client.quote(["AAPL"]);
    expect(calls.filter((call) => call.href === CRUMB_URL)).toHaveLength(1);
    expect(calls.at(-1).headers.cookie).toBe("A1=live; A3=live");
  });

  it("aborts an API request still in flight when the client closes", async () => {
    let observed = null;
    let releaseQuote;
    const gate = new Promise((resolve) => { releaseQuote = resolve; });
    const fetchImpl = vi.fn(async (url, options) => {
      const href = String(url);
      const doc = (setCookie = [], body = "") => ({
        status: 200, headers: { get: () => null, getSetCookie: () => setCookie }, text: async () => body,
      });
      if (href === SEED) return doc(["A1=live; Domain=.yahoo.com"]);
      if (href === CRUMB_URL) return doc([], "crumb-live");
      observed = options.signal;
      await Promise.race([gate, new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })]);
      return jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } });
    });

    const client = new YahooClient({ fetchImpl });
    const pending = client.quote(["AAPL"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(client.pending.size).toBe(1);

    client.close();
    expect(observed.aborted).toBe(true);
    await expect(pending).rejects.toBeTruthy();
    releaseQuote();
    expect(client.pending.size).toBe(0);
  });

  it("stops tracking a request once it settles", async () => {
    const { fetchImpl } = liveish();
    const client = new YahooClient({ fetchImpl });
    await client.quote(["AAPL"]);
    expect(client.pending.size).toBe(0);
  });

  it("still honours a caller's own abort", async () => {
    const { fetchImpl } = liveish();
    const client = new YahooClient({ fetchImpl });
    const controller = new AbortController();
    controller.abort(new Error("caller left"));
    await expect(
      client.quote(["AAPL"], {}, { fetchOptions: { signal: controller.signal } }),
    ).rejects.toThrow("caller left");
    expect(client.pending.size).toBe(0);
  });

  it("closes the session it built for itself", async () => {
    const { fetchImpl } = liveish();
    const client = new YahooClient({ fetchImpl });
    await client.quote(["AAPL"]);
    client.close();
    expect(client.session.crumb).toBeNull();
    expect(client.session.cookieHeaderFor(CRUMB_URL)).toBe("");
  });
});

describe("YahooClient construction", () => {
  it("rejects a non-function fetch and an empty user agent", () => {
    expect(() => new YahooClient({ fetchImpl: null })).toThrow(TypeError);
    expect(() => new YahooClient({ userAgent: "" })).toThrow(TypeError);
  });
});

describe("YahooClient.quote", () => {
  it("returns an empty list without reaching the network for no symbols", async () => {
    const { client, fetchImpl } = clientWith({});
    await expect(client.quote([])).resolves.toEqual([]);
    await expect(client.quote(["", "  "])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("answers a bare symbol with one quote and an array with an array", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } }),
    });
    const single = await client.quote("AAPL");
    expect(Array.isArray(single)).toBe(false);
    expect(single.regularMarketPrice).toBe(308.26);
    const batch = await client.quote(["AAPL"]);
    expect(Array.isArray(batch)).toBe(true);
    expect(batch).toHaveLength(1);
  });

  it("answers a bare symbol that resolves to nothing with nothing, not an empty array", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({ quoteResponse: { result: [], error: null } }),
    });
    await expect(client.quote("NOPE")).resolves.toBeUndefined();
    await expect(client.quote(["NOPE"])).resolves.toEqual([]);
    await expect(client.quote("  ")).resolves.toBeUndefined();
  });

  it("skips a null entry instead of failing the whole batch", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({
        quoteResponse: { result: [null, QUOTE_RESULT], error: null },
      }),
    });
    const quotes = await client.quote(["BAD", "AAPL"]);
    expect(quotes[0]).toBeNull();
    expect(quotes[1].regularMarketPrice).toBe(308.26);
  });

  it("names the crumb it is retiring, so a stale rejection cannot clear a fresh session", async () => {
    let attempts = 0;
    const invalidate = vi.fn();
    const { client } = clientWith({
      "/v7/finance/quote": () => {
        attempts += 1;
        return attempts === 1
          ? jsonReply({ quoteResponse: { error: "Unauthorized" } }, { status: 403 })
          : jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } });
      },
    }, { invalidate });
    await client.quote(["AAPL"]);
    expect(invalidate).toHaveBeenCalledWith(1);
  });

  it("reports a twice-rejected session as retryable, so it cannot quarantine the provider", async () => {
    for (const status of [401, 403]) {
      const { client } = clientWith({
        "/v7/finance/quote": jsonReply({ quoteResponse: { error: "Unauthorized" } }, { status }),
      });
      const failure = await client.quote(["AAPL"]).catch((error) => error);
      expect(failure.name).toBe("MarketDataError");
      expect(failure.code).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);
      expect(failure.retryable).toBe(true);
      expect(failure.details).toMatchObject({ reason: "session_rejected_twice", status });
    }
  });

  it("reports a rejected session the same way on the routes that carry no crumb", async () => {
    for (const [label, route, call] of [
      ["chart", "/v8/finance/chart/", (client) => client.chart("AAPL", { range: "1d" })],
      ["search", "/v1/finance/search", (client) => client.search("apple")],
    ]) {
      const { client } = clientWith({ [route]: jsonReply({}, { status: 403 }) });
      const failure = await call(client).catch((error) => error);
      expect(failure.code, label).toBe(ERROR_CODES.UPSTREAM_UNAVAILABLE);
      expect(failure.retryable, label).toBe(true);
    }
  });

  it("keeps a non-crumb failure on the retry as itself", async () => {
    let attempts = 0;
    const { client } = clientWith({
      "/v7/finance/quote": () => {
        attempts += 1;
        return attempts === 1
          ? jsonReply({ quoteResponse: {} }, { status: 401 })
          : jsonReply({ quoteResponse: {} }, { status: 500 });
      },
    });
    await expect(client.quote(["AAPL"])).rejects.toMatchObject({
      name: "YahooApiError",
      status: 500,
    });
  });

  it("closes the session it was given", () => {
    const close = vi.fn();
    const { client } = clientWith({}, { close });
    client.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("sends the symbols and the crumb, and accepts a bare symbol", async () => {
    const { client, calls } = clientWith({
      "/v7/finance/quote": jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } }),
    });
    await client.quote("AAPL");
    expect(calls[0].url.searchParams.get("symbols")).toBe("AAPL");
    expect(calls[0].url.searchParams.get("crumb")).toBe(CRUMB);
    expect(calls[0].options.headers.cookie).toBe("A1=live");
  });

  it("reads epoch seconds and epoch milliseconds into the same instant", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } }),
    });
    const [quote] = await client.quote(["AAPL"]);
    expect(quote.regularMarketTime).toEqual(new Date("2026-08-10T20:00:02.000Z"));
    expect(quote.expireDate).toEqual(new Date("2026-12-29T00:00:00.000Z"));
    expect(quote.startDate).toEqual(new Date("2010-07-13T00:00:00.000Z"));
  });

  it("reads a milliseconds field by its declaration, not by its magnitude", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } }),
    });
    const [quote] = await client.quote(["AAPL"]);
    expect(quote.firstTradeDateMilliseconds).toEqual(new Date("1980-12-12T14:30:00.000Z"));
  });

  it("reads an ISO instant and splits a printed range into its bounds", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } }),
    });
    const [quote] = await client.quote(["AAPL"]);
    expect(quote.expireIsoDate).toEqual(new Date("2026-12-29T00:00:00.000Z"));
    expect(quote.nameChangeDate).toEqual(new Date("2026-08-10T00:00:00.000Z"));
    expect(quote.regularMarketDayRange).toEqual({ low: 304.63, high: 313.58 });
    expect(quote.fiftyTwoWeekRange).toEqual({ low: 169.21, high: 320 });
  });

  it("leaves an unparseable range and a missing instant as they arrived", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({
        quoteResponse: {
          result: [{ symbol: "X", regularMarketDayRange: "n/a", regularMarketTime: null }],
          error: null,
        },
      }),
    });
    const [quote] = await client.quote(["X"]);
    expect(quote.regularMarketDayRange).toBe("n/a");
    expect(quote.regularMarketTime).toBeNull();
  });

  it("refuses a boolean where an instant belongs rather than publishing 1970", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({
        quoteResponse: { result: [{ symbol: "X", regularMarketTime: true }], error: null },
      }),
    });
    const [quote] = await client.quote(["X"]);
    expect(quote.regularMarketTime).toBe(true);
  });

  it("surfaces an envelope error as a client error", async () => {
    const { client } = clientWith({
      "/v7/finance/quote": jsonReply({
        quoteResponse: { result: null, error: { code: "Bad Request", description: "invalid crumb" } },
      }),
    });
    await expect(client.quote(["AAPL"])).rejects.toMatchObject({
      name: "YahooApiError",
      code: "Bad Request",
      endpoint: "quoteResponse",
    });
  });

  it("refreshes the crumb once when Yahoo rejects the first attempt", async () => {
    let attempts = 0;
    const { client, session } = clientWith({
      "/v7/finance/quote": () => {
        attempts += 1;
        return attempts === 1
          ? jsonReply({ quoteResponse: { error: "Unauthorized" } }, { status: 401 })
          : jsonReply({ quoteResponse: { result: [QUOTE_RESULT], error: null } });
      },
    });
    const quotes = await client.quote(["AAPL"]);
    expect(quotes).toHaveLength(1);
    expect(session.invalidate).toHaveBeenCalledTimes(1);
    expect(session.crumbFor).toHaveBeenCalledTimes(2);
  });

  it("does not refresh the crumb for a failure that is not a rejection of it", async () => {
    const { client, session } = clientWith({
      "/v7/finance/quote": jsonReply({ quoteResponse: {} }, { status: 500 }),
    });
    await expect(client.quote(["AAPL"])).rejects.toMatchObject({ status: 500 });
    expect(session.invalidate).not.toHaveBeenCalled();
  });
});

describe("YahooClient.quoteSummary", () => {
  const SUMMARY = {
    quoteSummary: {
      result: [{
        price: { regularMarketPrice: { raw: 308.26, fmt: "308.26" }, regularMarketTime: 1_786_392_002 },
        defaultKeyStatistics: { lastSplitDate: 1_598_832_000, sharesShortPriorMonth: 100_000 },
        topHoldings: { holdings: [{ symbol: "NVDA", holdingPercent: { raw: 0.075, fmt: "7.50%" } }] },
      }],
      error: null,
    },
  };

  it("requires a symbol and at least one module", async () => {
    const { client } = clientWith({});
    await expect(client.quoteSummary("", { modules: ["price"] })).rejects.toThrow(TypeError);
    await expect(client.quoteSummary("AAPL", { modules: [] })).rejects.toThrow(TypeError);
  });

  it("unwraps every raw wrapper, including inside a nested holdings array", async () => {
    const { client } = clientWith({ "/v10/finance/quoteSummary/": jsonReply(SUMMARY) });
    const summary = await client.quoteSummary("SPY", { modules: ["price", "topHoldings"] });
    expect(summary.price.regularMarketPrice).toBe(308.26);
    expect(summary.topHoldings.holdings[0]).toEqual({ symbol: "NVDA", holdingPercent: 0.075 });
  });

  it("reads the instants the details path depends on", async () => {
    const { client } = clientWith({ "/v10/finance/quoteSummary/": jsonReply(SUMMARY) });
    const summary = await client.quoteSummary("AAPL", { modules: ["price"] });
    expect(summary.price.regularMarketTime).toEqual(new Date("2026-08-10T20:00:02.000Z"));
    expect(summary.defaultKeyStatistics.lastSplitDate).toEqual(new Date("2020-08-31T00:00:00.000Z"));
    expect(summary.defaultKeyStatistics.sharesShortPriorMonth).toBe(100_000);
  });

  it("sends the modules joined and asks for unformatted values", async () => {
    const { client, calls } = clientWith({ "/v10/finance/quoteSummary/": jsonReply(SUMMARY) });
    await client.quoteSummary("AAPL", { modules: ["price", "summaryDetail"] });
    expect(calls[0].url.pathname).toBe("/v10/finance/quoteSummary/AAPL");
    expect(calls[0].url.searchParams.get("modules")).toBe("price,summaryDetail");
    expect(calls[0].url.searchParams.get("formatted")).toBe("false");
  });

  it("escapes a symbol that would otherwise change the path", async () => {
    const { client, calls } = clientWith({ "/v10/finance/quoteSummary/": jsonReply(SUMMARY) });
    await client.quoteSummary("BRK/B", { modules: ["price"] });
    expect(calls[0].url.pathname).toBe("/v10/finance/quoteSummary/BRK%2FB");
  });

  it("refuses a payload nested past the depth it will walk", async () => {
    let deep = { value: 1 };
    for (let level = 0; level < 40; level += 1) deep = { nested: deep };
    const { client } = clientWith({
      "/v10/finance/quoteSummary/": jsonReply({
        quoteSummary: { result: [{ price: deep }], error: null },
      }),
    });
    await expect(client.quoteSummary("AAPL", { modules: ["price"] })).rejects.toMatchObject({
      name: "YahooApiError",
      endpoint: "quoteSummary",
    });
  });

  it("walks a payload nested inside that depth", async () => {
    let deep = { value: 1 };
    for (let level = 0; level < 8; level += 1) deep = { nested: deep };
    const { client } = clientWith({
      "/v10/finance/quoteSummary/": jsonReply({
        quoteSummary: { result: [{ price: deep }], error: null },
      }),
    });
    await expect(client.quoteSummary("AAPL", { modules: ["price"] })).resolves.toBeTruthy();
  });

  it("answers with nothing when Yahoo returns no result", async () => {
    const { client } = clientWith({
      "/v10/finance/quoteSummary/": jsonReply({ quoteSummary: { result: [], error: null } }),
    });
    await expect(client.quoteSummary("AAPL", { modules: ["price"] })).resolves.toEqual({});
  });
});

describe("YahooClient.chart", () => {
  const CHART = {
    chart: {
      result: [{
        meta: {
          currency: "USD",
          symbol: "AAPL",
          firstTradeDate: 345_479_400,
          regularMarketTime: 1_786_392_002,
          currentTradingPeriod: {
            regular: { timezone: "EDT", start: 1_786_368_600, end: 1_786_392_000, gmtoffset: -14_400 },
          },
        },
        timestamp: [1_735_914_600, 1_736_001_000],
        events: {
          dividends: { "1739197800": { amount: 0.25, date: 1_739_197_800 } },
          splits: { "1598832000": { date: 1_598_832_000, numerator: 4, denominator: 1, splitRatio: "4:1" } },
        },
        indicators: {
          quote: [{
            open: [243.36, 244.1],
            high: [244.18, 245.2],
            low: [241.89, 243.0],
            close: [243.36, 244.9],
            volume: [40_244_100, 38_000_000],
          }],
          adjclose: [{ adjclose: [241.815, 243.34] }],
        },
      }],
      error: null,
    },
  };

  it("requires a symbol", async () => {
    const { client } = clientWith({});
    await expect(client.chart("", { range: "1d" })).rejects.toThrow(TypeError);
  });

  it("pivots the parallel indicator columns into one row per bar", async () => {
    const { client } = clientWith({ "/v8/finance/chart/": jsonReply(CHART) });
    const chart = await client.chart("AAPL", { range: "6m", interval: "1d" });
    expect(chart.quotes).toEqual([
      {
        date: new Date("2025-01-03T14:30:00.000Z"),
        high: 244.18,
        volume: 40_244_100,
        open: 243.36,
        low: 241.89,
        close: 243.36,
        adjclose: 241.815,
      },
      {
        date: new Date("2025-01-04T14:30:00.000Z"),
        high: 245.2,
        volume: 38_000_000,
        open: 244.1,
        low: 243,
        close: 244.9,
        adjclose: 243.34,
      },
    ]);
  });

  it("omits adjclose entirely when the payload carries none", async () => {
    const withoutAdjusted = structuredClone(CHART);
    delete withoutAdjusted.chart.result[0].indicators.adjclose;
    const { client } = clientWith({ "/v8/finance/chart/": jsonReply(withoutAdjusted) });
    const chart = await client.chart("^GSPC", { range: "6m", interval: "1d" });
    expect(Object.hasOwn(chart.quotes[0], "adjclose")).toBe(false);
  });

  it("holds a gap in a column open as null rather than shifting the bars", async () => {
    const gapped = structuredClone(CHART);
    gapped.chart.result[0].indicators.quote[0].close = [243.36, null];
    gapped.chart.result[0].indicators.quote[0].volume = [40_244_100];
    const { client } = clientWith({ "/v8/finance/chart/": jsonReply(gapped) });
    const chart = await client.chart("AAPL", { range: "6m", interval: "1d" });
    expect(chart.quotes).toHaveLength(2);
    expect(chart.quotes[1].close).toBeNull();
    expect(chart.quotes[1].volume).toBeNull();
  });

  it("reads the meta instants and the nested trading period", async () => {
    const { client } = clientWith({ "/v8/finance/chart/": jsonReply(CHART) });
    const { meta } = await client.chart("AAPL", { range: "6m", interval: "1d" });
    expect(meta.firstTradeDate).toEqual(new Date(345_479_400_000));
    expect(meta.regularMarketTime).toEqual(new Date("2026-08-10T20:00:02.000Z"));
    expect(meta.currentTradingPeriod.regular.start).toEqual(new Date("2026-08-10T13:30:00.000Z"));
    expect(meta.currentTradingPeriod.regular.timezone).toBe("EDT");
    expect(meta.currency).toBe("USD");
  });

  it("turns the keyed event maps into ordered arrays", async () => {
    const { client } = clientWith({ "/v8/finance/chart/": jsonReply(CHART) });
    const { events } = await client.chart("AAPL", { range: "1y", interval: "1d" });
    expect(events.dividends).toEqual([{ amount: 0.25, date: new Date("2025-02-10T14:30:00.000Z") }]);
    expect(events.splits).toEqual([{
      date: new Date("2020-08-31T00:00:00.000Z"),
      numerator: 4,
      denominator: 1,
      splitRatio: "4:1",
    }]);
  });

  it("carries no events key when the window holds none", async () => {
    const quiet = structuredClone(CHART);
    delete quiet.chart.result[0].events;
    const { client } = clientWith({ "/v8/finance/chart/": jsonReply(quiet) });
    expect(Object.hasOwn(await client.chart("AAPL", { range: "5d" }), "events")).toBe(false);
  });

  it("sends a period pair as epoch seconds and prefers an explicit range", async () => {
    const { client, calls } = clientWith({ "/v8/finance/chart/": jsonReply(CHART) });
    await client.chart("AAPL", {
      period1: new Date("2025-01-01T00:00:00.000Z"),
      period2: new Date("2026-01-01T00:00:00.000Z"),
      interval: "1d",
      includePrePost: true,
      events: "div|split",
    });
    expect(calls[0].url.searchParams.get("period1")).toBe("1735689600");
    expect(calls[0].url.searchParams.get("period2")).toBe("1767225600");
    expect(calls[0].url.searchParams.get("includePrePost")).toBe("true");
    expect(calls[0].url.searchParams.get("events")).toBe("div|split");

    await client.chart("AAPL", { range: "6m", interval: "1d" });
    expect(calls[1].url.searchParams.get("range")).toBe("6m");
    expect(calls[1].url.searchParams.has("period1")).toBe(false);
  });

  it("refuses a period that is not a date", async () => {
    const { client } = clientWith({ "/v8/finance/chart/": jsonReply(CHART) });
    await expect(client.chart("AAPL", { period1: "nonsense", period2: new Date() })).rejects.toThrow(TypeError);
  });

  it("reaches the chart without a crumb", async () => {
    const { client, calls, session } = clientWith({ "/v8/finance/chart/": jsonReply(CHART) });
    await client.chart("AAPL", { range: "1d" });
    expect(session.crumbFor).not.toHaveBeenCalled();
    expect(calls[0].url.searchParams.has("crumb")).toBe(false);
  });

  it("reports an empty result set rather than returning a shapeless chart", async () => {
    const { client } = clientWith({
      "/v8/finance/chart/": jsonReply({ chart: { result: [], error: null } }),
    });
    await expect(client.chart("NOPE", { range: "1d" })).rejects.toBeInstanceOf(YahooApiError);
  });
});

describe("YahooClient.search", () => {
  const SEARCH = {
    quotes: [{ symbol: "AAPL", isYahooFinance: true, quoteType: "EQUITY" }],
    news: [{ uuid: "n1", title: "Apple", providerPublishTime: 1_786_392_002 }],
  };

  it("requires a query", async () => {
    const { client } = clientWith({});
    await expect(client.search("  ")).rejects.toThrow(TypeError);
  });

  it("reads the publication instant of every article", async () => {
    const { client } = clientWith({ "/v1/finance/search": jsonReply(SEARCH) });
    const payload = await client.search("apple", { quotesCount: 6, newsCount: 4 });
    expect(payload.news[0].providerPublishTime).toEqual(new Date("2026-08-10T20:00:02.000Z"));
    expect(payload.quotes[0].symbol).toBe("AAPL");
  });

  it("sends the counts, the locale and the query identifiers Yahoo expects", async () => {
    const { client, calls } = clientWith({ "/v1/finance/search": jsonReply(SEARCH) });
    await client.search("AAPL", { quotesCount: 0, newsCount: 10, region: "US", lang: "en-US" });
    const query = calls[0].url.searchParams;
    expect(query.get("q")).toBe("AAPL");
    expect(query.get("quotesCount")).toBe("0");
    expect(query.get("newsCount")).toBe("10");
    expect(query.get("quotesQueryId")).toBe("tss_match_phrase_query");
    expect(query.get("region")).toBe("US");
    expect(query.get("lang")).toBe("en-US");
  });

  it("answers with empty collections when Yahoo returns nothing usable", async () => {
    const { client } = clientWith({ "/v1/finance/search": jsonReply(null) });
    await expect(client.search("apple")).resolves.toEqual({ quotes: [], news: [] });
  });

  it("reaches search without a crumb", async () => {
    const { client, session } = clientWith({ "/v1/finance/search": jsonReply(SEARCH) });
    await client.search("apple");
    expect(session.crumbFor).not.toHaveBeenCalled();
  });
});

describe("YahooClient transport failures", () => {
  it("reports a non-JSON body as such", async () => {
    const { client } = clientWith({ "/v1/finance/search": textReply("<html>maintenance</html>") });
    await expect(client.search("apple")).rejects.toMatchObject({
      name: "YahooApiError",
      endpoint: "search",
    });
  });

  it("carries the HTTP status through", async () => {
    const { client } = clientWith({ "/v1/finance/search": textReply("Too Many Requests", { status: 429 }) });
    await expect(client.search("apple")).rejects.toMatchObject({ status: 429 });
  });

  it("prefers the described envelope error over the bare status", async () => {
    const { client } = clientWith({
      "/v8/finance/chart/": jsonReply(
        { chart: { error: { code: "Not Found", description: "No data found, symbol may be delisted" } } },
        { status: 404 },
      ),
    });
    await expect(client.chart("NOPE", { range: "1d" })).rejects.toMatchObject({
      status: 404,
      code: "Not Found",
    });
  });

  it("wraps a transport failure but lets an abort travel untouched", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { client: aborting } = clientWith({
      "/v1/finance/search": () => Promise.reject(abort),
    });
    await expect(aborting.search("apple")).rejects.toBe(abort);

    const { client: broken } = clientWith({
      "/v1/finance/search": () => Promise.reject(new Error("socket hang up")),
    });
    await expect(broken.search("apple")).rejects.toMatchObject({ name: "YahooApiError" });
  });
});
