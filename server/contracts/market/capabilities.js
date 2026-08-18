import {
  MARKET_ASSET_CLASSES,
  CAPABILITY_SUPPORT_LEVELS,
  DETAIL_SECTIONS,
  EFFECTIVE_CAPABILITY_OPERATIONS,
  HISTORY_INTERVALS,
  HISTORY_RANGES,
  PRICE_BASES,
  PROVIDER_OPERATIONS,
  QUOTE_FIELD_CAPABILITIES,
} from "./constants.js";
import {
  hasOwn,
  isNonEmptyString,
  isObject,
  issue,
  requireEnum,
  requireObject,
  requireString,
  throwIfInvalid,
} from "./validation.js";

function collectSupportIssues(entry, path, issues) {
  if (!requireObject(entry, path, issues)) return false;
  requireEnum(entry, "support", CAPABILITY_SUPPORT_LEVELS, path, issues);
  return CAPABILITY_SUPPORT_LEVELS.includes(entry.support);
}

function collectFallbackIssues(entry, path, issues) {
  if (!hasOwn(entry, "fallback") || entry.fallback === undefined) return;
  const fallbackPath = `${path}.fallback`;
  if (!requireObject(entry.fallback, fallbackPath, issues)) return;
  if (!isNonEmptyString(entry.fallback.semanticMatch)) {
    issues.push(issue(`${fallbackPath}.semanticMatch`, "is required: fallback without an equivalence policy is not allowed"));
  }
  if (entry.support === "unsupported") {
    issues.push(issue(fallbackPath, "must not be declared on an unsupported operation"));
  }
}

function collectOperationIssues(operation, entry, path, issues, implementedOperations) {
  if (!collectSupportIssues(entry, path, issues)) return;
  collectFallbackIssues(entry, path, issues);

  if (entry.support !== "unsupported" && implementedOperations
    && implementedOperations[operation] === false) {
    issues.push(issue(`${path}.support`, `must be unsupported: ${operation} is not implemented by the provider`));
  }
  if (entry.support === "unsupported") return;

  if (operation === "quote" && hasOwn(entry, "fields") && entry.fields !== undefined) {
    const fieldsPath = `${path}.fields`;
    if (requireObject(entry.fields, fieldsPath, issues)) {
      for (const [field, level] of Object.entries(entry.fields)) {
        if (!QUOTE_FIELD_CAPABILITIES.includes(field)) {
          issues.push(issue(`${fieldsPath}.${field}`, `must be one of: ${QUOTE_FIELD_CAPABILITIES.join(", ")}`));
        }
        if (!CAPABILITY_SUPPORT_LEVELS.includes(level)) {
          issues.push(issue(`${fieldsPath}.${field}`, `must be one of: ${CAPABILITY_SUPPORT_LEVELS.join(", ")}`));
        }
      }
    }
  }

  if (operation === "history") {
    if (!Array.isArray(entry.priceBases) || !entry.priceBases.length
      || entry.priceBases.some((basis) => !PRICE_BASES.includes(basis))) {
      issues.push(issue(`${path}.priceBases`, `must be a non-empty subset of: ${PRICE_BASES.join(", ")}`));
    }
    if (!Array.isArray(entry.intervals) || !entry.intervals.length
      || entry.intervals.some((interval) => !HISTORY_INTERVALS.includes(interval))) {
      issues.push(issue(`${path}.intervals`, `must be a non-empty subset of: ${HISTORY_INTERVALS.join(", ")}`));
    }
    if (typeof entry.corporateActions !== "boolean") {
      issues.push(issue(`${path}.corporateActions`, "must be a boolean"));
    }
  }

  if (operation === "details") {
    if (!Array.isArray(entry.sections) || !entry.sections.length
      || entry.sections.some((section) => !DETAIL_SECTIONS.includes(section))) {
      issues.push(issue(`${path}.sections`, `must be a non-empty subset of: ${DETAIL_SECTIONS.join(", ")}`));
    }
  }
}

