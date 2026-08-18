import { Lifecycle } from "../../core/Lifecycle.js";
import {
  selectBoardSamples,
  selectBoardSnapshot,
  selectAggregateQuality,
} from "../models/boardSelectors.js";
import { selectEligibleBoardCohort } from "../models/boardCohorts.js";
import { presentAggregateCopy } from "../models/qualityPresentation.js";
import { PopoverController } from "../primitives/PopoverController.js";

const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const toneOf = (value) => (!isFiniteNumber(value) || value === 0 ? "neutral" : value > 0 ? "positive" : "negative");

export class BoardSnapshotView {
  constructor(app, instruments, helpers = {}, options = {}) {
    this.app = app;
    this.instruments = instruments || [];
    this.helpers = helpers;
    this.root = options.root || document;
    this.document = this.root.ownerDocument || this.root;
    this.lifecycle = new Lifecycle();
    this.frame = null;
    this.scheduled = false;
    this.resultCount = { shown: 0, total: 0, filtered: false };
    this.topMoverId = null;
    this.leadingSector = null;
    this.announcedState = null;
  }

  init() {
    this.statusPopover = new PopoverController(
      this.#byId("feed-status-info"),
      this.#byId("feed-status-popover"),
      this.lifecycle,
      { document: this.document },
    );
    this.guidePopover = new PopoverController(
      this.#byId("board-guide-info"),
      this.#byId("board-guide-popover"),
      this.lifecycle,
      { document: this.document },
    );
    const mover = this.#byId("snap-mover");
    if (mover) {
      this.lifecycle.listen(mover, "click", () => {
        if (this.topMoverId) this.helpers.openInstrumentDetails?.(this.topMoverId);
      });
    }
    const advancing = this.#byId("snap-advancing");
    if (advancing) {
      this.lifecycle.listen(advancing, "click", () => {
        this.helpers.applyPulseFilters?.({ assetClass: "equity", movement: "advancing" });
      });
    }
    const declining = this.#byId("snap-declining");
    if (declining) {
      this.lifecycle.listen(declining, "click", () => {
        this.helpers.applyPulseFilters?.({ assetClass: "equity", movement: "declining" });
      });
    }
    const leading = this.#byId("snap-leading");
    if (leading) {
      this.lifecycle.listen(leading, "click", () => {
        if (!this.leadingSector) return;
        this.helpers.applyPulseFilters?.({
          assetClass: "equity",
          category: this.leadingSector,
        });
      });
    }
    this.update();
  }

  destroy() {
    this.lifecycle.destroy();
    this.#cancelFrame();
  }

  setInstruments(instruments) {
    this.instruments = instruments || [];
    this.update();
  }

  setResultCount(shown, total, filtered) {
    this.resultCount = { shown, total, filtered };
    this.#renderResultCount();
  }

