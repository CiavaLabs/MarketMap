function nonNegativeFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function empiricalExceedance(currentScore, referenceScores) {
  if (!nonNegativeFinite(currentScore)) {
    throw new TypeError("currentScore must be a finite non-negative number");
  }
  if (!Array.isArray(referenceScores) || !referenceScores.length
    || referenceScores.some((value) => !nonNegativeFinite(value))) {
    throw new TypeError("referenceScores must be a non-empty array of finite non-negative numbers");
  }
  const exceedanceCount = referenceScores
    .reduce((count, value) => count + Number(value >= currentScore), 0);
  const empiricalExceedanceRate = (1 + exceedanceCount) / (referenceScores.length + 1);
  return {
    exceedanceCount,
    referenceCount: referenceScores.length,
    empiricalExceedanceRate,
    historicalRarityPercentile: 100 * (1 - empiricalExceedanceRate),
  };
}
