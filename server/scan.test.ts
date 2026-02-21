import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import path from "path";
import os from "os";
import { scanTeslacamFolder, getVideoPath, getThumbnailPath } from "./scan";

let tmpDir: string;

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
}

beforeAll(async () => {
  await createFixture();
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("scanTeslacamFolder", () => {
  it("finds SavedClips, SentryClips, and RecentClips events", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    expect(events.map((e) => e.type)).toContain("SavedClips");
    expect(events.map((e) => e.type)).toContain("SentryClips");
    expect(events.map((e) => e.type)).toContain("RecentClips");
  });

  it("sorts events by id descending (newest first)", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    // Should be sorted newest first
    for (let i = 1; i < events.length; i++) {
      expect(events[i - 1].id >= events[i].id).toBe(true);
    }
  });

  it("skips empty folders and non-timestamp folders", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const ids = events.map((e) => e.id);
    expect(ids).not.toContain("2025-01-01_00-00-00");
    expect(ids).not.toContain(".DS_Store");
  });

  it("parses event.json metadata correctly", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.city).toBe("San Francisco");
    expect(saved.lat).toBeCloseTo(37.7749);
    expect(saved.lon).toBeCloseTo(-122.4194);
    expect(saved.reason).toBe("user_interaction_dashcam_icon_tapped");
    expect(saved.timestamp).toBe("2025-06-01T18:17:49");
  });

  it("detects thumbnails", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const saved = events.find((e) => e.type === "SavedClips")!;
    const sentry = events.find((e) => e.type === "SentryClips")!;
    expect(saved.hasThumbnail).toBe(true);
    expect(sentry.hasThumbnail).toBe(false);
  });

  it("groups clips by timestamp and sorts cameras canonically", async () => {
    const events = await scanTeslacamFolder(tmpDir);
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
    const events = await scanTeslacamFolder(tmpDir);
    const saved = events.find((e) => e.type === "SavedClips")!;
    // Segments are 60s apart
    expect(saved.clips[0].durationSec).toBe(60);
    expect(saved.clips[1].durationSec).toBe(60);
    // Last segment defaults to 60s (no next timestamp)
    expect(saved.clips[2].durationSec).toBe(60);
  });

  it("computes total duration as sum of clip durations", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const saved = events.find((e) => e.type === "SavedClips")!;
    expect(saved.totalDurationSec).toBe(180);
  });

  it("handles 6-camera events", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const sentry = events.find((e) => e.type === "SentryClips")!;
    expect(sentry.clips).toHaveLength(1);
    expect(sentry.clips[0].cameras).toHaveLength(6);
    // Single segment defaults to 60s
    expect(sentry.clips[0].durationSec).toBe(60);
  });

  it("handles missing teslacam folder gracefully", async () => {
    const events = await scanTeslacamFolder("/nonexistent/path");
    expect(events).toEqual([]);
  });
});

describe("RecentClips scanning", () => {
  it("groups flat files into driving sessions by timestamp gaps", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const recent = events.filter((e) => e.type === "RecentClips");
    // Should have 3 sessions: session1 (3 clips), session2 (2 clips), subfolder (1 clip)
    expect(recent).toHaveLength(3);
  });

  it("splits sessions at gaps > 2 minutes", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const recent = events.filter((e) => e.type === "RecentClips");
    const session1 = recent.find((e) => e.id === "2026-02-01_10-00-00");
    const session2 = recent.find((e) => e.id === "2026-02-01_10-12-00");
    expect(session1).toBeDefined();
    expect(session2).toBeDefined();
    expect(session1!.clips).toHaveLength(3);
    expect(session2!.clips).toHaveLength(2);
  });

  it("tracks subfolder for date-organized files", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const subfolderEvent = events.find((e) => e.id === "2026-01-15_08-00-00");
    expect(subfolderEvent).toBeDefined();
    expect(subfolderEvent!.clips[0].subfolder).toBe("2026-01-15");
  });

  it("has no subfolder for flat files", async () => {
    const events = await scanTeslacamFolder(tmpDir);
    const flatEvent = events.find((e) => e.id === "2026-02-01_10-00-00");
    expect(flatEvent).toBeDefined();
    expect(flatEvent!.clips[0].subfolder).toBeUndefined();
  });
});

describe("getVideoPath", () => {
  it("constructs correct path for SavedClips", () => {
    const p = getVideoPath(
      "/data/teslacam",
      "SavedClips",
      "2025-06-01_18-17-49",
      "2025-06-01_18-07-09",
      "front"
    );
    expect(p).toBe(
      "/data/teslacam/SavedClips/2025-06-01_18-17-49/2025-06-01_18-07-09-front.mp4"
    );
  });

  it("constructs correct path for RecentClips flat files", () => {
    const p = getVideoPath(
      "/data/teslacam",
      "RecentClips",
      "2026-02-01_10-00-00",
      "2026-02-01_10-00-00",
      "front"
    );
    expect(p).toBe(
      "/data/teslacam/RecentClips/2026-02-01_10-00-00-front.mp4"
    );
  });

  it("constructs correct path for RecentClips with subfolder", () => {
    const p = getVideoPath(
      "/data/teslacam",
      "RecentClips",
      "2026-01-15_08-00-00",
      "2026-01-15_08-00-00",
      "front",
      "2026-01-15"
    );
    expect(p).toBe(
      "/data/teslacam/RecentClips/2026-01-15/2026-01-15_08-00-00-front.mp4"
    );
  });
});

describe("getThumbnailPath", () => {
  it("constructs correct path", () => {
    const p = getThumbnailPath(
      "/data/teslacam",
      "SavedClips",
      "2025-06-01_18-17-49"
    );
    expect(p).toBe(
      "/data/teslacam/SavedClips/2025-06-01_18-17-49/thumb.png"
    );
  });
});
