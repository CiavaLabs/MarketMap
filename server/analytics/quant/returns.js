function positiveFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function calculateSimpleReturn(previousPrice, currentPrice) {
  if (!positiveFinite(previousPrice) || !positiveFinite(currentPrice)) return null;
  const value = currentPrice / previousPrice - 1;
  return Number.isFinite(value) ? value : null;
}

export function calculateLogReturn(previousPrice, currentPrice) {
  if (!positiveFinite(previousPrice) || !positiveFinite(currentPrice)) return null;
  const value = Math.log(currentPrice / previousPrice);
  return Number.isFinite(value) ? value : null;
}

export function buildAdjacentReturns(alignedRows) {
  if (!Array.isArray(alignedRows)) throw new TypeError("alignedRows must be an array");
  const returns = [];
  for (let index = 1; index < alignedRows.length; index += 1) {
    const previous = alignedRows[index - 1];
    const current = alignedRows[index];
    const previousPrice = previous?.assetBar?.adjustedClose;
    const currentPrice = current?.assetBar?.adjustedClose;
    const simpleReturn = calculateSimpleReturn(previousPrice, currentPrice);
    const logReturn = calculateLogReturn(previousPrice, currentPrice);
    let reasonCode = null;
    if (previous?.assetBar === null || current?.assetBar === null) {
      reasonCode = "missing_asset_session";
    } else if (simpleReturn === null || logReturn === null) {
      reasonCode = "invalid_adjusted_close";
    }
    returns.push({
      previousSessionDate: previous?.sessionDate || null,
      sessionDate: current?.sessionDate || null,
      simpleReturn,
      logReturn,
      reasonCode,
    });
  }
  return returns;
}
