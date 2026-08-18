import { ERROR_CODES } from "../core/constants.js";
import { MarketDataError } from "../../errors/MarketDataError.js";

export const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
export const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

export function isIsoTimestamp(value) {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export function issue(path, message) {
  return { path, message };
}

export function requireObject(value, path, issues) {
  if (isObject(value)) return true;
  issues.push(issue(path, "must be an object"));
  return false;
}

export function requireString(value, key, path, issues) {
  if (!isNonEmptyString(value[key])) issues.push(issue(`${path}.${key}`, "must be a non-empty string"));
}

export function optionalString(value, key, path, issues) {
  if (hasOwn(value, key) && value[key] !== undefined && value[key] !== null && !isNonEmptyString(value[key])) {
    issues.push(issue(`${path}.${key}`, "must be a non-empty string when provided"));
  }
}

export function requireEnum(value, key, allowed, path, issues) {
  if (!allowed.includes(value[key])) {
    issues.push(issue(`${path}.${key}`, `must be one of: ${allowed.join(", ")}`));
  }
}

export function requireNullableNumber(value, key, path, issues) {
  const candidate = value[key];
  if (!hasOwn(value, key) || !(candidate === null || isFiniteNumber(candidate))) {
    issues.push(issue(`${path}.${key}`, "must be a finite number or null"));
  }
}

export function requireTimestamp(value, key, path, issues) {
  if (!isIsoTimestamp(value[key])) issues.push(issue(`${path}.${key}`, "must be an ISO-8601 timestamp"));
}

export function requireNullableTimestamp(value, key, path, issues) {
  if (value[key] !== null && !isIsoTimestamp(value[key])) {
    issues.push(issue(`${path}.${key}`, "must be an ISO-8601 timestamp or null"));
  }
}

export function throwIfInvalid(contract, issues, code = ERROR_CODES.SCHEMA_INVALID) {
  if (!issues.length) return;
  throw new MarketDataError(code, `${contract} failed runtime validation`, {
    details: { contract, issues },
  });
}
