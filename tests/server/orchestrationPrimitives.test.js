import { describe, expect, it, vi } from "vitest";

import {
  CIRCUIT_STATES,
  CircuitBreaker,
} from "../../server/orchestration/CircuitBreaker.js";
import { SingleFlight } from "../../server/orchestration/SingleFlight.js";
import {
  DEFAULT_TTL_POLICY,
  ttlForNews,
  ttlFor,
} from "../../server/orchestration/ttlPolicy.js";

describe("SingleFlight bookkeeping", () => {
  it("reports the keys currently in flight", async () => {
    const flight = new SingleFlight();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = flight.run("quote:AAPL", () => gate);

    expect(flight.size).toBe(1);
    expect(flight.has("quote:AAPL")).toBe(true);
    expect(flight.has("quote:MSFT")).toBe(false);
    expect(flight.keys()).toEqual(["quote:AAPL"]);

    release("done");
    await pending;
    expect(flight.size).toBe(0);
    expect(flight.keys()).toEqual([]);
  });

  it.each([
    ["an empty key", ""],
    ["a non-string key", 42],
    ["no key at all", undefined],
  ])("rejects %s", (_label, key) => {
    expect(() => new SingleFlight().run(key, () => {}))
      .toThrowError(/key must be a non-empty string/u);
  });

  it.each([
    ["a non-function operation", "work"],
    ["no operation at all", undefined],
  ])("rejects %s", (_label, operation) => {
    expect(() => new SingleFlight().run("key", operation))
      .toThrowError(/operation must be a function/u);
  });

  it("keeps a later flight for the same key once the first has settled", async () => {
    const flight = new SingleFlight();
    const first = await flight.run("key", () => "first");
    const second = await flight.run("key", () => "second");
    expect([first, second]).toEqual(["first", "second"]);
  });
});

describe("CircuitBreaker construction", () => {
  it.each([
    ["a fractional failure threshold", { failureThreshold: 1.5 }, TypeError],
    ["a zero failure threshold", { failureThreshold: 0 }, TypeError],
    ["a negative cooldown", { cooldownMs: -1 }, TypeError],
    ["a non-finite cooldown", { cooldownMs: Number.POSITIVE_INFINITY }, TypeError],
    ["a zero backoff multiplier", { backoffMultiplier: 0 }, TypeError],
    ["a maximum cooldown below the base", { cooldownMs: 1_000, maxCooldownMs: 500 }, RangeError],
  ])("rejects %s", (_label, options, expected) => {
    expect(() => new CircuitBreaker(options)).toThrowError(expected);
  });

  it.each(["clock", "shouldCountFailure", "jitter", "onStateChange"])(
    "rejects a non-function %s",
    (option) => {
      expect(() => new CircuitBreaker({ [option]: "nope" }))
        .toThrowError(new RegExp(`${option} must be a function`, "u"));
    },
  );

  it("accepts a zero cooldown and defaults its name", () => {
    const breaker = new CircuitBreaker({ cooldownMs: 0, maxCooldownMs: 0 });
    expect(breaker.name).toBe("market-data");
    expect(breaker.snapshot()).toMatchObject({
      state: CIRCUIT_STATES.CLOSED,
      failureCount: 0,
      openCount: 0,
      retryAfterMs: 0,
      probeInFlight: false,
    });
  });

  it("rejects a jitter function that returns something unusable", () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      jitter: () => Number.NaN,
    });
    expect(() => breaker.recordFailure()).toThrowError(/jitter result/u);
  });
});

