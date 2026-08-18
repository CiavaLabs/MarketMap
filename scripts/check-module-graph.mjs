import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import process from "node:process";

import { PUBLIC_PREFIXES } from "../server/dev.js";

const ROOT = process.cwd();

const GENERATED = ["/assets/react/", "/dist-react/"];

const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
const problems = [];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, "$1");
}

function specifiersIn(source) {
  const text = stripComments(source);
  const patterns = [
    /(?:^|[\s;}])(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']/gs,
    /(?:^|[\s;}])import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /@import\s+["']([^"']+)["']/g,
    /\burl\(\s*["']?([^"')]+)["']?\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]));
}

function rootPathOf(absolute) {
  return `/${relative(ROOT, absolute).split("\\").join("/")}`;
}

async function exists(absolute) {
  try {
    await stat(absolute);
    return true;
  } catch {
    return false;
  }
}

async function walkGraph({ label, entries, reaches, describeReach }) {
  const visited = new Set();

  async function walk(absolute, importedBy) {
    if (visited.has(absolute)) return;
    visited.add(absolute);

    const rootPath = rootPathOf(absolute);
    const where = importedBy ? `${relative(ROOT, importedBy)} → ${rootPath}` : rootPath;

    if (rootPath.startsWith("/..")) {
      problems.push(`${label}: ${where} escapes the project root`);
      return;
    }
    if (!reaches(rootPath)) {
      problems.push(`${label}: ${where} ${describeReach}`);
      return;
    }

    const isGenerated = GENERATED.some((prefix) => rootPath.startsWith(prefix));
    if (!await exists(absolute)) {
      if (!isGenerated) problems.push(`${label}: ${where} does not exist`);
      return;
    }
    if (isGenerated || /\.(woff2?|ttf|otf|png|svg|json)$/i.test(rootPath)) return;

    const source = await readFile(absolute, "utf8");
    for (const specifier of specifiersIn(source)) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
      const target = specifier.startsWith("/")
        ? resolve(ROOT, `.${specifier}`)
        : resolve(dirname(absolute), specifier.split("?")[0].split("#")[0]);
      await walk(target, absolute);
    }
  }

  for (const entry of entries) await walk(resolve(ROOT, entry.replace(/^\.?\//, "")), null);
  return visited.size;
}

const html = await readFile(resolve(ROOT, "index.html"), "utf8");
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}=["']([^"']+)["']`))?.[1];

const htmlEntries = [
  ...[...html.matchAll(/<script\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => attribute(tag, "type") === "module")
    .map((tag) => attribute(tag, "src")),
  ...[...html.matchAll(/<link\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => (attribute(tag, "rel") || "").split(/\s+/).includes("stylesheet"))
    .map((tag) => attribute(tag, "href")),
].filter(Boolean);

const moduleCount = [...html.matchAll(/<script\b[^>]*>/g)].filter((m) => attribute(m[0], "type") === "module").length;
const sheetCount = [...html.matchAll(/<link\b[^>]*>/g)]
  .filter((m) => (attribute(m[0], "rel") || "").split(/\s+/).includes("stylesheet")).length;
if (!moduleCount) problems.push("index.html declares no type=module script to walk");
if (!sheetCount) problems.push("index.html declares no stylesheet to walk");
if (htmlEntries.length !== moduleCount + sheetCount) {
  problems.push("index.html has a module script or stylesheet with no resolvable src/href");
}

const served = await walkGraph({
  label: "demo",
  entries: htmlEntries,
  reaches: (rootPath) => PUBLIC_PREFIXES.some((prefix) => rootPath.startsWith(prefix)),
  describeReach: `is outside every served prefix (${PUBLIC_PREFIXES.join(", ")})`,
});

const published = (manifest.files ?? []).map((entry) => `/${entry.replace(/^\.?\//, "")}`);
const exported = Object.values(manifest.exports ?? {})
  .flatMap((value) => (typeof value === "string" ? [value] : Object.values(value)))
  .filter((value) => typeof value === "string" && /\.(js|mjs|css)$/.test(value));

const packaged = await walkGraph({
  label: "package",
  entries: [...new Set(exported)],
  reaches: (rootPath) => published.some((entry) => rootPath === entry || rootPath.startsWith(`${entry}/`)),
  describeReach: `is not published by "files" (${published.join(", ")})`,
});

if (problems.length) {
  console.error(`Module graph failed (${problems.length}):\n  ${[...new Set(problems)].join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Module graph passed (${served} files reachable from index.html, all served; `
    + `${packaged} reachable from the package exports, all published).`,
  );
}
