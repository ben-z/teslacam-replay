import { vi, describe, it, expect, beforeEach } from "vitest";
import { GoogleDriveStorage } from "./google-drive";

// Prevent disk I/O from dir cache persistence during tests
vi.mock("fs/promises", async (importOriginal) => {
  const mod = await importOriginal<typeof import("fs/promises")>();
  return {
    ...mod,
    readFile: vi.fn().mockRejectedValue(new Error("no file")),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  };
});

/**
 * Create a mock Drive client for testing.
 * Returns the mock client and its mocked methods for assertions.
 */
function createMockDrive() {
  const mockList = Object.assign(
    async (_params: any) => ({ data: { files: [], nextPageToken: null } }),
    {} as { mockResolvedValueOnce: (val: any) => void; mockResolvedValue: (val: any) => void; callCount: number; calls: any[] }
  );

  const mockGet = Object.assign(
    async (_params: any, _opts?: any) => ({ data: {} }),
    {} as { mockResolvedValueOnce: (val: any) => void; callCount: number; calls: any[] }
  );

  // Track calls and allow setting return values
  const listResults: any[] = [];
  let listDefault: any = { data: { files: [], nextPageToken: null } };
  const listCalls: any[] = [];

  const getResults: any[] = [];
  const getCalls: any[] = [];

  const drive = {
    files: {
      list: async (params: any) => {
        listCalls.push(params);
        if (listResults.length > 0) return listResults.shift();
        return listDefault;
      },
      get: async (params: any, opts?: any) => {
        getCalls.push({ params, opts });
        if (getResults.length > 0) return getResults.shift();
        throw new Error("No mock result configured for files.get");
      },
    },
  };

  return {
    drive: drive as any,
    list: {
      enqueue: (result: any) => listResults.push(result),
      setDefault: (result: any) => { listDefault = result; },
      get calls() { return listCalls; },
      get callCount() { return listCalls.length; },
    },
    get: {
      enqueue: (result: any) => getResults.push(result),
      get calls() { return getCalls; },
      get callCount() { return getCalls.length; },
    },
  };
}

describe("GoogleDriveStorage", () => {
  let storage: GoogleDriveStorage;
  let mock: ReturnType<typeof createMockDrive>;

  beforeEach(async () => {
    mock = createMockDrive();
    storage = await GoogleDriveStorage.fromDriveClient(mock.drive, "root-folder-id");
  });

  describe("readdir", () => {
    it("lists entries in root folder", async () => {
      mock.list.enqueue({
        data: {
          files: [
            { id: "id1", name: "SavedClips", mimeType: "application/vnd.google-apps.folder" },
            { id: "id2", name: "SentryClips", mimeType: "application/vnd.google-apps.folder" },
            { id: "id3", name: "RecentClips", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      const entries = await storage.readdir("");
      expect(entries).toContain("SavedClips");
      expect(entries).toContain("SentryClips");
      expect(entries).toContain("RecentClips");
    });

    it("lists entries in nested folder", async () => {
      // First call: list root to resolve "SavedClips"
      mock.list.enqueue({
        data: {
          files: [
            { id: "saved-id", name: "SavedClips", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      // Second call: list SavedClips folder
      mock.list.enqueue({
        data: {
          files: [
            { id: "ev1", name: "2025-06-01_18-17-49", mimeType: "application/vnd.google-apps.folder" },
            { id: "ev2", name: "2025-06-02_10-00-00", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      const entries = await storage.readdir("SavedClips");
      expect(entries).toContain("2025-06-01_18-17-49");
      expect(entries).toContain("2025-06-02_10-00-00");
    });

    it("handles pagination", async () => {
      // Page 1
      mock.list.enqueue({
        data: {
          files: [
            { id: "id1", name: "folder1", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: "page2token",
        },
      });

      // Page 2
      mock.list.enqueue({
        data: {
          files: [
            { id: "id2", name: "folder2", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      const entries = await storage.readdir("");
      expect(entries).toContain("folder1");
      expect(entries).toContain("folder2");
    });

    it("uses cache for repeated readdir calls", async () => {
      mock.list.enqueue({
        data: {
          files: [
            { id: "id1", name: "SavedClips", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      await storage.readdir("");
      await storage.readdir(""); // should use cache

      // Only one API call
      expect(mock.list.callCount).toBe(1);
    });
  });

  describe("readFile", () => {
    it("downloads file content as Buffer", async () => {
      // Resolve path: list root to find SavedClips
      mock.list.enqueue({
        data: {
          files: [
            { id: "saved-id", name: "SavedClips", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      // List SavedClips to find event folder
      mock.list.enqueue({
        data: {
          files: [
            { id: "event-id", name: "2025-06-01_18-17-49", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      // List event folder to find event.json
      mock.list.enqueue({
        data: {
          files: [
            { id: "json-id", name: "event.json", mimeType: "application/json" },
          ],
          nextPageToken: null,
        },
      });

      // Download file content
      const content = JSON.stringify({ city: "San Francisco" });
      const arrayBuffer = new TextEncoder().encode(content).buffer;
      mock.get.enqueue({ data: arrayBuffer });

      const buf = await storage.readFile("SavedClips/2025-06-01_18-17-49/event.json");
      expect(buf.toString("utf-8")).toBe(content);
    });

    it("throws for nonexistent file", async () => {
      mock.list.enqueue({
        data: {
          files: [],
          nextPageToken: null,
        },
      });

      await expect(storage.readFile("nonexistent.txt")).rejects.toThrow("File not found");
    });
  });

  describe("exists", () => {
    it("returns true for existing file", async () => {
      mock.list.enqueue({
        data: {
          files: [
            { id: "id1", name: "SavedClips", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      expect(await storage.exists("SavedClips")).toBe(true);
    });

    it("returns false for nonexistent file", async () => {
      mock.list.enqueue({
        data: {
          files: [],
          nextPageToken: null,
        },
      });

      expect(await storage.exists("Nonexistent")).toBe(false);
    });
  });

  describe("clearCache", () => {
    it("clears directory cache", async () => {
      mock.list.setDefault({
        data: {
          files: [
            { id: "id1", name: "SavedClips", mimeType: "application/vnd.google-apps.folder" },
          ],
          nextPageToken: null,
        },
      });

      await storage.readdir("");
      storage.clearCache();
      await storage.readdir("");

      // Should have made 2 API calls (cache was cleared)
      expect(mock.list.callCount).toBe(2);
    });
  });

  describe("readFileUtf8", () => {
    it("returns string content", async () => {
      mock.list.enqueue({
        data: {
          files: [
            { id: "file-id", name: "test.txt", mimeType: "text/plain" },
          ],
          nextPageToken: null,
        },
      });

      const content = "Hello, World!";
      mock.get.enqueue({
        data: new TextEncoder().encode(content).buffer,
      });

      const result = await storage.readFileUtf8("test.txt");
      expect(result).toBe(content);
    });
  });

  describe("fileSize", () => {
    it("returns file size from API", async () => {
      mock.list.enqueue({
        data: {
          files: [
            { id: "file-id", name: "video.mp4", mimeType: "video/mp4" },
          ],
          nextPageToken: null,
        },
      });

      mock.get.enqueue({
        data: { size: "1048576" },
      });

      const size = await storage.fileSize("video.mp4");
      expect(size).toBe(1048576);
    });
  });
});
