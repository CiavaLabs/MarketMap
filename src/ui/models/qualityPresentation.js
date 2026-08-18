export function presentAggregateCopy(state, { time = null } = {}) {
  const at = time ? ` ${time}` : "";
  switch (state) {
    case "current": return `Last updated${at}`;
    case "confirmed": return `Last confirmed${at}`;
    case "partial": return `Partial update${at}`;
    case "unavailable": return "Update unavailable";
    case "empty": return "No instruments";
    default: return "Update unavailable";
  }
}

export function shouldPulse(state) {
  return state === "current";
}

const TILE_QUALITY_LABELS = Object.freeze({
  fresh: "Fresh",
  delayed: "Delayed",
  stale: "Last confirmed",
  unavailable: "Unavailable",
});

export function presentTileQuality(quality) {
  return TILE_QUALITY_LABELS[quality] || TILE_QUALITY_LABELS.unavailable;
}
