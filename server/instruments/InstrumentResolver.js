import { ERROR_CODES } from "../contracts/core/constants.js";
import {
  DEFAULT_ENABLED_ASSET_CLASSES,
  MAX_SEARCH_RESULTS,
  SEARCH_HYDRATION_LIMIT,
} from "../contracts/market/constants.js";
import { MarketDataError } from "../errors/MarketDataError.js";
import {
  LEGACY_CANONICAL_ID_MIGRATIONS,
  continuousFutureIdentityFor,
  decodeCanonicalId,
  providerSymbolFor,
  encodeCanonicalId,
  rankInstrumentCandidate,
} from "./InstrumentCatalog.js";
import { buildEffectiveCapabilities } from "./effectiveCapabilities.js";
import {
  descriptorFromLegacyInstrument,
  descriptorFromYahooQuote,
} from "./descriptorFactory.js";
import { providerSymbolCandidatesForVenue } from "./VenueRegistry.js";

const PROVIDER_SYMBOL_PATTERN = /^[A-Z0-9^.=_-]{1,24}$/i;
const CURATED_VERIFIED_AT = "2026-07-16T00:00:00.000Z";

function upper(value) {
  return `${value ?? ""}`.trim().toUpperCase();
}

export class InstrumentResolver {
  constructor({
    catalog,
    yahooProvider,
    store = null,
    manifests = [],
    enabledAssetClasses = DEFAULT_ENABLED_ASSET_CLASSES,
    clock = () => Date.now(),
    telemetry = null,
    logger = null,
    maxResolvedDescriptors = 2_000,
  } = {}) {
    if (typeof catalog?.list !== "function") throw new TypeError("InstrumentResolver requires a curated instrument catalog");
    if (typeof yahooProvider?.hydrateQuotes !== "function") {
      throw new TypeError("InstrumentResolver requires a capable Yahoo provider");
    }
    if (!Number.isInteger(maxResolvedDescriptors) || maxResolvedDescriptors < 1) {
      throw new TypeError("maxResolvedDescriptors must be a positive integer");
    }
    this.maxResolvedDescriptors = maxResolvedDescriptors;
    this.catalog = catalog;
    this.provider = yahooProvider;
    this.store = store;
    this.manifests = manifests;
    this.enabledAssetClasses = enabledAssetClasses;
    this.clock = clock;
    this.telemetry = telemetry;
    this.logger = logger;
    this.descriptors = new Map();
    this.searchAliasesById = new Map();
    this.idsByProviderSymbol = new Map();
    this.pinnedIds = new Set();
    this.#seedFromCatalog();
  }

