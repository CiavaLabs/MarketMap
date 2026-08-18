const finite = (value) => typeof value === "number" && Number.isFinite(value);

export function computeRangePosition(price, low, high) {
  if (!finite(price) || !finite(low) || !finite(high) || high <= low) return null;
  return Math.min(1, Math.max(0, (price - low) / (high - low)));
}
