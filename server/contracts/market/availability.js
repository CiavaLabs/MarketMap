import {
  FIELD_AVAILABILITY_STATUSES,
  VALUE_BEARING_AVAILABILITY,
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

const REASON_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
const REASON_REQUIRED = new Set(["not_applicable", "unsupported", "invalid"]);

export function availabilityEntry(status, reason) {
  return reason ? { status, reason } : { status };
}

export function collectFieldAvailabilityIssues(entry, path) {
  const issues = [];
  if (!requireObject(entry, path, issues)) return issues;
  requireEnum(entry, "status", FIELD_AVAILABILITY_STATUSES, path, issues);
  if (hasOwn(entry, "reason") && entry.reason !== undefined) {
    if (!isNonEmptyString(entry.reason) || !REASON_PATTERN.test(entry.reason)) {
      issues.push(issue(`${path}.reason`, "must be a snake_case reason code"));
    }
  } else if (REASON_REQUIRED.has(entry.status)) {
    issues.push(issue(`${path}.reason`, `is required when status is ${entry.status}`));
  }
  return issues;
}

export function validateFieldAvailability(entry, options = {}) {
  const issues = collectFieldAvailabilityIssues(entry, options.path || "fieldAvailability");
  throwIfInvalid("FieldAvailability", issues, options.code);
  return entry;
}

export function collectAvailabilityInvariantIssues({
  values,
  fieldAvailability,
  fields,
  path = "fieldAvailability",
}) {
  const issues = [];
  if (!requireObject(fieldAvailability, path, issues)) return issues;

  for (const key of Object.keys(fieldAvailability)) {
    if (!fields.includes(key)) {
      issues.push(issue(`${path}.${key}`, "does not correspond to a contract field"));
      continue;
    }
    issues.push(...collectFieldAvailabilityIssues(fieldAvailability[key], `${path}.${key}`));
  }

  for (const field of fields) {
    const value = isObject(values) ? values[field] : undefined;
    const entry = fieldAvailability[field];
    if (value === null || value === undefined) {
      if (!isObject(entry)) {
        issues.push(issue(`${path}.${field}`, "is required to explain a null field"));
      } else if (VALUE_BEARING_AVAILABILITY.includes(entry.status)) {
        issues.push(issue(`${path}.${field}.status`, "must not certify a value for a null field"));
      }
    } else if (isObject(entry)
      && VALUE_BEARING_AVAILABILITY.includes(entry.status)
      && !isFiniteNumber(value) && !isNonEmptyString(value)) {
      issues.push(issue(`${path}.${field}.status`, "certifies a value that is not usable"));
    }
  }
  return issues;
}

export function validateAvailabilityInvariants(input, options = {}) {
  const issues = collectAvailabilityInvariantIssues(input);
  throwIfInvalid("FieldAvailabilityInvariants", issues, options.code);
  return input.fieldAvailability;
}
