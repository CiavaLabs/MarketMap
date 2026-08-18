import { open, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";

import { STARTER_INSTRUMENTS } from "../src/data/workspaces.js";
import { InMemoryAnalyticsStore } from "./analytics/persistence/InMemoryAnalyticsStore.js";
import { createMarketDataService } from "./createMarketDataService.js";
import { devMovementCohort, devRunInstant, startDevAnalyticsBootstrap } from "./devAnalytics.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export const PUBLIC_PREFIXES = Object.freeze(["/css/", "/src/", "/shared/", "/assets/"]);

const DEFAULT_IMG_SOURCES = "'self' data:";
const IMG_SOURCE_PATTERN = /^[A-Za-z0-9:/.*'_ -]{1,512}$/;

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
});

function loadLocalEnvironment() {
  try {
    process.loadEnvFile?.(resolve(PROJECT_ROOT, ".env"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function commaSeparated(value) {
  const entries = `${value || ""}`.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries.length ? [...new Set(entries)] : undefined;
}

function optionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function imageSources(value) {
  const requested = `${value ?? ""}`.trim();
  if (!requested) return DEFAULT_IMG_SOURCES;
  if (!IMG_SOURCE_PATTERN.test(requested)) {
    throw new TypeError("MARKET_DEV_IMG_SRC must be a content-security-policy source list");
  }
  return requested;
}

function securityHeaders(contentType, imgSources) {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "content-security-policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src ${imgSources}; font-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'`,
  };
}

const MISSING_FILE_CODES = new Set(["ENOENT", "ENOTDIR", "EISDIR", "ENAMETOOLONG"]);

async function closeQuietly(fileHandle) {
  try {
    await fileHandle?.close();
  } catch {}
}

async function serveStatic(request, response, url, imgSources) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid URL encoding");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const isPublicPath = pathname === "/index.html"
    || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
  if (!isPublicPath) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }
  const filePath = resolve(PROJECT_ROOT, `.${pathname}`);
  const publicRoot = pathname === "/index.html"
    ? PROJECT_ROOT
    : resolve(PROJECT_ROOT, pathname.split("/")[1]);
  const isInsidePublicRoot = pathname === "/index.html"
    ? filePath === resolve(PROJECT_ROOT, "index.html")
    : filePath.startsWith(`${publicRoot}${sep}`);
  if (!isInsidePublicRoot) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  let fileHandle = null;
  let fileStat;
  try {
    const [resolvedFile, resolvedPublicRoot] = await Promise.all([
      realpath(filePath),
      realpath(publicRoot),
    ]);
    if (
      resolvedFile !== resolvedPublicRoot
      && !resolvedFile.startsWith(`${resolvedPublicRoot}${sep}`)
    ) {
      response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }
    fileHandle = await open(resolvedFile, "r");
    fileStat = await fileHandle.stat();
  } catch (error) {
    await closeQuietly(fileHandle);
    const missing = MISSING_FILE_CODES.has(error?.code);
    if (!missing) console.error("Static file could not be opened", error);
    response.writeHead(missing ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
    response.end(missing ? "Not found" : "Internal server error");
    return;
  }
  if (!fileStat.isFile()) {
    await closeQuietly(fileHandle);
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
  response.writeHead(200, {
    ...securityHeaders(contentType, imgSources),
    "content-length": fileStat.size,
    "cache-control": "no-cache",
  });
  if (request.method === "HEAD") {
    await closeQuietly(fileHandle);
    response.end();
    return;
  }
  const stream = fileHandle.createReadStream({ autoClose: true });
  stream.once("error", (error) => {
    console.error("Static file could not be streamed", error);
    response.destroy();
  });
  response.once("close", () => stream.destroy());
  stream.pipe(response);
}

async function writeWebResponse(nodeResponse, webResponse, method) {
  nodeResponse.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  if (method === "HEAD" || webResponse.status === 304) {
    nodeResponse.end();
    return;
  }
  const body = Buffer.from(await webResponse.arrayBuffer());
  nodeResponse.end(body);
}

export async function startDevServer(options = {}) {
  loadLocalEnvironment();
  const host = options.host || process.env.HOST || "127.0.0.1";
  const requestedPort = Number(options.port ?? process.env.PORT ?? 6060);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new TypeError("PORT must be an integer between 0 and 65535");
  }

  const imgSources = imageSources(options.imageSources ?? process.env.MARKET_DEV_IMG_SRC);
  const analyticsEnabled = options.analytics ?? process.env.MARKET_ANALYTICS === "1";
  const market = options.market || createMarketDataService({
    finnhubApiKey: process.env.FINNHUB_API_KEY || "",
    logLevel: process.env.MARKET_LOG_LEVEL || "info",
    enabledAssetClasses: commaSeparated(process.env.MARKET_ENABLED_ASSET_CLASSES),
    maxBatchIds: optionalPositiveInteger(process.env.MARKET_MAX_BATCH_IDS, "MARKET_MAX_BATCH_IDS"),
    exposeHealthInternals: true,
    ...(analyticsEnabled
      ? {
        analyticsStore: new InMemoryAnalyticsStore(),
        historyBatchConcurrency: 4,
        analyticsConfig: {
          equityInstrumentIds: devMovementCohort(STARTER_INSTRUMENTS),
          clock: () => devRunInstant(),
        },
      }
      : {}),
  });
  const server = createServer(async (request, response) => {
    let url;
    try {
      url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${requestedPort}`}`);
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Invalid request target");
      return;
    }
    try {
      if (
        url.pathname === "/api/market/v1"
        || url.pathname.startsWith("/api/market/v1/")
      ) {
        const abortController = new AbortController();
        request.once("aborted", () => abortController.abort());
        const webRequest = new Request(url, {
          method: request.method,
          headers: request.headers,
          signal: abortController.signal,
        });
        await writeWebResponse(response, await market.handleRequest(webRequest), request.method);
        return;
      }
      await serveStatic(request, response, url, imgSources);
    } catch (error) {
      console.error("Development server request failed", error);
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      response.end("Internal server error");
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(requestedPort, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;
  const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;
  const health = market.getHealth();
  console.log(`Market Map running at http://${displayHost}:${port}`);
  console.log(`Market API: http://${displayHost}:${port}/api/market/v1/health`);
  console.log(`Providers: ${Object.entries(health.providers || {}).map(([id, value]) => `${id}:${value.enabled ? "on" : "off"}`).join(", ") || "none"}`);
  console.log(`Persistence: ${health.persistence?.adapter || "none"}`);

  const analyticsReady = typeof market.runDailyAnalytics === "function"
    ? startDevAnalyticsBootstrap({ market, delayMs: options.analyticsDelayMs })
    : null;
  if (!analyticsReady) console.log("Analytics: off (start with --analytics)");

  const close = async () => {
    await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
    await market.close?.();
  };
  return { server, market, url: `http://${displayHost}:${port}`, analyticsReady, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const running = await startDevServer(
    process.argv.includes("--analytics") ? { analytics: true } : {},
  );
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      await running.close();
      process.exitCode = 0;
    } catch (error) {
      console.error("Unable to close Market Map cleanly", error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
