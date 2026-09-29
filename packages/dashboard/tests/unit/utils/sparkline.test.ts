import { describe, it, expect } from "vitest";
import { renderSparkline } from "../../../src/utils/sparkline.js";

describe("renderSparkline", () => {
  it("renders a flat line for an empty series", () => {
    expect(renderSparkline([], 10)).toBe("▁".repeat(10));
  });

  it("renders a rising series", () => {
    const line = renderSparkline([1, 2, 3, 4, 5], 5);
    expect(line.length).toBe(5);
    expect(line).not.toBe("▁".repeat(5));
  });
});
