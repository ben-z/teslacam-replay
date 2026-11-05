import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchArchiveCatalog, fetchArchiveDay } from "./api";

afterEach(() => vi.unstubAllGlobals());
const key = { type: "RecentClips", date: "2026-11-01" } as const;
function reply(data: unknown, status: number) {
  const fetch = vi.fn().mockResolvedValue(Response.json(data, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("archive resource API", () => {
  it("fetches independently addressed catalogs and days without browser HTTP cache", async () => {
    const fetch = reply({ type: "RecentClips", dates: ["2026-11-01", "2026-10-31"] }, 200);
    expect((await fetchArchiveCatalog("RecentClips")).dates).toHaveLength(2);
    expect(fetch).toHaveBeenLastCalledWith("/api/archive/RecentClips", { cache: "no-store" });
    fetch.mockResolvedValue(Response.json({ ...key, events: [] }));
    expect(await fetchArchiveDay(key)).toEqual({ ...key, events: [] });
    expect(fetch).toHaveBeenLastCalledWith("/api/archive/RecentClips/2026-11-01", { cache: "no-store" });
  });

  it("rejects incomplete or incorrectly ordered date catalogs", async () => {
    reply({ type: "RecentClips", dates: ["2026-10-31", "2026-11-01"] }, 200);
    await expect(fetchArchiveCatalog("RecentClips")).rejects.toThrow("sorted newest first");
    reply({ type: "RecentClips" }, 200);
    await expect(fetchArchiveCatalog("RecentClips")).rejects.toThrow("Invalid archive catalog");
  });

  it("rejects a response belonging to another source or day", async () => {
    reply({ type: "SavedClips", dates: [] }, 200);
    await expect(fetchArchiveCatalog("RecentClips")).rejects.toThrow("Expected RecentClips");
    reply({ ...key, date: "2026-10-31", events: [] }, 200);
    await expect(fetchArchiveDay(key)).rejects.toThrow("Expected RecentClips/2026-11-01");
  });

  it("reports catalog and day failures rather than treating them as empty resources", async () => {
    reply({}, 503);
    await expect(fetchArchiveCatalog("RecentClips")).rejects.toThrow("HTTP 503");
    reply({}, 404);
    await expect(fetchArchiveDay(key)).rejects.toThrow("HTTP 404");
  });
});
