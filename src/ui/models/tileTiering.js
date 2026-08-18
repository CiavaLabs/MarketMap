export const HERO_COUNT = 3;
export const WIDE_COUNT = 8;
const DEMOTE_MARGIN = 2;

const TIER_RANK = { hero: 0, wide: 1, compact: 2 };

function idealTierFor(rank) {
  if (rank < HERO_COUNT) return "hero";
  if (rank < WIDE_COUNT) return "wide";
  return "compact";
}

function resolveTier(previousTier, idealTier, rank) {
  if (TIER_RANK[idealTier] <= TIER_RANK[previousTier]) return idealTier;
  if (previousTier === "hero" && rank < HERO_COUNT + DEMOTE_MARGIN) return "hero";
  if (previousTier === "wide" && rank < WIDE_COUNT + DEMOTE_MARGIN) return "wide";
  return idealTier;
}

export function computeTiers(samples, previousTiers = new Map()) {
  const ranked = [...samples].sort((a, b) => {
    const magnitudeA = Math.abs(a.changePercent ?? 0);
    const magnitudeB = Math.abs(b.changePercent ?? 0);
    return magnitudeB - magnitudeA;
  });
  const next = new Map();
  ranked.forEach(({ instrumentId }, rank) => {
    if (!instrumentId) return;
    const previousTier = previousTiers.get(instrumentId) || "compact";
    next.set(instrumentId, resolveTier(previousTier, idealTierFor(rank), rank));
  });
  return next;
}
