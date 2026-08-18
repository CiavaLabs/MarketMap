import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postcss from "postcss";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSS_DIR = path.join(ROOT, "css");
const SOURCE_DIR = path.join(ROOT, "src");
const BASELINE_PATH = path.join(ROOT, "scripts", "css-guardrail-baseline.json");

const NON_RULE_FILES = new Set([
  "marketmap.css",
  "marketmap.nofonts.css",
  "embed.css",
  "embed.nofonts.css",
  "fonts.css",
]);
const EXPECTED_LAYER_BY_FILE = new Map([
  ["css/tokens.css", "tokens"],
  ["css/base.css", "base"],
  ["css/console.css", "components"],
  ["css/pulse.css", "components"],
  ["css/tiles.css", "components"],
  ["css/details.css", "components"],
  ["css/news.css", "components"],
  ["css/states.css", "states"],
  ["css/motion.css", "motion"],
  ["css/utilities.css", "utilities"],
]);
const CASCADE_IMPORTS = [
  "./tokens.css",
  "./base.css",
  "./console.css",
  "./pulse.css",
  "./tiles.css",
  "./details.css",
  "./news.css",
  "./states.css",
  "./motion.css",
  "./utilities.css",
];
const MARKETMAP_IMPORTS = ["./fonts.css", ...CASCADE_IMPORTS];
const MARKETMAP_NOFONTS_IMPORTS = [...CASCADE_IMPORTS];
const EMBED_IMPORTS = ["./marketmap.css"];
const EMBED_NOFONTS_IMPORTS = ["./marketmap.nofonts.css"];
const HARDCODED_COLOUR = /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
const ID_SELECTOR = /(^|[\s>+~,(])#[A-Za-z_][\w-]*/;
const TRANSITION_ALL = /(^|[\s,])all(?=$|[\s,])/i;
const COMPONENT_NAMESPACE_OWNERS = new Map([
  ["mm-news", "css/news.css"],
]);

const normalizeWhitespace = (value) => String(value || "").trim().replace(/\s+/g, " ");
const selectorKey = (rule) => (rule.selectors || []).map(normalizeWhitespace).join(", ");

const layerOf = (node) => {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "atrule" && parent.name === "layer") {
      return normalizeWhitespace(parent.params) || "(anonymous)";
    }
    parent = parent.parent;
  }
  return null;
};

const isInsideKeyframes = (node) => {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "atrule" && /keyframes$/i.test(parent.name)) return true;
    parent = parent.parent;
  }
  return false;
};

