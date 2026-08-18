import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const browserRoots = [join(root, "src"), join(root, "shared")];
const standaloneFiles = [join(root, "index.html")];
const allowedExtensions = new Set([".js", ".jsx", ".mjs", ".html"]);

const forbidden = [
  { label: "server module imported by browser code", pattern: /(?:from\s*|import\s*)["'][^"']*(?:^|\/)server(?:\/|["'])/m },
  { label: "server-only dependency in browser code", pattern: /["'](?:yahoo-finance2|mysql2)["']/ },
  { label: "direct provider URL in browser code", pattern: /https?:\/\/(?:[^/]+\.)?(?:finnhub\.io|yahoo\.com)|wss?:\/\/(?:[^/]+\.)?finnhub\.io/i },
  { label: "server secret name in browser code", pattern: /FINNHUB_API_KEY|X-Finnhub-Token/i },
  { label: "simulation controller in product code", pattern: /SimulationController|SIMULATION_ASSETS/ },
  { label: "synthetic market field in product code", pattern: /simulation(?:Price|BasePrice)/ },
  { label: "random value generator in market client", pattern: /Math\.random\s*\(/ },
];

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (allowedExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const files = [
  ...(await Promise.all(browserRoots.map(listFiles))).flat(),
  ...standaloneFiles,
];
const violations = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const rule of forbidden) {
    const match = source.match(rule.pattern);
    if (!match) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push(`${relative(root, file)}:${line} — ${rule.label}`);
  }
}

if (violations.length) {
  console.error("Browser/server boundary check failed:\n");
  violations.forEach((violation) => console.error(`- ${violation}`));
  process.exitCode = 1;
} else {
  console.log(`Browser/server boundary check passed (${files.length} files).`);
}
