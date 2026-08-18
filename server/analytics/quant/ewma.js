import {
  EWMA_LAMBDA,
  EWMA_WARMUP_RETURNS,
} from "../contracts/constants.js";

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function zeroMeanSecondMoment(values) {
  if (!Array.isArray(values) || !values.length || values.some((value) => !finite(value))) {
    return null;
  }
  const sum = values.reduce((total, value) => total + value ** 2, 0);
  const result = sum / values.length;
  return Number.isFinite(result) ? result : null;
}

export function computeEwmaForecastPath(
  returns,
  {
    lambda = EWMA_LAMBDA,
    warmupReturns = EWMA_WARMUP_RETURNS,
  } = {},
) {
  if (!Array.isArray(returns)) throw new TypeError("returns must be an array");
  if (!Number.isFinite(lambda) || lambda <= 0 || lambda >= 1) {
    throw new TypeError("lambda must be strictly between zero and one");
  }
  if (!Number.isInteger(warmupReturns) || warmupReturns < 2) {
    throw new TypeError("warmupReturns must be an integer of at least two");
  }

  const forecasts = new Array(returns.length).fill(null);
  const warmup = [];
  let variance = null;
  let initialVariance = null;
  let initializedAtIndex = null;
  let degenerate = false;
  let validReturnCount = 0;

  for (let index = 0; index < returns.length; index += 1) {
    const observed = returns[index];
    const observedIsFinite = finite(observed);
    if (observedIsFinite) validReturnCount += 1;

    if (variance === null) {
      if (!degenerate && observedIsFinite && warmup.length < warmupReturns) {
        warmup.push(observed);
        if (warmup.length === warmupReturns) {
          initialVariance = zeroMeanSecondMoment(warmup);
          initializedAtIndex = index;
          if (!finite(initialVariance) || initialVariance <= 0) {
            degenerate = true;
          } else {
            variance = initialVariance;
          }
        }
      }
      continue;
    }

    const dailyVolatility = Math.sqrt(variance);
    if (!finite(dailyVolatility) || dailyVolatility <= 0) {
      degenerate = true;
      variance = null;
      continue;
    }
    const standardizedReturn = observedIsFinite
      ? observed / dailyVolatility
      : null;
    if (standardizedReturn !== null && !finite(standardizedReturn)) {
      degenerate = true;
      variance = null;
      continue;
    }
    forecasts[index] = {
      variance,
      dailyVolatility,
      standardizedReturn,
    };

    if (observedIsFinite) {
      const nextVariance = lambda * variance + (1 - lambda) * observed ** 2;
      if (!finite(nextVariance) || nextVariance <= 0) {
        degenerate = true;
        variance = null;
      } else {
        variance = nextVariance;
      }
    }
  }

  const status = degenerate
    ? "degenerate_variance"
    : warmup.length < warmupReturns
      ? "insufficient_data"
      : "available";
  return {
    status,
    forecasts,
    warmupObservationCount: warmup.length,
    validReturnCount,
    initializedAtIndex,
    initialVariance,
  };
}
