const DEFAULT_BASE_URL = "http://127.0.0.1:8765/gdrive";
const PAGE_SIZE = 1000;
const DEFAULT_LIST_TIMEOUT_MS = 120_000;
const DEFAULT_METADATA_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 300_000;

export interface DriveShortcutDetails {
  targetId?: string;
  targetMimeType?: string;
  targetResourceKey?: string;
}

export interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  resourceKey?: string;
  shortcutDetails?: DriveShortcutDetails;
  url?: string;
}

export interface DriveFolderRef {
  id: string;
  resourceKey?: string;
}

export interface DriveList {
  folderId: string;
  resourceKey?: string;
  files: DriveEntry[];
  nextPageToken?: string;
  next?: string;
  count?: number;
  incompleteSearch?: boolean;
}

export interface DriveFileSource {
  id: string;
  name: string;
  url: string;
  mimeType?: string;
  sizeBytes?: number;
  modifiedTime?: string;
  resourceKey?: string;
}

interface ListResponse {
  folderId: string;
  resourceKey?: string;
  count?: number;
  files?: DriveEntry[];
  nextPageToken?: string;
  next?: string;
  incompleteSearch?: boolean;
}

interface ResolveResponse {
  file: DriveEntry;
}

export interface DriveListPageOptions {
  pageToken?: string;
  pageSize?: number;
  limit?: number;
  type?: "all" | "files" | "folders" | "dirs";
  orderBy?: string;
}

export function createGDriveLiteFromEnv(): GDriveLiteClient {
  return new GDriveLiteClient({
    baseUrl: process.env.GDRIVE_BASE_URL || DEFAULT_BASE_URL,
    username: process.env.GDRIVE_USER,
    password: process.env.GDRIVE_PASS,
  });
}

export class GDriveLiteClient {
  readonly baseUrl: string;
  private readonly authHeader: string | null;
  private readonly listTimeoutMs: number;
  private readonly metadataTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly pendingLists = new Map<string, Promise<DriveList>>();

  constructor(opts: { baseUrl: string; username?: string; password?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.listTimeoutMs = positiveInt(process.env.GDRIVE_LIST_TIMEOUT_MS, DEFAULT_LIST_TIMEOUT_MS);
    this.metadataTimeoutMs = positiveInt(process.env.GDRIVE_METADATA_TIMEOUT_MS, DEFAULT_METADATA_TIMEOUT_MS);
    this.readTimeoutMs = positiveInt(process.env.GDRIVE_READ_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS);
    if ((opts.username && !opts.password) || (!opts.username && opts.password)) {
      throw new Error("GDRIVE_USER and GDRIVE_PASS must be set together");
    }
    this.authHeader = opts.username
      ? `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`
      : null;
  }

  streamSource(source: DriveFileSource): { url: string; headers: Record<string, string> } {
    return {
      url: source.url,
      headers: this.authHeaders(),
    };
  }

  authHeaders(): Record<string, string> {
    return this.authHeader ? { Authorization: this.authHeader } : {};
  }

  async healthCheck(): Promise<void> {
    const res = await fetch(this.url("/healthz"), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`gdrive-serve-lite health check failed: ${res.status}`);
    }
  }

  async listRoot(): Promise<DriveList> {
    return this.listAll({});
  }

  async listRootPage(opts: DriveListPageOptions = {}): Promise<DriveList> {
    return this.listPage({}, opts);
  }

  async listFolder(folder: DriveFolderRef): Promise<DriveList> {
    return this.listAll(folder);
  }

  async listFolderPage(folder: DriveFolderRef, opts: DriveListPageOptions = {}): Promise<DriveList> {
    return this.listPage(folder, opts);
  }

