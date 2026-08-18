#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { YahooClient } from "../server/providers/yahoo/yahooClient.js";

import { ERROR_CODE_VALUES } from "../server/contracts/core/constants.js";
import { InstrumentCatalog } from "../server/instruments/InstrumentCatalog.js";
import { descriptorFromLegacyInstrument } from "../server/instruments/descriptorFactory.js";
import { FinnhubProvider } from "../server/providers/finnhub/FinnhubProvider.js";
import { YahooProvider } from "../server/providers/yahoo/YahooProvider.js";

const LIVE_OPT_IN = "MARKET_CANARY_LIVE";
const DEFAULT_OPERATIONS = Object.freeze(["quote", "history", "details"]);
const ALLOWED_OPERATIONS = new Set(DEFAULT_OPERATIONS);
const REPRESENTATIVE_IDS = Object.freeze([
  "XNAS:AAPL",
  "ARCX:SPY",
  "XNAS:BND",
  "INDEX:^GSPC",
  "FX:EURUSD",
  "CRYPTO:BTC-USD",
  "FUTURE:CMX.GC.CONTINUOUS.1",
  "RATE:^TNX",
]);
const SENSITIVE_KEY = /(?:token|api[-_]?key|authorization|credential|password|secret)/iu;
const SAFE_ERROR_CODES = new Set(ERROR_CODE_VALUES);

