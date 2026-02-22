import { google, type drive_v3 } from "googleapis";
import { mkdir, stat, writeFile, readFile } from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import type { StorageBackend } from "./storage.js";

export const DOWNLOAD_CACHE_DIR = "/tmp/teslacam-replay-gdrive";

interface OAuthCredentials {
  client_id: string;
  client_secret: string;
  root_folder_id: string;
  token: string; // JSON string containing access_token, refresh_token, expiry
}

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

  private constructor(drive: drive_v3.Drive, rootFolderId: string) {
    this.drive = drive;
    this.rootFolderId = rootFolderId;
  }

  /**
   * Create a GoogleDriveStorage from a credentials JSON file.
   * Supports two formats:
   * - OAuth credentials (with client_id, client_secret, token containing refresh_token)
   * - Service account key file (with type: "service_account")
   */
  static async fromCredentialsFile(credentialsFile: string): Promise<GoogleDriveStorage> {
    const raw = await readFile(credentialsFile, "utf-8");
    const creds = JSON.parse(raw);

    if (creds.type === "service_account") {
      // Service account JSON key
      const auth = new google.auth.GoogleAuth({
        keyFile: credentialsFile,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
      const drive = google.drive({ version: "v3", auth });
      const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || creds.root_folder_id;
      if (!folderId) {
        throw new Error("GOOGLE_DRIVE_FOLDER_ID is required for service account auth");
      }
      return new GoogleDriveStorage(drive, folderId);
    }

    if (creds.type === "drive" || (creds.client_id && creds.token)) {
      // OAuth credentials (e.g. rclone-style)
      const oauthCreds = creds as OAuthCredentials;
      const tokenData = JSON.parse(oauthCreds.token);

      const oauth2Client = new google.auth.OAuth2(
        oauthCreds.client_id,
        oauthCreds.client_secret
      );
      oauth2Client.setCredentials({
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        token_type: tokenData.token_type || "Bearer",
      });

      const drive = google.drive({ version: "v3", auth: oauth2Client });
      const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || oauthCreds.root_folder_id;
      if (!folderId) {
        throw new Error("GOOGLE_DRIVE_FOLDER_ID or root_folder_id in credentials is required");
      }
      return new GoogleDriveStorage(drive, folderId);
    }

    throw new Error(
      "Unrecognized credentials format. Expected service account key or OAuth credentials."
    );
  }

  /**
   * Create from an existing Drive client (used for testing).
   */
  static fromDriveClient(drive: drive_v3.Drive, rootFolderId: string): GoogleDriveStorage {
    return new GoogleDriveStorage(drive, rootFolderId);
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

    // Check if already cached
    try {
      await stat(localPath);
      return localPath;
    } catch {
      // Not cached, download it
    }

    const resolved = await this.resolve(filePath);
    if (!resolved) throw new Error(`File not found: ${filePath}`);

    // Ensure parent directory exists
    await mkdir(path.dirname(localPath), { recursive: true });

    // Download the file
    const res = await this.drive.files.get(
      { fileId: resolved.id, alt: "media" },
      { responseType: "arraybuffer" }
    );
    await writeFile(localPath, Buffer.from(res.data as ArrayBuffer));

    return localPath;
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

  /** Clear the directory listing cache. Called on refresh. */
  clearCache(): void {
    this.dirCache.clear();
    this.pendingListFolder.clear();
  }

  cacheEntryCount(): number {
    return this.dirCache.size;
  }
}
