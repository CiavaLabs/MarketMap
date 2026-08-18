import { YAHOO_COOKIE_DOMAINS, YahooCookieJar } from "./yahooCookieJar.js";

const CONSENT_SEED_URL = "https://finance.yahoo.com/quote/AAPL";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const CRUMB_URL = "https://query1.finance.yahoo.com/v1/test/getcrumb";
const MAX_CONSENT_HOPS = 5;
const INPUT_ELEMENT = /<input\b[^>]*>/gi;
const INPUT_ATTRIBUTE = /([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g;
const NUMERIC_ENTITY = /&#x([0-9A-Fa-f]{1,4});/gi;

export const YAHOO_USER_AGENT = "Mozilla/5.0 (compatible; marketmap; +https://github.com/CiavaLabs/MarketMap)";

const DOCUMENT_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

function decodeEntities(value) {
  return value.replace(NUMERIC_ENTITY, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function inputAttributes(element) {
  const attributes = {};
  for (const [, name, raw] of element.matchAll(INPUT_ATTRIBUTE)) {
    const quoted = raw.startsWith('"') || raw.startsWith("'");
    attributes[name.toLowerCase()] = quoted ? raw.slice(1, -1) : raw;
  }
  return attributes;
}

function consentFormBody(html) {
  const fields = [];
  for (const [element] of html.matchAll(INPUT_ELEMENT)) {
    const { type, name, value = "" } = inputAttributes(element);
    if (`${type}`.toLowerCase() !== "hidden" || !name) continue;
    fields.push(`${encodeURIComponent(name)}=${encodeURIComponent(decodeEntities(value))}`);
  }
  return [...fields, "agree=agree", "agree=agree"].join("&");
}

function sameSiteRedirect(location, base, allowedDomains) {
  let target;
  try {
    target = new URL(location, base);
  } catch {
    return null;
  }
  if (target.protocol !== "https:") return null;
  const hostname = target.hostname.toLowerCase();
  const allowed = allowedDomains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
  return allowed ? target : null;
}

export class YahooSessionError extends Error {
  constructor(message, { stage, status = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "YahooSessionError";
    this.stage = stage;
    this.status = status;
  }
}

export class YahooSession {
  constructor({
    fetchImpl = globalThis.fetch,
    cookieJar = new YahooCookieJar(),
    clock = () => Date.now(),
    crumbTtlMs = 3_600_000,
    seedUrl = CONSENT_SEED_URL,
    userAgent = YAHOO_USER_AGENT,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    allowedDomains = YAHOO_COOKIE_DOMAINS,
  } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    if (!Number.isFinite(crumbTtlMs) || crumbTtlMs <= 0) {
      throw new TypeError("crumbTtlMs must be a positive number");
    }
    if (!Number.isFinite(handshakeTimeoutMs) || handshakeTimeoutMs <= 0) {
      throw new TypeError("handshakeTimeoutMs must be a positive number");
    }
    if (typeof userAgent !== "string" || !userAgent.trim()) {
      throw new TypeError("userAgent must be a non-empty string");
    }
    this.fetchImpl = fetchImpl;
    this.cookieJar = cookieJar;
    this.clock = clock;
    this.crumbTtlMs = crumbTtlMs;
    this.seedUrl = seedUrl;
    this.userAgent = userAgent;
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.allowedDomains = Object.freeze([...allowedDomains].map((d) => `${d}`.toLowerCase()));
    this.crumb = null;
    this.crumbExpiresAt = 0;
    this.inFlight = null;
    this.generation = 0;
    this.abortHandshake = null;
  }

  close() {
    this.abortHandshake?.(new YahooSessionError("Yahoo session closed", { stage: "close" }));
    this.crumb = null;
    this.crumbExpiresAt = 0;
    this.cookieJar.clear();
  }

  invalidate(staleGeneration) {
    if (this.inFlight) return false;
    if (staleGeneration !== undefined && staleGeneration !== this.generation) return false;
    this.crumb = null;
    this.crumbExpiresAt = 0;
    this.cookieJar.clear();
    return true;
  }

  cookieHeaderFor(url) {
    return this.cookieJar.headerFor(url);
  }

  async crumbFor({ signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (this.crumb && this.clock() < this.crumbExpiresAt) {
      return { crumb: this.crumb, generation: this.generation };
    }
    if (!this.inFlight) this.inFlight = this.#sharedHandshake();
    return this.#raceCaller(this.inFlight, signal);
  }

  #sharedHandshake() {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new YahooSessionError("Yahoo handshake exceeded its budget", {
        stage: "handshake",
      })),
      this.handshakeTimeoutMs,
    );
    this.abortHandshake = (reason) => controller.abort(reason);
    return this.#acquireCrumb({ signal: controller.signal })
      .finally(() => {
        clearTimeout(timeout);
        this.abortHandshake = null;
        this.inFlight = null;
      });
  }

  async #raceCaller(work, signal) {
    if (!signal) return work;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #request(url, { method = "GET", accept, body, signal, referer } = {}) {
    const target = url instanceof URL ? url : new URL(String(url));
    const cookie = this.cookieJar.headerFor(target);
    const headers = {
      "user-agent": this.userAgent,
      "accept-language": "en-US,en;q=0.9",
      accept: accept || DOCUMENT_ACCEPT,
      ...(cookie ? { cookie } : {}),
      ...(referer ? { referer, origin: "https://finance.yahoo.com" } : {}),
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    };
    const response = await this.fetchImpl(target, {
      method,
      headers,
      redirect: "manual",
      ...(body ? { body } : {}),
      ...(signal ? { signal } : {}),
    });
    this.cookieJar.storeFromResponse(response, target);
    return response;
  }

  async #acquireCrumb({ signal }) {
    await this.#seedCookies(this.seedUrl, signal, 0);

    const response = await this.#request(CRUMB_URL, {
      accept: "*/*",
      signal,
      referer: this.seedUrl,
    });
    if (response.status !== 200) {
      throw new YahooSessionError(`Yahoo refused a crumb with status ${response.status}`, {
        stage: "getcrumb",
        status: response.status,
      });
    }
    const crumb = (await response.text()).trim();
    if (!crumb || crumb.length > 64 || /[<>\s]/.test(crumb)) {
      throw new YahooSessionError("Yahoo returned an unusable crumb", { stage: "getcrumb" });
    }
    this.crumb = crumb;
    this.crumbExpiresAt = this.clock() + this.crumbTtlMs;
    this.generation += 1;
    return { crumb, generation: this.generation };
  }

  async #seedCookies(url, signal, hop) {
    if (hop > MAX_CONSENT_HOPS) {
      throw new YahooSessionError("Yahoo consent redirected past the hop limit", { stage: "consent" });
    }
    const response = await this.#request(url, { signal });
    const location = response.headers.get("location");
    if (!location) return;
    const target = this.#redirect(location, url, "seed");
    if (target.hostname !== "guce.yahoo.com") {
      await this.#seedCookies(target.href, signal, hop + 1);
      return;
    }
    await this.#clearConsent(target.href, signal, hop);
  }

  #redirect(location, base, stage) {
    const target = sameSiteRedirect(location, base, this.allowedDomains);
    if (!target) {
      throw new YahooSessionError("Yahoo redirected outside its own origins", { stage });
    }
    return target;
  }

  async #clearConsent(consentUrl, signal, hop) {
    const consentResponse = await this.#request(consentUrl, { signal });
    const collectUrl = consentResponse.headers.get("location");
    if (!collectUrl) return;
    const collectTarget = this.#redirect(collectUrl, consentUrl, "consent");
    if (!collectTarget.pathname.includes("collectConsent")) {
      throw new YahooSessionError("Yahoo consent redirected to an unexpected target", {
        stage: "consent",
      });
    }

    const collectResponse = await this.#request(collectTarget.href, { signal });
    const submitted = await this.#request(collectTarget.href, {
      method: "POST",
      body: consentFormBody(await collectResponse.text()),
      signal,
    });

    const copyConsentUrl = submitted.headers.get("location");
    if (!copyConsentUrl) {
      throw new YahooSessionError("Yahoo consent submission returned no redirect", { stage: "consent" });
    }
    const copyTarget = this.#redirect(copyConsentUrl, collectTarget.href, "consent");
    const copyResponse = await this.#request(copyTarget.href, { signal });
    const finalUrl = copyResponse.headers.get("location");
    if (finalUrl) {
      await this.#seedCookies(this.#redirect(finalUrl, copyTarget.href, "consent").href, signal, hop + 1);
    }
  }
}
