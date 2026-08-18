// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppController } from "../src/services/AppController.js";

const AAPL = Object.freeze({
  id: "XNAS:AAPL",
  symbol: "AAPL",
  name: "Apple Inc.",
  assetClass: "equity",
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("AppController news facade", () => {
  it("preserves complete single and batch envelopes for provenance and partial errors", async () => {
    document.body.innerHTML = '<main data-root></main>';
    const single = {
      data: { instrumentId: AAPL.id, articles: [] },
      sources: { news: ["yahoo"] },
      meta: { nextRefreshAt: "2026-07-15T16:30:00.000Z" },
    };
    const batch = {
      data: { articles: [] },
      errors: [{ instrumentId: AAPL.id, message: "Unavailable", retryable: true }],
      sources: { news: ["last-known-good"] },
      meta: { nextRefreshAt: "2026-07-15T16:16:00.000Z" },
    };
    const client = {
      news: vi.fn(async () => single),
      newsBatch: vi.fn(async () => batch),
    };
    const app = new AppController([AAPL], {
      root: document.querySelector("[data-root]"),
      client,
      pauseWhenHidden: false,
    });

    await expect(app.getNews(AAPL.id, { limit: 6 })).resolves.toBe(single);
    await expect(app.getNewsBatch([AAPL.id], { limit: 12 })).resolves.toBe(batch);
    expect(client.news).toHaveBeenCalledWith(AAPL.id, { limit: 6 });
    expect(client.newsBatch).toHaveBeenCalledWith([AAPL.id], { limit: 12 });
    app.destroy();
  });
});
