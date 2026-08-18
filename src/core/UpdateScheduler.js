import { perfStart, perfEnd } from "../utils/perfHelpers.js";

const raf =
  typeof window !== "undefined" && window.requestAnimationFrame
    ? window.requestAnimationFrame.bind(window)
    : (cb) => setTimeout(cb, 16);
const cancelRaf =
  typeof window !== "undefined" && window.cancelAnimationFrame
    ? window.cancelAnimationFrame.bind(window)
    : clearTimeout;

export class UpdateScheduler {
  constructor(flushCallback, options = {}) {
    this.flushCallback = flushCallback;
    this.pending = new Map();
    this.frameScheduled = false;
    this.frameId = null;
    this.destroyed = false;
    this.perfLabel = options.perfLabel || "updateScheduler";
  }

  request(ticker, index) {
    if (!ticker || this.destroyed) return;
    if (index !== undefined) {
      this.pending.set(ticker, index);
    } else if (!this.pending.has(ticker)) {
      this.pending.set(ticker, undefined);
    }

    if (!this.frameScheduled) {
      this.frameScheduled = true;
      this.frameId = raf(() => this._flush());
    }
  }

  cancel(ticker) {
    if (!ticker) return;
    this.pending.delete(ticker);
  }

  clear() {
    this.pending.clear();
    this._cancelFrame();
  }

  destroy() {
    this.clear();
    this.destroyed = true;
    this.flushCallback = () => {};
  }

  flushImmediate() {
    this._cancelFrame();
    if (!this.pending.size) {
      this.flushCallback([], true);
      return;
    }
    this._flush(true);
  }

  _cancelFrame() {
    if (this.frameId != null) cancelRaf(this.frameId);
    this.frameId = null;
    this.frameScheduled = false;
  }

  _flush(immediate = false) {
    this.frameId = null;
    if (!this.pending.size) {
      this.frameScheduled = false;
      return;
    }

    this.frameScheduled = false;
    const perfId = perfStart(this.perfLabel);
    try {
      const batch = Array.from(this.pending.entries()).map(([ticker, index]) => ({
        ticker,
        index,
      }));
      this.pending.clear();
      this.flushCallback(batch, immediate);
      perfEnd(perfId, batch.length);
    } catch (error) {
      perfEnd(perfId);
      throw error;
    }
  }
}
