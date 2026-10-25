import { describe, expect, it } from "vitest";
import { archiveDateBounds, maximumRemainingArchiveDate } from "./archive-date-bounds.js";

describe("archive entry calendar bounds", () => {
  it("uses entry names independent of media metadata and input order", () => {
    expect(archiveDateBounds([
      "2026-10-23_23-59-00-front.mp4", "2026-10-24", "2026-10-20_12-00-00",
    ])).toEqual({ oldest: "2026-10-20", newest: "2026-10-24" });
    expect(archiveDateBounds([])).toEqual({ oldest: null, newest: null });
  });

  it("rejects an invalid calendar label", () => {
    expect(() => archiveDateBounds(["2026-02-30"])).toThrow("Invalid recording timestamp");
  });

  it("combines remaining bounds without treating unknown dates as exhaustion", () => {
    expect(maximumRemainingArchiveDate(["2026-10-24", undefined, "2026-10-26"])).toBe("2026-10-26");
    expect(maximumRemainingArchiveDate(["2026-10-26", null])).toBeNull();
    expect(maximumRemainingArchiveDate([null, "2026-10-26"])).toBeNull();
    expect(maximumRemainingArchiveDate([undefined])).toBeNull();
  });
});