  async resolvePath(path: string, type: "folder" | "file" | "any" = "folder"): Promise<DriveEntry> {
    const params = new URLSearchParams({ path, type });
    const res = await fetch(this.url(`/api/resolve?${params.toString()}`), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.metadataTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Failed to resolve Drive path ${path}: ${res.status}`);
    }
    const data = await res.json() as ResolveResponse;
    return withAbsoluteUrl(data.file, this.baseUrl);
  }

  async readText(file: DriveEntry): Promise<string> {
    const res = await this.fetchEntry(file);
    if (!res.ok) {
      throw new Error(`Failed to read ${file.name}: ${res.status}`);
    }
    return res.text();
  }

  async fetchSource(source: DriveFileSource): Promise<Response> {
    return fetch(source.url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.readTimeoutMs),
    });
  }

  fileSource(file: DriveEntry): DriveFileSource {
    const { id, resourceKey } = targetIDAndKey(file);
    const sizeBytes = file.size ? Number(file.size) : undefined;
    return {
      id,
      name: file.name,
      url: this.absoluteUrl(file.url || this.filePath(file, id, resourceKey)),
      mimeType: effectiveMimeType(file),
      sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
      modifiedTime: file.modifiedTime,
      resourceKey,
    };
  }

  folderRef(file: DriveEntry): DriveFolderRef {
    return targetIDAndKey(file);
  }

  isFolder(file: DriveEntry): boolean {
    return effectiveMimeType(file) === "application/vnd.google-apps.folder";
  }

  private async fetchEntry(file: DriveEntry): Promise<Response> {
    return fetch(this.fileSource(file).url, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.metadataTimeoutMs),
    });
  }

  private async listAll(folder: Partial<DriveFolderRef>): Promise<DriveList> {
    const cacheKey = `${folder.id ?? ""}\0${folder.resourceKey ?? ""}`;
    const pending = this.pendingLists.get(cacheKey);
    if (pending) return pending;

    const promise = this.listAllUncached(folder).finally(() => {
      this.pendingLists.delete(cacheKey);
    });
    this.pendingLists.set(cacheKey, promise);
    return promise;
  }

  private async listAllUncached(folder: Partial<DriveFolderRef>): Promise<DriveList> {
    const files: DriveEntry[] = [];
    let folderId = folder.id || "";
    let resourceKey = folder.resourceKey || "";
    let pageToken = "";

    do {
      const page = await this.listPage(folder, {
        pageSize: PAGE_SIZE,
        limit: PAGE_SIZE,
        pageToken,
      });
      folderId = page.folderId;
      resourceKey = page.resourceKey || resourceKey;
      files.push(...page.files);
      pageToken = page.nextPageToken || "";
    } while (pageToken);

    return { folderId, resourceKey, files };
  }

  private async listPage(
    folder: Partial<DriveFolderRef>,
    opts: DriveListPageOptions
  ): Promise<DriveList> {
    const pageSize = positiveInt(String(opts.pageSize ?? ""), PAGE_SIZE);
    const limit = positiveInt(String(opts.limit ?? ""), pageSize);
    const params = new URLSearchParams({
      pageSize: String(pageSize),
      limit: String(limit),
      links: "1",
    });
    if (folder.id) params.set("folderId", folder.id);
    if (folder.resourceKey) params.set("resourceKey", folder.resourceKey);
    if (opts.pageToken) params.set("pageToken", opts.pageToken);
    if (opts.type) params.set("type", opts.type);
    if (opts.orderBy) params.set("orderBy", opts.orderBy);

    const res = await fetch(this.url(`/api/list?${params.toString()}`), {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(this.listTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Failed to list Drive folder ${folder.id || "root"}: ${res.status}`);
    }
    const data = await res.json() as ListResponse;
    return {
      folderId: data.folderId,
      resourceKey: data.resourceKey || folder.resourceKey,
      count: data.count,
      next: data.next,
      nextPageToken: data.nextPageToken,
      incompleteSearch: data.incompleteSearch,
      files: (data.files || []).map((entry) => withAbsoluteUrl(entry, this.baseUrl)),
    };
  }

  private filePath(file: DriveEntry, id: string, resourceKey?: string): string {
    const params = new URLSearchParams();
    if (resourceKey) params.set("resourceKey", resourceKey);
    const query = params.toString();
    return `/file/${encodeURIComponent(id)}/${encodeURIComponent(file.name)}${query ? `?${query}` : ""}`;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private absoluteUrl(value: string): string {
    return absoluteUrl(this.baseUrl, value);
  }
}

function effectiveMimeType(file: DriveEntry): string {
  return file.shortcutDetails?.targetMimeType || file.mimeType;
}

function targetIDAndKey(file: DriveEntry): DriveFolderRef {
  if (file.shortcutDetails?.targetId) {
    return {
      id: file.shortcutDetails.targetId,
      resourceKey: file.shortcutDetails.targetResourceKey,
    };
  }
  return { id: file.id, resourceKey: file.resourceKey };
}

function withAbsoluteUrl(file: DriveEntry, baseUrl: string): DriveEntry {
  if (!file.url || /^https?:\/\//i.test(file.url)) return file;
  return { ...file, url: absoluteUrl(baseUrl, file.url) };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function absoluteUrl(baseUrl: string, value: string): string {
  if (/^https?:\/\//i.test(value)) return value;

  const base = new URL(`${baseUrl}/`);
  if (!value.startsWith("/")) {
    return new URL(value, base).toString();
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const basePrefix = basePath.replace(/^\/+/, "");
  const valuePath = value.replace(/^\/+/, "");
  if (!basePrefix || valuePath === basePrefix || valuePath.startsWith(`${basePrefix}/`)) {
    return `${base.origin}/${valuePath}`;
  }
  return `${base.origin}${basePath}/${valuePath}`;
}
