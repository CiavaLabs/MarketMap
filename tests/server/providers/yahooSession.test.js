import { describe, expect, it, vi } from "vitest";
import { YahooCookieJar } from "../../../server/providers/yahoo/yahooCookieJar.js";
import {
  YAHOO_USER_AGENT,
  YahooSession,
  YahooSessionError,
} from "../../../server/providers/yahoo/yahooSession.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");
const SEED = "https://finance.yahoo.com/quote/AAPL";
const CONSENT = "https://guce.yahoo.com/consent?brandType=nonEu&gcrumb=abc";
const COLLECT = "https://consent.yahoo.com/v2/collectConsent?sessionId=cc-1";
const COPY = "https://guce.yahoo.com/copyConsent?sessionId=cc-1";
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";

const CONSENT_FORM = `
  <form>
    <input type="hidden" name="csrfToken" value="tok&#x26;en">
    <input type="hidden" name="sessionId" value="cc-1">
  </form>`;

function reply({ status = 200, location = null, setCookie = [], body = "" } = {}) {
  return {
    status,
    headers: {
      get: (name) => (name.toLowerCase() === "location" ? location : null),
      getSetCookie: () => setCookie,
    },
    text: async () => body,
  };
}

function consentFlow({ crumbStatus = 200, crumbBody = "crumb-1" } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", headers: options.headers, body: options.body });
    if (href === SEED) {
      return reply({ status: 307, location: CONSENT, setCookie: ["dflow=1; Domain=.yahoo.com"] });
    }
    if (href === CONSENT) return reply({ status: 302, location: COLLECT });
    if (href === COLLECT && options.method === "POST") {
      return reply({ status: 302, location: COPY, setCookie: ["CFC=ok; Domain=.yahoo.com"] });
    }
    if (href === COLLECT) return reply({ status: 200, body: CONSENT_FORM });
    if (href === COPY) {
      return reply({
        status: 302,
        location: `${SEED}?guccounter=1`,
        setCookie: ["A1=live; Domain=.yahoo.com", "A3=live; Domain=.yahoo.com"],
      });
    }
    if (href === `${SEED}?guccounter=1`) return reply({ status: 200 });
    if (href === CRUMB_URL) return reply({ status: crumbStatus, body: crumbBody });
    throw new Error(`unexpected fetch ${href}`);
  });
  return { fetchImpl, calls };
}

function sessionWith(fetchImpl, overrides = {}) {
  return new YahooSession({
    fetchImpl,
    cookieJar: new YahooCookieJar({ clock: () => NOW }),
    clock: () => NOW,
    ...overrides,
  });
}

