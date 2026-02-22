import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import { scanTeslacamFolder, getVideoPath, getThumbnailPath } from "./scan";
import { LocalStorage, type StorageBackend } from "./storage";

let tmpDir: string;
let storage: StorageBackend;

// Create a realistic test fixture
async function createFixture() {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "dashreplay-test-"));

  // SavedClips event with 3 segments, 4 cameras each
  const savedDir = path.join(tmpDir, "SavedClips", "2025-06-01_18-17-49");
  await mkdir(savedDir, { recursive: true });

  // event.json
  await writeFile(
    path.join(savedDir, "event.json"),
    JSON.stringify({
      timestamp: "2025-06-01T18:17:49",
      city: "San Francisco",
      est_lat: "37.7749",
      est_lon: "-122.4194",
      reason: "user_interaction_dashcam_icon_tapped",
      camera: "front",
    })
  );

  // thumb.png
  await writeFile(path.join(savedDir, "thumb.png"), "fake-png-data");

  // 3 segments, 60s apart
  const cameras = ["front", "back", "left_repeater", "right_repeater"];
  const timestamps = [
    "2025-06-01_18-07-09",
    "2025-06-01_18-08-09",
    "2025-06-01_18-09-09",
  ];
  for (const ts of timestamps) {
    for (const cam of cameras) {
      await writeFile(path.join(savedDir, `${ts}-${cam}.mp4`), "");
    }
  }

  // SentryClips event with 1 segment, 6 cameras
  const sentryDir = path.join(tmpDir, "SentryClips", "2025-11-08_16-41-34");
  await mkdir(sentryDir, { recursive: true });

  await writeFile(
    path.join(sentryDir, "event.json"),
    JSON.stringify({
      timestamp: "2025-11-08T16:41:34",
      city: "Oakland",
      reason: "sentry_aware_object_detection",
    })
  );

  const allCameras = [
    "front",
    "back",
    "left_repeater",
    "right_repeater",
    "left_pillar",
    "right_pillar",
  ];
  for (const cam of allCameras) {
    await writeFile(
      path.join(sentryDir, `2025-11-08_16-31-34-${cam}.mp4`),
      ""
    );
  }

  // Empty event folder (no mp4s) — should be skipped
  const emptyDir = path.join(tmpDir, "SavedClips", "2025-01-01_00-00-00");
  await mkdir(emptyDir, { recursive: true });
  await writeFile(path.join(emptyDir, "event.json"), "{}");

  // Non-timestamp folder — should be skipped
  const junkDir = path.join(tmpDir, "SavedClips", ".DS_Store");
  await mkdir(junkDir, { recursive: true });

  // RecentClips: flat MP4 files (two driving sessions with a gap)
  const recentDir = path.join(tmpDir, "RecentClips");
  await mkdir(recentDir, { recursive: true });

  // Session 1: 3 segments, 60s apart
  const recentCameras = ["front", "back", "left_repeater", "right_repeater"];
  const session1 = ["2026-02-01_10-00-00", "2026-02-01_10-01-00", "2026-02-01_10-02-00"];
  for (const ts of session1) {
    for (const cam of recentCameras) {
      await writeFile(path.join(recentDir, `${ts}-${cam}.mp4`), "");
    }
  }

  // Session 2: 2 segments, 60s apart, 10min gap from session 1
  const session2 = ["2026-02-01_10-12-00", "2026-02-01_10-13-00"];
  for (const ts of session2) {
    for (const cam of recentCameras) {
      await writeFile(path.join(recentDir, `${ts}-${cam}.mp4`), "");
    }
  }

  // RecentClips: date subfolder
  const dateSub = path.join(recentDir, "2026-01-15");
  await mkdir(dateSub, { recursive: true });
  const subCams = ["front", "back"];
  for (const cam of subCams) {
    await writeFile(path.join(dateSub, `2026-01-15_08-00-00-${cam}.mp4`), "");
  }

  storage = new LocalStorage(tmpDir);
}

