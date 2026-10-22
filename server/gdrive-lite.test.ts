import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriveNotFoundError, GDriveLiteClient } from "./gdrive-lite";

beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file = { id: "clip", name: "front.mp4", mimeType: "video/mp4" };

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
