import { google, type drive_v3 } from "googleapis";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import type { StorageBackend } from "./storage.js";

export const DOWNLOAD_CACHE_DIR = "/tmp/teslacam-replay-gdrive";
const DIR_CACHE_PATH = "./data/google-drive-dircache.json";

/**
 * Google Drive storage backend.
 * Paths are relative (e.g. "SavedClips/2025-06-01_18-17-49/event.json")
 * and resolved by walking the folder hierarchy from the root folder ID.
 */
export class GoogleDriveStorage implements StorageBackend {
  private drive: drive_v3.Drive;
  private rootFolderId: string;

  // Cache: folder path -> Map<entry name, { id, mimeType }>
  private dirCache = new Map<string, Map<string, { id: string; mimeType: string }>>();
  // Deduplicate in-flight listFolder requests (avoids redundant API calls from parallel batches)
  private pendingListFolder = new Map<string, Promise<Map<string, { id: string; mimeType: string }>>>();
  // Deduplicate in-flight file downloads (avoids redundant downloads from parallel requests)
  private pendingDownloads = new Map<string, Promise<string>>();

  private dirCacheDirty = false;
  private savePending = false;

  private constructor(drive: drive_v3.Drive, rootFolderId: string) {
    this.drive = drive;
    this.rootFolderId = rootFolderId;
  }

  /**
   * Create from an existing authenticated Drive client and folder ID.
   * Loads persisted directory cache from disk if available.
   */
  static async fromDriveClient(drive: drive_v3.Drive, rootFolderId: string): Promise<GoogleDriveStorage> {
    const instance = new GoogleDriveStorage(drive, rootFolderId);
    await instance.loadDirCache();
    return instance;
  }

  private async loadDirCache(): Promise<void> {
    try {
      const raw = await readFile(DIR_CACHE_PATH, "utf-8");
      const entries: [string, [string, { id: string; mimeType: string }][]][] = JSON.parse(raw);
      for (const [path, items] of entries) {
        this.dirCache.set(path, new Map(items));
      }
      console.log(`Loaded ${this.dirCache.size} dir cache entries from disk`);
    } catch {
      // No cache file or invalid — start fresh
    }
  }

  private scheduleSaveDirCache(): void {
    this.dirCacheDirty = true;
    if (this.savePending) return;
    this.savePending = true;
    // Debounce: save once after current batch of API calls settles
    setTimeout(async () => {
      this.savePending = false;
      if (!this.dirCacheDirty) return;
      this.dirCacheDirty = false;
      try {
        const data = Array.from(this.dirCache.entries()).map(
          ([p, m]) => [p, Array.from(m.entries())] as const
        );
        await mkdir(path.dirname(DIR_CACHE_PATH), { recursive: true });
        await writeFile(DIR_CACHE_PATH, JSON.stringify(data));
      } catch (err) {
        console.error("Failed to save dir cache:", err);
      }
    }, 2000);
  }

  /**
   * List all entries in a Drive folder, with caching.
   * Returns a Map<name, { id, mimeType }>.
   */
  private async listFolder(folderId: string, cachePath: string): Promise<Map<string, { id: string; mimeType: string }>> {
    const cached = this.dirCache.get(cachePath);
    if (cached) return cached;

    // Deduplicate: if a request for the same path is already in-flight, wait for it
    const pending = this.pendingListFolder.get(cachePath);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const entries = new Map<string, { id: string; mimeType: string }>();
        let pageToken: string | undefined;

        do {
          const res = await this.drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: "nextPageToken, files(id, name, mimeType)",
            pageSize: 1000,
            pageToken,
          });

          for (const file of res.data.files || []) {
            if (file.name && file.id && file.mimeType) {
              entries.set(file.name, { id: file.id, mimeType: file.mimeType });
            }
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);