beforeAll(async () => {
  await createFixture();
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("scanTeslacamFolder", () => {
  it("finds SavedClips, SentryClips, and RecentClips events", async () => {
    const events = await scanTeslacamFolder(storage);
    expect(events.map((e) => e.type)).toContain("SavedClips");
    expect(events.map((e) => e.type)).toContain("SentryClips");
    expect(events.map((e) => e.type)).toContain("RecentClips");
  });

  it("sorts events by id descending (newest first)", async () => {
    const events = await scanTeslacamFolder(storage);
    // Should be sorted newest first
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].id >= events[i].id).toBe(true);
    }
  });

  it("skips empty folders and non-timestamp folders", async () => {
    const events = await scanTeslacamFolder(storage);
    const ids = events.map((e) => e.id);
    expect(ids).not.toContain("2025-01-01_00-00-00");
    expect(ids).not.toContain(".DS_Store");
  });

  it("parses event.json metadata correctly", async () => {
    const events = await scanTeslacamFolder(storage);
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.city).toBe("San Francisco");
    expect(saved.lat).toBeCloseTo(37.7749);
    expect(saved.lon).toBeCloseTo(-122.4194);
    expect(saved.reason).toBe("user_interaction_dashcam_icon_tapped");
    expect(saved.timestamp).toBe("2025-06-01T18:17:49");
  });

  it("detects thumbnails", async () => {
    const events = await scanTeslacamFolder(storage);
    const saved = events.find((e) => e.type === "SavedClips")!;
    const sentry = events.find((e) => e.type === "SentryClips")!;
    expect(saved.hasThumbnail).toBe(true);
    expect(sentry.hasThumbnail).toBe(false);
  });

  it("groups clips by timestamp and sorts cameras canonically", async () => {
    const events = await scanTeslacamFolder(storage);
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.clips).toHaveLength(3);
    expect(saved.clips[0].timestamp).toBe("2025-06-01_18-07-09");
    expect(saved.clips[1].timestamp).toBe("2025-06-01_18-08-09");
    expect(saved.clips[2].timestamp).toBe("2025-06-01_18-09-09");

    // Cameras in canonical order
    expect(saved.clips[0].cameras).toEqual([
      "front",
      "left_repeater",
      "right_repeater",
      "back",
    ]);
  });

  it("computes segment durations from timestamp gaps", async () => {
    const events = await scanTeslacamFolder(storage);
    const saved = events.find((e) => e.type === "SavedClips")!;
    // Segments are 60s apart
    expect(saved.clips[0].durationSec).toBe(60);
    expect(saved.clips[1].durationSec).toBe(60);
    // Last segment defaults to 60s (no next timestamp)
    expect(saved.clips[2].durationSec).toBe(60);
  });

  it("computes total duration as sum of clip durations", async () => {
    const events = await scanTeslacamFolder(storage);
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.totalDurationSec).toBe(180);
  });

  it("handles 6-camera events", async () => {
    const events = await scanTeslacamFolder(storage);
    const sentry = events.find((e) => e.type === "SentryClips")!;
    expect(sentry.clips).toHaveLength(1);
    expect(sentry.clips[0].cameras).toHaveLength(6);
    // Single segment defaults to 60s
    expect(sentry.clips[0].durationSec).toBe(60);
  });

  it("handles missing teslacam folder gracefully", async () => {
    const emptyStorage = new LocalStorage("/nonexistent/path");
    const events = await scanTeslacamFolder(emptyStorage);
    expect(events).toEqual([]);
  });
});

describe("RecentClips scanning", () => {
  it("groups flat files into driving sessions by timestamp gaps", async () => {
    const events = await scanTeslacamFolder(storage);
    const recent = events.filter((e) => e.type === "RecentClips");
    // Should have 3 sessions: session1 (3 clips), session2 (2 clips), subfolder (1 clip)
    expect(recent).toHaveLength(3);
  });

  it("splits sessions at gaps > 2 minutes", async () => {
    const events = await scanTeslacamFolder(storage);
    const recent = events.filter((e) => e.type === "RecentClips");
    const session1 = recent.find((e) => e.id === "2026-02-01_10-00-00");
    const session2 = recent.find((e) => e.id === "2026-02-01_10-12-00");
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    expect(session1!.clips).toHaveLength(3);
    expect(session2!.clips).toHaveLength(2);
  });

  it("tracks subfolder for date-organized files", async () => {
    const events = await scanTeslacamFolder(storage);
    const subfolderEvent = events.find((e) => e.id === "2026-01-15_08-00-00");
    expect(subfolderEvent).toBeDefined();
    expect(subfolderEvent!.clips[0].subfolder).toBe("2026-01-15");
  });

  it("has no subfolder for flat files", async () => {
    const events = await scanTeslacamFolder(storage);
    const flatEvent = events.find((e) => e.id === "2026-02-01_10-00-00");
    expect(flatEvent).toBeDefined();
    expect(flatEvent!.clips[0].subfolder).toBeUndefined();
  });
});

