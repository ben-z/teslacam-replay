import { describe, it, expect } from "vitest";
import {
  scanEventFolder,
  scanRecentClipsPage,
  getClipSource,
  type TeslacamDrive,
} from "./scan";
import {
  GDriveLiteClient,
  type DriveEntry,
  type DriveFileSource,
  type DriveFolderRef,
  type DriveList,
} from "./gdrive-lite";

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
    "SavedClips/2025-01-01_00-00-00": null,
    "SavedClips/2026-06-14_19-05-54/event.json": JSON.stringify({
      timestamp: "2026-06-14T19:05:54",
      city: "Redwood City",
      reason: "user_interaction_dashcam_icon_tapped",
    }),
    "SavedClips/2026-06-14_19-05-54/thumb.png": "pending-video-thumb",
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

  it("returns null for an empty folder and rejects a missing folder", async () => {
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
    )).rejects.toThrow("ENOENT: SavedClips/does-not-exist");
  });

  it.each(["null", "[]", "42", '"metadata"', "{"])("rejects malformed metadata %s", async (raw) => {
    const path = "SavedClips/2025-06-01_18-17-49";
    const drive = createMockDrive({ [`${path}/event.json`]: raw });
    await expect(scanEventFolder(drive, "SavedClips", drive.entry(path, true)))
      .rejects.toThrow(`Cannot read metadata for ${path}:`);
  });

  it.each(["timestamp", "city", "est_lat", "est_lon", "reason", "camera"])(
    "rejects a non-string %s metadata field",
    async (field) => {
      const path = "SavedClips/2025-06-01_18-17-49";
      const drive = createMockDrive({ [`${path}/event.json`]: JSON.stringify({ [field]: 17 }) });
      await expect(scanEventFolder(drive, "SavedClips", drive.entry(path, true)))
        .rejects.toThrow(`${field} must be a string`);
    },
  );

  it.each(["not-a-date", "2025-02-30T12:00:00", "2025-06-01T24:00:00"])(
    "rejects an invalid event timestamp %s",
    async (timestamp) => {
      const path = "SavedClips/2025-06-01_18-17-49";
      const drive = createMockDrive({ [`${path}/event.json`]: JSON.stringify({ timestamp }) });
      await expect(scanEventFolder(drive, "SavedClips", drive.entry(path, true)))
        .rejects.toThrow(`Invalid recording timestamp: ${timestamp}`);
    },
  );

  it.each([
    ["est_lat", "91"], ["est_lat", "-91"], ["est_lon", "181"], ["est_lon", "-181"],
    ["est_lat", "NaN"], ["est_lon", "Infinity"], ["est_lat", "37.2degrees"], ["est_lat", " "],
  ])("rejects invalid coordinate %s=%s", async (field, value) => {
    const path = "SavedClips/2025-06-01_18-17-49";
    const drive = createMockDrive({ [`${path}/event.json`]: JSON.stringify({ [field]: value }) });
    await expect(scanEventFolder(drive, "SavedClips", drive.entry(path, true)))
      .rejects.toThrow(`${field} is not a valid coordinate`);
  });

  it("keeps zero and exponential coordinates consistent with validation", async () => {
    const path = "SavedClips/2025-06-01_18-17-49";
    const drive = createMockDrive({ [`${path}/event.json`]: JSON.stringify({ est_lat: "0", est_lon: "1e1" }) });
    const event = await scanEventFolder(drive, "SavedClips", drive.entry(path, true));
    expect(event?.lat).toBe(0);
    expect(event?.lon).toBe(10);
  });

  it("propagates folder discovery failures instead of returning an empty event", async () => {
    const drive = createMockDrive(fixture());
    const error = new Error("Drive listing timed out");
    drive.listFolder = async () => { throw error; };
    await expect(scanEventFolder(drive, "SavedClips", drive.entry("SavedClips/2025-06-01_18-17-49", true)))
      .rejects.toBe(error);
  });

  it("reports metadata read failures with their recording and original cause", async () => {
    const drive = createMockDrive(fixture());
    const cause = new Error("Drive metadata read failed");
    drive.readText = async () => { throw cause; };
    await expect(scanEventFolder(drive, "SavedClips", drive.entry("SavedClips/2025-06-01_18-17-49", true)))
      .rejects.toMatchObject({ message: "Cannot read metadata for SavedClips/2025-06-01_18-17-49: Drive metadata read failed", cause });
  });

  it("does not inflate segment estimates to fill missing recording time", async () => {
    const path = "SavedClips/2025-06-01_18-17-49";
    const drive = createMockDrive(Object.fromEntries([
      "2025-06-01_18-00-00", "2025-06-01_18-00-30", "2025-06-01_18-02-30",
    ].map((timestamp) => [`${path}/${timestamp}-front.mp4`, ""])));
    const event = await scanEventFolder(drive, "SavedClips", drive.entry(path, true));
    expect(event?.clips.map((clip) => clip.durationSec)).toEqual([30, 60, 60]);
    expect(event?.totalDurationSec).toBe(150);
  });

  it("rejects an impossible date in a thumbnail-only event folder", async () => {
    const path = "SavedClips/2025-02-30_12-00-00";
    const drive = createMockDrive({ [`${path}/thumb.png`]: "thumbnail" });
    await expect(scanEventFolder(drive, "SavedClips", drive.entry(path, true)))
      .rejects.toThrow("Invalid recording timestamp");
  });

  it("rejects an invalid timestamp even when it is the only Saved segment", async () => {
    const path = "SavedClips/2025-06-01_18-17-49";
    const drive = createMockDrive({ [`${path}/2025-02-30_12-00-00-front.mp4`]: "" });
    await expect(scanEventFolder(drive, "SavedClips", drive.entry(path, true)))
      .rejects.toThrow("Invalid recording timestamp");
  });

  it("keeps metadata-only event folders visible while video files are pending", async () => {
    const drive = createMockDrive(fixture());
    const event = await scanEventFolder(
      drive,
      "SavedClips",
      drive.entry("SavedClips/2026-06-14_19-05-54", true)
    );

    expect(event?.id).toBe("2026-06-14_19-05-54");
    expect(event?.timestamp).toBe("2026-06-14T19:05:54");
    expect(event?.city).toBe("Redwood City");
    expect(event?.reason).toBe("user_interaction_dashcam_icon_tapped");
    expect(event?.hasThumbnail).toBe(true);
    expect(event?.clips).toEqual([]);
    expect(event?.totalDurationSec).toBe(0);
    expect(event?.cameraCount).toBe(0);
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

  it("propagates a date-folder discovery failure even if flat clips were already found", async () => {
    const drive = createMockDrive(fixture());
    const page = [drive.entry("RecentClips/2026-02-01_10-00-00-front.mp4"), drive.entry("RecentClips/2026-01-15", true)];
    const error = new Error("Drive date listing failed");
    drive.listFolder = async () => { throw error; };
    await expect(scanRecentClipsPage(drive, page)).rejects.toBe(error);
  });

  it("keeps a missing minute unrecorded within a Recent driving session", async () => {
    const files = Object.fromEntries(["2026-02-01_10-00-00", "2026-02-01_10-02-00"]
      .map((timestamp) => [`RecentClips/${timestamp}-front.mp4`, ""]));
    const drive = createMockDrive(files);
    const events = await scanRecentClipsPage(drive, Object.keys(files).map((path) => drive.entry(path)));
    expect(events).toHaveLength(1);
    expect(events[0].clips.map((clip) => clip.durationSec)).toEqual([60, 60]);
    expect(events[0].totalDurationSec).toBe(120);
  });

  it("rejects an invalid timestamp even when it is the only Recent segment", async () => {
    const path = "RecentClips/2025-02-30_12-00-00-front.mp4";
    const drive = createMockDrive({ [path]: "" });
    await expect(scanRecentClipsPage(drive, [drive.entry(path)]))
      .rejects.toThrow("Invalid recording timestamp");
  });
});

describe("GDriveLiteClient", () => {
  it("synthesizes file URLs from an unprefixed base URL", () => {
    const drive = new GDriveLiteClient({ baseUrl: "http://127.0.0.1:8765" });

    expect(drive.fileSource({
      id: "file-id",
      name: "clip.mp4",
      mimeType: "video/mp4",
    }).url).toBe("http://127.0.0.1:8765/file/file-id/clip.mp4");
  });

  it("keeps synthesized file URLs under the configured base path", () => {
    const drive = new GDriveLiteClient({ baseUrl: "http://127.0.0.1:8765/gdrive" });

    expect(drive.fileSource({
      id: "file-id",
      name: "clip.mp4",
      mimeType: "video/mp4",
    }).url).toBe("http://127.0.0.1:8765/gdrive/file/file-id/clip.mp4");

    expect(drive.fileSource({
      id: "file-id",
      name: "clip.mp4",
      mimeType: "video/mp4",
      url: "/gdrive/file/file-id/clip.mp4",
    }).url).toBe("http://127.0.0.1:8765/gdrive/file/file-id/clip.mp4");
  });
});
