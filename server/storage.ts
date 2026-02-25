import { readdir, readFile, stat } from "fs/promises";
import path from "path";

export interface StorageBackend {
  /** List entries in a directory (relative to storage root). Returns file/folder names. */
  readdir(dirPath: string): Promise<string[]>;

  /** Read a file as a Buffer (relative to storage root). */
  readFile(filePath: string): Promise<Buffer>;

  /** Read a file as UTF-8 string (relative to storage root). */
  readFileUtf8(filePath: string): Promise<string>;

  /** Check if a path exists (relative to storage root). */
  exists(filePath: string): Promise<boolean>;

  /**
   * Get a local filesystem path for a file.
   * For local storage, this is the actual path.
   * For remote storage, this downloads the file to a temp cache and returns that path.
   * Used by ffmpeg (HLS segmentation) and telemetry extraction which need local files.
   */
  getLocalPath(filePath: string): Promise<string>;

  /**
   * Create a ReadableStream for a file (relative to storage root).
   * Used for serving thumbnails and other binary files.
   */
  createReadStream(filePath: string): Promise<NodeJS.ReadableStream>;

  /**
   * Get the size of a file in bytes (relative to storage root).
   */
  fileSize(filePath: string): Promise<number>;

  /**
   * Get a direct stream URL for tools like ffmpeg that can fetch over HTTP.
   * Returns { url, headers } for remote backends, or null for local storage.
   * This allows ffmpeg to stream with Range requests instead of downloading the full file.
   */
  getStreamUrl?(filePath: string): Promise<{ url: string; headers: Record<string, string> } | null>;

  /** Incrementally refresh caches by querying only for new entries. No-op for backends without caching. */
  refreshCache?(): Promise<void>;

  /** Return number of entries in any in-memory caches. 0 if none. */
  cacheEntryCount(): number;
}

/**
 * Local filesystem storage backend.
 * All paths are relative to the rootPath.
 */
export class LocalStorage implements StorageBackend {
  private resolvedRoot: string;

  constructor(private rootPath: string) {
    this.resolvedRoot = path.resolve(rootPath);
  }

  /** Resolve a relative path and ensure it stays within rootPath. */
  private safePath(relativePath: string): string {
    const fullPath = path.resolve(this.resolvedRoot, relativePath);
    if (!fullPath.startsWith(this.resolvedRoot + path.sep) && fullPath !== this.resolvedRoot) {
      throw new Error(`Path traversal attempt: ${relativePath}`);
    }
    return fullPath;
  }

  async readdir(dirPath: string): Promise<string[]> {
    return readdir(this.safePath(dirPath));
  }

  async readFile(filePath: string): Promise<Buffer> {
    return readFile(this.safePath(filePath));
  }

  async readFileUtf8(filePath: string): Promise<string> {
    return readFile(this.safePath(filePath), "utf-8");
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await stat(this.safePath(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async getLocalPath(filePath: string): Promise<string> {
    return this.safePath(filePath);
  }

  async createReadStream(filePath: string): Promise<NodeJS.ReadableStream> {
    const { createReadStream: fsCreateReadStream } = await import("fs");
    return fsCreateReadStream(this.safePath(filePath));
  }

  async fileSize(filePath: string): Promise<number> {
    const s = await stat(this.safePath(filePath));
    return s.size;
  }

  cacheEntryCount(): number {
    return 0;
  }
}