describe("YahooSession", () => {
  it("rejects a non-function fetch, a non-positive TTL and an empty user agent", () => {
    expect(() => new YahooSession({ fetchImpl: null })).toThrow(TypeError);
    expect(() => new YahooSession({ fetchImpl: vi.fn(), crumbTtlMs: 0 })).toThrow(TypeError);
    expect(() => new YahooSession({ fetchImpl: vi.fn(), userAgent: "  " })).toThrow(TypeError);
  });

  it("walks the consent redirects, submits the form and returns the crumb", async () => {
    const { fetchImpl, calls } = consentFlow();
    const session = sessionWith(fetchImpl);
    await expect(session.crumbFor({})).resolves.toMatchObject({ crumb: "crumb-1" });
    expect(calls.map((call) => `${call.method} ${call.href.split("?")[0]}`)).toEqual([
      "GET https://finance.yahoo.com/quote/AAPL",
      "GET https://guce.yahoo.com/consent",
      "GET https://consent.yahoo.com/v2/collectConsent",
      "POST https://consent.yahoo.com/v2/collectConsent",
      "GET https://guce.yahoo.com/copyConsent",
      "GET https://finance.yahoo.com/quote/AAPL",
      "GET https://query1.finance.yahoo.com/v1/test/getcrumb",
    ]);
  });

  it("submits the consent form fields with their entities decoded and both agreements", async () => {
    const { fetchImpl, calls } = consentFlow();
    await sessionWith(fetchImpl).crumbFor({});
    const submission = calls.find((call) => call.method === "POST");
    expect(submission.body).toBe("csrfToken=tok%26en&sessionId=cc-1&agree=agree&agree=agree");
    expect(submission.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("reads the consent inputs however the markup orders and quotes their attributes", async () => {
    const forms = [
      `<input value="tok&#x26;en" name="csrfToken" type="hidden"><input type="hidden" name="sessionId" value="cc-1">`,
      `<input type='hidden' name='csrfToken' value='tok&#x26;en' /><input type='hidden' name='sessionId' value='cc-1' />`,
      `<input  type = "hidden"  data-x="1"  name = "csrfToken"  value = "tok&#x26;en" >`
        + `<input type=hidden name=sessionId value=cc-1>`,
    ];
    for (const form of forms) {
      const { fetchImpl, calls } = consentFlow();
      const shaped = vi.fn(async (url, options) => {
        const response = await fetchImpl(url, options);
        return String(url) === COLLECT && options.method !== "POST"
          ? { ...response, text: async () => form }
          : response;
      });
      await sessionWith(shaped).crumbFor({});
      expect(calls.find((call) => call.method === "POST").body)
        .toBe("csrfToken=tok%26en&sessionId=cc-1&agree=agree&agree=agree");
    }
  });

  it("submits only the agreements when the form carries no hidden inputs", async () => {
    const { fetchImpl, calls } = consentFlow();
    const empty = vi.fn(async (url, options) => {
      const response = await fetchImpl(url, options);
      return String(url) === COLLECT && options.method !== "POST"
        ? { ...response, text: async () => "<form><input type=\"submit\" value=\"go\"></form>" }
        : response;
    });
    await sessionWith(empty).crumbFor({});
    expect(calls.find((call) => call.method === "POST").body).toBe("agree=agree&agree=agree");
  });

  it("sends the honest user agent and carries the accumulated cookies into the crumb call", async () => {
    const { fetchImpl, calls } = consentFlow();
    await sessionWith(fetchImpl).crumbFor({});
    const crumbCall = calls.at(-1);
    expect(crumbCall.headers["user-agent"]).toBe(YAHOO_USER_AGENT);
    expect(YAHOO_USER_AGENT).toMatch(/^Mozilla\/5\.0 \(compatible; \S+; \+https?:\/\/\S+\)$/);
    expect(YAHOO_USER_AGENT).not.toMatch(/Chrome|Safari|Firefox|AppleWebKit/);
    expect(crumbCall.headers.accept).toBe("*/*");
    expect(crumbCall.headers.cookie).toBe("dflow=1; CFC=ok; A1=live; A3=live");
    expect(crumbCall.headers.referer).toBe(SEED);
  });

  it("lets a caller override the user agent", async () => {
    const { fetchImpl, calls } = consentFlow();
    await sessionWith(fetchImpl, { userAgent: "Mozilla/5.0 (compatible; host/1.0)" }).crumbFor({});
    expect(calls.at(-1).headers["user-agent"]).toBe("Mozilla/5.0 (compatible; host/1.0)");
  });

  it("reuses a live crumb and re-runs the handshake once it expires", async () => {
    let now = NOW;
    const { fetchImpl } = consentFlow();
    const session = new YahooSession({
      fetchImpl,
      cookieJar: new YahooCookieJar({ clock: () => now }),
      clock: () => now,
      crumbTtlMs: 1_000,
    });
    await session.crumbFor({});
    const afterFirst = fetchImpl.mock.calls.length;
    await session.crumbFor({});
    expect(fetchImpl.mock.calls.length).toBe(afterFirst);
    now += 1_001;
    await session.crumbFor({});
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it("collapses concurrent callers onto one handshake", async () => {
    const { fetchImpl } = consentFlow();
    const session = sessionWith(fetchImpl);
    const [first, second, third] = await Promise.all([
      session.crumbFor({}),
      session.crumbFor({}),
      session.crumbFor({}),
    ]);
    expect([first, second, third].map((entry) => entry.crumb)).toEqual(["crumb-1", "crumb-1", "crumb-1"]);
    expect(new Set([first, second, third].map((entry) => entry.generation)).size).toBe(1);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url) === CRUMB_URL)).toHaveLength(1);
  });

  it("retries the handshake after a failure rather than caching the rejection", async () => {
    let attempt = 0;
    const { fetchImpl } = consentFlow();
    const flaky = vi.fn(async (url, options) => {
      if (String(url) === CRUMB_URL && attempt++ === 0) return reply({ status: 429, body: "Too Many Requests" });
      return fetchImpl(url, options);
    });
    const session = sessionWith(flaky);
    await expect(session.crumbFor({})).rejects.toMatchObject({ stage: "getcrumb", status: 429 });
    await expect(session.crumbFor({})).resolves.toMatchObject({ crumb: "crumb-1" });
  });

  it("reports a refused crumb as a session error carrying the status", async () => {
    const { fetchImpl } = consentFlow({ crumbStatus: 429 });
    await expect(sessionWith(fetchImpl).crumbFor({})).rejects.toBeInstanceOf(YahooSessionError);
  });

  it("refuses a crumb body that could not be one", async () => {
    for (const crumbBody of ["", "   ", "<html>nope</html>", "x".repeat(65)]) {
      const { fetchImpl } = consentFlow({ crumbBody });
      await expect(sessionWith(fetchImpl).crumbFor({})).rejects.toMatchObject({ stage: "getcrumb" });
    }
  });

  it("skips the consent flow when the seed page does not redirect to it", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const href = String(url);
      if (href === SEED) return reply({ status: 200, setCookie: ["A1=direct; Domain=.yahoo.com"] });
      if (href === CRUMB_URL) return reply({ status: 200, body: "direct-crumb" });
      throw new Error(`unexpected fetch ${href}`);
    });
    await expect(sessionWith(fetchImpl).crumbFor({})).resolves.toMatchObject({ crumb: "direct-crumb" });
  });

  it("follows a redirect that stays inside Yahoo, such as a regional one", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const href = String(url);
      if (href === SEED) return reply({ status: 301, location: "https://uk.finance.yahoo.com/quote/AAPL" });
      if (href === "https://uk.finance.yahoo.com/quote/AAPL") {
        return reply({ status: 200, setCookie: ["A1=regional; Domain=.yahoo.com"] });
      }
      if (href === CRUMB_URL) return reply({ status: 200, body: "regional-crumb" });
      throw new Error(`unexpected fetch ${href}`);
    });
    const session = sessionWith(fetchImpl);
    await expect(session.crumbFor({})).resolves.toMatchObject({ crumb: "regional-crumb" });
    expect(session.cookieHeaderFor(CRUMB_URL)).toContain("A1=regional");
  });

  it("refuses a redirect that leaves Yahoo, however the host is disguised", async () => {
    for (const location of [
      "https://guce.yahoo.com@attacker.example/consent",
      "https://yahoo.com.attacker.example/consent",
      "http://guce.yahoo.com/consent",
    ]) {
      const fetchImpl = vi.fn(async (url) => {
        if (String(url) === SEED) return reply({ status: 307, location });
        throw new Error(`followed ${String(url)}`);
      });
      await expect(sessionWith(fetchImpl).crumbFor({})).rejects.toMatchObject({ stage: "seed" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("never sends a cookie to a host outside Yahoo", () => {
    const jar = new YahooCookieJar({ clock: () => NOW });
    jar.storeFromResponse(
      { headers: { getSetCookie: () => ["S=secret; Domain=evil.example"] } },
      "https://guce.yahoo.com/consent",
    );
    expect(jar.headerFor("https://api.evil.example/collect")).toBe("");
    expect(jar.size).toBe(0);
  });

  it("refuses a consent gateway that redirects somewhere other than the collection form", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const href = String(url);
      if (href === SEED) return reply({ status: 307, location: CONSENT });
      if (href === CONSENT) return reply({ status: 302, location: "https://guce.yahoo.com/somewhereElse" });
      throw new Error(`unexpected fetch ${href}`);
    });
    await expect(sessionWith(fetchImpl).crumbFor({})).rejects.toMatchObject({ stage: "consent" });
  });

  it("refuses a consent submission that answers without a redirect", async () => {
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href === SEED) return reply({ status: 307, location: CONSENT });
      if (href === CONSENT) return reply({ status: 302, location: COLLECT });
      if (href === COLLECT && options.method === "POST") return reply({ status: 200 });
      if (href === COLLECT) return reply({ status: 200, body: CONSENT_FORM });
      throw new Error(`unexpected fetch ${href}`);
    });
    await expect(sessionWith(fetchImpl).crumbFor({})).rejects.toMatchObject({ stage: "consent" });
  });

  it("stops a consent loop at the hop limit instead of recursing forever", async () => {
    const fetchImpl = vi.fn(async (url, options = {}) => {
      const href = String(url);
      if (href.startsWith("https://finance.yahoo.com/quote/AAPL")) {
        return reply({ status: 307, location: CONSENT });
      }
      if (href === CONSENT) return reply({ status: 302, location: COLLECT });
      if (href === COLLECT && options.method === "POST") return reply({ status: 302, location: COPY });
      if (href === COLLECT) return reply({ status: 200, body: CONSENT_FORM });
      if (href === COPY) return reply({ status: 302, location: `${SEED}?guccounter=1` });
      throw new Error(`unexpected fetch ${href}`);
    });
    await expect(sessionWith(fetchImpl).crumbFor({})).rejects.toMatchObject({ stage: "consent" });
  });

  it("aborts a handshake still in flight when the session closes", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { fetchImpl } = consentFlow();
    const gated = vi.fn(async (url, options) => {
      if (options.signal?.aborted) throw options.signal.reason;
      await Promise.race([gate, new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
      })]);
      return fetchImpl(url, options);
    });
    const session = sessionWith(gated);
    const pending = session.crumbFor({});
    await Promise.resolve();
    session.close();
    await expect(pending).rejects.toMatchObject({ stage: "close" });
    release();
    expect(session.crumb).toBeNull();
    expect(session.cookieHeaderFor(CRUMB_URL)).toBe("");
  });

  it("closes cleanly with nothing in flight", () => {
    const { fetchImpl } = consentFlow();
    const session = sessionWith(fetchImpl);
    expect(() => session.close()).not.toThrow();
  });

  it("drops the crumb and every cookie on invalidate", async () => {
    const { fetchImpl } = consentFlow();
    const session = sessionWith(fetchImpl);
    await session.crumbFor({});
    expect(session.cookieHeaderFor(CRUMB_URL)).not.toBe("");
    expect(session.invalidate()).toBe(true);
    expect(session.crumb).toBeNull();
    expect(session.cookieHeaderFor(CRUMB_URL)).toBe("");
  });

  it("retires a session by generation, so an identical crumb string cannot confuse it", async () => {
    const { fetchImpl } = consentFlow();
    const session = sessionWith(fetchImpl);
    const first = await session.crumbFor({});
    expect(session.invalidate(first.generation)).toBe(true);

    const second = await session.crumbFor({});
    expect(second.crumb).toBe(first.crumb);
    expect(second.generation).toBe(first.generation + 1);
    expect(session.invalidate(first.generation)).toBe(false);
    expect(session.cookieHeaderFor(CRUMB_URL)).toContain("A1=live");
  });

  it("retires a session once however many callers ask, and refuses the generation afterwards", async () => {
    const { fetchImpl } = consentFlow();
    const session = sessionWith(fetchImpl);
    const { generation } = await session.crumbFor({});

    const outcomes = Array.from({ length: 20 }, () => session.invalidate(generation));
    expect(outcomes.every(Boolean)).toBe(true);
    expect(session.crumb).toBeNull();
    expect(session.cookieHeaderFor(CRUMB_URL)).toBe("");

    const refreshed = await session.crumbFor({});
    expect(refreshed.generation).toBe(generation + 1);
    expect(session.invalidate(generation)).toBe(false);
    expect(session.cookieHeaderFor(CRUMB_URL)).toContain("A1=live");
  });

  it("ignores an invalidation naming a crumb that has already been replaced", async () => {
    const { fetchImpl } = consentFlow();
    const session = sessionWith(fetchImpl);
    await session.crumbFor({});
    expect(session.invalidate(0)).toBe(false);
    expect(session.crumb).toBe("crumb-1");
    expect(session.cookieHeaderFor(CRUMB_URL)).not.toBe("");
  });

  it("never clears the jar out from under a handshake already in flight", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { fetchImpl } = consentFlow();
    const gated = vi.fn(async (url, options) => {
      if (String(url) === CRUMB_URL) await gate;
      return fetchImpl(url, options);
    });
    const session = sessionWith(gated);

    const refreshing = session.crumbFor({});
    await Promise.resolve();
    expect(session.invalidate(0)).toBe(false);
    expect(session.invalidate()).toBe(false);

    release();
    await expect(refreshing).resolves.toMatchObject({ crumb: "crumb-1" });
    expect(session.cookieHeaderFor(CRUMB_URL)).toContain("A1=live");
  });

  it("refuses a caller whose signal is already aborted without touching the network", async () => {
    const { fetchImpl } = consentFlow();
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(sessionWith(fetchImpl).crumbFor({ signal: controller.signal })).rejects.toThrow("gone");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("runs the handshake on its own signal, so one caller leaving does not cancel it", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { fetchImpl } = consentFlow();
    const gated = vi.fn(async (url, options) => {
      if (String(url) === CRUMB_URL) await gate;
      return fetchImpl(url, options);
    });
    const session = sessionWith(gated);

    const leaving = new AbortController();
    const abandoned = session.crumbFor({ signal: leaving.signal });
    const patient = session.crumbFor({});
    leaving.abort(new Error("client hung up"));

    await expect(abandoned).rejects.toThrow("client hung up");
    release();
    await expect(patient).resolves.toMatchObject({ crumb: "crumb-1" });
    expect(gated.mock.calls.every(([, options]) => options.signal !== leaving.signal)).toBe(true);
  });

  it("gives up on a handshake that never answers, and lets the next caller try again", async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = consentFlow();
      const hanging = vi.fn((url, options) => (
        String(url) === SEED && hanging.mock.calls.length === 1
          ? new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason)))
          : fetchImpl(url, options)
      ));
      const session = sessionWith(hanging, { handshakeTimeoutMs: 5_000 });
      const stuck = expect(session.crumbFor({})).rejects.toMatchObject({ stage: "handshake" });
      await vi.advanceTimersByTimeAsync(5_001);
      await stuck;
      await expect(session.crumbFor({})).resolves.toMatchObject({ crumb: "crumb-1" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a handshake budget that is not a positive number", () => {
    expect(() => new YahooSession({ fetchImpl: vi.fn(), handshakeTimeoutMs: 0 })).toThrow(TypeError);
  });
});
