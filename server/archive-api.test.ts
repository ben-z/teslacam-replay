import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriveEntry } from "./gdrive-lite.js";

const { serve, ensureHlsSegments, extractTelemetryFromBuffer } = vi.hoisted(() => ({
  serve: vi.fn(),
  ensureHlsSegments: vi.fn(),
  extractTelemetryFromBuffer: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve }));
vi.mock("./sei.js", () => ({ extractTelemetryFromBuffer }));
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
  readonly reads = new Map<string, { body: string; status: number }>();

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

  remove(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (!entry) throw new Error(`Cannot remove missing fixture: ${filePath}`);
    this.entries.delete(filePath);
    for (const [id, children] of this.children) this.children.set(id, children.filter((child) => child.id !== entry.id));
    this.children.delete(entry.id);
  }

  async fetch(input: string | URL | Request): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    this.requests.push(url);
    if (url.pathname === "/healthz") return Response.json({ status: "ok" });
    if (url.pathname.startsWith("/file/")) {
      const file = this.reads.get(url.pathname.split("/")[2]);
      if (!file) throw new Error(`Missing file-read fixture: ${url}`);
      return new Response(file.body, { status: file.status });
    }
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
  vi.stubEnv("APP_ORIGIN", undefined);
  vi.stubEnv("GDRIVE_EVENT_ORDER_BY", undefined);
  for (const name of ["GDRIVE_USER", "GDRIVE_PASS", "BASIC_AUTH_USER", "BASIC_AUTH_PASSWORD", "SERVE_FRONTEND"]) {
    vi.stubEnv(name, "");
  }
  serve.mockReturnValue({ close: vi.fn() });
  ensureHlsSegments.mockResolvedValue(true);
  extractTelemetryFromBuffer.mockReset();
  extractTelemetryFromBuffer.mockResolvedValue(null);
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

