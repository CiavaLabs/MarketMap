import { describe, expect, it } from "vitest";
import { clonePlain } from "../shared/clonePlain.js";

describe("clonePlain", () => {
  it("deep copies the plain payload shapes it exists for", () => {
    const payload = {
      instrumentId: "XNAS:AAPL",
      price: 317.31,
      session: { model: "us_equity", phase: "regular", isTrading: true },
      dataQuality: { status: "ok", reasons: [], degradedFields: ["volume"] },
      bars: [{ close: 1, source: "yahoo" }, { close: null }],
      error: null,
    };
    const copy = clonePlain(payload);

    expect(copy).toEqual(payload);
    expect(copy).not.toBe(payload);
    expect(copy.session).not.toBe(payload.session);
    expect(copy.bars[0]).not.toBe(payload.bars[0]);
    expect(copy.dataQuality.degradedFields).not.toBe(payload.dataQuality.degradedFields);

    copy.session.phase = "post";
    copy.bars[0].close = 99;
    copy.dataQuality.degradedFields.push("price");
    expect(payload.session.phase).toBe("regular");
    expect(payload.bars[0].close).toBe(1);
    expect(payload.dataQuality.degradedFields).toEqual(["volume"]);
  });

  it("matches structuredClone for values that are not plain objects", () => {
    const payload = {
      at: new Date("2026-07-13T20:00:00.000Z"),
      pattern: /aapl/gi,
      tags: new Set(["a", "b"]),
      lookup: new Map([["k", { v: 1 }]]),
      bytes: new Uint8Array([1, 2, 3]),
    };
    const copy = clonePlain(payload);

    expect(copy).toEqual(structuredClone(payload));
    expect(copy.at).toBeInstanceOf(Date);
    expect(copy.at).not.toBe(payload.at);
    expect(copy.pattern).toBeInstanceOf(RegExp);
    expect(copy.tags).toBeInstanceOf(Set);
    expect(copy.lookup.get("k")).not.toBe(payload.lookup.get("k"));
    expect(copy.bytes).toBeInstanceOf(Uint8Array);
  });

  it("passes primitives and null through untouched", () => {
    for (const value of [null, undefined, 0, -1.5, "", "x", true, NaN]) {
      expect(Object.is(clonePlain(value), value)).toBe(true);
    }
  });

  it("terminates on a cyclic structure instead of overflowing the stack", () => {
    const node = { name: "root" };
    node.self = node;

    const copy = clonePlain(node);

    expect(copy).not.toBe(node);
    expect(copy.name).toBe("root");
    expect(copy.self.self.self.name).toBe("root");
  });

  it("is unary, so it stays safe to hand to map() and other clone collaborators", () => {
    const rows = [{ a: { b: 1 } }, { a: { b: 2 } }, { a: { b: 3 } }];
    const copies = rows.map(clonePlain);

    expect(copies).toEqual(rows);
    copies.forEach((copy, index) => {
      expect(copy.a).not.toBe(rows[index].a);
    });
  });
});
