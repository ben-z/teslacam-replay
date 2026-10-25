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
    expect(result.events).toMatchObject([{ id: segment, clips: [{ cameras: ["back"] }] }]);
    expect(result.events[0].clips[0].sourceByCamera).toBeUndefined();
    expect(provider.listsFor("RecentClips/metadata")).toHaveLength(0);
    const resolveCount = provider.requests.filter((url) => url.pathname === "/api/resolve").length;
    expect((await request(hls(segment, "back"))).status).toBe(200);
    expect(ensureHlsSegments.mock.calls[0][0].url).toContain(`/file/${file.id}/`);
    expect(provider.requests.filter((url) => url.pathname === "/api/resolve")).toHaveLength(resolveCount);
  });

  it("loads one complete calendar day per page without scanning older days or legacy roots", async () => {
    for (const date of ["2026-10-02", "2026-10-01", "2026-09-30"]) provider.add(`RecentClips/${date}`, true);
    const files = [
      "RecentClips/2026-10-02/2026-10-02_10-00-00-front.mp4",
      "RecentClips/2026-10-02/2026-10-02_09-00-00-front.mp4",
      "RecentClips/2026-10-02/2026-10-02_08-00-00-front.mp4",
      "RecentClips/2026-10-01/2026-10-01_10-00-00-front.mp4",
      "RecentClips/2026-09-30/2026-09-30_11-00-00-front.mp4",
    ];
    for (const file of files) provider.add(file);
    provider.add(`${LEGACY}/2026-09-29_10-00-00-front.mp4`);
    await start();
    const first = await page();
    expect(first.events).toHaveLength(3);
    expect(first.nextPageToken).toBe("2026-10-01");
    expect(first.nextPageDate).toBe("2026-10-02");
    expect(provider.listsFor("RecentClips/2026-10-02")).toHaveLength(2);
    expect(provider.listsFor("RecentClips/2026-10-01")).toHaveLength(0);
    expect(provider.listsFor(LEGACY)).toHaveLength(0);
    const second = await page(first.nextPageToken);
    expect(second.nextPageDate).toBe("2026-10-01");
    const last = await page(second.nextPageToken);
    expect(last.nextPageToken).toBeNull();
    expect(last.nextPageDate).toBeNull();
    expect([...first.events, ...second.events, ...last.events].map((event: { id: string }) => event.id))
      .toEqual(files.map((file) => file.split("/").at(-1)!.slice(0, 19)));
    expect(provider.requests.some((url) => url.pathname.startsWith("/file/"))).toBe(false);
  });

  it("plays a backfilled recording from its canonical dated path without probing preserved roots", async () => {
    const segment = "2026-08-20_12-00-00";
    provider.add("RecentClips/2026-08-20", true);
    const file = provider.add(`RecentClips/2026-08-20/${segment}-front.mp4`);
    provider.add(`${LEGACY}/${segment}-front.mp4`);
    await start();
    expect((await request(hls(segment, "front"))).status).toBe(200);
    expect(ensureHlsSegments.mock.calls[0][0].url).toContain(`/file/${file.id}/`);
    expect(provider.listsFor(LEGACY)).toHaveLength(0);
    expect(provider.requests.filter((url) => url.pathname === "/api/resolve")).toHaveLength(1);
  });

  it("discovers dates added after startup when the recording list is refreshed", async () => {
    await start();
    expect((await page()).events).toEqual([]);
    provider.add("RecentClips/2026-10-20", true);
    const segment = "2026-10-20_12-00-00";
    provider.add(`RecentClips/2026-10-20/${segment}-front.mp4`);
    expect((await page()).events.map((event: { id: string }) => event.id)).toEqual([segment]);
  });

  it.each(["recording", "video"])("restores a %s from a date added after startup without browsing", async (kind) => {
    await start();
    const date = "RecentClips/2026-10-20";
    const segment = "2026-10-20_12-00-00";
    provider.add(date, true);
    const file = provider.add(`${date}/${segment}-front.mp4`);
    if (kind === "recording") {
      const response = await request(`/api/events/RecentClips/${segment}`);
      expect(response.status).toBe(200);
      expect((await response.json()).clips[0].cameras).toEqual(["front"]);
    }
    expect((await request(hls(segment, "front"))).status).toBe(200);
    expect(ensureHlsSegments.mock.calls[0][0].url).toContain(`/file/${file.id}/`);
  });

  it("surfaces canonical root listing failure instead of serving a stale date list", async () => {
    await start();
    const rootId = provider.entries.get("RecentClips")!.id;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/list" && url.searchParams.get("folderId") === rootId) return new Response("Provider failure", { status: 503 });
      return provider.fetch(input);
    });
    const response = await request("/api/events/page?type=RecentClips");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: `Failed to list Drive folder ${rootId}: 503` });
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

  it.each(["0", "-1", "invalid", undefined])("rejects invalid video size %s before playback", async (size) => {
    const day = "2026-10-20";
    const segment = `${day}_12-00-00`;
    provider.add(`RecentClips/${day}`, true);
    const file = provider.add(`RecentClips/${day}/${segment}-front.mp4`);
    file.size = size;
    await start();
    const listing = await request("/api/events/page?type=RecentClips");
    expect(listing.status).toBe(500);
    expect(await listing.json()).toMatchObject({ error: expect.stringContaining("no valid video size") });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const playback = await request(hls(segment, "front"));
      expect(playback.status).toBe(500);
      expect(await playback.text()).toBe("Internal Server Error");
      expect(log).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("no valid video size") }));
    } finally {
      log.mockRestore();
    }
    expect(ensureHlsSegments).not.toHaveBeenCalled();
    expect(provider.requests.some((url) => url.pathname.startsWith("/file/"))).toBe(false);
  });

  it("rejects unsupported camera files rather than counting footage the player cannot show", async () => {
    provider.add("RecentClips/2026-10-20", true);
    provider.add("RecentClips/2026-10-20/2026-10-20_12-00-00-cabin.mp4");
    await start();
    const response = await request("/api/events/page?type=RecentClips");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Unsupported RecentClips camera") });
  });

  it("rejects flat files instead of silently hiding footage uploaded in an unsupported layout", async () => {
    provider.add("RecentClips/2026-10-02_12-00-00-front.mp4");
    await start();
    const response = await request("/api/events/page?type=RecentClips");
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("expected YYYY-MM-DD folders");
  });

  it("restores a complete session even when Drive splits its cameras across metadata pages", async () => {
    provider.add("RecentClips/2026-10-02", true);
    const segments = ["2026-10-02_10-00-00", "2026-10-02_10-01-00", "2026-10-02_10-02-00"];
    for (const segment of segments) provider.add(`RecentClips/2026-10-02/${segment}-front.mp4`);
    provider.add(`RecentClips/2026-10-02/${segments[1]}-back.mp4`);
    await start();
    const response = await request(`/api/events/RecentClips/${segments[1]}`);
    expect(response.status).toBe(200);
    const event = await response.json();
    expect(event.clips.map((clip: { timestamp: string }) => clip.timestamp)).toEqual(segments);
    expect(event.clips[1].cameras).toEqual(["front", "back"]);
    expect(provider.listsFor("RecentClips/2026-10-02")).toHaveLength(2);
    const requestsBefore = provider.requests.length;
    expect((await request(`/api/events/RecentClips/${segments[1]}`)).status).toBe(200);
    expect(provider.requests).toHaveLength(requestsBefore);
  });

  it("retains session aliases and private sources while refresh replaces removed cameras", async () => {
    const date = "RecentClips/2026-10-02";
    provider.add(date, true);
    const early = "2026-10-02_10-00-00";
    const middle = "2026-10-02_10-01-00";
    const late = "2026-10-02_10-02-00";
    provider.add(`${date}/${early}-front.mp4`);
    const front = provider.add(`${date}/${middle}-front.mp4`);
    const back = provider.add(`${date}/${middle}-back.mp4`);
    provider.add(`${date}/${late}-front.mp4`);
    await start();
    const first = await page();
    expect(first.events).toMatchObject([{ id: early, clips: [
      { timestamp: early }, { timestamp: middle, cameras: ["front", "back"] }, { timestamp: late },
    ] }]);
    expect(first.events[0].clips.every((clip: { sourceByCamera?: unknown }) => clip.sourceByCamera === undefined)).toBe(true);
    for (const alias of [early, middle, late]) {
      const response = await request(`/api/events/RecentClips/${alias}`);
      expect(response.status).toBe(200);
      expect((await response.json()).id).toBe(early);
    }
    const requestsBefore = provider.requests.length;
    for (const [camera, source] of [["front", front], ["back", back]] as const) {
      expect((await request(`/api/hls/RecentClips/${late}/${middle}/${camera}/stream.m3u8`)).status).toBe(200);
      expect(ensureHlsSegments.mock.calls.at(-1)![0].url).toContain(`/file/${source.id}/`);
    }
    expect(provider.requests).toHaveLength(requestsBefore);
    provider.remove(`${date}/${middle}-back.mp4`);
    const refreshed = await request(`/api/events/RecentClips/${middle}?refresh=1`);
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).clips[1].cameras).toEqual(["front"]);
    const beforeAliasReads = provider.requests.length;
    for (const alias of [early, middle, late]) {
      const event = await (await request(`/api/events/RecentClips/${alias}`)).json();
      expect(event.clips).toHaveLength(3);
      expect(event.clips[1].cameras).toEqual(["front"]);
    }
    expect(provider.requests).toHaveLength(beforeAliasReads);
    for (const segment of [early, middle, late]) provider.remove(`${date}/${segment}-front.mp4`);
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
    const date = "RecentClips/2026-10-02";
    provider.add(date, true);
    const front = `${date}/${id}-front.mp4`;
    const back = `${date}/${id}-back.mp4`;
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
    provider.resolveFailures.set(date, 503);
    expect((await request(`/api/events/RecentClips/${id}?refresh=1`)).status).toBe(500);
    provider.resolveFailures.delete(date);
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
    provider.resolveFailures.set(`RecentClips/2026-10-02/${segment}-front.mp4`, 503);
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

  it("keeps the loaded-day bound while the cursor selects the next older day", async () => {
    provider.add("RecentClips/2026-10-24", true);
    provider.add("RecentClips/2026-10-23", true);
    provider.add("RecentClips/2026-10-23/2026-10-23_10-00-00-front.mp4");
    await start();
    const first = await page();
    expect(first).toEqual({ type: "RecentClips", events: [], nextPageToken: "2026-10-23", nextPageDate: "2026-10-24" });
    expect(provider.listsFor("RecentClips/2026-10-23")).toHaveLength(0);
    expect((await page(first.nextPageToken)).nextPageToken).toBeNull();
  });

  it("finishes a day with more than 1000 files in one user-visible page", async () => {
    const directory = "RecentClips/2026-10-24";
    const folder = provider.add(directory, true);
    for (let minute = 0; minute < 1001; minute++) {
      const timestamp = new Date(Date.UTC(2026, 9, 24, 0, minute)).toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
      provider.add(`${directory}/${timestamp}-front.mp4`);
    }
    provider.add("RecentClips/2026-10-23", true);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/list" && url.searchParams.get("folderId") === folder.id) {
        provider.requests.push(url);
        const files = provider.children.get(folder.id)!;
        const offset = Number(url.searchParams.get("pageToken") || "0");
        return Response.json({ folderId: folder.id, files: files.slice(offset, offset + 1000), nextPageToken: offset === 0 ? "1000" : undefined });
      }
      return provider.fetch(input);
    });
    await start();
    const first = await page();
    expect(first.events).toHaveLength(1);
    expect(first.events[0].clips).toHaveLength(1001);
    expect(first.nextPageDate).toBe("2026-10-24");
    expect(first.nextPageToken).toBe("2026-10-23");
    const requests = provider.listsFor(directory);
    expect(requests).toHaveLength(2);
    expect(requests.map((url) => url.searchParams.get("pageToken"))).toEqual([null, "1000"]);
    expect(requests.every((url) => url.searchParams.get("limit") === "1000")).toBe(true);
    expect(provider.listsFor("RecentClips/2026-10-23")).toHaveLength(0);
    expect(provider.requests.some((url) => url.pathname.startsWith("/file/"))).toBe(false);
  });

  it("returns an error after an incomplete day fails, then retries the same date without losing files", async () => {
    const directory = "RecentClips/2026-10-24";
    const folder = provider.add(directory, true);
    for (let hour = 0; hour < 3; hour++) provider.add(`${directory}/2026-10-24_0${hour}-00-00-front.mp4`);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === "/api/list" && url.searchParams.get("folderId") === folder.id && url.searchParams.has("pageToken")) return new Response("Provider unavailable", { status: 503 });
      return provider.fetch(input);
    });
    await start();
    const failure = await request("/api/events/page?type=RecentClips");
    expect(failure.status).toBe(500);
    expect((await failure.json()).error).toContain("503");
    vi.stubGlobal("fetch", provider.fetch.bind(provider));
    const retried = await page();
    expect(retried.events).toHaveLength(3);
    expect(retried.nextPageToken).toBeNull();
    expect(provider.requests.some((url) => url.pathname.startsWith("/file/"))).toBe(false);
  });

  it.each(["2026-02-30", "2026-10-25", "private-cursor", Buffer.from(JSON.stringify({ root: "old-root" })).toString("base64url")])(
    "rejects invalid, missing, and legacy cursors with a refresh instruction: %s", async (token) => {
      provider.add("RecentClips/2026-10-24", true);
      await start();
      const response = await request(`/api/events/page?type=RecentClips&pageToken=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("refresh the event list");
      expect(provider.listsFor("RecentClips/2026-10-24")).toHaveLength(0);
    },
  );

  it("rejects duplicate timestamp-camera files across Drive pages", async () => {
    const directory = "RecentClips/2026-10-24";
    const folder = provider.add(directory, true);
    const file = provider.add(`${directory}/2026-10-24_10-00-00-front.mp4`);
    provider.add(`${directory}/2026-10-24_09-00-00-front.mp4`);
    provider.children.get(folder.id)!.push({ ...file, id: "duplicate-file" });
    await start();
    const response = await request("/api/events/page?type=RecentClips");
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Duplicate recording file: 2026-10-24_10-00-00-front.mp4");
    expect(provider.listsFor(directory)).toHaveLength(2);
  });

  it("rejects duplicate day folders instead of choosing an arbitrary recording source", async () => {
    const day = provider.add("RecentClips/2026-10-24", true);
    provider.children.get(provider.entries.get("RecentClips")!.id)!.push({ ...day, id: "duplicate-day" });
    await start();
    const response = await request("/api/events/page?type=RecentClips");
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("Duplicate RecentClips date folder: 2026-10-24");
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
