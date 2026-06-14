import { describe, it, expect } from "vitest";
import { scanTeslacamFolder, getClipSource, type TeslacamDrive } from "./scan";
import type { DriveEntry, DriveFileSource, DriveFolderRef, DriveList } from "./gdrive-lite";

type MockFiles = Record<string, string | null>;

const FOLDER_MIME = "application/vnd.google-apps.folder";

function createMockDrive(files: MockFiles): TeslacamDrive & { listCalls: string[] } {
  const listCalls: string[] = [];

  function entryFor(path: string, isFolder: boolean): DriveEntry {
    const name = path.split("/").pop() || "";
    return {
      id: path || "root",
      name,
      mimeType: isFolder ? FOLDER_MIME : mimeTypeFor(name),
      size: isFolder ? undefined : String(files[path]?.length ?? 0),
      url: isFolder ? undefined : `/file/${encodeURIComponent(path)}/${encodeURIComponent(name)}`,
    };
  }

  function listPath(dirPath: string): DriveList {
    listCalls.push(dirPath);
    const prefix = dirPath ? `${dirPath}/` : "";
    const entries = new Set<string>();

    for (const key of Object.keys(files)) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split("/")[0];
      if (name) entries.add(name);
    }

    if (entries.size === 0 && dirPath && !(dirPath in files)) {
      throw new Error(`ENOENT: ${dirPath}`);
    }

    const driveEntries = Array.from(entries).map((name) => {
      const fullPath = prefix + name;
      const isFolder = files[fullPath] === null || Object.keys(files).some((key) => key.startsWith(`${fullPath}/`));
      return entryFor(fullPath, isFolder);
    });

    return { folderId: dirPath || "root", files: driveEntries };
  }

  return {
    listCalls,
    async listRoot(): Promise<DriveList> {
      return listPath("");
    },
    async listFolder(folder: DriveFolderRef): Promise<DriveList> {
      return listPath(folder.id === "root" ? "" : folder.id);
    },
    async readText(file: DriveEntry): Promise<string> {
      const content = files[file.id];
      if (typeof content !== "string") throw new Error(`ENOENT: ${file.id}`);
      return content;
    },
    fileSource(file: DriveEntry): DriveFileSource {
      return {
        id: file.id,
        name: file.name,
        url: `http://gdrive.test${file.url || `/file/${encodeURIComponent(file.id)}/${encodeURIComponent(file.name)}`}`,
        mimeType: file.mimeType,
        sizeBytes: file.size ? Number(file.size) : undefined,
      };
    },
    folderRef(file: DriveEntry): DriveFolderRef {
      return { id: file.id };
    },
    isFolder(file: DriveEntry): boolean {
      return file.mimeType === FOLDER_MIME;
    },
  };
}