export function collectProviderManifestIssues(manifest, { implementedOperations, path = "manifest" } = {}) {
  const issues = [];
  if (!requireObject(manifest, path, issues)) return issues;
  requireString(manifest, "provider", path, issues);
  if (!Number.isInteger(manifest.manifestVersion) || manifest.manifestVersion < 1) {
    issues.push(issue(`${path}.manifestVersion`, "must be a positive integer"));
  }
  if (!requireObject(manifest.assets, `${path}.assets`, issues)) return issues;

  for (const [assetClass, operations] of Object.entries(manifest.assets)) {
    const assetPath = `${path}.assets.${assetClass}`;
    if (!MARKET_ASSET_CLASSES.includes(assetClass)) {
      issues.push(issue(assetPath, `must be one of: ${MARKET_ASSET_CLASSES.join(", ")}`));
      continue;
    }
    if (!requireObject(operations, assetPath, issues)) continue;
    for (const [operation, entry] of Object.entries(operations)) {
      const operationPath = `${assetPath}.${operation}`;
      if (!PROVIDER_OPERATIONS.includes(operation)) {
        issues.push(issue(operationPath, `must be one of: ${PROVIDER_OPERATIONS.join(", ")}`));
        continue;
      }
      collectOperationIssues(operation, entry, operationPath, issues, implementedOperations);
    }
  }
  return issues;
}

export function validateProviderCapabilityManifest(manifest, options = {}) {
  const issues = collectProviderManifestIssues(manifest, options);
  throwIfInvalid("ProviderCapabilityManifest", issues, options.code);
  return manifest;
}

export function collectEffectiveCapabilitiesIssues(value, path = "capabilities") {
  const issues = [];
  if (!requireObject(value, path, issues)) return issues;

  for (const operation of EFFECTIVE_CAPABILITY_OPERATIONS) {
    const entry = value[operation];
    const operationPath = `${path}.${operation}`;
    if (!requireObject(entry, operationPath, issues)) continue;
    requireEnum(entry, "status", CAPABILITY_SUPPORT_LEVELS, operationPath, issues);
    if (entry.status === "unsupported" && hasOwn(entry, "reason") && entry.reason !== undefined
      && !isNonEmptyString(entry.reason)) {
      issues.push(issue(`${operationPath}.reason`, "must be a non-empty string when provided"));
    }
    if (entry.status === "unsupported") continue;

    if (operation === "quote") {
      if (!isObject(entry.fields)) {
        issues.push(issue(`${operationPath}.fields`, "must declare product-facing quote fields"));
      } else {
        for (const [field, level] of Object.entries(entry.fields)) {
          if (!QUOTE_FIELD_CAPABILITIES.includes(field)) {
            issues.push(issue(`${operationPath}.fields.${field}`, `must be one of: ${QUOTE_FIELD_CAPABILITIES.join(", ")}`));
          }
          if (!CAPABILITY_SUPPORT_LEVELS.includes(level)) {
            issues.push(issue(`${operationPath}.fields.${field}`, `must be one of: ${CAPABILITY_SUPPORT_LEVELS.join(", ")}`));
          }
        }
      }
    }

    if (operation === "history") {
      if (!isObject(entry.ranges) || !Object.keys(entry.ranges).length) {
        issues.push(issue(`${operationPath}.ranges`, "must map ranges to supported intervals"));
      } else {
        for (const [range, intervals] of Object.entries(entry.ranges)) {
          if (!HISTORY_RANGES.includes(range)) {
            issues.push(issue(`${operationPath}.ranges.${range}`, `must be one of: ${HISTORY_RANGES.join(", ")}`));
          }
          if (!Array.isArray(intervals) || !intervals.length
            || intervals.some((interval) => !HISTORY_INTERVALS.includes(interval))) {
            issues.push(issue(`${operationPath}.ranges.${range}`, "must list supported intervals"));
          }
        }
      }
      if (!Array.isArray(entry.priceBases) || !entry.priceBases.length
        || entry.priceBases.some((basis) => !PRICE_BASES.includes(basis))) {
        issues.push(issue(`${operationPath}.priceBases`, `must be a non-empty subset of: ${PRICE_BASES.join(", ")}`));
      }
    }
    if (operation === "details") {
      if (!Array.isArray(entry.sections) || !entry.sections.length
        || entry.sections.some((section) => !DETAIL_SECTIONS.includes(section))) {
        issues.push(issue(`${operationPath}.sections`, `must be a non-empty subset of: ${DETAIL_SECTIONS.join(", ")}`));
      }
    }
  }

  for (const key of Object.keys(value)) {
    if (!EFFECTIVE_CAPABILITY_OPERATIONS.includes(key)) {
      issues.push(issue(`${path}.${key}`, `must be one of: ${EFFECTIVE_CAPABILITY_OPERATIONS.join(", ")}`));
    }
  }
  return issues;
}

export function validateEffectiveCapabilities(value, options = {}) {
  const issues = collectEffectiveCapabilitiesIssues(value, options.path || "capabilities");
  throwIfInvalid("EffectiveCapabilities", issues, options.code);
  return value;
}