describe("getVideoPath", () => {
  it("constructs correct path for SavedClips", () => {
    const p = getVideoPath(
      "SavedClips",
      "2025-06-01_18-17-49",
      "2025-06-01_18-07-09",
      "front"
    );
    expect(p).toBe(
      "SavedClips/2025-06-01_18-17-49/2025-06-01_18-07-09-front.mp4"
    );
  });

  it("constructs correct path for RecentClips flat files", () => {
    const p = getVideoPath(
      "RecentClips",
      "2026-02-01_10-00-00",
      "2026-02-01_10-00-00",
      "front"
    );
    expect(p).toBe(
      "RecentClips/2026-02-01_10-00-00-front.mp4"
    );
  });

  it("constructs correct path for RecentClips with subfolder", () => {
    const p = getVideoPath(
      "RecentClips",
      "2026-01-15_08-00-00",
      "2026-01-15_08-00-00",
      "front",
      "2026-01-15"
    );
    expect(p).toBe(
      "RecentClips/2026-01-15/2026-01-15_08-00-00-front.mp4"
    );
  });
});

describe("getThumbnailPath", () => {
  it("constructs correct path", () => {
    const p = getThumbnailPath(
      "SavedClips",
      "2025-06-01_18-17-49"
    );
    expect(p).toBe(
      "SavedClips/2025-06-01_18-17-49/thumb.png"
    );
  });
});

describe("StorageBackend (LocalStorage)", () => {
  it("readdir lists directory entries", async () => {
    const entries = await storage.readdir("SavedClips");
    expect(entries).toContain("2025-06-01_18-17-49");
  });

  it("readFileUtf8 reads file content", async () => {
    const content = await storage.readFileUtf8("SavedClips/2025-06-01_18-17-49/event.json");
    const parsed = JSON.parse(content);
    expect(parsed.city).toBe("San Francisco");
  });

  it("exists returns true for existing files", async () => {
    expect(await storage.exists("SavedClips/2025-06-01_18-17-49/thumb.png")).toBe(true);
  });

  it("exists returns false for missing files", async () => {
    expect(await storage.exists("SavedClips/nonexistent/thumb.png")).toBe(false);
  });

  it("getLocalPath returns full filesystem path", async () => {
    const localPath = await storage.getLocalPath("SavedClips/2025-06-01_18-17-49/thumb.png");
    expect(localPath).toContain(tmpDir);
    expect(localPath).toContain("thumb.png");
  });

  it("readdir throws for nonexistent directory", async () => {
    await expect(storage.readdir("NonexistentDir")).rejects.toThrow();
  });
});

