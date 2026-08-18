import { validateHistorySeries } from "../contracts/market/history.js";
import { computeMovementAssessment } from "./computeMovementAssessment.js";
import { validateSessionGrid } from "./data/sessionGrid.js";

export class AnalyticsEngine {
  constructor({
    computeMovement = computeMovementAssessment,
    validateHistory = validateHistorySeries,
    validateGrid = validateSessionGrid,
  } = {}) {
    if (typeof computeMovement !== "function") {
      throw new TypeError("computeMovement must be a function");
    }
    if (typeof validateHistory !== "function") {
      throw new TypeError("validateHistory must be a function");
    }
    if (typeof validateGrid !== "function") {
      throw new TypeError("validateGrid must be a function");
    }
    this.computeMovement = computeMovement;
    this.validateNormalizedHistory = validateHistory;
    this.validateNormalizedSessionGrid = validateGrid;
    this.contractValidatedSeries = new WeakMap();
  }

  validateHistory(series, label = "history") {
    const memoizable = series !== null && typeof series === "object";
    if (memoizable && this.contractValidatedSeries.has(series)) {
      return this.contractValidatedSeries.get(series);
    }
    const validated = this.validateNormalizedHistory(series, { path: label });
    if (memoizable) this.contractValidatedSeries.set(series, validated);
    return validated;
  }

  validateSessionGrid(sessionGrid) {
    return this.validateNormalizedSessionGrid(sessionGrid);
  }

  assessMovement({ assetSeries, benchmarkSeries, sessionGrid } = {}) {
    this.validateHistory(assetSeries, "assetSeries");
    this.validateHistory(benchmarkSeries, "benchmarkSeries");
    const normalizedSessionGrid = this.validateSessionGrid(sessionGrid);
    return this.computeMovement({
      assetSeries,
      benchmarkSeries,
      sessionGrid: normalizedSessionGrid,
    });
  }
}
