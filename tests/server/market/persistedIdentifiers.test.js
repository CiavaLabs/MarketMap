import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { SEMANTIC_REVISION, marketCacheKey } from "../../../server/contracts/market/constants.js";
import { curatedDescriptor } from "../fixtures/market/curatedDescriptors.js";

const ORCHESTRATOR = new URL("../../../server/orchestration/MarketDataOrchestrator.js", import.meta.url);
const CONFIG = new URL("../../../src/config.js", import.meta.url);

describe("identifiers written to disk", () => {
  it.each([
    ["the cache key namespace", () => marketCacheKey("quote", "XNAS:AAPL", "observation"), "v2:quote:XNAS:AAPL:observation:fetching-v2@1"],
    ["the semantic revision", () => SEMANTIC_REVISION, "fetching-v2@1"],
  ])("pins %s", (_label, read, expected) => {
    expect(read()).toBe(expected);
  });

  it.each([
    ["the quote normalizer revision", '"yahoo-v2@1"'],
    ["the details normalizer revision", '"yahoo-details-v2@1"'],
    ["the stored resource prefix", "`v2_${resourceType}`"],
  ])("pins %s", async (_label, literal) => {
    expect(await readFile(ORCHESTRATOR, "utf8")).toContain(literal);
  });

  it("pins the saved-board storage key", async () => {
    expect(await readFile(CONFIG, "utf8")).toContain('BOARD_V2: "marketmap-board-v2"');
  });

  it("keeps a descriptor's cache key stable", () => {
    const descriptor = curatedDescriptor("XNAS:AAPL");
    expect(marketCacheKey("details", descriptor.id, "abc")).toBe("v2:details:XNAS:AAPL:abc:fetching-v2@1");
  });
});
