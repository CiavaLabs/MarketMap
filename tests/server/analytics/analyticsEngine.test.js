import { describe, expect, it, vi } from "vitest";

import { AnalyticsEngine } from "../../../server/analytics/AnalyticsEngine.js";
import { movementFixture } from "./fixtures.js";

describe("AnalyticsEngine", () => {
  it("accepts normalized histories and delegates only the movement assessment", () => {
    const fixture = movementFixture();
    const computeMovement = vi.fn(() => ({ status: "fixture" }));
    const engine = new AnalyticsEngine({ computeMovement });

    expect(engine.assessMovement(fixture)).toEqual({ status: "fixture" });
    expect(computeMovement).toHaveBeenCalledOnce();
    expect(computeMovement).toHaveBeenCalledWith(fixture);
  });

  it("rejects a non-normalized history before invoking the movement calculation", () => {
    const fixture = movementFixture();
    fixture.assetSeries.range = "decade";
    const computeMovement = vi.fn();
    const engine = new AnalyticsEngine({ computeMovement });

    expect(() => engine.assessMovement(fixture)).toThrowError(
      expect.objectContaining({ code: "schema_invalid" }),
    );
    expect(computeMovement).not.toHaveBeenCalled();
  });
});
