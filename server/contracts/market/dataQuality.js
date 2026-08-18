import {
  DATA_QUALITY_ISSUE_CODES,
  DATA_QUALITY_ISSUE_SEVERITIES,
  DATA_QUALITY_STATUSES,
  SURFACE_QUALITIES,
} from "./constants.js";
import {
  hasOwn,
  isFiniteNumber,
  isNonEmptyString,
  isObject,
  issue,
  requireEnum,
  requireObject,
  throwIfInvalid,
} from "./validation.js";

const COUNTER_FIELDS = ["rowCount", "droppedRows", "missingAdjustedCloseRows"];

export function collectDataQualityIssues(value, path = "dataQuality") {
  const issues = [];
  if (!requireObject(value, path, issues)) return issues;
  requireEnum(value, "status", DATA_QUALITY_STATUSES, path, issues);

  if (!Array.isArray(value.issues)) {
    issues.push(issue(`${path}.issues`, "must be an array"));
  } else {
    value.issues.forEach((entry, index) => {
      const entryPath = `${path}.issues[${index}]`;
      if (!requireObject(entry, entryPath, issues)) return;
      requireEnum(entry, "code", DATA_QUALITY_ISSUE_CODES, entryPath, issues);
      requireEnum(entry, "severity", DATA_QUALITY_ISSUE_SEVERITIES, entryPath, issues);
      if (entry.field !== null && !isNonEmptyString(entry.field)) {
        issues.push(issue(`${entryPath}.field`, "must be a field name or null"));
      }
    });
  }

  if (value.status === "usable" && Array.isArray(value.issues)
    && value.issues.some((entry) => isObject(entry) && entry.severity === "error")) {
    issues.push(issue(`${path}.status`, "must not be usable while error issues are present"));
  }

  for (const field of COUNTER_FIELDS) {
    if (hasOwn(value, field) && value[field] !== undefined
      && (!isFiniteNumber(value[field]) || value[field] < 0 || !Number.isInteger(value[field]))) {
      issues.push(issue(`${path}.${field}`, "must be a non-negative integer when provided"));
    }
  }
  return issues;
}

export function validateDataQuality(value, options = {}) {
  const issues = collectDataQualityIssues(value, options.path || "dataQuality");
  throwIfInvalid("DataQuality", issues, options.code);
  return value;
}

export function collectSurfaceQualityIssues(container, path) {
  const issues = [];
  requireEnum(container, "quality", SURFACE_QUALITIES, path, issues);
  return issues;
}
