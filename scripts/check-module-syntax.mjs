#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { transformSync } from "esbuild";
import { join } from "node:path";

const ROOTS = ["src", "shared", "server", "scripts", "tests"];
const ROOT_FILES = ["vitest.config.js", "playwright.config.js", "eslint.config.js"];
const SKIP = new Set(["node_modules", ".git", "coverage", "dist", "dist-react", "test-results"]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (/\.(js|mjs|jsx)$/u.test(path)) yield path;
  }
}

const broken = [];
let checked = 0;
for (const file of ROOT_FILES) {
  if (!existsSync(file)) continue;
  checked += 1;
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    broken.push(`${file}: ${`${error.stderr}`.split("\n").find((line) => line.includes("Error")) || "parse failed"}`);
  }
}

for (const root of ROOTS) {
  for (const file of walk(root)) {
    checked += 1;
    try {
      if (file.endsWith(".jsx")) transformSync(readFileSync(file, "utf8"), { loader: "jsx", format: "esm" });
      else execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    } catch (error) {
      broken.push(`${file}: ${`${error.stderr || error.message}`.split("\n").find((line) => line.includes("Error")) || "parse failed"}`);
    }
  }
}

if (broken.length) {
  console.error(`Module syntax check failed for ${broken.length} file(s):`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`Module syntax guardrail passed (${checked} files parse as ESM).`);
