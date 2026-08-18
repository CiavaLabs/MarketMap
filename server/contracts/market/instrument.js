import {
  MARKET_ASSET_CLASSES,
  ASSET_SUBTYPES_BY_CLASS,
  MAPPING_STATUSES,
  PRICE_UNITS,
  PROVENANCE_SOURCES,
  VENUE_KINDS,
} from "./constants.js";
import {
  CANONICAL_INSTRUMENT_ID_PATTERN,
  INSTRUMENT_STATUSES,
} from "../core/constants.js";
import {
  hasOwn,
  isNonEmptyString,
  isObject,
  issue,
  optionalString,
  requireEnum,
  requireObject,
  requireString,
  requireTimestamp,
  throwIfInvalid,
} from "./validation.js";

const MIC_PATTERN = /^[A-Z0-9]{4}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const ASSET_CODE_PATTERN = /^[A-Z0-9]{2,10}$/;

function collectVenueIssues(venue, path, issues) {
  if (!requireObject(venue, path, issues)) return;
  requireString(venue, "code", path, issues);
  requireString(venue, "name", path, issues);
  requireEnum(venue, "kind", VENUE_KINDS, path, issues);
  if (venue.mic !== null && (!isNonEmptyString(venue.mic) || !MIC_PATTERN.test(venue.mic))) {
    issues.push(issue(`${path}.mic`, "must be a four-character MIC or null"));
  }
  if (venue.kind !== "exchange" && venue.kind !== "futures_exchange" && venue.mic !== null) {
    issues.push(issue(`${path}.mic`, "must be null for non-exchange venues"));
  }
}

function collectProviderSymbolIssues(providerSymbols, path, issues) {
  if (!requireObject(providerSymbols, path, issues)) return;
  const entries = Object.entries(providerSymbols);
  if (!entries.length) {
    issues.push(issue(path, "must declare at least one provider mapping"));
    return;
  }
  for (const [provider, mapping] of entries) {
    const entryPath = `${path}.${provider}`;
    if (!PROVENANCE_SOURCES.includes(provider)) {
      issues.push(issue(entryPath, `must be one of: ${PROVENANCE_SOURCES.join(", ")}`));
      continue;
    }
    if (!requireObject(mapping, entryPath, issues)) continue;
    requireString(mapping, "symbol", entryPath, issues);
    if (typeof mapping.verified !== "boolean") {
      issues.push(issue(`${entryPath}.verified`, "must be a boolean"));
    }
    if (mapping.verified) requireTimestamp(mapping, "verifiedAt", entryPath, issues);
    optionalString(mapping, "providerType", entryPath, issues);
  }
}

export function collectInstrumentDescriptorIssues(value, path = "instrument") {
  const issues = [];
  if (!requireObject(value, path, issues)) return issues;

  requireString(value, "id", path, issues);
  if (isNonEmptyString(value.id) && !CANONICAL_INSTRUMENT_ID_PATTERN.test(value.id)) {
    issues.push(issue(`${path}.id`, "must be a canonical instrument ID"));
  }
  requireString(value, "displaySymbol", path, issues);
  requireString(value, "symbol", path, issues);
  requireString(value, "name", path, issues);
  requireEnum(value, "assetClass", MARKET_ASSET_CLASSES, path, issues);

  const subtypes = ASSET_SUBTYPES_BY_CLASS[value.assetClass];
  if (subtypes && !subtypes.includes(value.assetSubtype)) {
    issues.push(issue(`${path}.assetSubtype`, `must be one of: ${subtypes.join(", ")}`));
  }

  collectVenueIssues(value.venue, `${path}.venue`, issues);
  requireString(value, "exchange", path, issues);

  if (!isNonEmptyString(value.currency) || !CURRENCY_PATTERN.test(value.currency)) {
    issues.push(issue(`${path}.currency`, "must be a three-letter currency code"));
  }
  if (value.assetClass === "fx" || value.assetClass === "crypto") {
    if (!isNonEmptyString(value.quoteCurrency) || !CURRENCY_PATTERN.test(value.quoteCurrency)) {
      issues.push(issue(`${path}.quoteCurrency`, "must be a three-letter currency code"));
    }
    if (!isNonEmptyString(value.baseCurrency) || !ASSET_CODE_PATTERN.test(value.baseCurrency)) {
      issues.push(issue(`${path}.baseCurrency`, "must be a base currency or asset code"));
    }
  }

  requireEnum(value, "priceUnit", PRICE_UNITS, path, issues);
  requireEnum(value, "status", INSTRUMENT_STATUSES, path, issues);
  requireEnum(value, "mappingStatus", MAPPING_STATUSES, path, issues);

  collectProviderSymbolIssues(value.providerSymbols, `${path}.providerSymbols`, issues);
  if (value.mappingStatus === "resolved" && isObject(value.providerSymbols)) {
    const anyVerified = Object.values(value.providerSymbols)
      .some((mapping) => isObject(mapping) && mapping.verified === true);
    if (!anyVerified) {
      issues.push(issue(`${path}.mappingStatus`, "resolved requires at least one verified provider symbol"));
    }
  }

  if (hasOwn(value, "capabilities") && value.capabilities !== undefined && !isObject(value.capabilities)) {
    issues.push(issue(`${path}.capabilities`, "must be an object when provided"));
  }
  return issues;
}

export function validateInstrumentDescriptor(value, options = {}) {
  const issues = collectInstrumentDescriptorIssues(value, options.path || "instrument");
  throwIfInvalid("InstrumentDescriptor", issues, options.code);
  return value;
}
