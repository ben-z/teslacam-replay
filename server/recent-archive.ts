import { HTTPException } from "hono/http-exception";
import {
  DriveNotFoundError,
  type DriveEntry,
  type DriveFileSource,
  type GDriveLiteClient,
} from "./gdrive-lite.js";
import { scanRecentClips, type DashcamEvent } from "./scan.js";
import { recordingWallTimeMs } from "../src/playback.js";
import { ALL_CAMERAS } from "../src/types.js";

const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CLIP_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})-(.+)\.mp4$/;

export class RecentArchive {
  constructor(private readonly drive: GDriveLiteClient) {}

  async page(pageToken: string | undefined): Promise<{
    events: DashcamEvent[];
    nextPageToken?: string;
    nextPageDate: string | null;
  }> {
    const requestedDate = pageToken ? parseDateCursor(pageToken) : undefined;
    const root = await this.drive.resolvePath("/RecentClips", "folder");
    const entries = (await this.drive.listFolder(this.drive.folderRef(root))).files;
    const dates: DriveEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (this.drive.isFolder(entry) && entry.name === "metadata") continue;
      if (!this.drive.isFolder(entry) || !DATE_FOLDER_PATTERN.test(entry.name)) {
        throw new Error(`Unsupported RecentClips entry: ${entry.name}; expected YYYY-MM-DD folders`);
      }
      recordingWallTimeMs(`${entry.name}_00-00-00`);
      if (seen.has(entry.name)) throw new Error(`Duplicate RecentClips date folder: ${entry.name}`);
      seen.add(entry.name);
      dates.push(entry);
    }
    dates.sort((a, b) => b.name.localeCompare(a.name));
    const index = requestedDate === undefined ? 0 : dates.findIndex((date) => date.name === requestedDate);
    if (index < 0) throw invalidCursor();
    if (!dates.length) return { events: [], nextPageDate: null };
    const date = dates[index];
    // A calendar day is the user-visible page; Drive pagination stays inside listFolder.
    const events = await this.readDay(date);
    const nextDate = dates[index + 1]?.name;
    return {
      events: events.sort((a, b) => b.id.localeCompare(a.id)),
      nextPageToken: nextDate,
      // Keep the common Timeline range on the day just loaded until the next day arrives.
      nextPageDate: nextDate ? date.name : null,
    };
  }

  async findEvent(id: string): Promise<DashcamEvent | null> {
    const date = await this.findPath(`/RecentClips/${id.slice(0, 10)}`, "folder");
    if (!date) return null;
    const events = await this.readDay(date);
    return events.find((event) => event.clips.some((clip) => clip.timestamp === id)) ?? null;
  }

  async findClipSource(segment: string, camera: string): Promise<DriveFileSource | null> {
    const file = await this.findPath(`/RecentClips/${segment.slice(0, 10)}/${segment}-${camera}.mp4`, "file");
    if (!file) return null;
    this.validateFile(file, segment.slice(0, 10));
    return this.drive.fileSource(file);
  }

  private async readDay(date: DriveEntry): Promise<DashcamEvent[]> {
    const files = (await this.drive.listFolder(this.drive.folderRef(date))).files;
    for (const file of files) this.validateFile(file, date.name);
    return scanRecentClips(this.drive, files);
  }

  private validateFile(file: DriveEntry, date: string): void {
    const match = file.name.match(CLIP_FILE_PATTERN);
    if (this.drive.isFolder(file) || !match) {
      throw new Error(`Unsupported RecentClips file: ${date}/${file.name}`);
    }
    recordingWallTimeMs(match[1]);
    if (match[1].slice(0, 10) !== date) {
      throw new Error(`RecentClips file is in the wrong date folder: ${date}/${file.name}`);
    }
    if (!ALL_CAMERAS.some((camera) => camera === match[2])) {
      throw new Error(`Unsupported RecentClips camera: ${date}/${file.name}`);
    }
    if (!file.size || !/^[1-9]\d*$/.test(file.size)) {
      throw new Error(`RecentClips recording has no valid video size: ${date}/${file.name}`);
    }
  }

  private async findPath(path: string, type: "folder" | "file"): Promise<DriveEntry | null> {
    try {
      return await this.drive.resolvePath(path, type);
    } catch (error) {
      if (error instanceof DriveNotFoundError) return null;
      throw error;
    }
  }
}

function parseDateCursor(token: string): string {
  if (!DATE_FOLDER_PATTERN.test(token)) throw invalidCursor();
  try {
    recordingWallTimeMs(`${token}_00-00-00`);
  } catch {
    throw invalidCursor();
  }
  return token;
}

function invalidCursor(): HTTPException {
  return new HTTPException(400, { message: "Invalid RecentClips page token; refresh the event list" });
}
