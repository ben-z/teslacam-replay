import { afterEach, describe, expect, it, vi } from "vitest";
import { GDriveLiteClient } from "./gdrive-lite";

afterEach(() => vi.unstubAllGlobals());

const file = { id: "clip", name: "front.mp4", mimeType: "video/mp4" };

describe("Drive listing completeness", () => {
  it("rejects provider-declared omissions even when a page has files and a continuation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      folderId: "archive", files: [file], nextPageToken: "older", incompleteSearch: true,
    })));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.listFolderPage({ id: "archive" }, {})).rejects.toThrow("incomplete folder listing");
  });

  it("does not report an incomplete empty page as archive exhaustion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      folderId: "archive", files: [], incompleteSearch: true,
    })));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.listFolderPage({ id: "archive" }, {})).rejects.toThrow("incomplete folder listing");
  });

  it.each([undefined, false])("preserves complete pages when incompleteSearch is %s", async (incompleteSearch) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      folderId: "archive", files: [file], nextPageToken: "older", incompleteSearch,
    })));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    expect(await drive.listFolderPage({ id: "archive" }, {})).toEqual({
      folderId: "archive", resourceKey: undefined, files: [file], nextPageToken: "older",
    });
  });

  it("rejects a later incomplete page without returning the earlier prefix, then permits a fresh read", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ folderId: "archive", files: [file], nextPageToken: "older" }))
      .mockResolvedValueOnce(Response.json({ folderId: "archive", files: [], incompleteSearch: true }))
      .mockResolvedValueOnce(Response.json({ folderId: "archive", files: [file] }));
    vi.stubGlobal("fetch", fetch);
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.listFolder({ id: "archive" })).rejects.toThrow("incomplete folder listing");
    expect((await drive.listFolder({ id: "archive" })).files).toEqual([file]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(new URL(fetch.mock.calls[1][0]).searchParams.get("pageToken")).toBe("older");
  });
});