describe("In-memory mock StorageBackend", () => {
  // Tests that scan.ts works with any StorageBackend, not just LocalStorage.
  // This validates the abstraction by using a simple in-memory implementation.

  function createMockStorage(files: Record<string, string | null>): StorageBackend {
    // files: key = path (forward slash separated), value = content (null for directories)
    return {
      async readdir(dirPath: string): Promise<string[]> {
        const prefix = dirPath ? dirPath + "/" : "";
        const entries = new Set<string>();
        for (const key of Object.keys(files)) {
          if (key.startsWith(prefix)) {
            const rest = key.slice(prefix.length);
            const name = rest.split("/")[0];
            if (name) entries.add(name);
          }
        }
        if (entries.size === 0 && dirPath) {
          throw new Error(`ENOENT: ${dirPath}`);
        }
        return Array.from(entries);
      },
      async readFile(filePath: string): Promise<Buffer> {
        const content = files[filePath];
        if (content === undefined || content === null) throw new Error(`ENOENT: ${filePath}`);
        return Buffer.from(content);
      },
      async readFileUtf8(filePath: string): Promise<string> {
        const content = files[filePath];
        if (content === undefined || content === null) throw new Error(`ENOENT: ${filePath}`);
        return content;
      },
      async exists(filePath: string): Promise<boolean> {
        return filePath in files;
      },
      async getLocalPath(): Promise<string> {
        throw new Error("Not implemented in mock");
      },
      async createReadStream(): Promise<NodeJS.ReadableStream> {
        throw new Error("Not implemented in mock");
      },
      async fileSize(): Promise<number> {
        throw new Error("Not implemented in mock");
      },
      clearCache(): void {},
      cacheEntryCount(): number { return 0; },
    };
  }

  it("scans events from mock storage", async () => {
    const mockFiles: Record<string, string | null> = {
      "SavedClips/2025-03-15_10-00-00/event.json": JSON.stringify({
        city: "TestCity",
        reason: "test_reason",
      }),
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-50-00-front.mp4": "",
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-50-00-back.mp4": "",
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-51-00-front.mp4": "",
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-51-00-back.mp4": "",
    };

    const mock = createMockStorage(mockFiles);
    const events = await scanTeslacamFolder(mock);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("SavedClips");
    expect(events[0].city).toBe("TestCity");
    expect(events[0].clips).toHaveLength(2);
    expect(events[0].clips[0].cameras).toContain("front");
    expect(events[0].clips[0].cameras).toContain("back");
  });

  it("scans RecentClips from mock storage", async () => {
    const mockFiles: Record<string, string | null> = {
      "RecentClips/2026-01-01_12-00-00-front.mp4": "",
      "RecentClips/2026-01-01_12-01-00-front.mp4": "",
      "RecentClips/2026-01-01_12-01-00-back.mp4": "",
    };

    const mock = createMockStorage(mockFiles);
    const events = await scanTeslacamFolder(mock);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("RecentClips");
    expect(events[0].clips).toHaveLength(2);
  });

  it("returns empty for empty storage", async () => {
    const mock = createMockStorage({});
    const events = await scanTeslacamFolder(mock);
    expect(events).toEqual([]);
  });

  it("incremental scan only picks up new folders", async () => {
    const mockFiles: Record<string, string | null> = {
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-50-00-front.mp4": "",
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-50-00-back.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-front.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-back.mp4": "",
    };

    const mock = createMockStorage(mockFiles);

    // Full scan first
    const fullEvents = await scanTeslacamFolder(mock);
    expect(fullEvents).toHaveLength(2);

    // Incremental: pass existing events — no new folders, so only existing are returned
    const incEvents = await scanTeslacamFolder(mock, fullEvents);
    expect(incEvents).toHaveLength(2);
    expect(incEvents.map(e => e.id).sort()).toEqual(fullEvents.map(e => e.id).sort());
  });

  it("incremental scan merges new events with existing", async () => {
    // Start with 1 event
    const mock1 = createMockStorage({
      "SentryClips/2025-03-15_10-00-00/2025-03-15_09-50-00-front.mp4": "",
    });
    const existing = await scanTeslacamFolder(mock1);
    expect(existing).toHaveLength(1);

    // Now storage has 2 events (old one + new one)
    const mock2 = createMockStorage({
      "SentryClips/2025-03-15_10-00-00/2025-03-15_09-50-00-front.mp4": "",
      "SentryClips/2025-06-01_12-00-00/2025-06-01_11-50-00-front.mp4": "",
    });

    const merged = await scanTeslacamFolder(mock2, existing);
    expect(merged).toHaveLength(2);
    expect(merged.map(e => e.id)).toContain("2025-03-15_10-00-00");
    expect(merged.map(e => e.id)).toContain("2025-06-01_12-00-00");
  });

  it("incremental scan always re-scans RecentClips", async () => {
    const mock1 = createMockStorage({
      "RecentClips/2026-01-01_12-00-00-front.mp4": "",
    });
    const existing = await scanTeslacamFolder(mock1);
    expect(existing).toHaveLength(1);
    expect(existing[0].clips).toHaveLength(1);

    // Add a new RecentClips file
    const mock2 = createMockStorage({
      "RecentClips/2026-01-01_12-00-00-front.mp4": "",
      "RecentClips/2026-01-01_12-01-00-front.mp4": "",
    });

    const merged = await scanTeslacamFolder(mock2, existing);
    const recent = merged.filter(e => e.type === "RecentClips");
    expect(recent).toHaveLength(1);
    expect(recent[0].clips).toHaveLength(2); // fresh scan picked up both
  });
});
