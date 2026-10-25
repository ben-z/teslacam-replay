import { describe, expect, it } from "vitest";
import { oldestArchiveDate } from "./archive-date-bounds.js";

describe("oldest archive entry calendar date", () => {
  it("uses entry names independent of media metadata and input order", () => {
    expect(oldestArchiveDate([
      "2026-10-23_23-59-00-front.mp4", "2026-10-24", "2026-10-20_12-00-00",
    ])).toBe("2026-10-20");
    expect(oldestArchiveDate([])).toBeNull();
  });

  it("rejects an invalid calendar label", () => {
    expect(() => oldestArchiveDate(["2026-02-30"])).toThrow("Invalid recording timestamp");
  });

});
