export const QLIKE_VARIANCE_DEFINITION =
  "log(forecastVariance) + realizedReturn^2 / forecastVariance";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function qlikeVarianceLoss({
  forecastVariance,
  realizedReturn,
} = {}) {
  if (!finite(forecastVariance) || forecastVariance <= 0) {
    throw new TypeError("forecastVariance must be a finite positive number");
  }
  if (!finite(realizedReturn)) {
    throw new TypeError("realizedReturn must be a finite number");
  }

  const loss = Math.log(forecastVariance)
    + realizedReturn ** 2 / forecastVariance;
  if (!finite(loss)) {
    throw new RangeError("QLIKE variance loss must be finite");
  }
  return loss;
}

function interpolatedQuantile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const weight = position - lowerIndex;
  return sortedValues[lowerIndex]
    + weight * (sortedValues[upperIndex] - sortedValues[lowerIndex]);
}

export function summarizeRarityDistribution(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("values must be an array");
  }
  if (!values.length) return null;
  if (values.some((value) => !finite(value) || value < 0 || value > 100)) {
    throw new TypeError(
      "rarity values must be finite numbers between zero and one hundred",
    );
  }

  const ordered = [...values].sort((left, right) => left - right);
  const sum = ordered.reduce((total, value) => total + value, 0);
  const mean = sum / ordered.length;
  const distribution = {
    count: ordered.length,
    minimum: ordered[0],
    p10: interpolatedQuantile(ordered, 0.1),
    p25: interpolatedQuantile(ordered, 0.25),
    median: interpolatedQuantile(ordered, 0.5),
    p75: interpolatedQuantile(ordered, 0.75),
    p90: interpolatedQuantile(ordered, 0.9),
    maximum: ordered.at(-1),
    mean,
  };
  if (Object.values(distribution).some((value) => !finite(value))) {
    throw new RangeError("rarity distribution must contain only finite values");
  }
  return distribution;
}