async function request(route: string, init?: RequestInit): Promise<Response> {
  const handler = serve.mock.calls[0][0].fetch as (request: Request) => Promise<Response>;
  return handler(new Request(`http://app.test${route}`, init));
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

  it("pages through dates and preserved roots without scanning later date-folder contents", async () => {
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
    // Looking at the bounded root metadata establishes a date hint without scanning its contents.
    expect(provider.listsFor(LEGACY)).toHaveLength(1);
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
    expect(provider.listsFor(LEGACY).filter((url) => url.searchParams.has("pageToken"))).toHaveLength(1);
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

  it("discovers archive folders added after startup when the recording list is refreshed", async () => {
    await start();
    const archive = "RecentClips-before-2026-10-21";
    const segment = "2026-10-20_12-00-00";
    provider.add(archive, true);
    provider.add(`${archive}/${segment}-front.mp4`);
    const ids: string[] = [];
    let token: string | undefined;
    do {
      const result = await page(token);
      ids.push(...result.events.map((event: { id: string }) => event.id));
      token = result.nextPageToken;
    } while (token);
    expect(ids).toEqual([segment]);
  });

  it.each(["recording", "video"])("restores a %s from an archive added after startup without browsing", async (kind) => {
    await start();
    const archive = "RecentClips-before-2026-10-21";
    const segment = "2026-10-20_12-00-00";
    provider.add(archive, true);
    const file = provider.add(`${archive}/${segment}-front.mp4`);
    if (kind === "recording") {
      const response = await request(`/api/events/RecentClips/${segment}`);
      expect(response.status).toBe(200);
      expect((await response.json()).clips[0].cameras).toEqual(["front"]);
    }
    expect((await request(hls(segment, "front"))).status).toBe(200);
    expect(ensureHlsSegments.mock.calls[0][0].url).toContain(`/file/${file.id}/`);
  });

  it("surfaces root discovery failure instead of serving a stale archive list", async () => {
    await start();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/list" && !url.searchParams.has("folderId")) return new Response("Provider failure", { status: 503 });
      return provider.fetch(input);
    });
    const response = await request("/api/events/page?type=RecentClips");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to list Drive folder root: 503" });
  });

  it("distinguishes missing chunks from a broken cache path", async () => {
    await start();
    const route = "/api/hls/RecentClips/2026-10-20_12-00-00/2026-10-20_12-00-00/front/chunk_0123456789abcdef_000.ts";
    expect((await request(route)).status).toBe(404);
    await rm(testDirectory, { recursive: true });
    await writeFile(testDirectory, "not a cache directory");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await request(route)).status).toBe(500);
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ code: "ENOTDIR" }));
    } finally {
      log.mockRestore();
    }
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
    const requestsBefore = provider.requests.length;
    expect((await request(`/api/events/RecentClips/${segments[1]}`)).status).toBe(200);
    expect(provider.requests).toHaveLength(requestsBefore);
  });

  it("joins overlapping page groups, retains the first server ID and all aliases, and unions private sources", async () => {
    const early = "2026-10-02_10-00-00";
    const middle = "2026-10-02_10-01-00";
    const late = "2026-10-02_10-02-00";
    provider.add(`RecentClips/${early}-front.mp4`);
    const front = provider.add(`RecentClips/${middle}-front.mp4`);
    const back = provider.add(`RecentClips/${middle}-back.mp4`);
    provider.add(`RecentClips/${late}-front.mp4`);
    await start();
    for (const id of [early, late]) {
      const response = await request(`/api/events/RecentClips/${id}`);
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(id);
    }
    const first = await page();
    expect(first.events[0].id).toBe(late);
    const second = await page(first.nextPageToken);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toMatchObject({ id: early, clips: [
      { timestamp: early },
      { timestamp: middle, cameras: ["front", "back"] },
      { timestamp: late },
    ] });
    expect(second.events[0].clips.every((clip: {sourceByCamera?: unknown}) => clip.sourceByCamera === undefined)).toBe(true);
    const requestsBefore = provider.requests.length;
    for (const alias of [early, middle, late]) {
      const response = await request(`/api/events/RecentClips/${alias}`);
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(early);
    }
    for (const [camera, source] of [["front", front], ["back", back]] as const) {
      const response = await request(`/api/hls/RecentClips/${late}/${middle}/${camera}/stream.m3u8`);
      expect(response.status).toBe(200);
      expect(ensureHlsSegments.mock.calls.at(-1)![0].url).toContain(`/file/${source.id}/`);
    }
    expect(provider.requests).toHaveLength(requestsBefore);
    provider.remove(`RecentClips/${middle}-back.mp4`);
    const refreshed = await request(`/api/events/RecentClips/${middle}?refresh=1`);
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ id: early, clips: [{ timestamp: middle, cameras: ["front"] }] });
    const beforeAliasReads = provider.requests.length;
    for (const alias of [early, middle, late]) {
      const event = await (await request(`/api/events/RecentClips/${alias}`)).json();
      expect(event.clips).toHaveLength(1);
      expect(event.clips[0].cameras).toEqual(["front"]);
    }
    expect(provider.requests).toHaveLength(beforeAliasReads);
    for (const segment of [early, middle, late]) provider.remove(`RecentClips/${segment}-front.mp4`);
    expect((await request(`/api/events/RecentClips/${late}?refresh=1`)).status).toBe(404);
    for (const alias of [early, middle, late]) expect((await request(`/api/events/RecentClips/${alias}`)).status).toBe(404);
  });

  it("uses indexed Saved snapshots until explicit refresh replaces removed cameras and folders", async () => {
    const id = "2026-10-02_10-00-00";
    const folder = `SavedClips/${id}`;
    provider.add("SavedClips", true);
    provider.add(folder, true);
    provider.add(`${folder}/${id}-front.mp4`);
    provider.add(`${folder}/${id}-back.mp4`);
    await start();
    expect((await request(`/api/events/SavedClips/${id}`)).status).toBe(200);
    provider.remove(`${folder}/${id}-back.mp4`);
    const before = provider.requests.length;
    const indexed = await request(`/api/events/SavedClips/${id}`);
    expect((await indexed.json()).clips[0].cameras).toEqual(["front", "back"]);
    expect(provider.requests).toHaveLength(before);
    const refreshed = await request(`/api/events/SavedClips/${id}?refresh=1`);
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).clips[0].cameras).toEqual(["front"]);
    provider.resolveFailures.set(folder, 503);
    expect((await request(`/api/events/SavedClips/${id}?refresh=1`)).status).toBe(500);
    provider.resolveFailures.delete(folder);
    provider.remove(folder);
    expect((await request(`/api/events/SavedClips/${id}?refresh=1`)).status).toBe(404);
    expect((await request(`/api/events/SavedClips/${id}`)).status).toBe(404);
  });

  it("replaces a Recent refreshed scope, preserves aliases, and never treats provider failure as deletion", async () => {
    const id = "2026-10-02_10-00-00";
    const front = `RecentClips/${id}-front.mp4`;
    const back = `RecentClips/${id}-back.mp4`;
    provider.add(front);
    provider.add(back);
    await start();
    expect((await request(`/api/events/RecentClips/${id}`)).status).toBe(200);
    provider.remove(back);
    const before = provider.requests.length;
    expect((await (await request(`/api/events/RecentClips/${id}`)).json()).clips[0].cameras).toEqual(["front", "back"]);
    expect(provider.requests).toHaveLength(before);
    const refreshed = await request(`/api/events/RecentClips/${id}?refresh=1`);
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).clips[0].cameras).toEqual(["front"]);
    provider.resolveFailures.set(back, 503);
    expect((await request(`/api/events/RecentClips/${id}?refresh=1`)).status).toBe(500);
    provider.resolveFailures.delete(back);
    expect((await (await request(`/api/events/RecentClips/${id}`)).json()).clips[0].cameras).toEqual(["front"]);
    provider.remove(front);
    expect((await request(`/api/events/RecentClips/${id}?refresh=1`)).status).toBe(404);
    expect((await request(`/api/events/RecentClips/${id}`)).status).toBe(404);
  });

  it("publishes a thumbnail version without leaking private Drive source fields", async () => {
    const id = "2026-10-02_10-00-00";
    provider.add("SavedClips", true);
    provider.add(`SavedClips/${id}`, true);
    const camera = provider.add(`SavedClips/${id}/${id}-front.mp4`);
    camera.resourceKey = "private-camera-key";
    const thumbnail = provider.add(`SavedClips/${id}/thumb.png`);
    thumbnail.resourceKey = "private-thumbnail-key";
    thumbnail.mimeType = "image/png";
    thumbnail.modifiedTime = "2026-10-02T10:00:00Z";
    await start();
    const original = await (await request(`/api/events/SavedClips/${id}`)).json();
    expect(original.thumbnailVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(original).not.toHaveProperty("thumbnailSource");
    expect(original.clips[0]).not.toHaveProperty("sourceByCamera");
    expect(JSON.stringify(original)).not.toMatch(/private-camera-key|private-thumbnail-key|drive\.test|file-\d/);
    thumbnail.modifiedTime = "2026-10-02T11:00:00Z";
    const refreshed = await (await request(`/api/events/SavedClips/${id}?refresh=1`)).json();
    expect(refreshed.thumbnailVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(refreshed.thumbnailVersion).not.toBe(original.thumbnailVersion);
    provider.reads.set(thumbnail.id, { body: "Provider unavailable", status: 503 });
    const failedThumbnail = await request(`/api/events/SavedClips/${id}/thumbnail`);
    expect(failedThumbnail.status).toBe(502);
    expect(await failedThumbnail.json()).toEqual({ error: "Cannot read thumbnail: HTTP 503" });
  });

  it("reports telemetry failures, caches genuine absence, and invalidates it when the refreshed source changes", async () => {
    const id = "2026-10-02_10-00-00";
    provider.add("SavedClips", true);
    provider.add(`SavedClips/${id}`, true);
    const camera = provider.add(`SavedClips/${id}/${id}-front.mp4`);
    provider.reads.set(camera.id, { body: "Provider unavailable", status: 503 });
    await start();
    const route = `/api/video/SavedClips/${id}/${id}/telemetry`;
    const failedRead = await request(route);
    expect(failedRead.status).toBe(502);
    expect(await failedRead.json()).toEqual({ error: "Cannot read video for vehicle data: HTTP 503" });
    expect(extractTelemetryFromBuffer).not.toHaveBeenCalled();
    provider.reads.set(camera.id, { body: "video bytes", status: 200 });
    extractTelemetryFromBuffer.mockRejectedValueOnce(new Error("Invalid SEI payload"));
    const failedExtraction = await request(route);
    expect(failedExtraction.status).toBe(502);
    expect(await failedExtraction.json()).toEqual({ error: "Invalid SEI payload" });
    expect(await (await request(route)).json()).toEqual({ hasSei: false });
    expect(await (await request(route)).json()).toEqual({ hasSei: false });
    expect(extractTelemetryFromBuffer).toHaveBeenCalledTimes(2);
    camera.modifiedTime = "2026-10-02T11:00:00Z";
    expect((await request(`/api/events/SavedClips/${id}?refresh=1`)).status).toBe(200);
    expect(await (await request(route)).json()).toEqual({ hasSei: false });
    expect(extractTelemetryFromBuffer).toHaveBeenCalledTimes(3);
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

  it("records archive request intervals and statuses without request secrets or error bodies", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await start();
      log.mockClear();
      expect((await request("/api/events/page?type=RecentClips")).status).toBe(200);
      expect((await request("/api/events/page?type=RecentClips&pageToken=private-cursor", {
        headers: { Authorization: "Bearer private-authorization" },
      })).status).toBe(400);
      expect((await request("/api/events/SavedClips/2026-10-02_10-00-00?private-query=private-value")).status).toBe(404);
      provider.add("RecentClips/2026-02-30_10-00-00-front.mp4");
      const failed = await request("/api/events/page?type=RecentClips");
      expect(failed.status).toBe(500);
      const messages = log.mock.calls.map(([message]) => JSON.parse(message));
      const spans = messages.filter((message) => message.event === "archive_request");
      expect(spans).toHaveLength(8);
      for (let i = 0; i < spans.length; i += 2) {
        const start = spans[i];
        const complete = spans[i + 1];
        expect(start.phase).toBe("start");
        expect(complete).toMatchObject({
          requestId: start.requestId, startedAt: start.startedAt,
          type: start.type, route: start.route, phase: "complete",
        });
        expect(Date.parse(start.startedAt)).not.toBeNaN();
        expect(complete.elapsedMs).toBeGreaterThanOrEqual(0);
      }
      expect(spans.filter((span) => span.phase === "complete").map((span) => span.status)).toEqual([200, 400, 404, 500]);
      expect(spans[4].route).toBe("recording");
      const serialized = JSON.stringify(messages);
      for (const secret of ["private-cursor", "private-authorization", "private-query", "private-value", "2026-02-30", "front.mp4"]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe("remaining archive calendar dates", () => {
  it("bounds Saved pages by listed folder labels even when events are empty or have different metadata times", async () => {
    provider.add("SavedClips", true);
    provider.add("SavedClips/2026-10-24_10-00-00", true);
    const folder = "SavedClips/2026-10-23_10-00-00";
    provider.add(folder, true);
    provider.add(`${folder}/2026-10-12_10-00-00-front.mp4`);
    const metadata = provider.add(`${folder}/event.json`);
    provider.reads.set(metadata.id, { body: JSON.stringify({ timestamp: "1999-01-01T00:00:00" }), status: 200 });
    provider.add("SavedClips/2026-10-22_10-00-00", true);
    await start();
    const first = await (await request("/api/events/page?type=SavedClips")).json();
    expect(first).toMatchObject({
      events: [{ timestamp: "1999-01-01T00:00:00", clips: [{ timestamp: "2026-10-12_10-00-00" }] }],
      nextPageToken: "2", nextPageDate: "2026-10-23",
    });
    const last = await (await request(`/api/events/page?type=SavedClips&pageToken=${first.nextPageToken}`)).json();
    expect(last).toEqual({ type: "SavedClips", events: [], nextPageToken: null, nextPageDate: null });
  });

  it("leaves an ignored Saved page unknown without scanning ahead or treating it as exhaustion", async () => {
    provider.add("SavedClips", true);
    provider.add("SavedClips/metadata-z", true);
    provider.add("SavedClips/metadata-y", true);
    provider.add("SavedClips/2026-10-24_10-00-00", true);
    await start();
    const first = await (await request("/api/events/page?type=SavedClips")).json();
    expect(first).toEqual({ type: "SavedClips", events: [], nextPageToken: "2", nextPageDate: null });
    expect(provider.listsFor("SavedClips")).toHaveLength(1);
    expect(provider.listsFor("SavedClips/2026-10-24_10-00-00")).toHaveLength(0);
  });

  it.each(["name asc", "modifiedTime desc", ""])("rejects nonchronological event ordering: %s", async (order) => {
    vi.stubEnv("GDRIVE_EVENT_ORDER_BY", order);
    await expect(start()).rejects.toThrow("GDRIVE_EVENT_ORDER_BY must be 'name desc'");
    expect(serve).not.toHaveBeenCalled();
  });

  it("keeps a newer pending date folder visible when the returned flat recording is older", async () => {
    provider.add("RecentClips/2026-10-24", true);
    provider.add("RecentClips/2026-09-01_10-00-00-front.mp4");
    provider.add(`${LEGACY}/metadata`, true);
    await start();
    const first = await page();
    expect(first.events.map((event: { id: string }) => event.id)).toEqual(["2026-09-01_10-00-00"]);
    expect(first.nextPageDate).toBe("2026-10-24");
    expect(first.nextPageToken).toBeTruthy();
    expect(provider.listsFor("RecentClips/2026-10-24")).toHaveLength(0);
    expect(provider.listsFor(`${LEGACY}/metadata`)).toHaveLength(0);
  });

  it("uses every later root's actual entry dates instead of migration labels", async () => {
    provider.add("RecentClips/2026-10-24_10-00-00-front.mp4");
    provider.add(`${LEGACY}/metadata`, true);
    provider.add(`${LEGACY}/2026-10-27`, true);
    provider.add(`${LEGACY}/2026-09-30_10-00-00-front.mp4`);
    const earlierRoot = "RecentClips-before-2026-09-01";
    provider.add(earlierRoot, true);
    provider.add(`${earlierRoot}/2026-10-30_10-00-00-front.mp4`);
    await start();
    const first = await page();
    expect(first.nextPageDate).toBe("2026-10-30");
    expect(provider.listsFor(`${LEGACY}/2026-10-27`)).toHaveLength(0);
    expect(provider.requests.some((url) => url.pathname.startsWith("/file/"))).toBe(false);
    expect(provider.listsFor(earlierRoot)).toHaveLength(1);
    const query = provider.listsFor(LEGACY)[0].searchParams;
    expect([query.get("pageSize"), query.get("limit"), query.get("orderBy")]).toEqual(["1000", "1000", "name desc"]);
  });

  it("propagates an unknown later root head even when the current pending date is known", async () => {
    provider.add("RecentClips/2026-10-24", true);
    provider.add("RecentClips/2026-09-01_10-00-00-front.mp4");
    provider.add(`${LEGACY}/metadata-z`, true);
    provider.add(`${LEGACY}/metadata-y`, true);
    provider.add(`${LEGACY}/2026-10-30_10-00-00-front.mp4`);
    await start();
    const first = await page();
    expect(first.nextPageToken).toBeTruthy();
    expect(first.nextPageDate).toBeNull();
    expect(provider.listsFor(LEGACY)).toHaveLength(1);
    expect(provider.listsFor("RecentClips/2026-10-24")).toHaveLength(0);
  });

  it("bounds a continued current root page by raw names, then the remaining root head", async () => {
    for (const day of ["26", "25", "24"]) provider.add(`RecentClips/2026-10-${day}_10-00-00-front.mp4`);
    provider.add(`${LEGACY}/2026-10-23_10-00-00-front.mp4`);
    await start();
    const first = await page();
    expect(first.nextPageDate).toBe("2026-10-25");
    const second = await page(first.nextPageToken);
    expect(second.nextPageDate).toBe("2026-10-23");
    const last = await page(second.nextPageToken);
    expect(last.nextPageToken).toBeNull();
    expect(last.nextPageDate).toBeNull();
  });

  it("keeps empty continued Recent pages unknown and bounded", async () => {
    provider.add("RecentClips/metadata-z", true);
    provider.add("RecentClips/metadata-y", true);
    provider.add("RecentClips/2026-10-24_10-00-00-front.mp4");
    await start();
    const first = await page();
    expect(first.events).toEqual([]);
    expect(first.nextPageToken).toBeTruthy();
    expect(first.nextPageDate).toBeNull();
    expect(provider.listsFor("RecentClips")).toHaveLength(1);
    expect(provider.listsFor("RecentClips/metadata-z")).toHaveLength(0);
  });

  it("retains the pending date through a 1000-file continuation without rereading date contents for hints", async () => {
    const directory = "RecentClips/2026-10-24";
    const folder = provider.add(directory, true);
    for (let minute = 0; minute < 1001; minute++) {
      const timestamp = new Date(Date.UTC(2026, 9, 24, 0, minute)).toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
      provider.add(`${directory}/${timestamp}-front.mp4`);
    }
    provider.add(`${LEGACY}/2026-09-30_10-00-00-front.mp4`);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/list" && url.searchParams.get("folderId") === folder.id) {
        provider.requests.push(url);
        const files = [...provider.children.get(folder.id)!].sort((a, b) => b.name.localeCompare(a.name));
        const offset = Number(url.searchParams.get("pageToken") || "0");
        return Response.json({ folderId: folder.id, files: files.slice(offset, offset + 1000), nextPageToken: offset === 0 ? "1000" : undefined });
      }
      return provider.fetch(input);
    });
    await start();
    const first = await page();
    expect(first.nextPageDate).toBe("2026-10-24");
    expect(provider.listsFor(directory)).toHaveLength(1);
    const cursor = JSON.parse(Buffer.from(first.nextPageToken, "base64url").toString());
    expect(cursor).toEqual({ root: provider.entries.get("RecentClips")!.id, date: { id: folder.id, pageToken: "1000" } });
    const second = await page(first.nextPageToken);
    expect(second.nextPageDate).toBe("2026-09-30");
    expect(provider.listsFor(directory)).toHaveLength(2);
    expect(second.events).toHaveLength(1);
  });

  it("surfaces a failed remaining-root metadata lookup without advancing the caller's cursor", async () => {
    provider.add("RecentClips/2026-10-24_10-00-00-front.mp4");
    provider.add(`${LEGACY}/2026-10-21_10-00-00-front.mp4`);
    const legacyId = provider.entries.get(LEGACY)!.id;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/list" && url.searchParams.get("folderId") === legacyId) return new Response("Provider unavailable", { status: 503 });
      return provider.fetch(input);
    });
    await start();
    const failure = await request("/api/events/page?type=RecentClips");
    expect(failure.status).toBe(500);
    expect(await failure.json()).toEqual({ error: `Failed to list Drive folder ${legacyId}: 503` });
    vi.stubGlobal("fetch", provider.fetch.bind(provider));
    const retried = await page();
    expect(retried.nextPageDate).toBe("2026-10-21");
    expect(retried.events.map((event: { id: string }) => event.id)).toEqual(["2026-10-24_10-00-00"]);
    expect(provider.requests.some((url) => url.pathname.startsWith("/file/"))).toBe(false);
  });
});

describe("hosted API origin policy", () => {
  const origin = "https://teslacam-replay.example.com";

  it.each<Record<string, string>>([
    {},
    { "Sec-Fetch-Site": "none" },
    { "Sec-Fetch-Site": "same-origin" },
    { Origin: origin, "Sec-Fetch-Site": "same-origin" },
  ])("allows direct and same-origin requests without credentials: %j", async (headers) => {
    vi.stubEnv("APP_ORIGIN", origin);
    await start();
    const response = await request("/api/status", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ storageBackend: "gdrive-serve-lite" });
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it.each<Record<string, string>>([
    { Origin: "https://untrusted.example.com" },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
  ])("rejects cross-origin reads and actions before handlers run: %j", async (headers) => {
    vi.stubEnv("APP_ORIGIN", origin);
    await start();
    const requestsBefore = provider.requests.length;
    for (const [route, method] of [
      ["/api/events/page?type=RecentClips", "GET"],
      ["/api/debug/caches/telemetry/clear", "POST"],
    ]) {
      const response = await request(route, { method, headers });
      expect(response.status).toBe(403);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
      expect(response.headers.get("Vary")).toBe("Origin, Sec-Fetch-Site");
    }
    expect(provider.requests).toHaveLength(requestsBefore);
  });

  it("removes cache mutation endpoints from the viewing app", async () => {
    vi.stubEnv("APP_ORIGIN", origin);
    await start();
    const response = await request("/api/debug/caches/telemetry/clear", {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.status).toBe(404);
  });

  it.each([
    ["/api/events/SavedClips/2026-10-02_10-00-00/thumbnail", "image/png", "thumbnail bytes"],
    ["/api/hls/SavedClips/2026-10-02_10-00-00/2026-10-02_10-00-00/front/stream.m3u8", "application/vnd.apple.mpegurl", "#EXTM3U\n#EXT-X-ENDLIST\n"],
    ["/api/hls/SavedClips/2026-10-02_10-00-00/2026-10-02_10-00-00/front/chunk_0123456789abcdef_000.ts", "video/mp2t", "segment bytes"],
  ])("preserves origin policy headers and streamed bytes for %s", async (route, contentType, body) => {
    vi.stubEnv("APP_ORIGIN", origin);
    provider.add("SavedClips", true);
    provider.add("SavedClips/2026-10-02_10-00-00", true);
    provider.add("SavedClips/2026-10-02_10-00-00/2026-10-02_10-00-00-front.mp4");
    const thumbnail = provider.add("SavedClips/2026-10-02_10-00-00/thumb.png");
    thumbnail.mimeType = "image/png";
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === `/file/${thumbnail.id}/thumb.png`) {
        return new Response("thumbnail bytes", { headers: { "Content-Type": "image/png" } });
      }
      return provider.fetch(input);
    });
    await writeFile(path.join(testDirectory, "chunk_0123456789abcdef_000.ts"), "segment bytes");
    await start();
    const response = await request(route, { headers: { Origin: origin, "Sec-Fetch-Site": "same-origin" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(response.headers.get("Vary")).toBe("Origin, Sec-Fetch-Site");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(await response.text()).toBe(body);
  });

  it("allows a separate frontend when APP_ORIGIN is unset", async () => {
    await start();
    const response = await request("/api/status", { headers: { Origin: "https://frontend.example.com" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it.each([
    "", "null", "ftp://app.test", "https://app.test/", "https://user:password@app.test",
    "https://app.test/path", "https://app.test?query", "https://app.test#fragment",
  ])("fails startup with an invalid APP_ORIGIN: %s", async (value) => {
    vi.stubEnv("APP_ORIGIN", value);
    await expect(start()).rejects.toThrow();
    expect(serve).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(0);
  });
});
