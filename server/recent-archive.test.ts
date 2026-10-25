import { afterEach, describe, expect, it, vi } from "vitest";
import { GDriveLiteClient, type DriveEntry } from "./gdrive-lite";
import { RecentArchive } from "./recent-archive";

const FOLDER_MIME = "application/vnd.google-apps.folder";

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
      const folderId = url.searchParams.get("folderId")!;
      if (failures[folderId]) return new Response("Provider failure", { status: failures[folderId] });
      if (!(folderId in listedFiles)) throw new Error(`Unexpected folder listing: ${folderId}`);
      return Response.json({ folderId, files: listedFiles[folderId].map((name) => entries.get(name)!) });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  }));
  const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
  return { archive: new RecentArchive(drive), requests };
}

afterEach(() => vi.unstubAllGlobals());

describe("Recent recording bookmarks", () => {
  it("restores the complete dated session from a middle-segment bookmark", async () => {
    const date = "RecentClips/2026-10-21";
    const timestamps = ["2026-10-21_20-34-58", "2026-10-21_20-35-58", "2026-10-21_20-36-58"];
    const names = timestamps.map((timestamp) => `${date}/${timestamp}-front.mp4`);
    const { archive, requests } = setup({ [date]: true, ...Object.fromEntries(names.map((name) => [name, false])) }, { [date]: names }, {});
    const event = await archive.findEvent(timestamps[1]);
    expect(event!.clips.map((clip) => clip.timestamp)).toEqual(timestamps);
    expect(event!.clips[0].sourceByCamera!.front.id).toBe(names[0]);
    expect(requests.filter((url) => url.pathname === "/api/list")).toHaveLength(1);
    expect(requests.filter((url) => url.pathname === "/api/resolve")).toHaveLength(1);
    expect(requests.some((url) => url.pathname.startsWith("/file/"))).toBe(false);
  });

  it("surfaces a provider failure rather than reporting missing footage", async () => {
    const date = "RecentClips/2026-10-21";
    const { archive } = setup({ [date]: true }, {}, { [date]: 503 });
    await expect(archive.findEvent("2026-10-21_12-00-00")).rejects.toThrow("503");
  });

  it("returns not-found when the date folder is missing without probing old layouts", async () => {
    const { archive, requests } = setup({}, {}, {});
    await expect(archive.findEvent("2026-09-30_12-00-00")).resolves.toBeNull();
    expect(requests).toHaveLength(1);
    expect(requests[0].searchParams.get("path")).toBe("/RecentClips/2026-09-30");
  });

  it("resolves a video directly from the canonical date path", async () => {
    const segment = "2026-09-30_12-00-00";
    const name = `RecentClips/2026-09-30/${segment}-back.mp4`;
    const { archive, requests } = setup({ [name]: false }, {}, {});
    await expect(archive.findClipSource(segment, "back")).resolves.toMatchObject({ id: name });
    expect(requests).toHaveLength(1);
  });

  it("propagates an ambiguous exact-path lookup without choosing another source", async () => {
    const segment = "2026-09-30_12-00-00";
    const name = `RecentClips/2026-09-30/${segment}-front.mp4`;
    const { archive, requests } = setup({}, {}, { [name]: 409 });
    await expect(archive.findClipSource(segment, "front")).rejects.toThrow("409");
    expect(requests).toHaveLength(1);
  });

  it.each([
    ["2026-10-20_12-00-00-front.mp4", "wrong date folder"],
    ["2026-10-21_25-00-00-front.mp4", "Invalid recording timestamp"],
    ["partial.mp4", "Unsupported RecentClips file"],
  ])("rejects invalid dated content: %s", async (filename, message) => {
    const date = "RecentClips/2026-10-21";
    const name = `${date}/${filename}`;
    const { archive } = setup({ [date]: true, [name]: false }, { [date]: [name] }, {});
    await expect(archive.findEvent("2026-10-21_12-00-00")).rejects.toThrow(message);
  });
});
