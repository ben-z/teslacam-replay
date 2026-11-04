import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { CAPTURE_CONFIG, DriveNotFoundError, GDriveLiteClient } from "./gdrive-lite";
import { timingMp4, timingRangeResponse } from "./test-mp4";

const { testCache } = vi.hoisted(() => ({ testCache: `/tmp/teslacam-drive-time-test-${process.pid}-${Math.random().toString(16).slice(2)}` }));
vi.mock("./paths.js", () => ({ CACHE_DIR: testCache }));

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => { await rm(testCache, { recursive: true, force: true }); });

const file = { id: "clip", name: "front.mp4", mimeType: "video/mp4" };

describe("recording capture metadata transport", () => {
  const capturedAt = Date.UTC(2026, 10, 1, 9, 1, 34);
  const bytes = timingMp4(capturedAt);
  const video = () => ({
    id: crypto.randomUUID(), name: "2026-11-01_01-01-34-front.mp4", mimeType: "video/mp4",
    modifiedTime: "2026-11-03T00:00:00Z", size: String(bytes.length), resourceKey: "private-key",
  });

  it("authenticates bounded range reads and reuses the successful source revision", async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: new URL(input instanceof Request ? input.url : input), headers: new Headers(init?.headers) });
      return timingRangeResponse(bytes, input, init);
    }));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test/prefix", username: "user", password: "pass" });
    const source = video();
    expect(await drive.captureTime(source)).toBe(capturedAt);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(({ url, headers }) => url.origin === "http://drive.test"
      && url.pathname.startsWith("/prefix/file/") && url.searchParams.get("resourceKey") === "private-key"
      && headers.get("Authorization") === `Basic ${Buffer.from("user:pass").toString("base64")}`)).toBe(true);
    expect(requests.every(({ headers }) => {
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(headers.get("Range")!)!;
      return Number(end) - Number(start) + 1 <= 4096;
    })).toBe(true);
    const reads = requests.length;
    expect(await drive.captureTime(source)).toBe(capturedAt);
    expect(requests).toHaveLength(reads);
  });

  it("bounds header work across recording folders and releases failed reads", async () => {
    const files = Array.from({ length: CAPTURE_CONFIG.concurrency + 1 }, video);
    const failing = new Set<string>(files.slice(0, CAPTURE_CONFIG.concurrency).map((file) => file.id));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = 0;
    let active = 0;
    let maximum = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      started++;
      active++;
      maximum = Math.max(maximum, active);
      await held;
      active--;
      const url = new URL(input instanceof Request ? input.url : input);
      return failing.has(url.pathname.split("/")[2])
        ? new Response("Provider unavailable", { status: 503 })
        : timingRangeResponse(bytes, input, init);
    }));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    const reads = Promise.allSettled(files.map((file) => drive.captureTime(file)));
    await vi.waitFor(() => expect(started).toBe(CAPTURE_CONFIG.concurrency));
    release();
    const results = await reads;
    expect(maximum).toBe(CAPTURE_CONFIG.concurrency);
    expect(results.slice(0, CAPTURE_CONFIG.concurrency).every((result) => result.status === "rejected")).toBe(true);
    expect(results[CAPTURE_CONFIG.concurrency]).toEqual({ status: "fulfilled", value: capturedAt });
  });

  it("keeps network permits available when another scan requests the same files or cached metadata", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Set<string>();
    let hold = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (hold) {
        started.add(new URL(input instanceof Request ? input.url : input).pathname);
        await held;
      }
      return timingRangeResponse(bytes, input, init);
    }));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    const cached = video();
    await drive.captureTime(cached);
    hold = true;
    const repeated = video();
    const reads = Promise.all([
      ...Array.from({ length: CAPTURE_CONFIG.concurrency }, () => repeated),
      ...Array.from({ length: CAPTURE_CONFIG.concurrency - 1 }, video),
    ].map((file) => drive.captureTime(file)));
    const cachedRead = drive.captureTime(cached);
    try {
      await vi.waitFor(() => expect(started.size).toBe(CAPTURE_CONFIG.concurrency));
      expect(await cachedRead).toBe(capturedAt);
    } finally {
      release();
      await reads;
      await cachedRead;
    }
  });

  it.each([200, 403, 503])("rejects HTTP %s without consuming a full video body", async (status) => {
    const response = new Response("not a range", { status });
    const cancelled = vi.spyOn(response.body!, "cancel");
    const body = vi.spyOn(response, "arrayBuffer");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.captureTime(video())).rejects.toThrow(`expected HTTP 206, received ${status}`);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body).not.toHaveBeenCalled();
  });

  it.each([undefined, "bytes 1-4096/65676", "bytes 0-4095/1"])("rejects mismatched Content-Range %s", async (range) => {
    const headers = new Headers();
    if (range) headers.set("Content-Range", range);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("wrong range", { status: 206, headers })));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.captureTime(video())).rejects.toThrow("Invalid recording header Content-Range");
  });

  it.each(["truncated", "oversized", "declared length"])("rejects a %s range body", async (fault) => {
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range")!;
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      const length = Number(end) - Number(start) + 1;
      const headers: Record<string, string> = { "Content-Range": `bytes ${start}-${end}/${bytes.length}` };
      if (fault === "declared length") headers["Content-Length"] = String(length + 1);
      return new Response(new Uint8Array(length + (fault === "truncated" ? -1 : 1)), { status: 206, headers });
    }));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.captureTime(video())).rejects.toThrow(fault === "truncated" ? "Truncated" : fault === "oversized" ? "Oversized" : "Content-Length");
  });
});

