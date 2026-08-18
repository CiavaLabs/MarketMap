import { chmod, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDevServer } from "../../server/dev.js";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PROBE_RELATIVE_PATH = "/css/__resilience-probe.txt";
const PROBE_PATH = resolve(PROJECT_ROOT, "css/__resilience-probe.txt");

const runningServers = [];

function requestWithRawHost(port, hostHeader, target = "/index.html") {
  return new Promise((resolveRequest) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`);
    });
    let received = "";
    socket.on("data", (chunk) => { received += chunk; });
    socket.on("close", () => resolveRequest(received.split("\r\n")[0] || ""));
    socket.on("error", () => resolveRequest("socket error"));
  });
}

async function startServer() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const running = await startDevServer({
    host: "127.0.0.1",
    port: 0,
    market: {
      handleRequest: async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      getHealth: () => ({ status: "ok", providers: {}, persistence: { adapter: "none" } }),
      close: async () => {},
    },
  });
  runningServers.push(running);
  return running;
}

beforeEach(async () => {
  await rm(PROBE_PATH, { force: true });
});

afterEach(async () => {
  await chmod(PROBE_PATH, 0o644).catch(() => {});
  await rm(PROBE_PATH, { force: true });
  await Promise.all(runningServers.splice(0).map((server) => server.close()));
  vi.restoreAllMocks();
});

describe("local server resilience", () => {
  it("rejects a request target it cannot parse instead of failing the handler", async () => {
    const running = await startServer();
    const port = running.server.address().port;

    expect(await requestWithRawHost(port, "[")).toContain("400");
    expect(await requestWithRawHost(port, `127.0.0.1:${port}`)).toContain("200");
    expect((await fetch(`${running.url}/index.html`)).status).toBe(200);
  });

  it.skipIf(process.getuid?.() === 0)("answers with a status instead of dying when a served file cannot be opened", async () => {
    const running = await startServer();
    await writeFile(PROBE_PATH, "probe\n");
    await chmod(PROBE_PATH, 0o000);

    const denied = await fetch(`${running.url}${PROBE_RELATIVE_PATH}`);
    expect(denied.status).toBe(500);
    expect((await fetch(`${running.url}/index.html`)).status).toBe(200);
  });

  it("serves a readable file under the same prefix", async () => {
    const running = await startServer();
    await writeFile(PROBE_PATH, "probe\n");

    const response = await fetch(`${running.url}${PROBE_RELATIVE_PATH}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("probe\n");
  });

  it("reports a missing file under a served prefix as not found", async () => {
    const running = await startServer();
    expect((await fetch(`${running.url}${PROBE_RELATIVE_PATH}`)).status).toBe(404);
  });
});
