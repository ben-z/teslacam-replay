import { google, type drive_v3 } from "googleapis";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import type { StorageBackend } from "./storage.js";
import { DOWNLOAD_CACHE_DIR, DIR_CACHE_PATH } from "./paths.js";

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
  // folder path -> Drive folder ID (needed for incremental queries)
  private dirCacheFolderIds = new Map<string, string>();
  // folder path -> latest createdTime seen from Drive API (high water mark for incremental refresh)
  private dirCacheHighWater = new Map<string, string>();
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
      const data = JSON.parse(raw);
      // Support both old format (array of entries) and new format (object with folderIds/highWater)
      const entries: [string, [string, { id: string; mimeType: string }][]][] =
        Array.isArray(data) ? data : data.entries ?? [];
      for (const [p, items] of entries) {
        this.dirCache.set(p, new Map(items));
      }
      if (!Array.isArray(data)) {
        for (const [p, id] of data.folderIds ?? []) this.dirCacheFolderIds.set(p, id);
        for (const [p, ts] of data.highWater ?? []) this.dirCacheHighWater.set(p, ts);
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
        const data = {
          entries: Array.from(this.dirCache.entries()).map(
            ([p, m]) => [p, Array.from(m.entries())] as const
          ),
          folderIds: Array.from(this.dirCacheFolderIds.entries()),
          highWater: Array.from(this.dirCacheHighWater.entries()),
        };
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
        let maxCreatedTime = "";

        do {
          const res = await this.drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: "nextPageToken, files(id, name, mimeType, createdTime)",
            pageSize: 1000,
            pageToken,
          });

          for (const file of res.data.files || []) {
            if (file.name && file.id && file.mimeType) {
              entries.set(file.name, { id: file.id, mimeType: file.mimeType });
              if (file.createdTime && file.createdTime > maxCreatedTime) {
                maxCreatedTime = file.createdTime;
              }
            }
          }
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);

        this.dirCache.set(cachePath, entries);
        this.dirCacheFolderIds.set(cachePath, folderId);
        if (maxCreatedTime) this.dirCacheHighWater.set(cachePath, maxCreatedTime);
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

  /** Incrementally refresh top-level dir listings by querying only for entries
   *  created after the last known createdTime. Typically 3 fast API calls
   *  (SavedClips, SentryClips, RecentClips -- root is skipped since it never changes). */
  async refreshCache(): Promise<void> {
    let found = 0;
    for (const [cachePath, folderId] of this.dirCacheFolderIds) {
      // Only refresh category-level listings (SavedClips, SentryClips, RecentClips).
      // Skip root ("") since it only contains the 3 static category folders,
      // and skip deeper paths (contain "/") since they're per-event and immutable.
      if (cachePath === "" || cachePath.includes("/")) continue;
      const since = this.dirCacheHighWater.get(cachePath);
      if (!since) continue; // no high water mark — needs a full listing first
      const existing = this.dirCache.get(cachePath);
      if (!existing) continue;

      let pageToken: string | undefined;
      let maxCreatedTime = since;

      do {
        const res = await this.drive.files.list({
          q: `'${folderId}' in parents and trashed = false and createdTime > '${since}'`,
          fields: "nextPageToken, files(id, name, mimeType, createdTime)",
          pageSize: 1000,
          pageToken,
        });

        for (const file of res.data.files || []) {
          if (file.name && file.id && file.mimeType) {
            existing.set(file.name, { id: file.id, mimeType: file.mimeType });
            found++;
            if (file.createdTime && file.createdTime > maxCreatedTime) {
              maxCreatedTime = file.createdTime;
            }
          }
        }
        pageToken = res.data.nextPageToken ?? undefined;
      } while (pageToken);

      if (maxCreatedTime > since) {
        this.dirCacheHighWater.set(cachePath, maxCreatedTime);
      }
    }
    if (found > 0) this.scheduleSaveDirCache();
  }

  /** Clear all cached directory listings. Used by debug panel. */
  clearAllCaches(): void {
    this.dirCache.clear();
    this.dirCacheFolderIds.clear();
    this.dirCacheHighWater.clear();
    this.pendingListFolder.clear();
    this.scheduleSaveDirCache();
  }

  cacheEntryCount(): number {
    return this.dirCache.size;
  }
}