  scheduleUpdate() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.frame = this.#requestFrame(() => {
      this.frame = null;
      this.scheduled = false;
      this.update();
    });
  }

  update() {
    const samples = selectBoardSamples({
      instruments: this.#instruments(),
      getTile: (identity) => this.app?.state?.getTile?.(identity),
    });
    const pulseSamples = selectEligibleBoardCohort(samples, "equity_pulse");
    const equityTotal = samples.filter(({ instrument }) => (
      !instrument?.assetClass || instrument.assetClass === "equity"
    )).length;
    this.#renderPulse(selectBoardSnapshot(pulseSamples.length >= 2 ? pulseSamples : []));
    this.#renderPulseCoverage(pulseSamples.length, equityTotal);
    this.#renderStatus(selectEligibleBoardCohort(samples, "aggregate_quality"));
    this.#renderResultCount();
  }

  #renderPulseCoverage(valid, total) {
    const suffix = valid < 2 ? " · insufficient coverage" : "";
    const copy = `Equity pulse — ${valid} of ${total} equities${suffix}`;
    this.root.querySelector(".mm-pulse")?.setAttribute("aria-label", copy);
  }

  #renderPulse(snapshot) {
    this.#renderSpread(snapshot);
    this.#setSigned("snap-breadth", snapshot.breadth, 0, "%");
    this.#setSigned("snap-average", snapshot.average, 2, "%");
    this.#setValue(
      "snap-dispersion",
      isFiniteNumber(snapshot.dispersion) ? `${snapshot.dispersion.toFixed(2)}%` : "—",
      "neutral",
    );
    this.#renderTopMover(snapshot.topMover);
    const leading = snapshot.leadingSector;
    const leadingButton = this.#byId("snap-leading");
    this.leadingSector = leading?.sector || null;
    if (leading) {
      const sign = leading.average > 0 ? "+" : "";
      this.#setValue("snap-leading", `${leading.sector} ${sign}${leading.average.toFixed(2)}%`, toneOf(leading.average));
      leadingButton?.setAttribute(
        "aria-label",
        `Filter to equities in ${leading.sector}, the leading sector`,
      );
    } else {
      this.#setValue("snap-leading", "—", "neutral");
      leadingButton?.setAttribute("aria-label", "Leading sector unavailable");
    }
    if (leadingButton) leadingButton.disabled = !leading;
  }

  #renderSpread({ advancing, declining, unchanged, sampleCount }) {
    this.#renderMovementAction("snap-advancing", advancing, sampleCount, "advancing");
    this.#renderMovementAction("snap-declining", declining, sampleCount, "declining");
    const spread = this.#byId("snap-spread");
    if (spread) {
      spread.setAttribute("aria-label", sampleCount
        ? `${advancing} advancing, ${declining} declining, ${unchanged} unchanged`
        : "Advance and decline unavailable");
    }
    const bar = this.#byId("snap-bar");
    if (bar) {
      bar.hidden = sampleCount === 0;
      const shares = { up: advancing, flat: unchanged, down: declining };
      for (const segment of bar.querySelectorAll("[data-side]")) {
        const share = shares[segment.dataset.side] || 0;
        segment.style.flexGrow = String(share);
        segment.hidden = share === 0;
      }
    }
  }

  #renderMovementAction(id, count, sampleCount, pulseLabel) {
    const button = this.#byId(id);
    if (!button) return;
    button.textContent = sampleCount ? String(count) : "—";
    button.disabled = sampleCount === 0;
    button.setAttribute("aria-label", sampleCount
      ? `${count} ${pulseLabel} equities; filter to them`
      : `Equity ${pulseLabel} unavailable`);
  }

  #renderTopMover(topMover) {
    const button = this.#byId("snap-mover");
    if (!button) return;
    this.topMoverId = topMover?.instrumentId || null;
    button.disabled = !topMover;
    const text = topMover
      ? `${topMover.symbol} ${topMover.change > 0 ? "+" : ""}${topMover.change.toFixed(2)}%`
      : "—";
    this.#applyValue(button, text, topMover ? toneOf(topMover.change) : "neutral");
  }

  #renderStatus(samples) {
    const { state } = selectAggregateQuality(samples);
    const copy = presentAggregateCopy(state, { time: this.#feedTime() || this.#latestTime(samples) });
    this.#setText("feed-status-copy", copy);
    const status = this.root.querySelector(".mm-status");
    const previousState = this.announcedState ?? status?.dataset.state ?? null;
    if (status) status.dataset.state = state;
    this.announcedState = state;
    if (state !== previousState) this.#setText("feed-status-announcement", presentAggregateCopy(state));
  }

  #renderResultCount() {
    const { shown, total, filtered } = this.resultCount;
    let text;
    if (total === 0) text = "0 instruments";
    else if (!filtered) text = `${total} instrument${total === 1 ? "" : "s"}`;
    else if (shown === 0) text = "No instruments match these filters";
    else text = `${shown} of ${total} shown`;
    this.#setText("result-count", text);
  }

  #latestTime(samples) {
    let latest = Number.NEGATIVE_INFINITY;
    for (const sample of samples) {
      if (sample.quality === "unavailable") continue;
      const parsed = Date.parse(sample.tile?.fetchedAt ?? sample.tile?.asOf ?? "");
      if (Number.isFinite(parsed)) latest = Math.max(latest, parsed);
    }
    if (!Number.isFinite(latest)) return null;
    return this.helpers.formatRelativeTime?.(new Date(latest)) || null;
  }

  #feedTime() {
    const updatedAt = this.app?.feed?.lastUpdatedAt;
    if (!Number.isFinite(Date.parse(updatedAt))) return null;
    return this.helpers.formatRelativeTime?.(new Date(updatedAt)) || null;
  }

  #instruments() {
    return this.app?.assets || this.instruments || [];
  }

  #setSigned(id, value, precision, suffix) {
    if (!isFiniteNumber(value)) return this.#setValue(id, "—", "neutral");
    const text = `${value > 0 ? "+" : ""}${value.toFixed(precision)}${suffix}`;
    return this.#setValue(id, text, toneOf(value));
  }

  #setValue(id, text, tone) {
    const element = this.#byId(id);
    if (element) this.#applyValue(element, text, tone);
  }

  #applyValue(element, text, tone) {
    element.textContent = text;
    element.classList.remove("positive", "negative", "neutral");
    element.classList.add(tone);
  }

  #setText(id, text) {
    const element = this.#byId(id);
    if (element) element.textContent = String(text);
  }

  #byId(id) {
    return this.root.querySelector(`#${id}`);
  }

  #requestFrame(callback) {
    const view = this.document.defaultView || globalThis;
    return typeof view.requestAnimationFrame === "function"
      ? view.requestAnimationFrame(callback)
      : view.setTimeout(callback, 0);
  }

  #cancelFrame() {
    if (this.frame == null) return;
    const view = this.document.defaultView || globalThis;
    if (typeof view.cancelAnimationFrame === "function") view.cancelAnimationFrame(this.frame);
    else view.clearTimeout(this.frame);
    this.frame = null;
  }
}
