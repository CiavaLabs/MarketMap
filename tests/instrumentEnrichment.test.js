import { describe, expect, it } from "vitest";
import { detailsField, enrichmentFromDetails } from "../src/ui/models/instrumentEnrichment.js";

describe("detailsField", () => {
  it("returns the first defined value for a field across sections", () => {
    const details = {
      sections: [
        { id: "equity_fundamentals", fields: { marketCap: 1_000_000 } },
        { id: "company_profile", fields: { sector: "Technology", industry: null } },
      ],
    };
    expect(detailsField(details, "sector")).toBe("Technology");
    expect(detailsField(details, "industry")).toBeNull();
    expect(detailsField(details, "missing")).toBeNull();
  });

  it("tolerates a missing sections array", () => {
    expect(detailsField(null, "sector")).toBeNull();
    expect(detailsField({}, "sector")).toBeNull();
  });
});

describe("enrichmentFromDetails", () => {
  it("reads directly off .instrument when it already carries a sector", () => {
    const details = { instrument: { id: "XNAS:IBM", sector: "Technology", category: "Software" } };
    expect(enrichmentFromDetails(details)).toEqual({ id: "XNAS:IBM", sector: "Technology", category: "Software" });
  });

  it("falls back to the company_profile section when .instrument has no sector", () => {
    const details = {
      instrument: { id: "XNAS:SNDK", assetClass: "equity" },
      sections: [
        { id: "company_profile", fields: { sector: "Technology", industry: "Computer Hardware" } },
        { id: "equity_fundamentals", fields: { marketCap: 42 } },
      ],
    };
    expect(enrichmentFromDetails(details)).toEqual({ sector: "Technology", category: "Computer Hardware" });
  });

  it("returns null when neither shape has a real sector anywhere", () => {
    expect(enrichmentFromDetails({ instrument: { id: "X" }, sections: [] })).toBeNull();
    expect(enrichmentFromDetails(null)).toBeNull();
  });
});
