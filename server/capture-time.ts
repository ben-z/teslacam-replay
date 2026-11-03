import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DriveFileSource } from "./gdrive-lite.js";

// Small windows avoid downloading video data while following MP4 box headers.
// The total budget bounds remote IO even for a malformed chain of boxes.
const HEADER_CONFIG = { windowBytes: 4096, maximumReadBytes: 64 * 1024 } as const;
const MP4_EPOCH_MS = Date.UTC(1904, 0, 1);

type ReadRange = (source: DriveFileSource, start: number, end: number) => Promise<Buffer>;

export class CaptureTimeReader {
  private readonly pending = new Map<string, Promise<number>>();

  constructor(private readonly readRange: ReadRange, private readonly cacheDirectory: string) {}

  async read(source: DriveFileSource): Promise<number> {
    if (!source.id || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes! < 8) {
      throw new Error(`Cannot read capture time for ${source.name}: missing valid source ID or size`);
    }
    if (!source.modifiedTime || !Number.isFinite(Date.parse(source.modifiedTime))) {
      throw new Error(`Cannot read capture time for ${source.name}: missing valid source revision`);
    }
    const key = createHash("sha256").update(JSON.stringify([source.id, source.modifiedTime, source.sizeBytes])).digest("hex");
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = this.readCached(source, key).catch((cause: unknown) => {
      throw new Error(`Cannot read capture time for ${source.name}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  private async readCached(source: DriveFileSource, key: string): Promise<number> {
    const file = path.join(this.cacheDirectory, `${key}.json`);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || !Number.isFinite(new Date(parsed).getTime())) {
        throw new Error("Invalid cached MP4 capture time");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const captureTimeMs = await readMovieCreationTime(source, this.readRange);
    await mkdir(this.cacheDirectory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(captureTimeMs));
    await rename(temporary, file);
    return captureTimeMs;
  }
}

async function readMovieCreationTime(source: DriveFileSource, readRange: ReadRange): Promise<number> {
  const size = source.sizeBytes!;
  let windowStart = 0;
  let window: Buffer = Buffer.alloc(0);
  let readBytes = 0;

  async function bytes(offset: number, length: number, limit: number): Promise<Buffer> {
    if (offset < 0 || offset + length > limit) throw new Error("Truncated MP4 box header");
    if (offset < windowStart || offset + length > windowStart + window.length) {
      const end = Math.min(limit, offset + HEADER_CONFIG.windowBytes) - 1;
      const requested = end - offset + 1;
      if (readBytes + requested > HEADER_CONFIG.maximumReadBytes) throw new Error("MP4 headers exceed the capture-time read budget");
      window = await readRange(source, offset, end);
      if (window.length !== requested) throw new Error(`Truncated MP4 range: expected ${requested} bytes, received ${window.length}`);
      windowStart = offset;
      readBytes += requested;
    }
    return window.subarray(offset - windowStart, offset - windowStart + length);
  }

  async function box(offset: number, limit: number): Promise<{ type: string; payload: number; end: number }> {
    const header = await bytes(offset, 8, limit);
    let length = header.readUInt32BE(0);
    const type = header.toString("ascii", 4, 8);
    let headerSize = 8;
    if (length === 1) {
      length = Number((await bytes(offset + 8, 8, limit)).readBigUInt64BE(0));
      headerSize = 16;
    } else if (length === 0) {
      length = limit - offset;
    }
    if (!Number.isSafeInteger(length) || length < headerSize || length > limit - offset) throw new Error(`Invalid MP4 ${type} box size`);
    return { type, payload: offset + headerSize, end: offset + length };
  }

  for (let offset = 0; offset < size;) {
    const movie = await box(offset, size);
    if (movie.type === "moov") {
      for (let childOffset = movie.payload; childOffset < movie.end;) {
        const child = await box(childOffset, movie.end);
        if (child.type === "mvhd") {
          const version = (await bytes(child.payload, 1, child.end))[0];
          if (version !== 0 && version !== 1) throw new Error(`Unsupported MP4 mvhd version: ${version}`);
          if (child.end - child.payload < (version === 0 ? 100 : 112)) throw new Error("Truncated MP4 mvhd box");
          const creation = await bytes(child.payload + 4, version === 0 ? 4 : 8, child.end);
          const seconds = version === 0 ? creation.readUInt32BE(0) : Number(creation.readBigUInt64BE(0));
          const captureTimeMs = MP4_EPOCH_MS + seconds * 1000;
          if (seconds === 0 || !Number.isSafeInteger(captureTimeMs) || !Number.isFinite(new Date(captureTimeMs).getTime())) {
            throw new Error("MP4 has no valid creation time");
          }
          return captureTimeMs;
        }
        childOffset = child.end;
      }
      throw new Error("MP4 has no mvhd creation time");
    }
    offset = movie.end;
  }
  throw new Error("MP4 has no mvhd creation time");
}
