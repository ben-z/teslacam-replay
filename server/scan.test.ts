import { describe, it, expect } from "vitest";
import {
  scanEventFolder,
  scanRecentClipsPage,
  getClipSource,
  type TeslacamDrive,
} from "./scan";
import type { DriveEntry, DriveFileSource, DriveFolderRef, DriveList } from "./gdrive-lite";

type MockFiles = Record<string, string | null>;

const FOLDER_MIME = "application/vnd.google-apps.folder";

function createMockDrive(files: MockFiles): TeslacamDrive & {
  entry: (path: string, isFolder?: boolean) => DriveEntry;
  listCalls: string[];
} {
  const listCalls: string[] = [];

  function entry(path: string, isFolder = false): DriveEntry {
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

    return {
      folderId: dirPath || "root",
      files: Array.from(entries).map((name) => {
        const fullPath = prefix + name;
        const isFolder = files[fullPath] === null ||
          Object.keys(files).some((key) => key.startsWith(`${fullPath}/`));
        return entry(fullPath, isFolder);
      }),
    };
  }

  return {
    entry,
    listCalls,
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

function fixture(): MockFiles {
  const files: MockFiles = {
    "SavedClips/2025-06-01_18-17-49/event.json": JSON.stringify({
      timestamp: "2025-06-01T18:17:49",
      city: "San Francisco",
      est_lat: "37.7749",
      est_lon: "-122.4194",
      reason: "user_interaction_dashcam_icon_tapped",
      camera: "front",
    }),
    "SavedClips/2025-06-01_18-17-49/thumb.png": "fake-png-data",
    "SavedClips/2025-01-01_00-00-00/event.json": "{}",
    "SentryClips/2025-11-08_16-41-34/event.json": JSON.stringify({
      timestamp: "2025-11-08T16:41:34",
      city: "Oakland",
      reason: "sentry_aware_object_detection",
    }),
  };

  for (const ts of [
    "2025-06-01_18-07-09",
    "2025-06-01_18-08-09",
    "2025-06-01_18-09-09",
  ]) {
    for (const cam of ["front", "back", "left_repeater", "right_repeater"]) {
      files[`SavedClips/2025-06-01_18-17-49/${ts}-${cam}.mp4`] = "";
    }
  }

  for (const cam of [
    "front",
    "back",
    "left_repeater",
    "right_repeater",
    "left_pillar",
    "right_pillar",
  ]) {
    files[`SentryClips/2025-11-08_16-41-34/2025-11-08_16-31-34-${cam}.mp4`] = "";
  }

  for (const ts of [
    "2026-02-01_10-00-00",
    "2026-02-01_10-01-00",
    "2026-02-01_10-02-00",
    "2026-02-01_10-12-00",
    "2026-02-01_10-13-00",
  ]) {
    for (const cam of ["front", "back", "left_repeater", "right_repeater"]) {
      files[`RecentClips/${ts}-${cam}.mp4`] = "";
    }
  }

  for (const cam of ["front", "back"]) {
    files[`RecentClips/2026-01-15/2026-01-15_08-00-00-${cam}.mp4`] = "";
  }

  return files;
}

describe("scanEventFolder", () => {
  it("parses metadata, thumbnails, clips, durations, and file sources", async () => {
    const drive = createMockDrive(fixture());
    const event = await scanEventFolder(
      drive,
      "SavedClips",
      drive.entry("SavedClips/2025-06-01_18-17-49", true)
    );

    expect(event?.city).toBe("San Francisco");
    expect(event?.lat).toBeCloseTo(37.7749);
    expect(event?.lon).toBeCloseTo(-122.4194);
    expect(event?.reason).toBe("user_interaction_dashcam_icon_tapped");
    expect(event?.timestamp).toBe("2025-06-01T18:17:49");
    expect(event?.hasThumbnail).toBe(true);
    expect(event?.thumbnailSource?.url).toContain("thumb.png");
    expect(event?.clips).toHaveLength(3);
    expect(event?.clips[0].cameras).toEqual([
      "front",
      "left_repeater",
      "right_repeater",
      "back",
    ]);
    expect(event?.clips.map((clip) => clip.durationSec)).toEqual([60, 60, 60]);
    expect(event?.totalDurationSec).toBe(180);
    expect(getClipSource(event!, "2025-06-01_18-07-09", "front")?.url).toContain("front.mp4");
  });

  it("returns null for empty or missing event folders", async () => {
    const drive = createMockDrive(fixture());

    await expect(scanEventFolder(
      drive,
      "SavedClips",
      drive.entry("SavedClips/2025-01-01_00-00-00", true)
    )).resolves.toBeNull();
    await expect(scanEventFolder(
      drive,
      "SavedClips",
      drive.entry("SavedClips/does-not-exist", true)
    )).resolves.toBeNull();
  });

  it("handles six-camera Sentry events", async () => {
    const drive = createMockDrive(fixture());
    const event = await scanEventFolder(
      drive,
      "SentryClips",
      drive.entry("SentryClips/2025-11-08_16-41-34", true)
    );

    expect(event?.clips).toHaveLength(1);
    expect(event?.clips[0].cameras).toEqual([
      "front",
      "left_repeater",
      "right_repeater",
      "back",
      "left_pillar",
      "right_pillar",
    ]);
    expect(event?.cameraCount).toBe(6);
    expect(event?.hasThumbnail).toBe(false);
  });
});

describe("scanRecentClipsPage", () => {
  it("groups flat RecentClips page files into driving sessions", async () => {
    const drive = createMockDrive(fixture());
    const page = (await drive.listFolder(drive.folderRef(drive.entry("RecentClips", true)))).files
      .filter((entry) => !drive.isFolder(entry));
    const events = await scanRecentClipsPage(drive, page);

    expect(events.map((event) => event.id)).toEqual([
      "2026-02-01_10-00-00",
      "2026-02-01_10-12-00",
    ]);
    expect(events[0].clips).toHaveLength(3);
    expect(events[1].clips).toHaveLength(2);
  });

  it("scans date subfolders from a RecentClips page", async () => {
    const drive = createMockDrive(fixture());
    const page = (await drive.listFolder(drive.folderRef(drive.entry("RecentClips", true)))).files;
    const events = await scanRecentClipsPage(drive, page);
    const subfolderEvent = events.find((event) => event.id === "2026-01-15_08-00-00");

    expect(subfolderEvent?.clips).toHaveLength(1);
    expect(subfolderEvent?.clips[0].subfolder).toBe("2026-01-15");
    expect(subfolderEvent?.clips[0].cameras).toEqual(["front", "back"]);
  });

  it("returns an empty page when no clips are present", async () => {
    const drive = createMockDrive({});
    await expect(scanRecentClipsPage(drive, [])).resolves.toEqual([]);
  });
});