const tokenContext = (rule) => {
  const selectors = rule.selectors || [];
  if (selectors.length !== 1) return null;
  const selector = normalizeWhitespace(selectors[0]);
  if (selector === ".marketmap-app") return "base";
  if (/\.marketmap-app\[data-marketmap-theme=["']dark["']\]/.test(selector)) return "dark";
  if (/\.marketmap-app:not\(\[data-marketmap-theme=["']light["']\]\)/.test(selector)) return "dark";
  if (/\.marketmap-app\[data-marketmap-theme=["']light["']\]/.test(selector)) return "light";
  if (selector === ".marketmap-app:not([data-marketmap-theme])") return "light";
  return null;
};

const declarationIdentity = (file, decl) => {
  const owner = decl.parent?.type === "rule" ? selectorKey(decl.parent) : `@${decl.parent?.name || "unknown"}`;
  return `${file}|${owner}|${decl.prop}|${normalizeWhitespace(decl.value)}`;
};

const selectorIdentity = (file, selector) => `${file}|${normalizeWhitespace(selector)}`;

async function listJavaScriptFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(entryPath));
    else if (entry.isFile() && /\.(?:js|jsx|mjs)$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

async function importList(file) {
  const source = await readFile(path.join(ROOT, file), "utf8");
  const root = postcss.parse(source, { from: file });
  const imports = [];
  root.walkAtRules("import", (rule) => {
    const match = rule.params.match(/^["']([^"']+)["']/);
    imports.push(match?.[1] || normalizeWhitespace(rule.params));
  });
  return imports;
}

async function collect() {
  const entries = await readdir(CSS_DIR);
  const allCssFiles = entries.filter((file) => file.endsWith(".css")).sort().map((file) => `css/${file}`);
  const ruleFiles = allCssFiles.filter((file) => !NON_RULE_FILES.has(path.basename(file)));

  const scopeViolations = [];
  const keyframeViolations = [];
  const wrongLayerRules = [];
  const unownedRuleFiles = new Set();
  const selectorOwners = new Map();
  const componentNamespaceOwnershipViolations = [];
  const importantDeclarations = new Set();
  const idSelectors = new Set();
  const hardcodedColours = [];
  const transitionAllDeclarations = [];
  const revampImporters = new Set();
  const customPropertyDefinitions = new Set();
  const customPropertyUsages = [];
  const invalidTokenDefinitionContexts = [];
  const tokenContexts = new Map();

  for (const file of ruleFiles) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    const root = postcss.parse(source, { from: file });
    const expectedLayer = EXPECTED_LAYER_BY_FILE.get(file);
    if (!expectedLayer) unownedRuleFiles.add(file);

    root.walkRules((rule) => {
      if (isInsideKeyframes(rule)) return;
      const actualLayer = layerOf(rule);
      if (actualLayer !== expectedLayer) {
        wrongLayerRules.push(
          `${file}:${rule.source.start.line} ${selectorKey(rule)} (expected ${expectedLayer || "a declared owner"}, found ${actualLayer || "unlayered"})`,
        );
      }

      for (const selector of rule.selectors || []) {
        const normalized = normalizeWhitespace(selector);
        if (!normalized.startsWith(".marketmap-app")) {
          scopeViolations.push(`${file}:${rule.source.start.line} ${normalized}`);
        }
        if (file !== "css/tokens.css") {
          if (!selectorOwners.has(normalized)) selectorOwners.set(normalized, new Set());
          selectorOwners.get(normalized).add(file);
        }
        if (ID_SELECTOR.test(normalized)) idSelectors.add(selectorIdentity(file, normalized));
        for (const [namespace, owner] of COMPONENT_NAMESPACE_OWNERS) {
          const namespacePattern = new RegExp(`\\.${namespace}[\\w-]*`);
          const usesNamespace = namespacePattern.test(normalized);
          if (usesNamespace && file !== owner) {
            componentNamespaceOwnershipViolations.push(
              `${file}:${rule.source.start.line} ${normalized} (owned by ${owner})`,
            );
          }
          if (file === owner && !usesNamespace) {
            componentNamespaceOwnershipViolations.push(
              `${file}:${rule.source.start.line} ${normalized} (missing owned .${namespace} namespace)`,
            );
          }
        }
      }
    });

    root.walkDecls((decl) => {
      const location = `${file}:${decl.source.start.line}`;
      if (decl.important) importantDeclarations.add(declarationIdentity(file, decl));
      if (file !== "css/tokens.css" && HARDCODED_COLOUR.test(decl.value)) {
        hardcodedColours.push(`${location} ${decl.prop}: ${normalizeWhitespace(decl.value)}`);
      }
      if ((decl.prop === "transition" || decl.prop === "transition-property") && TRANSITION_ALL.test(decl.value)) {
        transitionAllDeclarations.push(`${location} ${decl.prop}: ${normalizeWhitespace(decl.value)}`);
      }

      if (decl.prop.startsWith("--mm-")) {
        customPropertyDefinitions.add(decl.prop);
        const context = decl.parent?.type === "rule" ? tokenContext(decl.parent) : null;
        if (file !== "css/tokens.css" || !context) {
          invalidTokenDefinitionContexts.push(`${location} ${decl.prop}`);
        } else {
          if (!tokenContexts.has(decl.prop)) tokenContexts.set(decl.prop, new Set());
          tokenContexts.get(decl.prop).add(context);
        }
      }

      for (const match of decl.value.matchAll(/var\((--mm-[\w-]+)/g)) {
        customPropertyUsages.push({ name: match[1], location });
      }
    });

    root.walkAtRules(/keyframes$/i, (rule) => {
      if (!rule.params.startsWith("mm-")) {
        keyframeViolations.push(`${file}:${rule.source.start.line} @${rule.name} ${rule.params}`);
      }
    });
  }

  for (const file of allCssFiles) {
    const source = await readFile(path.join(ROOT, file), "utf8");
    const root = postcss.parse(source, { from: file });
    root.walkAtRules("import", (rule) => {
      if (/revamp\.css/.test(rule.params)) revampImporters.add(file);
    });
  }

  for (const sourcePath of await listJavaScriptFiles(SOURCE_DIR)) {
    const source = await readFile(sourcePath, "utf8");
    for (const match of source.matchAll(/(?:["']|var\(\s*)(--mm-[\w-]+)/g)) {
      const line = source.slice(0, match.index).split("\n").length;
      customPropertyUsages.push({
        name: match[1],
        location: `${path.relative(ROOT, sourcePath)}:${line}`,
      });
    }
  }

  const crossFileDuplicates = [...selectorOwners.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([selector]) => selector)
    .sort();
  const undefinedCustomProperties = customPropertyUsages
    .filter(({ name }) => !customPropertyDefinitions.has(name))
    .map(({ name, location }) => `${location} ${name}`);
  const usedCustomProperties = new Set(customPropertyUsages.map(({ name }) => name));
  const unusedCustomProperties = [...customPropertyDefinitions]
    .filter((name) => !usedCustomProperties.has(name))
    .sort();
  const incompleteThemeTokens = [...usedCustomProperties]
    .filter((name) => customPropertyDefinitions.has(name))
    .flatMap((name) => {
      const contexts = tokenContexts.get(name) || new Set();
      if (contexts.has("base")) return [];
      const missing = ["dark", "light"].filter((theme) => !contexts.has(theme));
      return missing.length ? [`${name} (missing ${missing.join(" and ")})`] : [];
    })
    .sort();
  const legacyFiles = allCssFiles.filter((file) => file.endsWith("/revamp.css"));

  const entryPoints = [
    ["css/marketmap.css", MARKETMAP_IMPORTS],
    ["css/marketmap.nofonts.css", MARKETMAP_NOFONTS_IMPORTS],
    ["css/embed.css", EMBED_IMPORTS],
    ["css/embed.nofonts.css", EMBED_NOFONTS_IMPORTS],
  ];
  const actualImports = await Promise.all(
    entryPoints.map(([file]) => importList(file)),
  );
  const importManifestViolations = [];
  entryPoints.forEach(([file, expected], index) => {
    const actual = actualImports[index];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      importManifestViolations.push(
        `${file} imports ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
      );
    }
  });

  return {
    componentNamespaceOwnershipViolations,
    crossFileDuplicates,
    hardcodedColours,
    idSelectors: [...idSelectors].sort(),
    importantDeclarations: [...importantDeclarations].sort(),
    importManifestViolations,
    incompleteThemeTokens,
    invalidTokenDefinitionContexts,
    keyframeViolations,
    legacyFiles,
    revampImporters: [...revampImporters].sort(),
    scopeViolations,
    transitionAllDeclarations,
    undefinedCustomProperties,
    unownedRuleFiles: [...unownedRuleFiles].sort(),
    unusedCustomProperties,
    wrongLayerRules,
  };
}

async function main() {
  const update = process.argv.includes("--update");
  const state = await collect();

  if (update) {
    const baseline = {
      _comment: "Precise reviewed CSS exceptions only. Each entry includes file, selector, property and value where applicable; new exceptions fail until this file is intentionally regenerated and reviewed.",
      importantDeclarations: state.importantDeclarations,
      idSelectors: state.idSelectors,
    };
    await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`CSS exception baseline written to ${path.relative(ROOT, BASELINE_PATH)}`);
    return;
  }

  let baseline;
  try {
    baseline = JSON.parse(await readFile(BASELINE_PATH, "utf8"));
  } catch {
    console.error(
      `Missing baseline ${path.relative(ROOT, BASELINE_PATH)}. Generate it with: node scripts/check-css-scope.mjs --update`,
    );
    process.exitCode = 1;
    return;
  }

  const allowedImportant = new Set(baseline.importantDeclarations || []);
  const allowedIds = new Set(baseline.idSelectors || []);
  const failures = [];
  const notices = [];

  for (const value of state.scopeViolations) failures.push(`unscoped selector: ${value}`);
  for (const value of state.componentNamespaceOwnershipViolations) {
    failures.push(`component namespace ownership violation: ${value}`);
  }
  for (const value of state.keyframeViolations) failures.push(`unprefixed keyframes (need mm-): ${value}`);
  for (const value of state.crossFileDuplicates) failures.push(`cross-file duplicate selector: ${value}`);
  for (const value of state.unownedRuleFiles) failures.push(`application sheet has no layer owner: ${value}`);
  for (const value of state.wrongLayerRules) failures.push(`wrong cascade layer: ${value}`);
  for (const value of state.importManifestViolations) failures.push(`stylesheet manifest mismatch: ${value}`);
  for (const value of state.revampImporters) failures.push(`import of removed revamp.css: ${value}`);
  for (const value of state.legacyFiles) failures.push(`removed legacy stylesheet is present: ${value}`);
  for (const value of state.undefinedCustomProperties) failures.push(`undefined internal custom property: ${value}`);
  for (const value of state.unusedCustomProperties) failures.push(`unused internal custom property: ${value}`);
  for (const value of state.invalidTokenDefinitionContexts) {
    failures.push(`--mm-* definitions belong to a base/dark/light rule in css/tokens.css: ${value}`);
  }
  for (const value of state.incompleteThemeTokens) failures.push(`token does not resolve in every theme: ${value}`);
  for (const value of state.hardcodedColours) failures.push(`literal colour outside css/tokens.css: ${value}`);
  for (const value of state.transitionAllDeclarations) failures.push(`transition: all is forbidden: ${value}`);

  for (const identity of state.importantDeclarations) {
    if (!allowedImportant.has(identity)) failures.push(`new !important exception: ${identity}`);
  }
  for (const identity of state.idSelectors) {
    if (!allowedIds.has(identity)) failures.push(`new ID selector: ${identity}`);
  }
  for (const identity of allowedImportant) {
    if (!state.importantDeclarations.includes(identity)) notices.push(`resolved !important exception: ${identity}`);
  }
  for (const identity of allowedIds) {
    if (!state.idSelectors.includes(identity)) notices.push(`resolved ID-selector exception: ${identity}`);
  }

  if (notices.length) {
    console.log(
      `CSS guardrail: ${notices.length} exception${notices.length === 1 ? "" : "s"} can be removed from the baseline:\n  ${notices.join("\n  ")}`,
    );
  }
  if (failures.length) {
    console.error(`CSS guardrail failed (${failures.length}):\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `CSS guardrail passed (${state.importantDeclarations.length} reviewed !important declarations, ${state.idSelectors.length} reviewed ID selector${state.idSelectors.length === 1 ? "" : "s"}).`,
  );
}

await main();