function mimeTypeFor(name: string): string {
  if (name.endsWith(".mp4")) return "video/mp4";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function createFixture(): MockFiles {
  const files: MockFiles = {};

  files["SavedClips/2025-06-01_18-17-49/event.json"] = JSON.stringify({
    timestamp: "2025-06-01T18:17:49",
    city: "San Francisco",
    est_lat: "37.7749",
    est_lon: "-122.4194",
    reason: "user_interaction_dashcam_icon_tapped",
    camera: "front",
  });
  files["SavedClips/2025-06-01_18-17-49/thumb.png"] = "fake-png-data";

  const cameras = ["front", "back", "left_repeater", "right_repeater"];
  const timestamps = [
    "2025-06-01_18-07-09",
    "2025-06-01_18-08-09",
    "2025-06-01_18-09-09",
  ];
  for (const ts of timestamps) {
    for (const cam of cameras) {
      files[`SavedClips/2025-06-01_18-17-49/${ts}-${cam}.mp4`] = "";
    }
  }

  files["SentryClips/2025-11-08_16-41-34/event.json"] = JSON.stringify({
    timestamp: "2025-11-08T16:41:34",
    city: "Oakland",
    reason: "sentry_aware_object_detection",
  });

  const allCameras = [
    "front",
    "back",
    "left_repeater",
    "right_repeater",
    "left_pillar",
    "right_pillar",
  ];
  for (const cam of allCameras) {
    files[`SentryClips/2025-11-08_16-41-34/2025-11-08_16-31-34-${cam}.mp4`] = "";
  }

  // Empty event folder (no mp4s) should be skipped.
  files["SavedClips/2025-01-01_00-00-00/event.json"] = "{}";

  // RecentClips: flat MP4 files (two driving sessions with a gap)
  const recentCameras = ["front", "back", "left_repeater", "right_repeater"];
  const session1 = ["2026-02-01_10-00-00", "2026-02-01_10-01-00", "2026-02-01_10-02-00"];
  for (const ts of session1) {
    for (const cam of recentCameras) {
      files[`RecentClips/${ts}-${cam}.mp4`] = "";
    }
  }

  const session2 = ["2026-02-01_10-12-00", "2026-02-01_10-13-00"];
  for (const ts of session2) {
    for (const cam of recentCameras) {
      files[`RecentClips/${ts}-${cam}.mp4`] = "";
    }
  }

  for (const cam of ["front", "back"]) {
    files[`RecentClips/2026-01-15/2026-01-15_08-00-00-${cam}.mp4`] = "";
  }

  return files;
}

describe("scanTeslacamFolder", () => {
  it("finds SavedClips, SentryClips, and RecentClips events", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    expect(events.map((e) => e.type)).toContain("SavedClips");
    expect(events.map((e) => e.type)).toContain("SentryClips");
    expect(events.map((e) => e.type)).toContain("RecentClips");
  });

  it("sorts events by id descending (newest first)", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].id >= events[i].id).toBe(true);
    }
  });

  it("skips empty folders and non-timestamp folders", async () => {
    const files = createFixture();
    files["SavedClips/.DS_Store/ignored.txt"] = "";
    const events = await scanTeslacamFolder(createMockDrive(files));
    const ids = events.map((e) => e.id);
    expect(ids).not.toContain("2025-01-01_00-00-00");
    expect(ids).not.toContain(".DS_Store");
  });

  it("parses event.json metadata correctly", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.city).toBe("San Francisco");
    expect(saved.lat).toBeCloseTo(37.7749);
    expect(saved.lon).toBeCloseTo(-122.4194);
    expect(saved.reason).toBe("user_interaction_dashcam_icon_tapped");
    expect(saved.timestamp).toBe("2025-06-01T18:17:49");
  });

  it("detects thumbnails and keeps their direct source", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const saved = events.find((e) => e.type === "SavedClips")!;
    const sentry = events.find((e) => e.type === "SentryClips")!;
    expect(saved.hasThumbnail).toBe(true);
    expect(saved.thumbnailSource?.url).toContain("/file/SavedClips%2F2025-06-01_18-17-49%2Fthumb.png/");
    expect(sentry.hasThumbnail).toBe(false);
  });

  it("groups clips by timestamp, sorts cameras canonically, and keeps file sources", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.clips).toHaveLength(3);
    expect(saved.clips[0].timestamp).toBe("2025-06-01_18-07-09");
    expect(saved.clips[1].timestamp).toBe("2025-06-01_18-08-09");
    expect(saved.clips[2].timestamp).toBe("2025-06-01_18-09-09");
    expect(saved.clips[0].cameras).toEqual([
      "front",
      "left_repeater",
      "right_repeater",
      "back",
    ]);
    expect(getClipSource(saved, "2025-06-01_18-07-09", "front")?.url).toContain("front.mp4");
  });

  it("computes segment durations from timestamp gaps", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.clips[0].durationSec).toBe(60);
    expect(saved.clips[1].durationSec).toBe(60);
    expect(saved.clips[2].durationSec).toBe(60);
  });

  it("computes total duration as sum of clip durations", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.totalDurationSec).toBe(180);
  });

  it("handles 6-camera events", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const sentry = events.find((e) => e.type === "SentryClips")!;
    expect(sentry.clips).toHaveLength(1);
    expect(sentry.clips[0].cameras).toHaveLength(6);
    expect(sentry.cameraCount).toBe(6);
    expect(sentry.clips[0].durationSec).toBe(60);
  });

  it("handles missing teslacam folders gracefully", async () => {
    const events = await scanTeslacamFolder(createMockDrive({}));
    expect(events).toEqual([]);
  });
});

describe("RecentClips scanning", () => {
  it("groups flat files into driving sessions by timestamp gaps", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const recent = events.filter((e) => e.type === "RecentClips");
    expect(recent).toHaveLength(3);
  });

  it("splits sessions at gaps > 2 minutes", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const recent = events.filter((e) => e.type === "RecentClips");
    const session1 = recent.find((e) => e.id === "2026-02-01_10-00-00");
    const session2 = recent.find((e) => e.id === "2026-02-01_10-12-00");
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    expect(session1!.clips).toHaveLength(3);
    expect(session2!.clips).toHaveLength(2);
  });

  it("tracks subfolder for date-organized files", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const subfolderEvent = events.find((e) => e.id === "2026-01-15_08-00-00");
    expect(subfolderEvent).toBeDefined();
    expect(subfolderEvent!.clips[0].subfolder).toBe("2026-01-15");
  });

  it("has no subfolder for flat files", async () => {
    const events = await scanTeslacamFolder(createMockDrive(createFixture()));
    const flatEvent = events.find((e) => e.id === "2026-02-01_10-00-00");
    expect(flatEvent).toBeDefined();
    expect(flatEvent!.clips[0].subfolder).toBeUndefined();
  });
});