describe("CircuitBreaker state", () => {
  const breakerAt = (now, options = {}) => new CircuitBreaker({
    failureThreshold: 2,
    cooldownMs: 1_000,
    clock: () => now.value,
    ...options,
  });

  it("exposes isOpen and refuses requests while open", () => {
    const now = { value: 0 };
    const breaker = breakerAt(now);
    expect(breaker.isOpen).toBe(false);
    expect(breaker.canRequest()).toBe(true);

    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen).toBe(true);
    expect(breaker.canRequest()).toBe(false);
  });

  it("admits exactly one probe once the cooldown expires", () => {
    const now = { value: 0 };
    const breaker = breakerAt(now);
    breaker.recordFailure();
    breaker.recordFailure();

    now.value = 1_000;
    expect(breaker.isOpen).toBe(false);
    expect(breaker.canRequest()).toBe(true);
    expect(breaker.snapshot().state).toBe(CIRCUIT_STATES.HALF_OPEN);
  });

  it("rejects a non-function operation", async () => {
    await expect(new CircuitBreaker().execute("work"))
      .rejects.toThrowError(/operation must be a function/u);
  });

  it("resets back to closed", () => {
    const now = { value: 0 };
    const breaker = breakerAt(now);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.reset();
    expect(breaker.snapshot()).toMatchObject({
      state: CIRCUIT_STATES.CLOSED,
      failureCount: 0,
      openCount: 0,
      openedAt: null,
      retryAt: null,
    });
  });

  it("ignores further failures while already open", () => {
    const now = { value: 0 };
    const breaker = breakerAt(now);
    breaker.recordFailure();
    breaker.recordFailure();
    const openedAt = breaker.snapshot().openedAt;
    breaker.recordFailure();
    expect(breaker.snapshot()).toMatchObject({ openCount: 1, openedAt });
  });

  it("announces every state transition once", () => {
    const now = { value: 0 };
    const onStateChange = vi.fn();
    const breaker = breakerAt(now, { onStateChange });

    breaker.recordFailure();
    expect(onStateChange).not.toHaveBeenCalled();
    breaker.recordFailure();
    expect(onStateChange).toHaveBeenLastCalledWith(
      CIRCUIT_STATES.OPEN,
      CIRCUIT_STATES.CLOSED,
      expect.objectContaining({ state: CIRCUIT_STATES.OPEN }),
    );

    now.value = 1_000;
    breaker.canRequest();
    expect(onStateChange).toHaveBeenLastCalledWith(
      CIRCUIT_STATES.HALF_OPEN,
      CIRCUIT_STATES.OPEN,
      expect.anything(),
    );

    breaker.recordSuccess();
    expect(onStateChange).toHaveBeenLastCalledWith(
      CIRCUIT_STATES.CLOSED,
      CIRCUIT_STATES.HALF_OPEN,
      expect.anything(),
    );
    expect(onStateChange).toHaveBeenCalledTimes(3);
  });

  it("caps the cooldown at its maximum", () => {
    const now = { value: 0 };
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      maxCooldownMs: 2_000,
      backoffMultiplier: 10,
      clock: () => now.value,
    });
    breaker.recordFailure();
    expect(breaker.snapshot().retryAfterMs).toBe(1_000);

    now.value = 1_000;
    breaker.canRequest();
    breaker.recordFailure();
    expect(breaker.snapshot().retryAfterMs).toBe(2_000);
  });

  it("reports a snapshot without advancing the state", () => {
    const now = { value: 0 };
    const breaker = breakerAt(now);
    breaker.recordFailure();
    breaker.recordFailure();

    now.value = 5_000;
    expect(breaker.snapshotWithoutRefresh().state).toBe(CIRCUIT_STATES.OPEN);
    expect(breaker.snapshot().state).toBe(CIRCUIT_STATES.HALF_OPEN);
  });
});