  #seedFromCatalog() {
    for (const instrument of this.catalog.list()) {
      try {
        const descriptor = this.#remember(
          descriptorFromLegacyInstrument(instrument, { verifiedAt: CURATED_VERIFIED_AT }),
          { pinned: true },
        );
        if (instrument.aliases?.length) this.searchAliasesById.set(descriptor.id, [...instrument.aliases]);
      } catch (error) {
        this.logger?.warn?.({
          component: "instrument-resolver",
          instrumentId: instrument.id,
          errorCode: error?.code,
          message: "curated instrument could not be converted to a descriptor",
        });
      }
    }
  }

  #remember(descriptor, { pinned = false } = {}) {
    const previous = this.descriptors.get(descriptor.id);
    this.descriptors.delete(descriptor.id);
    this.descriptors.set(descriptor.id, descriptor);
    if (pinned) this.pinnedIds.add(descriptor.id);
    for (const mapping of Object.values(previous?.providerSymbols || {})) {
      this.#unmapProviderSymbol(mapping?.symbol, descriptor.id);
    }
    this.#mapProviderSymbol(descriptor.providerSymbols.yahoo?.symbol, descriptor.id);
    this.#evictOverflow();
    return descriptor;
  }

  #mapProviderSymbol(symbol, instrumentId) {
    const key = upper(symbol);
    if (!key) return;
    const ids = this.idsByProviderSymbol.get(key) || new Set();
    ids.add(instrumentId);
    this.idsByProviderSymbol.set(key, ids);
  }

  #unmapProviderSymbol(symbol, instrumentId) {
    const key = upper(symbol);
    const ids = key && this.idsByProviderSymbol.get(key);
    if (!ids) return;
    ids.delete(instrumentId);
    if (ids.size === 0) this.idsByProviderSymbol.delete(key);
  }

  #idForProviderSymbolOrNull(symbol) {
    const ids = this.idsByProviderSymbol.get(upper(symbol));
    return ids?.size === 1 ? [...ids][0] : null;
  }

  #touch(instrumentId) {
    const descriptor = this.descriptors.get(instrumentId);
    if (!descriptor) return;
    this.descriptors.delete(instrumentId);
    this.descriptors.set(instrumentId, descriptor);
  }

  #forget(instrumentId) {
    const descriptor = this.descriptors.get(instrumentId);
    this.descriptors.delete(instrumentId);
    for (const mapping of Object.values(descriptor?.providerSymbols || {})) {
      this.#unmapProviderSymbol(mapping?.symbol, instrumentId);
    }
  }

  #evictOverflow() {
    const capacity = this.pinnedIds.size + this.maxResolvedDescriptors;
    while (this.descriptors.size > capacity) {
      let evictable = null;
      for (const instrumentId of this.descriptors.keys()) {
        if (this.pinnedIds.has(instrumentId)) continue;
        evictable = instrumentId;
        break;
      }
      if (evictable === null) return;
      this.#forget(evictable);
      this.telemetry?.increment?.("instrument_descriptor_evicted", { source: "memory" });
    }
  }

  async #register(descriptor, { persist = true } = {}) {
    this.#assertCanonicalIdMatchesVenue(descriptor);
    this.#remember(descriptor);
    if (persist && this.store && descriptor.mappingStatus === "resolved") {
      try {
        await this.store.set({
          instrumentId: descriptor.id,
          descriptor,
          verifiedAt: descriptor.providerSymbols.yahoo?.verifiedAt || null,
          lastSeenAt: this.clock(),
        });
      } catch (error) {
        this.telemetry?.increment?.("persistence_error", { operation: "catalog-set" });
        this.logger?.warn?.({
          component: "instrument-resolver",
          instrumentId: descriptor.id,
          errorCode: error?.code,
          message: "descriptor persistence failed",
        });
      }
    }
    return descriptor;
  }

  idForProviderSymbol(providerSymbol) {
    return this.#idForProviderSymbolOrNull(providerSymbol);
  }

  capabilitiesFor(descriptor) {
    return buildEffectiveCapabilities({
      assetClass: descriptor.assetClass,
      manifests: this.manifests,
      enabledAssetClasses: this.enabledAssetClasses,
    });
  }

  isAddable(descriptor) {
    if (descriptor.mappingStatus !== "resolved" || descriptor.status === "delisted") {
      return { addable: false, reasonCode: `identity_${descriptor.mappingStatus}` };
    }
    if (!this.enabledAssetClasses.includes(descriptor.assetClass)) {
      return { addable: false, reasonCode: "asset_class_disabled" };
    }
    if (this.capabilitiesFor(descriptor).quote.status === "unsupported") {
      return { addable: false, reasonCode: "quote_unsupported" };
    }
    return { addable: true, reasonCode: null };
  }

  async getDescriptor(instrumentId, { hints, signal } = {}) {
    const id = upper(instrumentId);
    const migratedTo = LEGACY_CANONICAL_ID_MIGRATIONS[id];
    if (migratedTo) {
      this.telemetry?.increment?.("instrument_resolution_total", {
        assetClass: "unknown",
        outcome: "migrated",
        source: "legacy_id",
      });
      throw new MarketDataError(
        ERROR_CODES.MAPPING_AMBIGUOUS,
        `Instrument ID ${id} was migrated to ${migratedTo}`,
        {
          instrumentId: id,
          retryable: false,
          details: { migratedTo, reason: "legacy_id_migrated" },
        },
      );
    }
    const known = this.descriptors.get(id);
    if (known) {
      this.#touch(id);
      this.telemetry?.increment?.("instrument_resolution", {
        assetClass: known.assetClass,
        outcome: "hit",
        source: "memory",
      });
      this.telemetry?.increment?.("instrument_resolution_total", {
        assetClass: known.assetClass,
        outcome: "hit",
        source: "memory",
      });
      return known;
    }

    if (this.store) {
      try {
        const record = await this.store.get(id);
        if (record) {
          const descriptor = await this.#register(record.descriptor, { persist: false });
          this.telemetry?.increment?.("instrument_resolution", {
            assetClass: descriptor.assetClass,
            outcome: "hit",
            source: "store",
          });
          this.telemetry?.increment?.("instrument_resolution_total", {
            assetClass: descriptor.assetClass,
            outcome: "hit",
            source: "store",
          });
          return descriptor;
        }
      } catch (error) {
        this.telemetry?.increment?.("persistence_error", { operation: "catalog-get" });
        this.logger?.warn?.({
          component: "instrument-resolver",
          instrumentId: id,
          errorCode: error?.code,
          message: "catalog store read failed; falling back to cold resolution",
        });
      }
    }
    return this.#coldResolve(id, { hints, signal });
  }

  async #coldResolve(id, { hints, signal } = {}) {
    const decoded = decodeCanonicalId(id);
    const candidates = [];
    const hinted = upper(hints?.yahoo?.symbol || hints?.yahoo);
    if (hinted && PROVIDER_SYMBOL_PATTERN.test(hinted)) candidates.push(hinted);
    const futureIdentity = decoded.assetClass === "commodity_future"
      ? continuousFutureIdentityFor(id)
      : null;
    const deterministic = decoded.mic
      ? providerSymbolCandidatesForVenue({
          provider: "yahoo",
          symbol: decoded.symbol,
          mic: decoded.mic,
        })
      : [futureIdentity
          ? futureIdentity.providerSymbol
          : providerSymbolFor(
              { symbol: decoded.symbol, assetClass: decoded.assetClass || "equity" },
              "yahoo",
            )];
    for (const guessed of deterministic) {
      if (guessed && !candidates.includes(upper(guessed))) candidates.push(upper(guessed));
    }

    let lastFailure = null;
    for (const candidate of candidates) {
      let quote = null;
      try {
        const quotes = await this.provider.hydrateQuotes([candidate], { signal });
        quote = quotes.get(candidate) || null;
      } catch (error) {
        lastFailure = error;
        continue;
      }
      if (!quote) continue;
      let built;
      try {
        built = descriptorFromYahooQuote({ providerSymbol: candidate, quote, clock: this.clock });
      } catch (error) {
        lastFailure = error;
        continue;
      }
      if (!built.descriptor) continue;
      if (built.descriptor.id !== id) {
        lastFailure = new MarketDataError(
          ERROR_CODES.MAPPING_AMBIGUOUS,
          `Provider identity ${built.descriptor.id} does not match the requested ${id}`,
          { instrumentId: id, retryable: false, details: { resolvedId: built.descriptor.id, candidate } },
        );
        continue;
      }
      const descriptor = await this.#register(built.descriptor);
      this.telemetry?.increment?.("instrument_resolution", {
        assetClass: descriptor.assetClass,
        outcome: "resolved",
        source: "cold",
      });
      this.telemetry?.increment?.("instrument_resolution_total", {
        assetClass: descriptor.assetClass,
        outcome: "resolved",
        source: "cold",
      });
      return descriptor;
    }

    this.telemetry?.increment?.("instrument_resolution", {
      assetClass: decoded.assetClass || "unknown",
      outcome: "miss",
      source: "cold",
    });
    this.telemetry?.increment?.("instrument_resolution_total", {
      assetClass: decoded.assetClass || "unknown",
      outcome: "miss",
      source: "cold",
    });
    if (lastFailure instanceof MarketDataError && lastFailure.code === ERROR_CODES.MAPPING_AMBIGUOUS) {
      throw lastFailure;
    }
    throw new MarketDataError(ERROR_CODES.INSTRUMENT_NOT_FOUND, `Instrument not found: ${id}`, {
      instrumentId: id,
      retryable: false,
      cause: lastFailure || undefined,
    });
  }

  async searchInstruments(query, {
    assetClasses = [],
    currency = null,
    venue = null,
    limit = MAX_SEARCH_RESULTS,
    includeUnsupported = false,
    hydrationLimit = SEARCH_HYDRATION_LIMIT,
    signal,
  } = {}) {
    const results = new Map();
    const filters = {
      classes: new Set(assetClasses),
      currency: upper(currency) || null,
      venue: upper(venue) || null,
      includeUnsupported,
    };

    const seedLimit = Math.max(1, Math.min(Number(limit) || MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS));
    const seeded = [];
    for (const descriptor of this.descriptors.values()) {
      const aliases = this.searchAliasesById.get(descriptor.id);
      const score = rankInstrumentCandidate(aliases ? { ...descriptor, aliases } : descriptor, query);
      if (score > 0 && this.#matchesSearchFilters(descriptor, filters)) seeded.push({ descriptor, score });
    }
    seeded.sort((left, right) => right.score - left.score
      || left.descriptor.symbol.localeCompare(right.descriptor.symbol));
    for (const { descriptor, score } of seeded.slice(0, seedLimit)) {
      results.set(descriptor.id, this.#resultRow({
        descriptor,
        score,
        provenance: { discovery: "catalog", hydrated: false, typeConflict: false },
      }));
    }

    let discoveries = [];
    try {
      discoveries = await this.provider.discoverInstruments(query, { limit, signal });
    } catch (error) {
      this.logger?.warn?.({
        component: "instrument-resolver",
        capability: "search",
        errorCode: error?.code,
        message: "provider discovery failed; serving catalog matches only",
      });
    }

    const unknown = [];
    for (const discovery of discoveries) {
      const knownId = this.#idForProviderSymbolOrNull(discovery.providerSymbol);
      if (knownId && results.has(knownId)) continue;
      const knownDescriptor = knownId ? this.descriptors.get(knownId) : null;
      if (knownDescriptor) {
        const descriptor = knownDescriptor;
        results.set(knownId, this.#resultRow({
          descriptor,
          score: rankInstrumentCandidate({ ...descriptor, providerScore: discovery.score }, query),
          provenance: { discovery: "yahoo", hydrated: false, typeConflict: false },
        }));
        continue;
      }
      unknown.push(discovery);
    }

    const toHydrate = unknown.slice(0, Math.max(0, hydrationLimit));
    let hydrated = new Map();
    if (toHydrate.length) {
      try {
        hydrated = await this.provider.hydrateQuotes(
          toHydrate.map((discovery) => discovery.providerSymbol),
          { signal },
        );
      } catch (error) {
        this.logger?.warn?.({
          component: "instrument-resolver",
          capability: "search",
          errorCode: error?.code,
          message: "search hydration failed; results stay provisional",
        });
      }
    }

    for (const discovery of unknown) {
      const quote = hydrated.get(discovery.providerSymbol) || null;
      if (!quote) {
        results.set(`provisional:${discovery.providerSymbol}`, this.#provisionalRow(discovery));
        continue;
      }
      let built;
      try {
        built = descriptorFromYahooQuote({
          providerSymbol: discovery.providerSymbol,
          quote,
          discovery,
          clock: this.clock,
        });
      } catch {
        results.set(`provisional:${discovery.providerSymbol}`, this.#provisionalRow(discovery));
        continue;
      }
      if (built.typeConflict) {
        this.telemetry?.increment?.("provider_type_conflict", {
          provider: "yahoo",
          assetClass: built.descriptor?.assetClass || discovery.quoteType.toLowerCase(),
        });
      }
      if (!built.descriptor) {
        results.set(`unsupported:${discovery.providerSymbol}`, this.#unsupportedRow(discovery, built));
        continue;
      }
      const descriptor = await this.#register(built.descriptor);
      results.set(descriptor.id, this.#resultRow({
        descriptor,
        score: rankInstrumentCandidate({ ...descriptor, providerScore: discovery.score }, query),
        provenance: { discovery: "yahoo", hydrated: true, typeConflict: built.typeConflict },
      }));
    }

    return [...results.values()]
      .filter((row) => {
        const subject = row.instrument ?? row.candidate;
        if (!this.#matchesSearchFilters(subject, filters)) return false;
        if (!includeUnsupported && !row.addable) return false;
        return true;
      })
      .sort((left, right) => right.score - left.score
        || `${left.instrument?.displaySymbol || left.candidate?.providerSymbol}`
          .localeCompare(`${right.instrument?.displaySymbol || right.candidate?.providerSymbol}`))
      .slice(0, Math.max(1, Math.min(Number(limit) || MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS)));
  }

  #assertCanonicalIdMatchesVenue(descriptor) {
    try {
      const derived = encodeCanonicalId({
        assetClass: descriptor.assetClass,
        symbol: descriptor.symbol,
        mic: descriptor.venue?.mic,
      });
      if (derived === descriptor.id) return;
      this.logger?.warn?.({
        component: "instrument-resolver",
        instrumentId: descriptor.id,
        derivedId: derived,
        message: "descriptor id does not match the identity its own venue encodes",
      });
    } catch (error) {
      this.logger?.warn?.({
        component: "instrument-resolver",
        instrumentId: descriptor.id,
        errorCode: error?.code,
        message: "descriptor id could not be re-derived from its venue",
      });
    }
  }

  #matchesSearchFilters(subject, { classes, currency, venue, includeUnsupported }) {
    if (!subject) return false;
    if (classes.size && (!subject.assetClass || !classes.has(subject.assetClass))) return false;
    if (currency && (subject.currency ?? null) !== currency) return false;
    if (venue) {
      const subjectVenue = subject.venue ?? null;
      if (!subjectVenue || ![subjectVenue.code, subjectVenue.mic].map(upper).includes(venue)) return false;
    }
    if (!includeUnsupported && subject.id && !this.isAddable(subject).addable) return false;
    return true;
  }

  #resultRow({ descriptor, score, provenance }) {
    const { addable, reasonCode } = this.isAddable(descriptor);
    return {
      instrument: descriptor,
      candidate: null,
      mappingStatus: descriptor.mappingStatus,
      addable,
      reasonCode,
      capabilities: this.capabilitiesFor(descriptor),
      score: Number.isFinite(score) && score > 0 ? score : 1,
      provenance,
    };
  }

  #provisionalRow(discovery) {
    return {
      instrument: null,
      candidate: {
        providerSymbol: discovery.providerSymbol,
        name: discovery.name,
        assetClass: null,
        provisionalQuoteType: discovery.quoteType,
        venue: null,
        currency: null,
      },
      mappingStatus: "provisional",
      addable: false,
      reasonCode: "identity_provisional",
      capabilities: null,
      score: Math.min(Number(discovery.score) || 0, 100) / 100,
      provenance: { discovery: "yahoo", hydrated: false, typeConflict: false },
    };
  }

  #unsupportedRow(discovery, built) {
    return {
      instrument: null,
      candidate: {
        providerSymbol: discovery.providerSymbol,
        name: built.candidate?.name || discovery.name,
        assetClass: built.candidate?.assetClass ?? null,
        venue: built.candidate?.venue ?? null,
        currency: built.candidate?.currency ?? null,
      },
      mappingStatus: built.candidate?.mappingStatus || "unsupported",
      addable: false,
      reasonCode: built.reasonCode || "unsupported_asset",
      capabilities: null,
      score: Math.min(Number(discovery.score) || 0, 100) / 100,
      provenance: { discovery: "yahoo", hydrated: true, typeConflict: built.typeConflict },
    };
  }
}
