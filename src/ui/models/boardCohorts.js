const finite = (value) => typeof value === "number" && Number.isFinite(value);

function instrumentOf(sample) {
  return sample?.instrument?.instrument || sample?.instrument || sample?.descriptor || sample || {};
}

function quoteOf(sample) {
  return sample?.quote || sample?.tile || sample || {};
}

function capabilityOf(sample, operation) {
  return sample?.capabilities?.[operation]
    || sample?.instrument?.capabilities?.[operation]
    || sample?.instrument?.instrument?.capabilities?.[operation]
    || null;
}

function hasOperationCapability(sample, operation) {
  const capability = capabilityOf(sample, operation);
  if (capability) return capability.status !== "unsupported";
  if (operation === "quote") {
    const quote = quoteOf(sample);
    return quote !== sample || finite(quote.value) || finite(quote.price) || quote.quality != null;
  }
  return false;
}

function availabilityStatus(quote, field) {
  const availability = quote?.fieldAvailability?.[field];
  return typeof availability === "string" ? availability : availability?.status;
}

function usablePercentChange(sample) {
  const quote = quoteOf(sample);
  const value = finite(quote.changePercent)
    ? quote.changePercent
    : finite(sample?.changePercent)
      ? sample.changePercent
      : finite(sample?.change)
        ? sample.change
        : null;
  if (value === null) return false;
  if (quote.quality === "unavailable" || sample?.quality === "unavailable") return false;
  if (quote.dataQuality?.status === "unusable") return false;
  return ![
    "not_applicable", "unsupported", "temporarily_unavailable", "invalid",
  ].includes(availabilityStatus(quote, "changePercent"));
}

export function selectEligibleBoardCohort(samples = [], purpose = "aggregate_quality") {
  if (!Array.isArray(samples)) return [];
  switch (purpose) {
    case "pulse":
    case "equity_pulse":
      return samples.filter((sample) => {
        const assetClass = instrumentOf(sample).assetClass;
        return (!assetClass || assetClass === "equity")
          && hasOperationCapability(sample, "quote")
          && usablePercentChange(sample);
      });
    case "quality":
    case "board_status":
    case "aggregate_quality":
      return samples.filter((sample) => hasOperationCapability(sample, "quote"));
    case "history":
    case "details":
    case "news":
    case "analytics":
      return samples.filter((sample) => hasOperationCapability(sample, purpose));
    default:
      throw new RangeError(`Unknown board cohort purpose: ${String(purpose)}`);
  }
}
