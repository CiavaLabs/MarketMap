import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const FONT_DIRECTORY = "assets/fonts";
const LICENCE_FILE = "OFL.txt";
const BINARY_EXTENSIONS = [".woff2", ".woff", ".ttf", ".otf"];

const problems = [];
const entries = await readdir(resolve(ROOT, FONT_DIRECTORY));
const binaries = entries.filter((entry) => BINARY_EXTENSIONS.some((extension) => entry.endsWith(extension)));

if (!binaries.length) {
  problems.push(`${FONT_DIRECTORY} holds no font binaries — this guardrail is watching the wrong directory`);
}

let licence = "";
if (!entries.includes(LICENCE_FILE)) {
  problems.push(`${FONT_DIRECTORY}/${LICENCE_FILE} is missing, but ${binaries.length} font binaries ship from here`);
} else {
  licence = await readFile(resolve(ROOT, FONT_DIRECTORY, LICENCE_FILE), "utf8");
  for (const binary of binaries) {
    if (!licence.includes(binary)) problems.push(`${LICENCE_FILE} does not name ${binary}`);
  }
  if (!/SIL OPEN FONT LICENSE/i.test(licence)) {
    problems.push(`${LICENCE_FILE} does not contain the SIL Open Font License text`);
  }
}

const manifest = JSON.parse(await readFile(resolve(ROOT, "package.json"), "utf8"));
if (!manifest.files?.includes(FONT_DIRECTORY)) {
  problems.push(`package.json "files" does not publish ${FONT_DIRECTORY}, so the notice never reaches consumers`);
}

if (problems.length) {
  console.error(`Font licence guardrail failed (${problems.length}):\n  ${problems.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`Font licence guardrail passed (${binaries.length} binaries, ${LICENCE_FILE} names each and ships with them).`);
}
