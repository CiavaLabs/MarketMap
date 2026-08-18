import { PROVENANCE_SOURCES } from "./constants.js";
import {
  hasOwn,
  isNonEmptyString,
  issue,
  optionalString,
  requireEnum,
  requireObject,
  requireString,
  throwIfInvalid,
} from "./validation.js";

export function collectProvenanceIssues(value, path = "provenance") {
  const issues = [];
  if (!requireObject(value, path, issues)) return issues;
  requireEnum(value, "source", PROVENANCE_SOURCES, path, issues);
  requireString(value, "providerSymbol", path, issues);
  optionalString(value, "providerType", path, issues);
  if (typeof value.fallback !== "boolean") {
    issues.push(issue(`${path}.fallback`, "must be a boolean"));
  }
  if (value.fallback === true) {
    if (!PROVENANCE_SOURCES.includes(value.fallbackFrom) || value.fallbackFrom === value.source) {
      issues.push(issue(`${path}.fallbackFrom`, "must name the failed primary provider"));
    }
    for (const key of ["fallbackReason", "semanticMatch"]) {
      if (!isNonEmptyString(value[key])) {
        issues.push(issue(`${path}.${key}`, "is required for a fallback response"));
      }
    }
  } else {
    for (const key of ["fallbackFrom", "fallbackReason", "semanticMatch"]) {
      if (hasOwn(value, key) && value[key] !== undefined && value[key] !== null) {
        issues.push(issue(`${path}.${key}`, "is only valid for a fallback response"));
      }
    }
  }
  if (hasOwn(value, "originalSource") && value.originalSource !== undefined
    && !PROVENANCE_SOURCES.includes(value.originalSource)) {
    issues.push(issue(`${path}.originalSource`, `must be one of: ${PROVENANCE_SOURCES.join(", ")}`));
  }
  return issues;
}

export function validateProvenance(value, options = {}) {
  const issues = collectProvenanceIssues(value, options.path || "provenance");
  throwIfInvalid("Provenance", issues, options.code);
  return value;
}
