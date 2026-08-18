import { createHash } from "node:crypto";

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function canonicalJson(value, path = "value", ancestors = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} must contain finite numbers`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
    ancestors.add(value);
    const serialized = `[${value.map((entry, index) => (
      canonicalJson(entry === undefined ? null : entry, `${path}[${index}]`, ancestors)
    )).join(",")}]`;
    ancestors.delete(value);
    return serialized;
  }
  if (!isPlainObject(value)) {
    throw new TypeError(`${path} must contain only plain JSON values`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} must not contain cycles`);
  ancestors.add(value);
  const entries = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`, ancestors)}`
    ));
  ancestors.delete(value);
  return `{${entries.join(",")}}`;
}

export function analyticsSha256(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
