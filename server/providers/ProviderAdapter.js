import { ERROR_CODES } from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";

export const PROVIDER_CAPABILITIES = Object.freeze([
  "quote",
  "search",
  "history",
  "details",
  "news",
]);

function normalizeCapabilitySpec(spec) {
  if (spec === true || spec === false) {
    return Object.freeze({ enabled: spec, assetClasses: null });
  }
  if (Array.isArray(spec)) {
    return Object.freeze({ enabled: true, assetClasses: Object.freeze([...spec]) });
  }
  if (spec && typeof spec === "object") {
    return Object.freeze({
      enabled: spec.enabled !== false,
      assetClasses: Array.isArray(spec.assetClasses)
        ? Object.freeze([...spec.assetClasses])
        : null,
      ...(Array.isArray(spec.intervals)
        ? { intervals: Object.freeze([...spec.intervals]) }
        : {}),
    });
  }
  return Object.freeze({ enabled: false, assetClasses: null });
}

function statusFrom(error) {
  const value = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return Number.isInteger(value) ? value : null;
}

function inferErrorCode(error, fallbackCode) {
  const status = statusFrom(error);
  const message = `${error?.name || ""} ${error?.message || ""}`.toLowerCase();
  if (error?.name === "AbortError" || message.includes("timeout") || message.includes("timed out")) {
    return ERROR_CODES.TIMEOUT;
  }
  if (status === 401 || message.includes("invalid api key") || message.includes("authentication")) {
    return ERROR_CODES.AUTH_FAILED;
  }
  if (status === 403 || message.includes("entitlement") || message.includes("permission")) {
    return ERROR_CODES.ENTITLEMENT_MISSING;
  }
  if (status === 404 || message.includes("not found") || message.includes("no data found")) {
    return ERROR_CODES.INSTRUMENT_NOT_FOUND;
  }
  if (status === 429 || message.includes("rate limit") || message.includes("too many requests")) {
    return ERROR_CODES.RATE_LIMITED;
  }
  if (status !== null && status >= 500) return ERROR_CODES.UPSTREAM_UNAVAILABLE;
  if (error instanceof SyntaxError || message.includes("json") || message.includes("schema")) {
    return ERROR_CODES.SCHEMA_INVALID;
  }
  return fallbackCode;
}

export function normalizeProviderError(error, context = {}) {
  const fallbackCode = context.code || ERROR_CODES.UPSTREAM_UNAVAILABLE;
  const code = error instanceof MarketDataError
    ? error.code
    : inferErrorCode(error, fallbackCode);
  const message = context.message
    || (error instanceof MarketDataError ? error.message : `${context.provider || "Provider"} request failed`);

  if (
    error instanceof MarketDataError
    && (!context.provider || error.provider === context.provider)
    && (!context.capability || error.capability === context.capability)
    && (!context.instrumentId || error.instrumentId === context.instrumentId)
  ) {
    return error;
  }

  return new MarketDataError(code, message, {
    cause: error,
    status: context.status || (error instanceof MarketDataError ? error.status : undefined),
    retryable: context.retryable ?? (error instanceof MarketDataError ? error.retryable : undefined),
    provider: context.provider || (error instanceof MarketDataError ? error.provider : null),
    capability: context.capability || (error instanceof MarketDataError ? error.capability : null),
    instrumentId: context.instrumentId || (error instanceof MarketDataError ? error.instrumentId : null),
    details: context.details || (error instanceof MarketDataError ? error.details : null),
  });
}

export class ProviderAdapter {
  constructor({ id, capabilities = {} } = {}) {
    if (!id || typeof id !== "string") {
      throw new TypeError("ProviderAdapter requires a provider id");
    }
    this.id = id;
    this._capabilities = Object.freeze(
      Object.fromEntries(
        PROVIDER_CAPABILITIES.map((capability) => [
          capability,
          normalizeCapabilitySpec(capabilities[capability]),
        ]),
      ),
    );
  }

  capabilities() {
    return Object.fromEntries(
      Object.entries(this._capabilities).map(([capability, spec]) => [
        capability,
        {
          ...spec,
          assetClasses: spec.assetClasses ? [...spec.assetClasses] : null,
          ...(spec.intervals ? { intervals: [...spec.intervals] } : {}),
        },
      ]),
    );
  }

  supports(capability, assetClass) {
    const spec = this._capabilities[capability];
    if (!spec?.enabled) return false;
    if (!assetClass || !spec.assetClasses) return true;
    return spec.assetClasses.includes(assetClass);
  }

  supportsInstrument(capability, instrument) {
    return this.supports(capability, instrument?.assetClass);
  }

  assertCapability(capability, assetClass, instrumentId = null) {
    if (this.supports(capability, assetClass)) return;
    throw new MarketDataError(ERROR_CODES.UNSUPPORTED_ASSET, `${this.id} does not support ${capability}${assetClass ? ` for ${assetClass}` : ""}`, {
      provider: this.id,
      capability,
      instrumentId,
      retryable: false,
      details: assetClass ? { assetClass } : null,
    });
  }

  async quoteMany() {
    this.assertCapability("quote");
    throw new TypeError(`${this.constructor.name}.quoteMany() is not implemented`);
  }

  async search() {
    this.assertCapability("search");
    throw new TypeError(`${this.constructor.name}.search() is not implemented`);
  }

  async details() {
    throw new TypeError(`${this.constructor.name}.details() is not implemented`);
  }

  async history() {
    this.assertCapability("history");
    throw new TypeError(`${this.constructor.name}.history() is not implemented`);
  }

  async news() {
    this.assertCapability("news");
    throw new TypeError(`${this.constructor.name}.news() is not implemented`);
  }
}
