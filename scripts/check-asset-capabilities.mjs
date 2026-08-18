import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  MARKET_ASSET_CLASSES,
  DEFAULT_ENABLED_ASSET_CLASSES,
  DETAIL_SECTIONS_BY_KIND,
  PRICE_UNITS,
} from "../server/contracts/market/constants.js";
import {
  validateHistorySeries,
  validateInstrumentDescriptor,
  validateInstrumentDetails,
  validateProviderCapabilityManifest,
  validateQuoteSnapshot,
} from "../server/contracts/market/index.js";
import {
  ALL_ASSET_POLICIES,
  assetPolicyFor,
  normalizeEnabledAssetClasses,
} from "../server/instruments/assetPolicies.js";
import { encodeCanonicalId } from "../server/instruments/InstrumentCatalog.js";
import { YAHOO_CAPABILITY_MANIFEST } from "../server/providers/yahoo/capabilityManifest.js";
import { FINNHUB_CAPABILITY_MANIFEST } from "../server/providers/finnhub/capabilityManifest.js";
import { YahooProvider } from "../server/providers/yahoo/YahooProvider.js";
import { FinnhubProvider } from "../server/providers/finnhub/FinnhubProvider.js";
import { ALL_DESCRIPTORS } from "../tests/server/fixtures/market/descriptors.js";
import { ALL_QUOTES } from "../tests/server/fixtures/market/quotes.js";
import { ALL_HISTORIES } from "../tests/server/fixtures/market/histories.js";
import { ALL_DETAILS } from "../tests/server/fixtures/market/details.js";

const root = process.cwd();
const problems = [];

const OPERATION_METHODS = Object.freeze({
  search: "discoverInstruments",
  quote: "quoteMany",
  history: "history",
  details: "details",
  news: "news",
});

function implementsOwn(ProviderClass, method) {
  return typeof Object.getOwnPropertyDescriptor(ProviderClass.prototype, method)?.value === "function";
}

function implementedOperationsOf(ProviderClass) {
  return Object.fromEntries(Object.entries(OPERATION_METHODS)
    .map(([operation, method]) => [operation, implementsOwn(ProviderClass, method)]));
}

const policyClasses = Object.keys(ALL_ASSET_POLICIES).sort();
if (JSON.stringify(policyClasses) !== JSON.stringify([...MARKET_ASSET_CLASSES].sort())) {
  problems.push(`asset policies cover [${policyClasses}] but the v2 taxonomy is [${MARKET_ASSET_CLASSES}]`);
}

try {
  normalizeEnabledAssetClasses(DEFAULT_ENABLED_ASSET_CLASSES);
} catch (error) {
  problems.push(`default enabledAssetClasses is invalid: ${error.message}`);
}

const manifests = [
  [YAHOO_CAPABILITY_MANIFEST, implementedOperationsOf(YahooProvider)],
  [FINNHUB_CAPABILITY_MANIFEST, implementedOperationsOf(FinnhubProvider)],
];
for (const [manifest, implementedOperations] of manifests) {
  try {
    validateProviderCapabilityManifest(manifest, { implementedOperations });
  } catch (error) {
    problems.push(`${manifest.provider} capability manifest is invalid: ${JSON.stringify(error.details?.issues || error.message)}`);
  }
}

for (const assetClass of MARKET_ASSET_CLASSES) {
  const policy = assetPolicyFor(assetClass);
  const providerBases = new Set(manifests
    .map(([manifest]) => manifest.assets[assetClass]?.history)
    .filter((history) => history && history.support !== "unsupported")
    .flatMap((history) => history.priceBases || []));
  for (const basis of policy.history.priceBases) {
    if (!providerBases.has(basis)) {
      problems.push(`${assetClass} declares history basis ${basis} that no provider manifest offers`);
    }
  }
  const yahoo = YAHOO_CAPABILITY_MANIFEST.assets[assetClass];
  if (!yahoo || yahoo.quote?.support === "unsupported" || yahoo.history?.support === "unsupported") {
    problems.push(`${assetClass} has no primary provider quote/history coverage in the Yahoo manifest`);
  }
}

for (const [assetClass, operations] of Object.entries(FINNHUB_CAPABILITY_MANIFEST.assets)) {
  for (const [operation, entry] of Object.entries(operations)) {
    if (entry.support !== "unsupported" && !entry.fallback?.semanticMatch) {
      problems.push(`finnhub ${assetClass}/${operation} is supported without a declared semanticMatch`);
    }
  }
}

const fixtureChecks = [
  ["descriptor", ALL_DESCRIPTORS, validateInstrumentDescriptor],
  ["quote", ALL_QUOTES, validateQuoteSnapshot],
  ["history", ALL_HISTORIES, validateHistorySeries],
  ["details", ALL_DETAILS, validateInstrumentDetails],
];
for (const [label, fixtures, validate] of fixtureChecks) {
  fixtures.forEach((fixture, index) => {
    try {
      validate(fixture);
    } catch (error) {
      problems.push(`${label} fixture #${index} is invalid: ${JSON.stringify(error.details?.issues || error.message)}`);
    }
  });
}
const fixtureSections = new Set(ALL_DETAILS.flatMap((details) => details.sections.map((section) => section.id)));
for (const assetClass of MARKET_ASSET_CLASSES) {
  const policy = assetPolicyFor(assetClass);
  for (const section of DETAIL_SECTIONS_BY_KIND[policy.detailKind]) {
    if (!fixtureSections.has(section)) {
      problems.push(`detail section ${section} (${assetClass}) has no fixture in tests/server/fixtures/market/details.js`);
    }
  }
}

const identitySamples = {
  equity: { assetClass: "equity", symbol: "AAPL", mic: "XNAS" },
  etf: { assetClass: "etf", symbol: "SPY", mic: "ARCX" },
  index: { assetClass: "index", symbol: "^GSPC" },
  fx: { assetClass: "fx", symbol: "EURUSD" },
  crypto: { assetClass: "crypto", symbol: "BTC-USD" },
  commodity_future: { assetClass: "commodity_future", symbol: "GC=F" },
  rate_index: { assetClass: "rate_index", symbol: "^TNX" },
};
for (const assetClass of MARKET_ASSET_CLASSES) {
  const sample = identitySamples[assetClass];
  if (!sample) {
    problems.push(`no identity sample defined for ${assetClass}`);
    continue;
  }
  try {
    encodeCanonicalId(sample);
  } catch (error) {
    problems.push(`${assetClass} cannot encode a canonical ID: ${error.message}`);
  }
}

const formatterPath = join(root, "src/ui/models/instrumentFormat.js");
try {
  const formatter = await import(pathToFileURL(formatterPath).href);
  const enabledUnits = new Set(
    normalizeEnabledAssetClasses(DEFAULT_ENABLED_ASSET_CLASSES).map((assetClass) => assetPolicyFor(assetClass).priceUnit),
  );
  for (const unit of enabledUnits) {
    if (!PRICE_UNITS.includes(unit) || formatter.supportsPriceUnit?.(unit) !== true) {
      problems.push(`price unit ${unit} has no browser formatter support in src/ui/models/instrumentFormat.js`);
    }
  }
} catch (error) {
  problems.push(`formatter check failed: ${error.message}`);
}

if (problems.length) {
  console.error("Asset capability guardrail failed:\n");
  problems.forEach((problem) => console.error(`- ${problem}`));
  process.exitCode = 1;
} else {
  console.log(`Asset capability guardrail passed (${MARKET_ASSET_CLASSES.length} asset classes, ${manifests.length} provider manifests).`);
}
