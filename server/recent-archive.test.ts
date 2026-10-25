import { afterEach, describe, expect, it, vi } from "vitest";
import { GDriveLiteClient, type DriveEntry } from "./gdrive-lite";
import { RecentArchive } from "./recent-archive";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const LEGACY = "RecentClips-before-2026-10-02";

function setup(paths: Record<string, boolean>, listedFiles: Record<string, string[]>, failures: Record<string, number>) {
  const entries = new Map(Object.entries(paths).map(([name, folder]) => [name, {
    id: name,
    name: name.split("/").at(-1)!,
    mimeType: folder ? FOLDER_MIME : "video/mp4",
    size: folder ? undefined : "1234",
    hasThumbnail: false,
  } satisfies DriveEntry]));
  const requests: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.pathname === "/api/resolve") {
      const name = url.searchParams.get("path")!.replace(/^\//, "");
      if (failures[name]) return new Response("Provider failure", { status: failures[name] });
      const file = entries.get(name);
      return file ? Response.json({ file }) : new Response("Not found", { status: 404 });
    }
    if (url.pathname === "/api/list") {
      const folderId = url.searchParams.get("folderId");
      if (!folderId) return Response.json({ folderId: "root", files: [...entries.values()].filter((entry) => entry.mimeType === FOLDER_MIME && !entry.id.includes("/")) });
      if (!(folderId in listedFiles)) throw new Error(`Unexpected unbounded folder listing: ${folderId}`);
      return Response.json({ folderId, files: listedFiles[folderId].map((name) => entries.get(name)!) });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }));
  const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
  return { archive: new RecentArchive(drive), requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("Recent recording bookmarks", () => {
  it("restores a flat recording with six bounded lookups and never scans the flat root", async () => {
    const id = "2026-09-30_12-00-00";
    const { archive, requests } = setup({
      RecentClips: true,
      [`RecentClips/${id}-front.mp4`]: false,
      [`RecentClips/${id}-back.mp4`]: false,
    }, {}, {});
    const event = await archive.findEvent(id);
    expect(event).toMatchObject({ id, type: "RecentClips", cameraCount: 2, clips: [{ timestamp: id, cameras: ["front", "back"] }] });
    expect(event!.clips[0].sourceByCamera!.front.id).toBe(`RecentClips/${id}-front.mp4`);
    expect(requests).toHaveLength(8);
    expect(requests.filter((url) => url.pathname === "/api/resolve")).toHaveLength(7);
    expect(requests.filter((url) => url.pathname === "/api/list").every((url) => !url.searchParams.has("folderId"))).toBe(true);
  });

  it("restores a preserved flat recording without listing the large legacy archive", async () => {
    const id = "2026-05-06_20-49-14";
    const { archive, requests } = setup({
      RecentClips: true,
      [LEGACY]: true,
      [`${LEGACY}/${id}-left_repeater.mp4`]: false,
    }, {}, {});
    const event = await archive.findEvent(id);
    expect(event!.clips[0].sourceByCamera!.left_repeater.id).toBe(`${LEGACY}/${id}-left_repeater.mp4`);
    expect(event!.clips[0].cameras).toEqual(["left_repeater"]);
    expect(requests).toHaveLength(15);
    expect(requests.filter((url) => url.pathname === "/api/resolve")).toHaveLength(14);
    expect(requests.filter((url) => url.pathname === "/api/list").every((url) => !url.searchParams.has("folderId"))).toBe(true);
  });

  it("retains dated-session restoration without adding flat-root scans", async () => {
    const date = "RecentClips/2026-10-21";
    const timestamps = ["2026-10-21_20-34-58", "2026-10-21_20-35-58", "2026-10-21_20-36-58"];
    const names = timestamps.map((timestamp) => `${date}/${timestamp}-front.mp4`);
    const { archive, requests } = setup({ RecentClips: true, [date]: true, ...Object.fromEntries(names.map((name) => [name, false])) }, { [date]: names }, {});
    const event = await archive.findEvent(timestamps[1]);
    expect(event!.clips.map((clip) => clip.timestamp)).toEqual(timestamps);
    expect(event!.clips.every((clip) => clip.subfolder === "2026-10-21")).toBe(true);
    expect(requests.filter((url) => url.pathname === "/api/list" && url.searchParams.has("folderId"))).toHaveLength(1);
  });

  it("surfaces a provider failure rather than returning a partial camera set", async () => {
    const id = "2026-09-30_12-00-00";
    const { archive } = setup({ RecentClips: true, [`RecentClips/${id}-back.mp4`]: false }, {}, { [`RecentClips/${id}-front.mp4`]: 503 });
    await expect(archive.findEvent(id)).rejects.toThrow("503");
  });

  it("returns not-found only after all supported roots lack the requested recording", async () => {
    const { archive, requests } = setup({ RecentClips: true, [LEGACY]: true }, {}, {});
    await expect(archive.findEvent("2026-09-30_12-00-00")).resolves.toBeNull();
    expect(requests).toHaveLength(15);
  });
});
