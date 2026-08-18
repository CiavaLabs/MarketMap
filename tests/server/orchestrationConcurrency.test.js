import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "../../server/orchestration/CircuitBreaker.js";
import { SingleFlight } from "../../server/orchestration/SingleFlight.js";
import { RequestQuota } from "../../server/http/RequestQuota.js";
import { YahooCookieJar } from "../../server/providers/yahoo/yahooCookieJar.js";
import { YahooSession } from "../../server/providers/yahoo/yahooSession.js";

const SEED = "https://finance.yahoo.com/quote/AAPL";
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";

function document(setCookie = [], body = "", status = 200) {
  return {
    status,
    headers: { get: () => null, getSetCookie: () => setCookie },
    text: async () => body,
  };
}

describe("a breaker under simultaneous callers", () => {
  function halfOpen() {
    const clock = { now: 0 };
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      clock: () => clock.now,
    });
    breaker.recordFailure();
    clock.now = 200;
    return { breaker, clock };
  }

  it("admits exactly one probe out of a burst and refuses the rest", async () => {
    const { breaker } = halfOpen();
    let admitted = 0;
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => breaker
      .execute(async () => {
        admitted += 1;
        await Promise.resolve();
        return "served";
      })
      .catch(() => "refused")));

    expect(admitted).toBe(1);
    expect(outcomes.filter((outcome) => outcome === "served")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(49);
    expect(breaker.state).toBe("closed");
    expect(breaker.probeInFlight).toBe(false);
  });

  it("reopens rather than sticking half-open when the one probe fails", async () => {
    const { breaker, clock } = halfOpen();
    let admitted = 0;
    await Promise.all(Array.from({ length: 20 }, () => breaker
      .execute(async () => {
        admitted += 1;
        await Promise.resolve();
        throw new Error("still down");
      })
      .catch(() => {})));

    expect(admitted).toBe(1);
    expect(breaker.state).toBe("open");
    expect(breaker.probeInFlight).toBe(false);
    clock.now = 1_000_000;
    expect(breaker.canRequest()).toBe(true);
  });
});

describe("single flight under a burst", () => {
  it("runs one operation per key and releases it afterwards", async () => {
    const flight = new SingleFlight();
    let runs = 0;
    const results = await Promise.all(Array.from({ length: 40 }, () => flight.run("quote", async () => {
      runs += 1;
      await Promise.resolve();
      return runs;
    })));

    expect(runs).toBe(1);
    expect(new Set(results).size).toBe(1);
    expect(flight.size).toBe(0);
  });

  it("does not cache a rejection, and the key works again after one", async () => {
    const flight = new SingleFlight();
    let attempts = 0;
    await Promise.all(Array.from({ length: 10 }, () => flight
      .run("quote", async () => {
        attempts += 1;
        throw new Error("upstream");
      })
      .catch(() => {})));

    expect(attempts).toBe(1);
    expect(flight.size).toBe(0);
    await expect(flight.run("quote", async () => "recovered")).resolves.toBe("recovered");
  });
});

describe("a quota under interleaved charges and refunds", () => {
  it("never mints a token, however the two phases interleave", async () => {
    const quota = new RequestQuota({ limit: 100, windowMs: 600_000, clock: () => 0 });
    await Promise.all(Array.from({ length: 200 }, () => (async () => {
      if (!quota.consume("client", 1).allowed) return;
      await Promise.resolve();
      if (!quota.consume("client", 3).allowed) quota.refund("client", 1);
    })()));

    const bucket = quota.buckets.get("client");
    expect(bucket.tokens).toBeGreaterThanOrEqual(0);
    expect(bucket.tokens).toBeLessThanOrEqual(100);
    expect(quota.consume("client", 1).allowed).toBe(false);
  });
});

describe("a Yahoo session under a cold-start stampede", () => {
  function session({ failFirstCrumb = false } = {}) {
    let handshakes = 0;
    let shouldFail = failFirstCrumb;
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href === SEED) return document([`A1=gen${handshakes + 1}; Domain=.yahoo.com`]);
      if (href === CRUMB_URL) {
        handshakes += 1;
        await Promise.resolve();
        if (shouldFail) {
          shouldFail = false;
          return document([], "Too Many Requests", 429);
        }
        return document([], `crumb-${handshakes}`);
      }
      throw new Error(`unexpected fetch ${href}`);
    };
    return {
      handshakeCount: () => handshakes,
      session: new YahooSession({ fetchImpl, cookieJar: new YahooCookieJar() }),
    };
  }

  it("collapses a forty-caller cold start onto one handshake", async () => {
    const { session: live, handshakeCount } = session();
    const crumbs = await Promise.all(Array.from({ length: 40 }, () => live.crumbFor({})));

    expect(handshakeCount()).toBe(1);
    expect(new Set(crumbs.map((entry) => entry.crumb)).size).toBe(1);
    expect(new Set(crumbs.map((entry) => entry.generation)).size).toBe(1);
    expect(live.cookieHeaderFor(CRUMB_URL)).toContain("A1=gen1");
  });

  it("fails every waiter together, then recovers on the next burst", async () => {
    const { session: live, handshakeCount } = session({ failFirstCrumb: true });
    const failed = await Promise.allSettled(Array.from({ length: 30 }, () => live.crumbFor({})));
    expect(failed.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(handshakeCount()).toBe(1);

    const recovered = await Promise.all(Array.from({ length: 30 }, () => live.crumbFor({})));
    expect(handshakeCount()).toBe(2);
    expect(new Set(recovered.map((entry) => entry.generation)).size).toBe(1);
    expect(live.cookieHeaderFor(CRUMB_URL)).toContain("A1=gen2");
  });

  it("mints one replacement when every caller retires the same generation at once", async () => {
    const { session: live, handshakeCount } = session();
    const { generation } = await live.crumbFor({});

    const refreshed = await Promise.all(Array.from({ length: 25 }, () => (async () => {
      live.invalidate(generation);
      return live.crumbFor({});
    })()));

    expect(handshakeCount()).toBe(2);
    expect(new Set(refreshed.map((entry) => entry.generation)).size).toBe(1);
    expect(live.cookieHeaderFor(CRUMB_URL)).toContain("A1=gen2");
  });
});