describe("private source boundaries", () => {
  it("requests linked preview sources when resolving a bookmarked file", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.pathname).toBe("/prefix/api/resolve");
      expect(url.searchParams.get("type")).toBe("file");
      expect(url.searchParams.get("links")).toBe("1");
      return Response.json({ file: {
        ...file,
        hasThumbnail: true,
        thumbnailVersion: "preview-17",
        resourceKey: "preview-key",
        ...(url.searchParams.get("links") === "1"
          ? { thumbnailUrl: "/prefix/thumbnail/clip?resourceKey=preview-key" }
          : {}),
      } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test/prefix" });
    const resolved = await drive.resolvePath("/RecentClips/2026-10-02/2026-10-02_10-00-00-front.mp4", "file");
    const thumbnail = drive.thumbnailSource(resolved);
    expect(thumbnail).toMatchObject({
      id: "clip",
      url: "http://drive.test/prefix/thumbnail/clip?resourceKey=preview-key",
      resourceKey: "preview-key",
      version: "preview-17",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["https://lh3.googleusercontent.com/SIGNED_PRIVATE", "http://user:pass@drive.test/file/clip"]) (
    "rejects an unsafe source before forwarding credentials", async (url) => {
      vi.stubGlobal("fetch", vi.fn());
      const drive = new GDriveLiteClient({ baseUrl: "http://drive.test", username: "user", password: "pass" });
      const source = { id: "clip", name: "front.mp4", url };
      expect(() => drive.streamSource(source)).toThrow("configured proxy origin");
      await expect(drive.fetchSource(source)).rejects.toThrow("configured proxy origin");
      await expect(drive.captureTime({ ...file, url })).rejects.toThrow("configured proxy origin");
      expect(fetch).not.toHaveBeenCalled();
    });
});

type Operation = "resolve" | "list-page" | "read-text";
const operations: Operation[] = ["resolve", "list-page", "read-text"];
const privateFile = { id: "FILE_PRIVATE", name: "BODY_PRIVATE", mimeType: "application/json", resourceKey: "RESOURCE_PRIVATE" };

function runMetadata(operation: Operation, drive: GDriveLiteClient) {
  switch (operation) {
    case "resolve": return drive.resolvePath("/PATH_PRIVATE");
    case "list-page": return drive.listFolderPage({ id: "FOLDER_PRIVATE", resourceKey: "RESOURCE_PRIVATE" }, { pageToken: "PAGE_PRIVATE" });
    case "read-text": return drive.readText(privateFile);
  }
}

function loggedRecords() {
  return vi.mocked(console.info).mock.calls.map(([line]) => JSON.parse(line));
}

function expectPrivateValuesAbsent() {
  const logged = JSON.stringify(vi.mocked(console.info).mock.calls);
  for (const value of ["FILE_PRIVATE", "BODY_PRIVATE", "RESOURCE_PRIVATE", "FOLDER_PRIVATE", "PAGE_PRIVATE", "PATH_PRIVATE", "PASSWORD_PRIVATE", "USERNAME_PRIVATE", "ERROR_PRIVATE", "GPS_PRIVATE", "http://drive.test", Buffer.from("USERNAME_PRIVATE:PASSWORD_PRIVATE").toString("base64")]) {
    expect(logged).not.toContain(value);
  }
}

describe("safe metadata operation timing", () => {
  it.each(operations)("includes the complete %s response body before logging success", async (operation) => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let releaseBody!: (value: unknown) => void;
    let enteredBody!: () => void;
    const body = new Promise<unknown>((resolve) => { releaseBody = resolve; });
    const entered = new Promise<void>((resolve) => { enteredBody = resolve; });
    const response = new Response(null, { status: 200 });
    if (operation === "read-text") {
      vi.spyOn(response, "text").mockImplementation(async () => { enteredBody(); return await body as string; });
    } else {
      vi.spyOn(response, "json").mockImplementation(async () => { enteredBody(); return body; });
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test", username: "USERNAME_PRIVATE", password: "PASSWORD_PRIVATE" });
    const result = runMetadata(operation, drive);
    await entered;
    expect(console.info).not.toHaveBeenCalled();
    now = 350;
    releaseBody(operation === "resolve" ? { file: privateFile } : operation === "list-page" ? { folderId: "FOLDER_PRIVATE", files: [privateFile] } : "BODY_PRIVATE GPS_PRIVATE");
    await result;
    expect(loggedRecords()).toEqual([{
      event: "drive_metadata",
      operation,
      startedAt: expect.any(String),
      elapsedMs: 250,
      outcome: "success",
      status: 200,
    }]);
    expect(new Date(loggedRecords()[0].startedAt).toISOString()).toBe(loggedRecords()[0].startedAt);
    expectPrivateValuesAbsent();
  });

  it.each<[Operation, number, string]>([
    ["resolve", 404, "Drive path not found: /PATH_PRIVATE"],
    ["resolve", 503, "Failed to resolve Drive path /PATH_PRIVATE: 503"],
    ["list-page", 502, "Failed to list Drive folder FOLDER_PRIVATE: 502"],
    ["read-text", 503, "Failed to read BODY_PRIVATE: 503"],
  ])("records %s HTTP %s without logging its error or response body", async (operation, status, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ERROR_PRIVATE GPS_PRIVATE", { status })));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    const failure = await runMetadata(operation, drive).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(operation === "resolve" && status === 404 ? DriveNotFoundError : Error);
    expect((failure as Error).message).toBe(message);
    expect(loggedRecords()).toHaveLength(1);
    expect(loggedRecords()[0]).toMatchObject({ operation, outcome: "error", status });
    expectPrivateValuesAbsent();
  });

  it("records a rejected fetch without inventing a status or replacing the original error", async () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const original = new TypeError("ERROR_PRIVATE GPS_PRIVATE http://drive.test");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { now = 500; throw original; }));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.resolvePath("/PATH_PRIVATE")).rejects.toBe(original);
    expect(loggedRecords()).toEqual([{
      event: "drive_metadata", operation: "resolve", startedAt: expect.any(String), elapsedMs: 400, outcome: "error",
    }]);
    expectPrivateValuesAbsent();
  });

  it.each(operations)("records a rejected %s body read and propagates the same error", async (operation) => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const original = new SyntaxError("ERROR_PRIVATE GPS_PRIVATE BODY_PRIVATE");
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, operation === "read-text" ? "text" : "json").mockImplementation(async () => { now = 700; throw original; });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(runMetadata(operation, drive)).rejects.toBe(original);
    expect(loggedRecords()).toEqual([{
      event: "drive_metadata", operation, startedAt: expect.any(String), elapsedMs: 600, outcome: "error", status: 200,
    }]);
    expectPrivateValuesAbsent();
  });
});

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

  it("rejects a provider cursor cycle without returning a prefix, then permits a fresh read", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ folderId: "archive", files: [file], nextPageToken: "private-first" }))
      .mockResolvedValueOnce(Response.json({ folderId: "archive", files: [], nextPageToken: "private-second" }))
      .mockResolvedValueOnce(Response.json({ folderId: "archive", files: [], nextPageToken: "private-first" }))
      .mockResolvedValueOnce(Response.json({ folderId: "archive", files: [file] }));
    vi.stubGlobal("fetch", fetch);
    const drive = new GDriveLiteClient({ baseUrl: "http://drive.test" });
    await expect(drive.listFolder({ id: "archive" })).rejects.toThrow("Repeated Drive folder page token");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect((await drive.listFolder({ id: "archive" })).files).toEqual([file]);
    expect(fetch).toHaveBeenCalledTimes(4);
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
