export const ARIA_QUALITY = Object.freeze({
  fresh: "current",
  delayed: "delayed",
  stale: "last confirmed",
  unavailable: "unavailable",
});

export function buildTileAriaLabel({ name, symbol, viewModel, quality }) {
  const displaySymbol = viewModel.displaySymbol || symbol;
  const identity = !name || name === displaySymbol ? displaySymbol : `${name} (${displaySymbol})`;
  const parts = [`Open ${identity} details.`];
  if (typeof viewModel.value === "number" && Number.isFinite(viewModel.value)) {
    parts.push(`Price ${viewModel.formattedValue}.`);
  }
  if (typeof viewModel.changePercent === "number" && Number.isFinite(viewModel.changePercent)) {
    const direction = viewModel.changePercent > 0 ? "up" : viewModel.changePercent < 0 ? "down" : "flat";
    parts.push(`${direction} ${Math.abs(viewModel.changePercent).toFixed(2)} percent.`);
  }
  parts.push(`Data ${ARIA_QUALITY[quality] || "unavailable"}.`);
  return parts.join(" ");
}
