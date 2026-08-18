import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../../server/contracts/core/constants.js";
import {
  CIRCUIT_STATES,
  CircuitBreaker,
} from "../../server/orchestration/CircuitBreaker.js";
import { SingleFlight } from "../../server/orchestration/SingleFlight.js";

describe("SingleFlight", () => {
  it("coalesces concurrent work by key and clears the flight after success", async () => {
    const flights = new SingleFlight();
    let resolve;
    const operation = vi.fn(() => new Promise((done) => { resolve = done; }));

    const first = flights.run("quote:XNAS:AAPL", operation);
    const second = flights.run("quote:XNAS:AAPL", operation);
    expect(first).toBe(second);
    expect(flights.size).toBe(1);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledOnce();
    resolve({ price: 225.5 });

    await expect(first).resolves.toEqual({ price: 225.5 });
    expect(flights.size).toBe(0);
  });

  it("clears rejected work so a later request can retry", async () => {
    const flights = new SingleFlight();
    await expect(flights.run("profile:XNAS:AAPL", () => Promise.reject(new Error("down"))))
      .rejects.toThrow("down");
    await expect(flights.run("profile:XNAS:AAPL", () => "recovered"))
      .resolves.toBe("recovered");
  });
});

describe("CircuitBreaker", () => {
  it("opens after consecutive failures and admits one half-open probe", async () => {
    let now = 0;
    const transitions = [];
    const breaker = new CircuitBreaker({
      name: "yahoo:quote",
      failureThreshold: 2,
      cooldownMs: 100,
      maxCooldownMs: 400,
      clock: () => now,
      onStateChange: (next) => transitions.push(next),
    });
    const failure = new Error("upstream down");
    const failing = vi.fn(async () => { throw failure; });

    await expect(breaker.execute(failing)).rejects.toBe(failure);
    await expect(breaker.execute(failing)).rejects.toBe(failure);
    expect(breaker.snapshot()).toMatchObject({
      state: CIRCUIT_STATES.OPEN,
      failureCount: 2,
      retryAfterMs: 100,
    });

    await expect(breaker.execute(failing)).rejects.toMatchObject({
      code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
      details: { reason: "circuit_open", retryAfterMs: 100 },
    });
    expect(failing).toHaveBeenCalledTimes(2);

    now = 100;
    let finishProbe;
    const probe = breaker.execute(() => new Promise((resolve) => { finishProbe = resolve; }));
    expect(breaker.snapshot()).toMatchObject({ state: CIRCUIT_STATES.HALF_OPEN, probeInFlight: true });
    await expect(breaker.execute(() => "must not run")).rejects.toMatchObject({
      code: ERROR_CODES.UPSTREAM_UNAVAILABLE,
    });
    finishProbe("healthy");
    await expect(probe).resolves.toBe("healthy");
    expect(breaker.snapshot()).toMatchObject({ state: CIRCUIT_STATES.CLOSED, failureCount: 0 });
    expect(transitions).toEqual(["open", "half-open", "closed"]);
  });

  it("applies bounded exponential cooldown after a failed probe", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 250,
      clock: () => now,
    });
    const fail = () => Promise.reject(new Error("down"));

    await expect(breaker.execute(fail)).rejects.toThrow("down");
    now = 100;
    await expect(breaker.execute(fail)).rejects.toThrow("down");
    expect(breaker.snapshot()).toMatchObject({ openCount: 2, retryAfterMs: 200 });

    now = 300;
    await expect(breaker.execute(fail)).rejects.toThrow("down");
    expect(breaker.snapshot()).toMatchObject({ openCount: 3, retryAfterMs: 250 });
  });

  it("does not penalize provider-valid domain errors", async () => {
    const domainError = Object.assign(new Error("not found"), { code: "instrument_not_found" });
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      shouldCountFailure: (error) => error.code !== "instrument_not_found",
    });

    await expect(breaker.execute(() => Promise.reject(domainError))).rejects.toBe(domainError);
    expect(breaker.snapshot()).toMatchObject({ state: CIRCUIT_STATES.CLOSED, failureCount: 0 });
  });

  it("keeps the existing failure streak when a failure is explicitly ignored", async () => {
    const counted = Object.assign(new Error("offline"), { counted: true });
    const ignored = Object.assign(new Error("caller aborted"), { counted: false });
    const breaker = new CircuitBreaker({
      failureThreshold: 3,
      shouldCountFailure: (error) => error.counted,
    });

    await expect(breaker.execute(() => Promise.reject(counted))).rejects.toBe(counted);
    await expect(breaker.execute(() => Promise.reject(ignored))).rejects.toBe(ignored);
    expect(breaker.snapshot()).toMatchObject({
      state: CIRCUIT_STATES.CLOSED,
      failureCount: 1,
      probeInFlight: false,
    });
  });

  it("releases an ignored half-open probe without treating it as provider recovery", async () => {
    let now = 0;
    const counted = Object.assign(new Error("offline"), { counted: true });
    const ignored = Object.assign(new Error("caller aborted"), { counted: false });
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10,
      clock: () => now,
      shouldCountFailure: (error) => error.counted,
    });

    await expect(breaker.execute(() => Promise.reject(counted))).rejects.toBe(counted);
    now = 10;
    await expect(breaker.execute(() => Promise.reject(ignored))).rejects.toBe(ignored);
    expect(breaker.snapshot()).toMatchObject({
      state: CIRCUIT_STATES.HALF_OPEN,
      failureCount: 1,
      probeInFlight: false,
    });
    await expect(breaker.execute(() => "healthy")).resolves.toBe("healthy");
    expect(breaker.snapshot()).toMatchObject({ state: CIRCUIT_STATES.CLOSED, failureCount: 0 });
  });
});
