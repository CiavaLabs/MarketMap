import { describe, expect, it } from "vitest";
import { RequestQuota } from "../../server/http/RequestQuota.js";

function quotaAt(now, options = {}) {
  const clock = { value: now };
  const quota = new RequestQuota({ clock: () => clock.value, ...options });
  return { quota, advance: (ms) => { clock.value += ms; } };
}

describe("RequestQuota", () => {
  it("rejects a configuration that cannot bound anything", () => {
    expect(() => new RequestQuota({ limit: 0 })).toThrow(TypeError);
    expect(() => new RequestQuota({ windowMs: 0 })).toThrow(TypeError);
    expect(() => new RequestQuota({ maxClients: 0 })).toThrow(TypeError);
    expect(() => new RequestQuota({ clock: "now" })).toThrow(TypeError);
  });

  it("rejects a cost that is not a positive integer", () => {
    const { quota } = quotaAt(0);
    expect(() => quota.consume("a", 0)).toThrow(TypeError);
    expect(() => quota.consume("a", 1.5)).toThrow(TypeError);
  });

  it("refuses a cost no allowance could ever cover, rather than promising a retry", () => {
    const { quota } = quotaAt(0, { limit: 10 });
    expect(() => quota.consume("a", 11)).toThrow(RangeError);
    expect(quota.consume("a", 10).allowed).toBe(true);
  });

  it("rejects a refund that is not a positive integer, and ignores an unknown client", () => {
    const { quota } = quotaAt(0, { limit: 10 });
    expect(() => quota.refund("a", 0)).toThrow(TypeError);
    expect(quota.refund("never-seen", 1)).toBe(false);
  });

  it("returns tokens on refund without ever exceeding the limit", () => {
    const { quota } = quotaAt(0, { limit: 10 });
    quota.consume("a", 6);
    expect(quota.refund("a", 6)).toBe(true);
    expect(quota.consume("a", 10).allowed).toBe(true);

    quota.refund("a", 10);
    quota.refund("a", 10);
    expect(quota.consume("a", 10).allowed).toBe(true);
    expect(quota.consume("a", 1).allowed).toBe(false);
  });

  it("spends a full bucket and then refuses, reporting when to come back", () => {
    const { quota } = quotaAt(0, { limit: 3, windowMs: 60_000 });
    expect(quota.consume("client").remaining).toBe(2);
    expect(quota.consume("client").remaining).toBe(1);
    expect(quota.consume("client").remaining).toBe(0);
    const refused = quota.consume("client");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBe(20_000);
  });

  it("charges a batch by the instruments it asks for", () => {
    const { quota } = quotaAt(0, { limit: 100, windowMs: 60_000 });
    expect(quota.consume("client", 40).remaining).toBe(60);
    expect(quota.consume("client", 40).remaining).toBe(20);
    expect(quota.consume("client", 40).allowed).toBe(false);
    expect(quota.consume("client", 20).allowed).toBe(true);
  });

  it("refills continuously rather than in steps at the window edge", () => {
    const { quota, advance } = quotaAt(0, { limit: 60, windowMs: 60_000 });
    quota.consume("client", 60);
    expect(quota.consume("client").allowed).toBe(false);
    advance(10_000);
    expect(quota.consume("client", 10).allowed).toBe(true);
    expect(quota.consume("client").allowed).toBe(false);
    advance(60_000);
    expect(quota.consume("client", 60).allowed).toBe(true);
  });

  it("never refills past the limit however long a client is idle", () => {
    const { quota, advance } = quotaAt(0, { limit: 5, windowMs: 1_000 });
    quota.consume("client", 5);
    advance(10_000_000);
    expect(quota.consume("client", 5).allowed).toBe(true);
    expect(quota.consume("client").allowed).toBe(false);
  });

  it("keeps one client's spending off another's bucket", () => {
    const { quota } = quotaAt(0, { limit: 2, windowMs: 60_000 });
    quota.consume("first", 2);
    expect(quota.consume("first").allowed).toBe(false);
    expect(quota.consume("second").allowed).toBe(true);
  });

  it("drops the buckets of clients that have gone quiet for a whole window", () => {
    const { quota, advance } = quotaAt(0, { limit: 10, windowMs: 1_000 });
    quota.consume("idle");
    advance(5_000);
    quota.consume("active");
    expect(quota.size).toBe(1);
  });

  it("evicts the least recently seen client once the roster is full", () => {
    const { quota } = quotaAt(0, { limit: 10, windowMs: 60_000, maxClients: 2 });
    quota.consume("first");
    quota.consume("second");
    quota.consume("first");
    quota.consume("third");
    expect(quota.size).toBe(2);
    expect(quota.consume("second").remaining).toBe(9);
  });

  it("forgets a client on request and empties on clear", () => {
    const { quota } = quotaAt(0, { limit: 2, windowMs: 60_000 });
    quota.consume("client", 2);
    expect(quota.forget("client")).toBe(true);
    expect(quota.consume("client").allowed).toBe(true);
    quota.clear();
    expect(quota.size).toBe(0);
  });
});