describe("Incremental scanning", () => {
  it("incremental scan only picks up new folders", async () => {
    const files: MockFiles = {
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-50-00-front.mp4": "",
      "SavedClips/2025-03-15_10-00-00/2025-03-15_09-50-00-back.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-front.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-back.mp4": "",
    };

    const mock = createMockDrive(files);
    const fullEvents = await scanTeslacamFolder(mock);
    expect(fullEvents).toHaveLength(2);

    const incEvents = await scanTeslacamFolder(mock, fullEvents);
    expect(incEvents).toHaveLength(2);
    expect(incEvents.map(e => e.id).sort()).toEqual(fullEvents.map(e => e.id).sort());
  });

  it("incremental scan merges new events with existing", async () => {
    const existing = await scanTeslacamFolder(createMockDrive({
      "SentryClips/2025-03-15_10-00-00/2025-03-15_09-50-00-front.mp4": "",
    }));
    expect(existing).toHaveLength(1);

    const merged = await scanTeslacamFolder(createMockDrive({
      "SentryClips/2025-03-15_10-00-00/2025-03-15_09-50-00-front.mp4": "",
      "SentryClips/2025-06-01_12-00-00/2025-06-01_11-50-00-front.mp4": "",
    }), existing);

    expect(merged).toHaveLength(2);
    expect(merged.map(e => e.id)).toContain("2025-03-15_10-00-00");
    expect(merged.map(e => e.id)).toContain("2025-06-01_12-00-00");
  });

  it("incremental scan refreshes newest SavedClips folders that were partially uploaded", async () => {
    const existing = await scanTeslacamFolder(createMockDrive({
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-front.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-back.mp4": "",
    }));
    expect(existing).toHaveLength(1);
    expect(existing[0].cameraCount).toBe(2);

    const rescanned = await scanTeslacamFolder(createMockDrive({
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-front.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-back.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-left_repeater.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-right_repeater.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-left_pillar.mp4": "",
      "SavedClips/2025-06-01_12-00-00/2025-06-01_11-50-00-right_pillar.mp4": "",
    }), existing);
    const saved = rescanned.find(e => e.type === "SavedClips" && e.id === "2025-06-01_12-00-00");

    expect(rescanned).toHaveLength(1);
    expect(saved?.cameraCount).toBe(6);
    expect(saved?.clips[0].cameras).toEqual([
      "front",
      "left_repeater",
      "right_repeater",
      "back",
      "left_pillar",
      "right_pillar",
    ]);
  });

  it("incremental scan extends the newest RecentClips session", async () => {
    const existing = await scanTeslacamFolder(createMockDrive({
      "RecentClips/2026-01-01_12-00-00-front.mp4": "",
    }));
    expect(existing).toHaveLength(1);
    expect(existing[0].clips).toHaveLength(1);

    const merged = await scanTeslacamFolder(createMockDrive({
      "RecentClips/2026-01-01_12-00-00-front.mp4": "",
      "RecentClips/2026-01-01_12-01-00-front.mp4": "",
    }), existing);
    const recent = merged.filter(e => e.type === "RecentClips");
    expect(recent).toHaveLength(1);
    expect(recent[0].clips).toHaveLength(2);
  });

  it("incremental scan skips RecentClips date folders older than the newest session", async () => {
    const initialFiles: MockFiles = {
      "RecentClips/2026-01-01/2026-01-01_08-00-00-front.mp4": "",
      "RecentClips/2026-01-02/2026-01-02_12-00-00-front.mp4": "",
    };
    const existing = await scanTeslacamFolder(createMockDrive(initialFiles));
    expect(existing.filter(e => e.type === "RecentClips")).toHaveLength(2);

    const mock = createMockDrive({
      ...initialFiles,
      "RecentClips/2026-01-02/2026-01-02_12-01-00-front.mp4": "",
    });

    const merged = await scanTeslacamFolder(mock, existing);
    const recent = merged.filter(e => e.type === "RecentClips");
    const updated = recent.find(e => e.id === "2026-01-02_12-00-00");
    const preserved = recent.find(e => e.id === "2026-01-01_08-00-00");

    expect(mock.listCalls).not.toContain("RecentClips/2026-01-01");
    expect(updated?.clips).toHaveLength(2);
    expect(preserved?.clips).toHaveLength(1);
  });
});