describe("v1 TTL policy", () => {
  it.each([
    ["an open quote", "quote", { marketState: "regular" }, DEFAULT_TTL_POLICY.quote],
    ["a closed quote", "quote", { marketState: "closed" }, DEFAULT_TTL_POLICY.quoteClosed],
    ["a quote with no state", "quote", null, DEFAULT_TTL_POLICY.quote],
    ["intraday history", "history", { interval: "5m" }, DEFAULT_TTL_POLICY.historyIntraday],
    ["hourly history", "history", { interval: "1h" }, DEFAULT_TTL_POLICY.historyIntraday],
    ["daily history", "history", { interval: "1d" }, DEFAULT_TTL_POLICY.historyDaily],
    ["history with no interval", "history", null, DEFAULT_TTL_POLICY.historyDaily],
    ["a populated news feed", "news", { articles: [{}] }, DEFAULT_TTL_POLICY.news],
    ["an empty news feed", "news", { articles: [] }, DEFAULT_TTL_POLICY.newsEmpty],
    ["news with no article list", "news", {}, DEFAULT_TTL_POLICY.news],
    ["a search result", "search", null, DEFAULT_TTL_POLICY.search],
    ["an unknown resource", "fundamentals", null, DEFAULT_TTL_POLICY.profile],
  ])("resolves %s", (_label, resourceType, value, expected) => {
    expect(ttlForNews(resourceType, value)).toBe(expected);
  });
});

describe("v2 TTL policy", () => {
  const quote = (session, patch = {}) => ({ session, ...patch });

  it.each([
    ["a 24x7 venue", quote({ model: "24x7" }), DEFAULT_TTL_POLICY.quote24x7],
    ["an open 24x5 venue", quote({ model: "24x5", phase: "regular" }), DEFAULT_TTL_POLICY.quote24x5],
    ["a closed 24x5 venue", quote({ model: "24x5", phase: "closed" }), DEFAULT_TTL_POLICY.quoteClosed],
    ["a publisher schedule", quote({ model: "publisher_schedule" }), DEFAULT_TTL_POLICY.quotePublisher],
    ["a provider schedule", quote({ model: "provider_schedule" }), DEFAULT_TTL_POLICY.quoteFuture],
    ["a future on any schedule", quote({ model: "exchange_hours" }, { assetClass: "commodity_future" }), DEFAULT_TTL_POLICY.quoteFuture],
    ["an open exchange", quote({ model: "exchange_hours", phase: "regular" }), DEFAULT_TTL_POLICY.quote],
    ["a closed exchange", quote({ model: "exchange_hours", phase: "closed" }), DEFAULT_TTL_POLICY.quoteClosed],
    ["a quote with no session", null, DEFAULT_TTL_POLICY.quote],
  ])("resolves a quote on %s", (_label, value, expected) => {
    expect(ttlFor("quote", value)).toBe(expected);
  });

  it.each([
    ["24x7", DEFAULT_TTL_POLICY.quote],
    ["24x5", DEFAULT_TTL_POLICY.quote],
    ["publisher_schedule", DEFAULT_TTL_POLICY.quote],
    ["provider_schedule", DEFAULT_TTL_POLICY.quote],
  ])("falls back to the base quote TTL when %s has none", (model, expected) => {
    const policy = { ...DEFAULT_TTL_POLICY };
    delete policy.quote24x7;
    delete policy.quote24x5;
    delete policy.quotePublisher;
    delete policy.quoteFuture;
    expect(ttlFor("quote", { session: { model, phase: "regular" } }, policy)).toBe(expected);
  });

  it.each([
    ["intraday history", "history", { interval: "15m" }, DEFAULT_TTL_POLICY.historyIntraday],
    ["daily history", "history", { interval: "1d" }, DEFAULT_TTL_POLICY.historyDaily],
    ["news", "news", null, DEFAULT_TTL_POLICY.news],
    ["an unknown resource", "fundamentals", null, DEFAULT_TTL_POLICY.profile],
  ])("resolves %s", (_label, resourceType, value, expected) => {
    expect(ttlFor(resourceType, value)).toBe(expected);
  });

  it("prefers a declared details TTL and falls back to the profile one", () => {
    expect(ttlFor("details", null)).toBe(DEFAULT_TTL_POLICY.profile);
    const withDetails = { ...DEFAULT_TTL_POLICY, details: { freshMs: 1, staleMs: 2 } };
    expect(ttlFor("details", null, withDetails)).toBe(withDetails.details);
  });
});
