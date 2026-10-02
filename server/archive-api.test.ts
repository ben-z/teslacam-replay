import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriveEntry } from "./gdrive-lite.js";

const { serve, ensureHlsSegments } = vi.hoisted(() => ({
  serve: vi.fn(),
  ensureHlsSegments: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve }));
vi.mock("./hls.js", () => ({
  ensureHlsSegments,
  hlsManifestPath: () => path.join(testDirectory, "stream.m3u8"),
  hlsCacheDir: () => testDirectory,
}));

const FOLDER_MIME = "application/vnd.google-apps.folder";
const LEGACY = "RecentClips-before-2026-10-02";
let testDirectory: string;
let provider: DriveProvider;
let priorSignals: Set<unknown>;

class DriveProvider {
  readonly entries = new Map<string, DriveEntry>();
  readonly children = new Map<string, DriveEntry[]>([["", []]]);
  readonly requests: URL[] = [];
  readonly resolveFailures = new Map<string, number>();

  add(filePath: string, folder = false): DriveEntry {
    const parentPath = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
    const parentId = parentPath ? this.entries.get(parentPath)!.id : "";
    const entry: DriveEntry = {
      id: `file-${this.entries.size}`,
      name: filePath.split("/").at(-1)!,
      mimeType: folder ? FOLDER_MIME : "video/mp4",
      size: folder ? undefined : "1234",
    };
    this.entries.set(filePath, entry);
    this.children.get(parentId)!.push(entry);
    if (folder) this.children.set(entry.id, []);
    return entry;
  }

  async fetch(input: string | URL | Request): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    this.requests.push(url);
    if (url.pathname === "/healthz") return Response.json({ status: "ok" });
    if (url.pathname === "/api/resolve") {
      const filePath = url.searchParams.get("path")!.replace(/^\//, "");
      const failure = this.resolveFailures.get(filePath);
      if (failure) return new Response("Drive unavailable", { status: failure });
      const file = this.entries.get(filePath);
      return file ? Response.json({ file }) : new Response("Not found", { status: 404 });
    }
    if (url.pathname !== "/api/list") throw new Error(`Unexpected Drive request: ${url}`);
    const folderId = url.searchParams.get("folderId") || "";
    let files = this.children.get(folderId);
    if (!files) return new Response("Not found", { status: 404 });
    const type = url.searchParams.get("type");
    if (type === "files") files = files.filter((file) => file.mimeType !== FOLDER_MIME);
    if (type === "folders") files = files.filter((file) => file.mimeType === FOLDER_MIME);
    files = [...files];
    if (url.searchParams.get("orderBy") === "name desc") {
      files.sort((a, b) => b.name.localeCompare(a.name));
    }
    const offset = Number(url.searchParams.get("pageToken") || "0");
    // Drive may return fewer files than the requested limit, with a continuation token.
    const size = Math.min(2, Number(url.searchParams.get("limit")));
    return Response.json({
      folderId,
      files: files.slice(offset, offset + size),
      nextPageToken: offset + size < files.length ? String(offset + size) : undefined,
    });
  }

  listsFor(filePath: string): URL[] {
    const id = this.entries.get(filePath)!.id;
    return this.requests.filter((url) => url.pathname === "/api/list" && url.searchParams.get("folderId") === id);
  }
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("GDRIVE_BASE_URL", "http://drive.test");
  for (const name of ["GDRIVE_USER", "GDRIVE_PASS", "BASIC_AUTH_USER", "BASIC_AUTH_PASSWORD", "SERVE_FRONTEND"]) {
    vi.stubEnv(name, "");
  }
  serve.mockReturnValue({ close: vi.fn() });
  ensureHlsSegments.mockResolvedValue(true);
  testDirectory = await mkdtemp(path.join(tmpdir(), "teslacam-archive-api-"));
  await writeFile(path.join(testDirectory, "stream.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");
  priorSignals = new Set([...process.listeners("SIGTERM"), ...process.listeners("SIGINT")]);
  provider = new DriveProvider();
  provider.add("RecentClips", true);
  provider.add(LEGACY, true);
  vi.stubGlobal("fetch", provider.fetch.bind(provider));
});

