import { forwardRef, memo, useCallback, useSyncExternalStore } from "react";
import { AssetTile } from "@ciavalabs/ds-react/market";

function AssetTileCellImpl({
  instrumentId,
  index,
  tier,
  placementStyle,
  store,
  onSelect,
  grabbed,
  dragHandlers,
  onReorderKeyDown,
  onReorderClick,
  onReorderBlur,
}, ref) {
  const subscribe = useCallback(
    (listener) => store.subscribe(instrumentId, listener),
    [store, instrumentId],
  );
  const getSnapshot = useCallback(() => store.getSnapshot(instrumentId), [store, instrumentId]);
  const entry = useSyncExternalStore(subscribe, getSnapshot);
  const { viewModel, sparklineData, derivedState, quality, designSystemQuality, ariaLabel } = entry;
  const handleClick = useCallback((event) => onSelect(index, {
    instrumentId,
    sourceElement: event.currentTarget.closest?.("[data-layout-id]") || null,
  }), [index, instrumentId, onSelect]);

  if (!viewModel) return null;

  return (
    <div
      ref={ref}
      className="mm-layout-cell"
      data-layout-id={instrumentId}
      data-grabbed={grabbed ? "true" : undefined}
      style={placementStyle}
      {...dragHandlers}
    >
      <AssetTile
        ticker={viewModel.displaySymbol}
        name={viewModel.name}
        price={viewModel.formattedValue}
        change={viewModel.changePercent ?? 0}
        quality={designSystemQuality}
        assetClass={viewModel.assetClass}
        sector={viewModel.footerLabel}
        sparklineData={sparklineData || []}
        size={tier}
        className="asset-tile"
        data-instrument-id={instrumentId}
        data-index={index}
        data-tier={tier}
        data-state={derivedState}
        data-quality={quality}
        aria-label={ariaLabel}
        onClick={handleClick}
      />
      <button
        type="button"
        className="mm-reorder-handle mm-reorder-handle--keyboard"
        aria-label={`Reorder ${viewModel.displaySymbol || viewModel.name || instrumentId}`}
        aria-describedby="board-reorder-instructions"
        data-reorder-handle={instrumentId}
        onClick={onReorderClick}
        onBlur={onReorderBlur}
        onKeyDown={onReorderKeyDown}
      >
        <span aria-hidden="true">⠿</span>
      </button>
    </div>
  );
}

export const AssetTileCell = memo(forwardRef(AssetTileCellImpl));