function loadLocalEnvironment() {
  try {
    process.loadEnvFile?.(resolve(process.cwd(), ".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function stableHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 24);
}

function safeShapeKey(value) {
  const key = `${value}`;
  if (SENSITIVE_KEY.test(key)) return "<redacted-key>";
  if (/^\d{6,}$/u.test(key)) return "<dynamic-key>";
  return key.length <= 80 ? key : "<long-key>";
}

function valueKind(value) {
  if (value === null) return "null";
  if (value instanceof Date) return "date";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

export function shapeMetadata(value, { maxDepth = 7, maxPaths = 400 } = {}) {
  const paths = [];
  let sensitiveKeysRedacted = 0;

  const visit = (candidate, path, depth) => {
    const kind = valueKind(candidate);
    paths.push(`${path}:${kind}`);
    if (depth >= maxDepth || candidate === null || kind === "date") return;
    if (Array.isArray(candidate)) {
      if (candidate.length) visit(candidate[0], `${path}[]`, depth + 1);
      return;
    }
    if (kind !== "object") return;
    for (const rawKey of Object.keys(candidate).sort()) {
      const key = safeShapeKey(rawKey);
      if (key === "<redacted-key>") sensitiveKeysRedacted += 1;
      visit(candidate[rawKey], `${path}.${key}`, depth + 1);
    }
  };

  visit(value, "$", 0);
  const uniquePaths = [...new Set(paths)].sort();
  const retainedPaths = uniquePaths.slice(0, maxPaths);
  return Object.freeze({
    rootKind: valueKind(value),
    pathCount: uniquePaths.length,
    truncated: uniquePaths.length > retainedPaths.length,
    sensitiveKeysRedacted,
    keySetHash: stableHash(uniquePaths),
    paths: retainedPaths,
  });
}

function createYahooObserver(client) {
  let active = null;
  const record = (transport, payload) => {
    if (active) active.push({ transport, ...shapeMetadata(payload) });
  };
  const delegate = (method) => async (...args) => {
    const payload = await client[method](...args);
    record(method, payload);
    return payload;
  };
  return {
    client: {
      quote: delegate("quote"),
      chart: delegate("chart"),
      quoteSummary: delegate("quoteSummary"),
      search: delegate("search"),
    },
    start() {
      active = [];
    },
    finish() {
      const result = active || [];
      active = null;
      return result;
    },
  };
}

function createFinnhubObserver(fetchImplementation) {
  let active = null;
  return {
    async fetch(_url, options) {
      const response = await fetchImplementation(_url, options);
      if (active) {
        try {
          const payload = await response.clone().json();
          active.push({
            transport: "http-json",
            httpStatus: Number(response.status) || null,
            ...shapeMetadata(payload),
          });
        } catch {
          active.push({
            transport: "http-non-json",
            httpStatus: Number(response.status) || null,
            rootKind: "unknown",
            pathCount: 0,
            truncated: false,
            sensitiveKeysRedacted: 0,
            keySetHash: stableHash([]),
            paths: [],
          });
        }
      }
      return response;
    },
    start() {
      active = [];
    },
    finish() {
      const result = active || [];
      active = null;
      return result;
    },
  };
}

function timestampState(value, now) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "invalid";
  if (timestamp > now + 5 * 60_000) return "future";
  if (timestamp < now - 7 * 24 * 60 * 60_000) return "older_than_7d";
  return "valid";
}

function availabilitySummary(fieldAvailability = {}) {
  const counts = {};
  for (const entry of Object.values(fieldAvailability)) {
    const status = typeof entry?.status === "string" ? entry.status : "missing";
    counts[status] = (counts[status] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function issueCodes(surface) {
  return [...new Set((surface?.dataQuality?.issues || [])
    .map((issue) => `${issue?.code || ""}`)
    .filter((code) => /^[a-z][a-z0-9_]{0,63}$/u.test(code)))]
    .sort();
}

export function summarizeQuote(quote, now = Date.now()) {
  return {
    contract: "QuoteSnapshot",
    normalizedShape: shapeMetadata(quote),
    quality: quote.quality,
    dataQualityStatus: quote.dataQuality?.status || "missing",
    issueCodes: issueCodes(quote),
    availability: availabilitySummary(quote.fieldAvailability),
    timestamps: {
      asOf: timestampState(quote.asOf, now),
      fetchedAt: timestampState(quote.fetchedAt, now),
    },
  };
}

export function summarizeHistory(history, now = Date.now()) {
  const timestamps = (history.bars || []).map((bar) => Date.parse(bar?.timestamp));
  const monotonic = timestamps.every((timestamp, index) => (
    Number.isFinite(timestamp) && (index === 0 || timestamp > timestamps[index - 1])
  ));
  const droppedRows = Number(history.dataQuality?.droppedRows) || 0;
  const acceptedRows = Array.isArray(history.bars) ? history.bars.length : 0;
  return {
    contract: "HistorySeries",
    normalizedShape: shapeMetadata(history),
    range: history.range,
    interval: history.interval,
    priceBasis: history.priceBasis,
    adjustmentStatus: history.adjustment?.status || "missing",
    continuityKind: history.continuity?.kind || "missing",
    quality: history.quality,
    dataQualityStatus: history.dataQuality?.status || "missing",
    issueCodes: issueCodes(history),
    acceptedRows,
    droppedRows,
    droppedRowRatio: acceptedRows + droppedRows
      ? Number((droppedRows / (acceptedRows + droppedRows)).toFixed(6))
      : 0,
    timestamps: {
      asOf: timestampState(history.asOf, now),
      fetchedAt: timestampState(history.fetchedAt, now),
      barsStrictlyAscending: monotonic,
    },
  };
}

export function summarizeDetails(details, now = Date.now()) {
  return {
    contract: "InstrumentDetails",
    normalizedShape: shapeMetadata(details),
    kind: details.kind,
    quality: details.quality,
    dataQualityStatus: details.dataQuality?.status || "missing",
    issueCodes: issueCodes(details),
    sections: (details.sections || []).map((section) => ({
      id: section.id,
      status: section.status,
      fieldKeys: Object.keys(section.fields || {}).sort(),
    })),
    timestamps: {
      asOf: timestampState(details.asOf, now),
      fetchedAt: timestampState(details.fetchedAt, now),
    },
  };
}

export function sanitizeFailure(error) {
  const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : "canary_probe_failed";
  const provider = ["yahoo", "finnhub"].includes(error?.provider) ? error.provider : null;
  const capability = ["quote", "history", "details"].includes(error?.capability)
    ? error.capability
    : null;
  return {
    code,
    retryable: error?.retryable === true,
    ...(provider ? { provider } : {}),
    ...(capability ? { capability } : {}),
  };
}

async function withDeadline(timeoutMs, task) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error("Provider canary deadline exceeded");
      error.code = "timeout";
      error.retryable = true;
      reject(error);
    }, timeoutMs);
  });
  timer.unref?.();
  try {
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function firstResult(batch) {
  if (batch?.data?.[0]) return batch.data[0];
  if (batch?.errors?.[0]) throw batch.errors[0];
  const error = new Error("Canary provider returned no item outcome");
  error.code = "canary_probe_failed";
  throw error;
}

async function runObservedProbe({ observer, provider, operation, descriptor, timeoutMs, task, summarize }) {
  observer.start();
  try {
    const value = await withDeadline(timeoutMs, task);
    return {
      provider,
      operation,
      instrumentId: descriptor.id,
      assetClass: descriptor.assetClass,
      status: "passed",
      result: summarize(value),
      rawShapes: observer.finish(),
    };
  } catch (error) {
    return {
      provider,
      operation,
      instrumentId: descriptor.id,
      assetClass: descriptor.assetClass,
      status: "failed",
      error: sanitizeFailure(error),
      rawShapes: observer.finish(),
    };
  }
}

function baselineIndex(report) {
  return new Map((report?.probes || []).map((probe) => [
    `${probe.provider}:${probe.operation}:${probe.instrumentId}`,
    probe,
  ]));
}

function safeTransportName(value) {
  const name = `${value || ""}`;
  return ["quote", "chart", "quoteSummary", "search", "http-json", "http-non-json"].includes(name)
    ? name
    : "unknown";
}

export function compareWithBaseline(report, baseline) {
  if (!baseline) return report;
  const previous = baselineIndex(baseline);
  const probes = report.probes.map((probe) => {
    const before = previous.get(`${probe.provider}:${probe.operation}:${probe.instrumentId}`);
    if (!before) return { ...probe, schemaDiff: { state: "new" } };
    const priorHashes = (before.rawShapes || []).map(({ transport, keySetHash }) => `${safeTransportName(transport)}:${keySetHash}`);
    const currentHashes = (probe.rawShapes || []).map(({ transport, keySetHash }) => `${safeTransportName(transport)}:${keySetHash}`);
    const changed = JSON.stringify(priorHashes) !== JSON.stringify(currentHashes);
    return {
      ...probe,
      schemaDiff: {
        state: changed ? "changed" : "unchanged",
        ...(changed ? {
          changedTransports: [...new Set([
            ...(before.rawShapes || []).map(({ transport }) => safeTransportName(transport)),
            ...(probe.rawShapes || []).map(({ transport }) => safeTransportName(transport)),
          ])].sort(),
        } : {}),
      },
    };
  });
  return { ...report, probes };
}

function canaryAlerts(probes) {
  const alerts = [];
  for (const probe of probes) {
    if (probe.status === "failed") {
      alerts.push({
        provider: probe.provider,
        operation: probe.operation,
        instrumentId: probe.instrumentId,
        code: probe.error?.code || "canary_probe_failed",
      });
    }
    if (probe.schemaDiff?.state === "changed") {
      alerts.push({
        provider: probe.provider,
        operation: probe.operation,
        instrumentId: probe.instrumentId,
        code: "raw_shape_changed",
      });
    }
    for (const code of probe.result?.issueCodes || []) {
      if (["provider_type_conflict", "missing_required_field"].includes(code)) {
        alerts.push({
          provider: probe.provider,
          operation: probe.operation,
          instrumentId: probe.instrumentId,
          code,
        });
      }
    }
    if ((probe.result?.droppedRowRatio || 0) > 0) {
      alerts.push({
        provider: probe.provider,
        operation: probe.operation,
        instrumentId: probe.instrumentId,
        code: "history_rows_dropped",
      });
    }
  }
  return alerts;
}

function normalizeOperations(value) {
  const operations = `${value || DEFAULT_OPERATIONS.join(",")}`
    .split(",")
    .map((operation) => operation.trim().toLowerCase())
    .filter(Boolean);
  if (!operations.length || operations.some((operation) => !ALLOWED_OPERATIONS.has(operation))) {
    throw new TypeError("MARKET_CANARY_OPERATIONS contains an unsupported operation");
  }
  return [...new Set(operations)];
}

function normalizeTimeout(value) {
  const timeoutMs = Number(value || 12_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new TypeError("MARKET_CANARY_TIMEOUT_MS must be between 1000 and 60000");
  }
  return timeoutMs;
}

async function readBaseline(path) {
  if (!path) return null;
  try {
    const parsed = JSON.parse(await readFile(resolve(path), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function runProviderCanary({
  operations = DEFAULT_OPERATIONS,
  timeoutMs = 12_000,
  finnhubApiKey = "",
  includeFinnhub = false,
  baseline = null,
  now = Date.now,
  yahooClient = null,
  fetchImplementation = globalThis.fetch,
} = {}) {
  const nowValue = typeof now === "function" ? now() : now;
  const generatedAtMs = new Date(nowValue).getTime();
  if (!Number.isFinite(generatedAtMs)) throw new TypeError("Canary clock must return a valid timestamp");
  if (includeFinnhub && !`${finnhubApiKey}`.trim()) {
    throw new TypeError("MARKET_CANARY_FINNHUB=1 requires FINNHUB_API_KEY");
  }
  const generatedAt = new Date(generatedAtMs).toISOString();
  const catalog = new InstrumentCatalog();
  const descriptors = REPRESENTATIVE_IDS.map((id) => descriptorFromLegacyInstrument(
    catalog.resolve(id),
    { verifiedAt: generatedAt },
  ));

  const rawYahoo = yahooClient || new YahooClient();
  const yahooObserver = createYahooObserver(rawYahoo);
  const yahoo = new YahooProvider({ client: yahooObserver.client, clock: now });
  const probes = [];

  for (const descriptor of descriptors) {
    if (operations.includes("quote")) {
      probes.push(await runObservedProbe({
        observer: yahooObserver,
        provider: "yahoo",
        operation: "quote",
        descriptor,
        timeoutMs,
        task: async (signal) => firstResult(await yahoo.quoteMany([descriptor], { signal })),
        summarize: (quote) => summarizeQuote(quote, generatedAtMs),
      }));
    }
    if (operations.includes("history")) {
      probes.push(await runObservedProbe({
        observer: yahooObserver,
        provider: "yahoo",
        operation: "history",
        descriptor,
        timeoutMs,
        task: (signal) => yahoo.history(descriptor, {
          range: "5d",
          interval: "15m",
          priceBasis: "raw",
          signal,
        }),
        summarize: (history) => summarizeHistory(history, generatedAtMs),
      }));
    }
    if (operations.includes("details")) {
      probes.push(await runObservedProbe({
        observer: yahooObserver,
        provider: "yahoo",
        operation: "details",
        descriptor,
        timeoutMs,
        task: (signal) => yahoo.details(descriptor, { signal }),
        summarize: (details) => summarizeDetails(details, generatedAtMs),
      }));
    }
  }

  if (includeFinnhub && finnhubApiKey) {
    if (typeof fetchImplementation !== "function") {
      throw new TypeError("A fetch implementation is required for the Finnhub canary");
    }
    const descriptor = descriptors.find(({ id }) => id === "XNAS:AAPL");
    const finnhubObserver = createFinnhubObserver(fetchImplementation);
    const finnhub = new FinnhubProvider({
      apiKey: finnhubApiKey,
      fetch: finnhubObserver.fetch,
      clock: now,
      maxConcurrency: 1,
    });
    probes.push(await runObservedProbe({
      observer: finnhubObserver,
      provider: "finnhub",
      operation: "quote",
      descriptor,
      timeoutMs,
      task: async (signal) => firstResult(await finnhub.quoteMany([descriptor], {
        signal,
        fallbackContextById: new Map([[descriptor.id, {
          fromProvider: "yahoo",
          errorCode: "upstream_unavailable",
          semanticMatch: "raw_quote",
        }]]),
      })),
      summarize: (quote) => summarizeQuote(quote, generatedAtMs),
    }));
  }

  let report = {
    schemaVersion: 1,
    generatedAt,
    mode: "live",
    operations: [...operations],
    representativeAssetClasses: [...new Set(descriptors.map(({ assetClass }) => assetClass))],
    providers: ["yahoo", ...(includeFinnhub && finnhubApiKey ? ["finnhub"] : [])],
    probes,
  };
  report = compareWithBaseline(report, baseline);
  const alerts = canaryAlerts(report.probes);
  return {
    ...report,
    summary: {
      status: alerts.length ? "attention" : "passed",
      passed: report.probes.filter(({ status }) => status === "passed").length,
      failed: report.probes.filter(({ status }) => status === "failed").length,
      schemaChanges: report.probes.filter(({ schemaDiff }) => schemaDiff?.state === "changed").length,
      alertCount: alerts.length,
    },
    alerts,
  };
}

export function assertSanitizedReport(report, secrets = []) {
  const serialized = JSON.stringify(report);
  if (/token=/iu.test(serialized) || /https?:\/\//iu.test(serialized)) {
    throw new Error("Canary report contains a URL or token query");
  }
  for (const secret of secrets) {
    if (`${secret || ""}`.length >= 4 && serialized.includes(`${secret}`)) {
      throw new Error("Canary report contains configured secret material");
    }
  }
  return report;
}

async function writeSanitizedReport(path, report) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
}

async function withProviderConsoleMuted(task) {
  const methods = ["log", "info", "warn", "error", "debug"];
  const original = Object.fromEntries(methods.map((method) => [method, console[method]]));
  for (const method of methods) console[method] = () => {};
  try {
    return await task();
  } finally {
    for (const method of methods) console[method] = original[method];
  }
}

async function main() {
  loadLocalEnvironment();
  if (process.env[LIVE_OPT_IN] !== "1") {
    console.log(`Provider canary skipped: set ${LIVE_OPT_IN}=1 to opt in to live network probes.`);
    return;
  }

  const operations = normalizeOperations(process.env.MARKET_CANARY_OPERATIONS);
  const timeoutMs = normalizeTimeout(process.env.MARKET_CANARY_TIMEOUT_MS);
  const baseline = await readBaseline(process.env.MARKET_CANARY_BASELINE);
  const includeFinnhub = process.env.MARKET_CANARY_FINNHUB === "1";
  const finnhubApiKey = process.env.FINNHUB_API_KEY || "";
  const report = assertSanitizedReport(await withProviderConsoleMuted(() => runProviderCanary({
    operations,
    timeoutMs,
    baseline,
    includeFinnhub,
    finnhubApiKey,
  })), [finnhubApiKey]);

  if (process.env.MARKET_CANARY_OUTPUT) {
    await writeSanitizedReport(process.env.MARKET_CANARY_OUTPUT, report);
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.status !== "passed") process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({
      schemaVersion: 1,
      mode: "live",
      summary: { status: "failed" },
      error: sanitizeFailure(error),
    }));
    process.exitCode = 1;
  });
}
