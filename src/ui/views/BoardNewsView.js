import { displaySymbolOf } from "../models/instrumentFormat.js";

export class BoardNewsView {
  constructor(instruments = [], options = {}) {
    this.gridApi = options.gridApi || null;
    this.instrumentLabels = new Map();
    this.setInstruments(instruments);
  }

  init() {}

  setInstruments(instruments = []) {
    this.instrumentLabels = new Map((instruments || []).map((instrument) => [
      instrument.id,
      displaySymbolOf(instrument),
    ]));
  }

  render(state) {
    this.gridApi?.setNewsState({
      status: state?.status || "idle",
      articles: Array.isArray(state?.articles) ? state.articles : [],
      errors: state?.errors,
      sources: state?.sources,
      quality: state?.quality,
      lastUpdatedAt: state?.lastUpdatedAt,
      instrumentLabels: this.instrumentLabels,
    });
  }

  destroy() {}
}
