import { describe, expect, it } from "vitest";
import { YahooCookieJar } from "../../../server/providers/yahoo/yahooCookieJar.js";

const NOW = Date.parse("2026-07-13T12:00:00.000Z");

function response(setCookies) {
  return { headers: { getSetCookie: () => setCookies } };
}

function jarAt(now = NOW, options = {}) {
  return new YahooCookieJar({ clock: () => now, ...options });
}

describe("YahooCookieJar", () => {
  it("rejects a non-function clock and a non-positive bound", () => {
    expect(() => new YahooCookieJar({ clock: "now" })).toThrow(TypeError);
    expect(() => new YahooCookieJar({ maxCookies: 0 })).toThrow(TypeError);
  });

  it("stores a host-only cookie and returns it to the same host alone", () => {
    const jar = jarAt();
    jar.storeFromResponse(response(["A1=one; Path=/"]), "https://finance.yahoo.com/quote/AAPL");
    expect(jar.headerFor("https://finance.yahoo.com/x")).toBe("A1=one");
    expect(jar.headerFor("https://query1.finance.yahoo.com/x")).toBe("");
  });

  it("shares a Domain cookie across every subdomain but never a sibling registrable domain", () => {
    const jar = jarAt();
    jar.storeFromResponse(response(["A3=two; Domain=.yahoo.com; Path=/"]), "https://finance.yahoo.com/quote/AAPL");
    expect(jar.headerFor("https://query1.finance.yahoo.com/v1/test/getcrumb")).toBe("A3=two");
    expect(jar.headerFor("https://consent.yahoo.com/v2/collectConsent")).toBe("A3=two");
    expect(jar.headerFor("https://notyahoo.com/x")).toBe("");
  });

  it("withholds a Secure cookie from a plaintext request", () => {
    const jar = jarAt();
    jar.storeFromResponse(response(["S=secret; Domain=.yahoo.com; Path=/; Secure"]), "https://finance.yahoo.com/");
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("S=secret");
    expect(jar.headerFor("http://finance.yahoo.com/")).toBe("");
  });

  it("honours Path scoping without matching a prefix that is not a segment boundary", () => {
    const jar = jarAt();
    jar.storeFromResponse(response(["P=scoped; Path=/v2"]), "https://consent.yahoo.com/v2/collectConsent");
    expect(jar.headerFor("https://consent.yahoo.com/v2/collectConsent")).toBe("P=scoped");
    expect(jar.headerFor("https://consent.yahoo.com/v2/other")).toBe("P=scoped");
    expect(jar.headerFor("https://consent.yahoo.com/v20/other")).toBe("");
  });

  it("drops a cookie whose Expires has passed and one whose Max-Age has elapsed", () => {
    const jar = jarAt();
    jar.storeFromResponse(response([
      "Gone=1; Domain=.yahoo.com; Expires=Mon, 13 Jul 2026 11:00:00 GMT",
      "Live=2; Domain=.yahoo.com; Max-Age=1800",
    ]), "https://finance.yahoo.com/");
    expect(jar.size).toBe(1);
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("Live=2");

    const later = new YahooCookieJar({ clock: () => NOW + 1_801_000 });
    later.storeFromResponse(response(["Live=2; Domain=.yahoo.com; Max-Age=-1"]), "https://finance.yahoo.com/");
    expect(later.headerFor("https://finance.yahoo.com/")).toBe("");
  });

  it("lets Max-Age overrule Expires whichever order they arrive in", () => {
    const jar = jarAt();
    jar.storeFromResponse(response([
      "Doomed=1; Domain=.yahoo.com; Max-Age=0; Expires=Fri, 13 Jul 2029 12:00:00 GMT",
      "AlsoDoomed=1; Domain=.yahoo.com; Expires=Fri, 13 Jul 2029 12:00:00 GMT; Max-Age=0",
    ]), "https://finance.yahoo.com/");
    expect(jar.size).toBe(0);
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("");

    const kept = jarAt();
    kept.storeFromResponse(response([
      "Live=1; Domain=.yahoo.com; Expires=Mon, 13 Jul 2026 11:00:00 GMT; Max-Age=1800",
    ]), "https://finance.yahoo.com/");
    expect(kept.headerFor("https://finance.yahoo.com/")).toBe("Live=1");
  });

  it("expires a stored cookie lazily on read once its Max-Age window closes", () => {
    let now = NOW;
    const jar = new YahooCookieJar({ clock: () => now });
    jar.storeFromResponse(response(["GUCS=short; Domain=.yahoo.com; Max-Age=1800"]), "https://finance.yahoo.com/");
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("GUCS=short");
    now += 1_800_001;
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("");
    expect(jar.size).toBe(0);
  });

  it("replaces a cookie of the same name, domain and path rather than duplicating it", () => {
    const jar = jarAt();
    jar.storeFromResponse(response(["A1=first; Domain=.yahoo.com"]), "https://finance.yahoo.com/");
    jar.storeFromResponse(response(["A1=second; Domain=.yahoo.com"]), "https://finance.yahoo.com/");
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("A1=second");
    expect(jar.size).toBe(1);
  });

  it("keeps the same name under two domains apart", () => {
    const jar = jarAt();
    jar.storeFromResponse(response(["A1=wide; Domain=.yahoo.com"]), "https://finance.yahoo.com/");
    jar.storeFromResponse(response(["A1=narrow"]), "https://consent.yahoo.com/");
    expect(jar.size).toBe(2);
    expect(jar.headerFor("https://consent.yahoo.com/")).toBe("A1=wide; A1=narrow");
  });

  it("ignores a header with no name and reports whether anything was stored", () => {
    const jar = jarAt();
    expect(jar.storeFromResponse(response(["=orphan", "novalue"]), "https://finance.yahoo.com/")).toBe(false);
    expect(jar.storeFromResponse(response([]), "https://finance.yahoo.com/")).toBe(false);
    expect(jar.storeFromResponse({ headers: {} }, "https://finance.yahoo.com/")).toBe(false);
    expect(jar.size).toBe(0);
  });

  it("evicts the oldest entry once the bound is reached", () => {
    const jar = jarAt(NOW, { maxCookies: 2 });
    for (const name of ["one", "two", "three"]) {
      jar.storeFromResponse(response([`${name}=v; Domain=.yahoo.com`]), "https://finance.yahoo.com/");
    }
    expect(jar.size).toBe(2);
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("two=v; three=v");
  });

  it("forgets everything on clear", () => {
    const jar = jarAt();
    jar.storeFromResponse(response(["A1=one; Domain=.yahoo.com"]), "https://finance.yahoo.com/");
    jar.clear();
    expect(jar.size).toBe(0);
    expect(jar.headerFor("https://finance.yahoo.com/")).toBe("");
  });
});
