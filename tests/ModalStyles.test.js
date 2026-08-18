import { readFile } from "node:fs/promises";
import postcss from "postcss";
import { describe, expect, it } from "vitest";

const detailsPath = new URL("../css/details.css", import.meta.url);
const detailsText = await readFile(detailsPath, "utf8");
const details = postcss.parse(detailsText, { from: detailsPath.pathname });

function valueOf(selector, property) {
  let value = null;
  details.walkRules((rule) => {
    if ((rule.selectors || []).includes(selector)) {
      rule.walkDecls(property, (declaration) => { value ??= declaration.value; });
    }
  });
  return value;
}

describe("instrument-detail CSS boundary", () => {
  it("contains only island layout glue; visual controls remain design-system components", () => {
    expect(detailsText).not.toContain(".modal-overlay");
    expect(detailsText).not.toContain(".modal-chart");
    expect(detailsText).not.toContain(".detail-rail");
    expect(detailsText).not.toContain(".metric-line");
    expect(detailsText).not.toContain(".mm-news");
  });

  it("keeps the identity, quote, ranges and detail sections responsive", () => {
    expect(valueOf(".marketmap-app .mm-instrument-detail__header", "grid-template-columns")).toBe("minmax(0, 1fr) auto");
    expect(valueOf(".marketmap-app .mm-instrument-detail__quote", "justify-items")).toBe("end");
    expect(valueOf(".marketmap-app .mm-instrument-detail__ranges", "grid-template-columns")).toBe("repeat(2, minmax(0, 1fr))");
    expect(valueOf(".marketmap-app .mm-detail-sections", "grid-template-columns")).toBe("repeat(2, minmax(0, 1fr))");
    expect(valueOf(".marketmap-app .mm-instrument-detail__analyst-take", "grid-column")).toBe("1 / -1");
    expect(valueOf(".marketmap-app .mm-instrument-detail__panel--full", "grid-column")).toBe("1 / -1");
    expect(valueOf(".marketmap-app .mm-instrument-detail__ticker", "font-size")).toBeNull();
  });

  it("uses the shared token palette for the controller-owned fallback states", () => {
    expect(valueOf(".marketmap-app .mm-detail-chart-empty", "border")).toBe("1px dashed var(--mm-line-strong)");
    expect(valueOf(".marketmap-app .mm-detail-chart-empty", "border-radius")).toBe("var(--mm-radius-overlay)");
    expect(valueOf(".marketmap-app .mm-instrument-detail__footer", "border-top")).toBe("1px solid var(--mm-line)");
  });
});
