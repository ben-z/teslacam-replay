import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEventPage } from "./api";

afterEach(() => vi.unstubAllGlobals());

function reply(position: Record<string, unknown>) {
  const fetch = vi.fn().mockImplementation(() => Promise.resolve(Response.json({
    type: "RecentClips", events: [], ...position,
  })));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("recording page date contract", () => {
  it.each(["2026-10-24", null])("rejects a repeated immediate cursor with date %s", async (date) => {
    const fetch = reply({ nextPageToken: "same-page", nextPageDate: date });
    await expect(fetchEventPage("RecentClips", "same-page", 24)).rejects.toThrow("did not advance");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an advancing cursor even when an empty page retains the same boundary date", async () => {
    const fetch = reply({ nextPageToken: "next-page", nextPageDate: "2026-10-24" });
    expect(await fetchEventPage("RecentClips", "current-page", 24)).toMatchObject({
      events: [], nextPageToken: "next-page", nextPageDate: "2026-10-24",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts exhaustion after a continuation without treating null as a repeated cursor", async () => {
    reply({ nextPageToken: null, nextPageDate: null });
    expect(await fetchEventPage("RecentClips", "last-page", 24)).toMatchObject({
      nextPageToken: null, nextPageDate: null,
    });
    expect(await fetchEventPage("RecentClips", null, 24)).toMatchObject({
      nextPageToken: null, nextPageDate: null,
    });
  });

  it("preserves opaque continuation tokens in the requested page URL", async () => {
    const token = "next &/+?==";
    const fetch = reply({ nextPageToken: "different-page", nextPageDate: "2026-10-24" });
    await fetchEventPage("RecentClips", token, 24);
    const url = new URL(fetch.mock.calls[0][0] as string, "https://app.example");
    expect(url.searchParams.get("pageToken")).toBe(token);
    expect(url.searchParams.get("type")).toBe("RecentClips");
    expect(url.searchParams.get("limit")).toBe("24");
  });
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
