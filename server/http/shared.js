import { createHash } from "node:crypto";
import {
  CANONICAL_INSTRUMENT_ID_PATTERN,
  ERROR_CODES,
} from "../contracts/core/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-cache",
};

export function resolveRequestId(request, requestIdFactory) {
  const supplied = request.headers.get("x-request-id");
  if (supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return String(requestIdFactory());
}

export function normalizeBasePath(path, fallback) {
  const value = String(path || fallback).replace(/\/+$/, "");
  return value.startsWith("/") ? value : `/${value}`;
}

export function invalid(message, details) {
  return new MarketDataError(ERROR_CODES.INVALID_REQUEST, message, {
    status: 400,
    retryable: false,
    details,
  });
}

export function splitIds(searchParams) {
  return [...new Set(searchParams.getAll("ids")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.toUpperCase()))];
}

export function validateInstrumentId(value) {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  if (
    typeof value !== "string"
    || value.length < 3
    || value.length > 191
    || !CANONICAL_INSTRUMENT_ID_PATTERN.test(normalized)
  ) {
    throw invalid("A valid canonical instrument ID is required", { field: "id" });
  }
  return normalized;
}

function bodyHash(body) {
  return `W/"${createHash("sha256").update(body).digest("base64url")}"`;
}

function weakEtagValue(value) {
  return `${value || ""}`.trim().replace(/^W\//, "");
}

function ifNoneMatchMatches(header, etag) {
  if (!header) return false;
  return header
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || weakEtagValue(value) === weakEtagValue(etag));
}

export function jsonResponse(payload, { status = 200, request, headers = {}, etagValue } = {}) {
  const body = JSON.stringify(payload);
  const etag = bodyHash(JSON.stringify(etagValue ?? payload));
  if (ifNoneMatchMatches(request?.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { etag, ...headers } });
  }
  return new Response(body, {
    status,
    headers: { ...jsonHeaders, etag, ...headers },
  });
}

export function normalizeServiceResult(result) {
  if (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && (Object.hasOwn(result, "data") || Object.hasOwn(result, "errors"))
  ) {
    return result;
  }
  return { data: result };
}

export function errorRetryAfterSeconds(error) {
  const seconds = error?.details?.retryAfterSeconds;
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const milliseconds = error?.details?.retryAfterMs;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 1_000 : null;
}

export function problemResponse(error, { request, requestId, headers: extraHeaders = {} }) {
  const normalized = MarketDataError.from(error);
  const headers = {
    "content-type": "application/problem+json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };
  const retryAfter = errorRetryAfterSeconds(normalized);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    headers["retry-after"] = String(Math.ceil(retryAfter));
  }
  if (normalized.status === 405) headers.allow = "GET";
  return new Response(JSON.stringify(normalized.toProblem({
    instance: new URL(request.url).pathname,
    requestId,
  })), { status: normalized.status, headers });
}