        this.dirCache.set(cachePath, entries);
        this.scheduleSaveDirCache();
        return entries;
      } finally {
        this.pendingListFolder.delete(cachePath);
      }
    })();

    this.pendingListFolder.set(cachePath, promise);
    return promise;
  }

  /**
   * Resolve a relative path to a Google Drive file ID.
   * Walks the folder hierarchy from root.
   */
  private async resolve(relativePath: string): Promise<{ id: string; mimeType: string } | null> {
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) {
      return { id: this.rootFolderId, mimeType: "application/vnd.google-apps.folder" };
    }

    let currentFolderId = this.rootFolderId;
    let currentPath = "";

    for (let i = 0; i < parts.length; i++) {
      const entries = await this.listFolder(currentFolderId, currentPath);
      const entry = entries.get(parts[i]);
      if (!entry) return null;

      if (i < parts.length - 1) {
        // Intermediate segment must be a folder
        if (entry.mimeType !== "application/vnd.google-apps.folder") return null;
        currentFolderId = entry.id;
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      } else {
        return entry;
      }
    }

    return null;
  }

  async readdir(dirPath: string): Promise<string[]> {
    const resolved = dirPath
      ? await this.resolve(dirPath)
      : { id: this.rootFolderId, mimeType: "application/vnd.google-apps.folder" };
    if (!resolved || resolved.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    const entries = await this.listFolder(resolved.id, dirPath);
    return Array.from(entries.keys());
  }

  async readFile(filePath: string): Promise<Buffer> {
    const resolved = await this.resolve(filePath);
    if (!resolved) throw new Error(`File not found: ${filePath}`);

    const res = await this.drive.files.get(
      { fileId: resolved.id, alt: "media" },
      { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data as ArrayBuffer);
  }

  async readFileUtf8(filePath: string): Promise<string> {
    const buf = await this.readFile(filePath);
    return buf.toString("utf-8");
  }

  async exists(filePath: string): Promise<boolean> {
    const resolved = await this.resolve(filePath);
    return resolved !== null;
  }

  /** Resolve a cache path and ensure it stays within the cache directory. */
  private safeCachePath(filePath: string): string {
    const resolvedCache = path.resolve(DOWNLOAD_CACHE_DIR);
    const localPath = path.resolve(DOWNLOAD_CACHE_DIR, filePath);
    if (!localPath.startsWith(resolvedCache + path.sep)) {
      throw new Error(`Path traversal attempt in cache: ${filePath}`);
    }
    return localPath;
  }

  async getLocalPath(filePath: string): Promise<string> {
    const localPath = this.safeCachePath(filePath);

    // Check if already cached on disk
    try {
      await stat(localPath);
      return localPath;
    } catch {
      // Not cached, download it
    }

    // Deduplicate: if a download for the same file is already in-flight, wait for it
    const pending = this.pendingDownloads.get(filePath);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const resolved = await this.resolve(filePath);
        if (!resolved) throw new Error(`File not found: ${filePath}`);

        await mkdir(path.dirname(localPath), { recursive: true });

        const res = await this.drive.files.get(
          { fileId: resolved.id, alt: "media" },
          { responseType: "arraybuffer" }
        );
        await writeFile(localPath, Buffer.from(res.data as ArrayBuffer));

        return localPath;
      } finally {
        this.pendingDownloads.delete(filePath);
      }
    })();

    this.pendingDownloads.set(filePath, promise);
    return promise;
  }

  async createReadStream(filePath: string): Promise<NodeJS.ReadableStream> {
    // Download to local cache first, then stream from there
    const localPath = await this.getLocalPath(filePath);
    return createReadStream(localPath);
  }

  async fileSize(filePath: string): Promise<number> {
    const resolved = await this.resolve(filePath);
    if (!resolved) throw new Error(`File not found: ${filePath}`);

    const res = await this.drive.files.get({
      fileId: resolved.id,
      fields: "size",
    });
    return parseInt(res.data.size || "0", 10);
  }

  async getStreamUrl(filePath: string): Promise<{ url: string; headers: Record<string, string> } | null> {
    const resolved = await this.resolve(filePath);
    if (!resolved) return null;

    // Get a fresh access token (auto-refreshes if expired)
    const auth = this.drive.context._options.auth as { getAccessToken(): Promise<{ token?: string | null }> };
    const { token } = await auth.getAccessToken();
    if (!token) return null;

    return {
      url: `https://www.googleapis.com/drive/v3/files/${resolved.id}?alt=media`,
      headers: { Authorization: `Bearer ${token}` },
    };
  }

  /** Clear top-level dir listings so new folders are discovered on refresh.
   *  Keeps per-event subfolder caches to avoid re-fetching hundreds of listings.
   *  Also clears the most recent RecentClips date folder (may have new clips). */
  clearCache(): void {
    let latestRecent = "";
    for (const key of this.dirCache.keys()) {
      if (!key.includes("/")) {
        this.dirCache.delete(key);
      } else if (key.startsWith("RecentClips/") && key > latestRecent) {
        latestRecent = key;
      }
    }
    if (latestRecent) this.dirCache.delete(latestRecent);
    this.pendingListFolder.clear();
    this.scheduleSaveDirCache();
  }

  /** Clear all cached directory listings. Used by debug panel. */
  clearAllCaches(): void {
    this.dirCache.clear();
    this.pendingListFolder.clear();
    this.scheduleSaveDirCache();
  }

  cacheEntryCount(): number {
    return this.dirCache.size;
  }
}
