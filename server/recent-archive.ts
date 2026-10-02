import { HTTPException } from "hono/http-exception";
import {
  DriveNotFoundError,
  type DriveEntry,
  type DriveFileSource,
  type GDriveLiteClient,
} from "./gdrive-lite.js";
import { scanRecentClipsPage, type DashcamEvent } from "./scan.js";

const RECENT_ROOT_PATTERN = /^RecentClips(?:-before-\d{4}-\d{2}-\d{2})?$/;
const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RECENT_FILE_PAGE_SIZE = 1000;

interface Cursor {
  root: string;
  pageToken?: string;
  date?: { id: string; pageToken?: string };
}

export class RecentArchive {
  private readonly roots: DriveEntry[];

  constructor(private readonly drive: GDriveLiteClient, rootEntries: DriveEntry[]) {
    this.roots = rootEntries
      .filter((entry) => drive.isFolder(entry) && RECENT_ROOT_PATTERN.test(entry.name))
      .sort((a, b) => {
        if (a.name === b.name) return 0;
        if (a.name === "RecentClips") return -1;
        if (b.name === "RecentClips") return 1;
        return b.name.localeCompare(a.name);
      });
  }

  async page(pageToken: string | undefined): Promise<{
    events: DashcamEvent[];
    nextPageToken?: string;
  }> {
    if (this.roots.length === 0) throw new Error("No RecentClips archive folders found");
    const cursor = pageToken ? this.decodeCursor(pageToken) : { root: this.roots[0].id };
    const rootIndex = this.roots.findIndex((root) => root.id === cursor.root);
    if (rootIndex < 0) throw invalidCursor();
    const root = this.roots[rootIndex];
    const page = await this.drive.listFolderPage(this.drive.folderRef(root), {
      pageToken: cursor.pageToken,
      pageSize: RECENT_FILE_PAGE_SIZE,
      limit: RECENT_FILE_PAGE_SIZE,
      orderBy: "name desc",
    });
    const dates = page.files.filter((entry) =>
      this.drive.isFolder(entry) && DATE_FOLDER_PATTERN.test(entry.name)
    );
    let afterRootPage: Cursor | undefined;
    const nextRoot = this.roots[rootIndex + 1];
    if (page.nextPageToken) afterRootPage = { root: root.id, pageToken: page.nextPageToken };
    else if (nextRoot) afterRootPage = { root: nextRoot.id };

    if (!cursor.date) {
      const files = page.files.filter((entry) => !this.drive.isFolder(entry));
      const events = await scanRecentClipsPage(this.drive, files);
      if (events.length || !dates.length) {
        const next = dates.length ? { ...cursor, date: { id: dates[0].id } } : afterRootPage;
        return this.result(events, next);
      }
      cursor.date = { id: dates[0].id };
    }

    // A date listing is paged independently so one request never scans the full archive.
    const dateIndex = dates.findIndex((entry) => entry.id === cursor.date!.id);
    if (dateIndex < 0) throw invalidCursor();
    const date = dates[dateIndex];
    const clips = await this.drive.listFolderPage(this.drive.folderRef(date), {
      type: "files",
      pageToken: cursor.date.pageToken,
      pageSize: RECENT_FILE_PAGE_SIZE,
      limit: RECENT_FILE_PAGE_SIZE,
      orderBy: "name desc",
    });
    const events = await scanRecentClipsPage(this.drive, clips.files);
    for (const event of events) {
      for (const clip of event.clips) clip.subfolder = date.name;
    }
    const nextDate = dates[dateIndex + 1];
    let next = afterRootPage;
    if (clips.nextPageToken) {
      next = { ...cursor, date: { id: date.id, pageToken: clips.nextPageToken } };
    } else if (nextDate) {
      next = { ...cursor, date: { id: nextDate.id } };
    }
    return this.result(events, next);
  }

  async findEvent(id: string): Promise<DashcamEvent | null> {
    for (const root of this.roots) {
      const date = await this.findPath(`/${root.name}/${id.slice(0, 10)}`, "folder");
      if (!date) continue;
      const files = (await this.drive.listFolder(this.drive.folderRef(date))).files;
      const events = await scanRecentClipsPage(this.drive, files);
      const event = events.find((entry) => entry.clips.some((clip) => clip.timestamp === id));
      if (event) {
        for (const clip of event.clips) clip.subfolder = date.name;
        return event;
      }
    }
    return null;
  }

  async findClipSource(segment: string, camera: string): Promise<DriveFileSource | null> {
    for (const root of this.roots) {
      for (const directory of [root.name, `${root.name}/${segment.slice(0, 10)}`]) {
        const file = await this.findPath(`/${directory}/${segment}-${camera}.mp4`, "file");
        if (file) return this.drive.fileSource(file);
      }
    }
    return null;
  }

  private async findPath(path: string, type: "folder" | "file"): Promise<DriveEntry | null> {
    try {
      return await this.drive.resolvePath(path, type);
    } catch (error) {
      if (error instanceof DriveNotFoundError) return null;
      throw error;
    }
  }

  private result(events: DashcamEvent[], next: Cursor | undefined) {
    return {
      events: events.sort((a, b) => b.id.localeCompare(a.id)),
      nextPageToken: next ? Buffer.from(JSON.stringify(next)).toString("base64url") : undefined,
    };
  }

  private decodeCursor(token: string): Cursor {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(token, "base64url").toString());
    } catch {
      throw invalidCursor();
    }
    if (!value || typeof value !== "object" || !("root" in value) || typeof value.root !== "string") {
      throw invalidCursor();
    }
    if ("pageToken" in value && typeof value.pageToken !== "string") throw invalidCursor();
    if ("date" in value) {
      const date = value.date;
      if (!date || typeof date !== "object" || !("id" in date) || typeof date.id !== "string") {
        throw invalidCursor();
      }
      if ("pageToken" in date && typeof date.pageToken !== "string") throw invalidCursor();
    }
    return value as Cursor;
  }
}

function invalidCursor(): HTTPException {
  return new HTTPException(400, { message: "Invalid RecentClips page token; refresh the event list" });
}
