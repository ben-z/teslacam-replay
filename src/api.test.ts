import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEventPage } from "./api";

afterEach(() => vi.unstubAllGlobals());

function reply(position: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    type: "RecentClips", events: [], ...position,
  })));
}

describe("recording page date contract", () => {
  it("retains an unknown date with its continuation instead of treating it as exhausted", async () => {
    reply({ nextPageToken: "more", nextPageDate: null });
    expect(await fetchEventPage("RecentClips", null, 24)).toMatchObject({ nextPageToken: "more", nextPageDate: null });
  });

  it.each([undefined, "2026-02-30", "2026-13-01", "Oct 24", 20261024])("rejects an invalid date: %s", async (date) => {
    reply({ nextPageToken: "more", nextPageDate: date });
    await expect(fetchEventPage("RecentClips", null, 24)).rejects.toThrow("Invalid recording page date");
  });

  it("rejects a date on an exhausted source", async () => {
    reply({ nextPageToken: null, nextPageDate: "2026-10-24" });
    await expect(fetchEventPage("RecentClips", null, 24)).rejects.toThrow("exhausted recording source");
  });

  it("rejects a missing or empty cursor instead of silently exhausting the source", async () => {
    for (const token of [undefined, ""]) {
      reply({ nextPageToken: token, nextPageDate: null });
      await expect(fetchEventPage("RecentClips", null, 24)).rejects.toThrow("Invalid recording page token");
    }
  });
});
