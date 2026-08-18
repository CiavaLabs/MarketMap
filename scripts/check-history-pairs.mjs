#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isHistoryRangeIntervalSupported } from "../server/contracts/core/history.js";

const ROOTS = ["src", "shared", "server", "scripts", "tests"];
const ROOT_FILES = ["README.md", "ARCHITECTURE.md", "CHANGELOG.md", "ROADMAP.md", "RUNBOOK.md"];
const SKIP = new Set(["node_modules", ".git", "coverage", "dist", "dist-react", "test-results"]);
const SCANNED = /\.(js|mjs|jsx|md)$/u;
const ALLOW_INVALID = /rejects?|refuses?|unsupported|do not pair|invalid|allowlist|\bbad\b|toBe\(4\d\d\)|status\).toBe\(4/iu;

const PATTERNS = [
  /range:\s*["']([^"']+)["'],\s*\n?\s*interval:\s*["']([^"']+)["']/gu,
  /interval:\s*["']([^"']+)["'],\s*\n?\s*range:\s*["']([^"']+)["']/gu,
  /[?&]range=([^&"'`\s]+)[^"'`\s]*?[?&]interval=([^&"'`\s]+)/gu,
  /[?&]interval=([^&"'`\s]+)[^"'`\s]*?[?&]range=([^&"'`\s]+)/gu,
];
const REVERSED = new Set([1, 3]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SCANNED.test(path)) yield path;
  }
}

function* candidates() {
  for (const file of ROOT_FILES) yield file;
  for (const root of ROOTS) yield* walk(root);
}

const offenders = [];
let checked = 0;
for (const file of candidates()) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = source.split("\n");
  PATTERNS.forEach((pattern, index) => {
    for (const match of source.matchAll(pattern)) {
      const [range, interval] = REVERSED.has(index)
        ? [match[2], match[1]]
        : [match[1], match[2]];
      checked += 1;
      if (isHistoryRangeIntervalSupported(range, interval)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      const context = lines.slice(Math.max(0, line - 6), line + 3).join(" ");
      if (ALLOW_INVALID.test(context)) continue;
      offenders.push(`${file}:${line}: ${range}/${interval}`);
    }
  });
}

if (offenders.length) {
  console.error(`History pairing check failed for ${offenders.length} literal(s):`);
  for (const line of offenders) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`History pairing guardrail passed (${checked} range/interval pairs).`);
