export const YAHOO_COOKIE_DOMAINS = Object.freeze(["yahoo.com"]);

const ATTRIBUTE_PARSERS = Object.freeze({
  domain: (cookie, value) => {
    if (value) cookie.domain = value.replace(/^\./, "").toLowerCase();
  },
  path: (cookie, value) => {
    if (value?.startsWith("/")) cookie.path = value;
  },
  expires: (cookie, value) => {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) cookie.expiresFromExpires = parsed;
  },
  "max-age": (cookie, value, now) => {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) cookie.expiresFromMaxAge = now + seconds * 1_000;
  },
  secure: (cookie) => {
    cookie.secure = true;
  },
});

function parseSetCookie(header, requestUrl, now) {
  const [pair, ...attributes] = header.split(";");
  const separator = pair.indexOf("=");
  if (separator < 1) return null;
  const name = pair.slice(0, separator).trim();
  if (!name) return null;

  const cookie = {
    name,
    value: pair.slice(separator + 1).trim(),
    domain: requestUrl.hostname.toLowerCase(),
    hostOnly: true,
    path: "/",
    expiresFromExpires: null,
    expiresFromMaxAge: null,
    expiresAt: null,
    secure: false,
  };

  for (const attribute of attributes) {
    const index = attribute.indexOf("=");
    const key = (index === -1 ? attribute : attribute.slice(0, index)).trim().toLowerCase();
    const value = index === -1 ? "" : attribute.slice(index + 1).trim();
    if (key === "domain" && value) cookie.hostOnly = false;
    if (Object.hasOwn(ATTRIBUTE_PARSERS, key)) ATTRIBUTE_PARSERS[key](cookie, value, now);
  }
  cookie.expiresAt = cookie.expiresFromMaxAge ?? cookie.expiresFromExpires;
  return cookie;
}

function withinDomain(candidate, domain) {
  return candidate === domain || candidate.endsWith(`.${domain}`);
}

function domainMatches(cookie, hostname) {
  if (cookie.domain === hostname) return true;
  return !cookie.hostOnly && hostname.endsWith(`.${cookie.domain}`);
}

function pathMatches(cookie, pathname) {
  if (cookie.path === "/" || cookie.path === pathname) return true;
  return pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`);
}

export class YahooCookieJar {
  constructor({
    clock = () => Date.now(),
    maxCookies = 200,
    allowedDomains = YAHOO_COOKIE_DOMAINS,
  } = {}) {
    if (typeof clock !== "function") throw new TypeError("clock must be a function");
    if (!Number.isInteger(maxCookies) || maxCookies < 1) {
      throw new TypeError("maxCookies must be a positive integer");
    }
    const domains = [...allowedDomains].map((domain) => `${domain}`.trim().toLowerCase());
    if (!domains.length || domains.some((domain) => !domain.includes("."))) {
      throw new TypeError("allowedDomains must each name a registrable domain");
    }
    this.clock = clock;
    this.maxCookies = maxCookies;
    this.allowedDomains = Object.freeze(domains);
    this.cookies = new Map();
  }

  accepts(hostname) {
    const host = `${hostname}`.trim().toLowerCase();
    return this.allowedDomains.some((domain) => withinDomain(host, domain));
  }

  get size() {
    return this.cookies.size;
  }

  storeFromResponse(response, requestUrl) {
    const headers = typeof response?.headers?.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
    if (!headers.length) return false;
    const url = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl));
    const hostname = url.hostname.toLowerCase();
    if (!this.accepts(hostname)) return false;
    const now = this.clock();
    let stored = false;
    for (const header of headers) {
      const cookie = parseSetCookie(header, url, now);
      if (!cookie) continue;
      if (!this.accepts(cookie.domain) || !domainMatches(cookie, hostname)) continue;
      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      this.cookies.delete(key);
      this.cookies.set(key, cookie);
      stored = true;
    }
    this.#evictOverflow();
    return stored;
  }

  headerFor(requestUrl) {
    const url = requestUrl instanceof URL ? requestUrl : new URL(String(requestUrl));
    const hostname = url.hostname.toLowerCase();
    if (!this.accepts(hostname)) return "";
    const secure = url.protocol === "https:";
    const now = this.clock();
    const pairs = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && !secure) continue;
      if (!domainMatches(cookie, hostname) || !pathMatches(cookie, url.pathname)) continue;
      pairs.push(`${cookie.name}=${cookie.value}`);
    }
    return pairs.join("; ");
  }

  clear() {
    this.cookies.clear();
  }

  #evictOverflow() {
    while (this.cookies.size > this.maxCookies) {
      const oldest = this.cookies.keys().next();
      if (oldest.done) return;
      this.cookies.delete(oldest.value);
    }
  }
}
