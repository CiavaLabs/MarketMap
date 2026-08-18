import { UpdateScheduler } from "../core/UpdateScheduler.js";
import { GridBridgeRenderer } from "../render/GridBridgeRenderer.js";
import { perfStart, perfEnd } from "../utils/perfHelpers.js";

export class TileController {
  constructor({ state, registry, historyLength, gridApi }) {
    this.state = state;
    this.registry = registry;
    this.historyLength = historyLength;

    this.renderer = new GridBridgeRenderer({
      state,
      assets: registry.assets,
      assetIndexLookup: registry.assetIndexLookup,
      historySeries: registry.historySeries,
      gridApi,
    });

    this.scheduler = new UpdateScheduler(
      (batch) => this.renderer.renderBatch(batch),
      { perfLabel: "tileBatchFlush" },
    );
  }

  markTileDirty(ticker) {
    const tile = this.state.getTile(ticker);
    if (tile) {
      tile.dirty = true;
    }
  }

  markAllDirty() {
    this.state.getAllTiles().forEach((tile) => {
      if (tile) {
        tile.dirty = true;
      }
    });
  }

  scheduleTileUpdate(ticker, index) {
    if (ticker) {
      this.scheduler.request(ticker, index);
    }
  }

  cancelScheduledUpdate(ticker) {
    if (ticker) {
      this.scheduler.cancel(ticker);
    }
  }

  flushScheduledUpdates() {
    this.scheduler.clear();
  }

  destroy() {
    this.scheduler.destroy();
  }

  renderImmediate(ticker, index) {
    this.markTileDirty(ticker);
    this.cancelScheduledUpdate(ticker);
    this.renderer.renderTile(ticker, index);
  }

  renderAll() {
    const perfId = perfStart("paintAll");
    this.flushScheduledUpdates();
    this.markAllDirty();
    this.renderer.renderAll();
    perfEnd(perfId, this.registry.assets.length);
  }

  handleTileUpdated({ instrumentId, id, ticker, index }) {
    const identity = instrumentId || id || ticker;
    if (!identity) return;
    const tile = this.state.getTile(identity);
    if (tile) {
      tile.dirty = true;
    }

    if (tile && tile.price != null) {
      this.registry.appendQuote(identity, tile, this.historyLength);
    }

    const cacheIndex =
      typeof index === "number" ? index : this.registry.getAssetIndex(identity);
    this.scheduler.request(identity, cacheIndex);
  }

  handleTilesBatchUpdated({ items, tickers }) {
    const updates = Array.isArray(items) ? items : tickers;
    if (!Array.isArray(updates)) return;

    const perfId = perfStart("handleTilesBatch");

    updates.forEach(({ instrumentId, id, ticker, index }) => {
      const identity = instrumentId || id || ticker;
      if (!identity) return;

      const tile = this.state.getTile(identity);
      if (tile) {
        tile.dirty = true;
      }

      if (tile && tile.price != null) {
        this.registry.appendQuote(identity, tile, this.historyLength);
      }

      const cacheIndex =
        typeof index === "number" ? index : this.registry.getAssetIndex(identity);
      this.scheduler.request(identity, cacheIndex);
    });

    perfEnd(perfId, updates.length);
  }
}
