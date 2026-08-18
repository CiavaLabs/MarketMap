import { CONFIG } from "../config.js";
import { legacyCompatiblePresentationInput } from "../ui/models/assetPresentationPolicy.js";
import { buildTileViewModel } from "../ui/models/tileViewModel.js";
import { buildTileAriaLabel } from "../ui/models/tileAriaLabel.js";
import { toDesignSystemQuality } from "../ui/models/dataQuality.js";
import { perfStart, perfEnd } from "../utils/perfHelpers.js";

const QUALITY_VALUES = ["fresh", "delayed", "stale", "unavailable"];

function identityFor(asset) {
  return asset?.id || asset?.instrumentId || asset?.instrument?.id || null;
}

function deriveTileState(changePercent, quality, price) {
  if (quality === "unavailable" || price === null) return "unavailable";
  const thresholds = CONFIG.UI.THRESHOLDS;
  if (changePercent === null) return "neutral";
  if (changePercent > thresholds.STRONG_GAIN) return "gaining-strong";
  if (changePercent > thresholds.MILD_GAIN) return "gaining";
  if (changePercent < thresholds.STRONG_LOSS) return "losing-strong";
  if (changePercent < thresholds.MILD_LOSS) return "losing";
  return "neutral";
}

export class GridBridgeRenderer {
  constructor({ state, assets = [], assetIndexLookup = new Map(), historySeries, gridApi }) {
    this.state = state;
    this.assets = assets;
    this.assetIndexLookup = assetIndexLookup;
    this.historySeries = historySeries || new Map();
    this.gridApi = gridApi;
  }

  _sparklineSeries(identity) {
    const instrumentId = this.state?.resolveInstrumentId?.(identity) || identity;
    const series = this.historySeries.get(instrumentId);
    return Array.isArray(series) ? series : [];
  }

  renderBatch(items = []) {
    const entries = [];
    items.forEach((item) => {
      const identity = item.instrumentId || item.id || item.symbol || item.ticker;
      const entry = this._buildEntry(identity, item.index);
      if (entry) entries.push(entry);
    });
    if (entries.length) this.gridApi?.applyBatch(entries);
  }

  renderAll() {
    const perfId = perfStart("paintAll");
    const entries = this.assets
      .map((asset, index) => this._buildEntry(identityFor(asset) || asset.symbol, index))
      .filter(Boolean);
    if (entries.length) this.gridApi?.applyBatch(entries);
    perfEnd(perfId, this.assets.length);
  }

  renderTile(identity, indexHint = undefined) {
    const entry = this._buildEntry(identity, indexHint);
    if (entry) this.gridApi?.applyBatch([entry]);
  }

  _buildEntry(identity, indexHint) {
    if (!identity) return null;
    const tile = this.state.getTile(identity);
    if (!tile) return null;
    const instrumentId = tile.instrumentId;
    const index = typeof indexHint === "number"
      ? indexHint
      : this.assetIndexLookup.get(instrumentId) ?? -1;
    if (index === -1) return null;

    const perfId = perfStart("paintTile");
    try {
      const series = this._sparklineSeries(instrumentId);
      const viewModel = buildTileViewModel({
        instrument: legacyCompatiblePresentationInput(tile),
        quote: tile,
        requestState: { history: series.length >= 2 ? "ready" : null },
      });
      const quality = QUALITY_VALUES.includes(viewModel.quality) ? viewModel.quality : "unavailable";
      const derivedState = deriveTileState(viewModel.changePercent, quality, viewModel.value);
      const asset = this.assets[index];
      const ariaLabel = buildTileAriaLabel({ name: asset?.name, symbol: tile.symbol, viewModel, quality });
      const sparklineData = viewModel.sparkline.requestable && quality !== "unavailable"
        ? series.filter((value) => typeof value === "number" && Number.isFinite(value))
        : [];

      tile.dirty = false;
      return {
        instrumentId,
        index,
        viewModel,
        quality,
        designSystemQuality: toDesignSystemQuality(quality),
        derivedState,
        ariaLabel,
        sparklineData,
      };
    } catch {
      return null;
    } finally {
      perfEnd(perfId);
    }
  }
}