afterEach(async () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!priorSignals.has(listener)) process.removeListener(signal, listener);
    }
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(testDirectory, { recursive: true });
});

async function start(): Promise<void> {
  await import("./index.js");
}

async function request(route: string): Promise<Response> {
  const handler = serve.mock.calls[0][0].fetch as (request: Request) => Promise<Response>;
  return handler(new Request(`http://app.test${route}`));
}

async function page(token?: string) {
  const params = new URLSearchParams({ type: "RecentClips" });
  if (token) params.set("pageToken", token);
  const response = await request(`/api/events/page?${params}`);
  expect(response.status).toBe(200);
  return response.json();
}

function hls(segment: string, camera: string): string {
  return `/api/hls/RecentClips/${segment}/${segment}/${camera}/stream.m3u8`;
}

describe("RecentClips archive API", () => {
  it("browses dated clips, ignores metadata, and plays the retained file ID", async () => {
    provider.add("RecentClips/metadata", true);
    provider.add("RecentClips/metadata/thumb.png");
    provider.add("RecentClips/2026-10-02", true);
    const segment = "2026-10-02_02-13-03";
    const file = provider.add(`RecentClips/2026-10-02/${segment}-back.mp4`);
    await start();
    expect(provider.listsFor("RecentClips")).toHaveLength(0);
    const result = await page();
    expect(result.events).toMatchObject([{ id: segment, clips: [{ subfolder: "2026-10-02", cameras: ["back"] }] }]);
    expect(result.events[0].clips[0].sourceByCamera).toBeUndefined();
    expect(provider.listsFor("RecentClips/metadata")).toHaveLength(0);
    const resolveCount = provider.requests.filter((url) => url.pathname === "/api/resolve").length;
    expect((await request(hls(segment, "back"))).status).toBe(200);
    expect(ensureHlsSegments.mock.calls[0][0].url).toContain(`/file/${file.id}/`);
    expect(provider.requests.filter((url) => url.pathname === "/api/resolve")).toHaveLength(resolveCount);
  });

  it("pages within dates and then through preserved roots without scanning ahead", async () => {
    provider.add("RecentClips/2026-10-02", true);
    provider.add("RecentClips/2026-10-01", true);
    provider.add("RecentClips/2026-09-30", true);
    const files = [
      "RecentClips/2026-10-02/2026-10-02_10-00-00-front.mp4",
      "RecentClips/2026-10-02/2026-10-02_09-00-00-front.mp4",
      "RecentClips/2026-10-02/2026-10-02_08-00-00-front.mp4",
      "RecentClips/2026-10-01/2026-10-01_10-00-00-front.mp4",
      "RecentClips/2026-09-30/2026-09-30_11-00-00-front.mp4",
      `${LEGACY}/2026-09-30_10-00-00-front.mp4`,
      `${LEGACY}/2026-09-29_10-00-00-front.mp4`,
      `${LEGACY}/2026-09-28_10-00-00-front.mp4`,
    ];
    for (const file of files) provider.add(file);
    await start();
    const first = await page();
    expect(first.events).toHaveLength(2);
    expect(provider.listsFor("RecentClips/2026-10-02")).toHaveLength(1);
    expect(provider.listsFor("RecentClips/2026-10-01")).toHaveLength(0);
    expect(provider.listsFor(LEGACY)).toHaveLength(0);
    const ids = first.events.map((event: { id: string }) => event.id);
    let token = first.nextPageToken;
    const tokens = new Set<string>();
    while (token) {
      expect(tokens.has(token)).toBe(false);
      tokens.add(token);
      const next = await page(token);
      ids.push(...next.events.map((event: { id: string }) => event.id));
      token = next.nextPageToken;
    }
    expect(ids).toEqual(files.map((file) => file.split("/").at(-1)!.slice(0, 19)));
    expect(provider.listsFor(LEGACY)).toHaveLength(2);
  });

  it("discovers the supported archive prefix and resolves legacy playback without browsing", async () => {
    const earlier = "RecentClips-before-2026-09-01";
    provider.add(earlier, true);
    provider.add("RecentClips-backup", true);
    const segment = "2026-08-20_12-00-00";
    const file = provider.add(`${earlier}/${segment}-front.mp4`);
    await start();
    expect((await request(hls(segment, "front"))).status).toBe(200);
    expect(ensureHlsSegments.mock.calls[0][0].url).toContain(`/file/${file.id}/`);
    expect(provider.listsFor(earlier)).toHaveLength(0);
    expect(provider.requests.some((url) => url.searchParams.get("path")?.includes("RecentClips-backup"))).toBe(false);
  });

  it("preserves flat browsing alongside dated files without repeating clips", async () => {
    const flat = "2026-10-02_12-00-00";
    const dated = "2026-10-02_11-00-00";
    provider.add(`RecentClips/${flat}-front.mp4`);
    provider.add("RecentClips/2026-10-02", true);
    provider.add(`RecentClips/2026-10-02/${dated}-back.mp4`);
    await start();
    const first = await page();
    expect(first.events.map((event: { id: string }) => event.id)).toEqual([flat]);
    const second = await page(first.nextPageToken);
    expect(second.events.map((event: { id: string }) => event.id)).toEqual([dated]);
  });

  it("loads a dated event bookmark from a preserved archive", async () => {
    const segment = "2026-09-30_12-00-00";
    provider.add(`${LEGACY}/2026-09-30`, true);
    provider.add(`${LEGACY}/2026-09-30/${segment}-front.mp4`);
    await start();
    const response = await request(`/api/events/RecentClips/${segment}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: segment, clips: [{ cameras: ["front"] }] });
  });

  it("restores a dated bookmark whose session was split across browse pages", async () => {
    provider.add("RecentClips/2026-10-02", true);
    const segments = ["2026-10-02_10-00-00", "2026-10-02_10-01-00", "2026-10-02_10-02-00"];
    for (const segment of segments) provider.add(`RecentClips/2026-10-02/${segment}-front.mp4`);
    await start();
    const response = await request(`/api/events/RecentClips/${segments[1]}`);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(event.clips.map((clip: { timestamp: string }) => clip.timestamp)).toEqual(segments);
  });

  it("keeps SavedClips event browsing available", async () => {
    const eventId = "2026-10-02_10-00-00";
    provider.add("SavedClips", true);
    provider.add(`SavedClips/${eventId}`, true);
    provider.add(`SavedClips/${eventId}/${eventId}-front.mp4`);
    await start();
    const response = await request("/api/events/page?type=SavedClips");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ type: "SavedClips", events: [{ id: eventId }] });
  });

  it("resolves dated playback without first loading an event page", async () => {
    provider.add("RecentClips/2026-10-02", true);
    const segment = "2026-10-02_03-14-04";
    const file = provider.add(`RecentClips/2026-10-02/${segment}-left_repeater.mp4`);
    await start();
    expect((await request(hls(segment, "left_repeater"))).status).toBe(200);
    expect(ensureHlsSegments.mock.calls[0][0].url).toContain(`/file/${file.id}/`);
  });

  it("propagates Drive errors instead of treating them as missing footage", async () => {
    const segment = "2026-10-02_03-14-04";
    provider.resolveFailures.set(`RecentClips/${segment}-front.mp4`, 503);
    await start();
    expect((await request(hls(segment, "front"))).status).toBe(500);
    expect(ensureHlsSegments).not.toHaveBeenCalled();
    expect(provider.requests.filter((url) => url.pathname === "/api/resolve")).toHaveLength(1);
  });

  it("rejects a cursor that selects an unrelated root", async () => {
    const unrelated = provider.add("Private", true);
    await start();
    const token = Buffer.from(JSON.stringify({ root: unrelated.id })).toString("base64url");
    const response = await request(`/api/events/page?type=RecentClips&pageToken=${token}`);
    expect(response.status).toBe(400);
    expect(provider.listsFor("Private")).toHaveLength(0);
  });
});
