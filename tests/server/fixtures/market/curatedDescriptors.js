import { InstrumentCatalog } from "../../../../server/instruments/InstrumentCatalog.js";
import { descriptorFromLegacyInstrument } from "../../../../server/instruments/descriptorFactory.js";

export const CURATED_VERIFIED_AT = "2026-07-16T00:00:00.000Z";

export const curatedCatalog = new InstrumentCatalog();

export function descriptorFrom(catalog, instrumentId) {
  return descriptorFromLegacyInstrument(
    catalog.resolve(String(instrumentId).toUpperCase()),
    { verifiedAt: CURATED_VERIFIED_AT },
  );
}

export function curatedDescriptor(instrumentId) {
  return descriptorFrom(curatedCatalog, instrumentId);
}

export function catalogDescriptorResolver(catalog = curatedCatalog) {
  return {
    getDescriptor: async (value) => descriptorFrom(catalog, value),
    idForProviderSymbol: (symbol) => catalog.resolveByProviderSymbol?.(symbol)?.id || null,
    capabilitiesFor: () => ({ news: { status: "supported" } }),
    isAddable: () => ({ addable: true, reasonCode: null }),
    searchInstruments: async () => [],
  };
}
