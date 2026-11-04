import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CaptureTimeReader } from "./capture-time.js";
import type { DriveFileSource } from "./gdrive-lite.js";

const MP4_EPOCH_MS = Date.UTC(1904, 0, 1);
const CAPTURE_TIME = Date.parse("2026-11-01T08:01:06.000Z");
let cacheDirectory: string;

function box(type: string, payload: Buffer, extended: boolean): Buffer {
  const header = Buffer.alloc(extended ? 16 : 8);
  header.writeUInt32BE(extended ? 1 : payload.length + header.length, 0);
  header.write(type, 4, "ascii");
  if (extended) header.writeBigUInt64BE(BigInt(payload.length + header.length), 8);
  return Buffer.concat([header, payload]);
}

function movieHeader(version: number, creationTimeMs: number): Buffer {
  const payload = Buffer.alloc(version === 1 ? 112 : 100);
  payload[0] = version;
  const seconds = BigInt((creationTimeMs - MP4_EPOCH_MS) / 1000);
  if (version === 1) payload.writeBigUInt64BE(seconds, 4);
  else payload.writeUInt32BE(Number(seconds), 4);
  return box("mvhd", payload, false);
}

function fixture(movie: Buffer, mediaBytes: number, movieFirst: boolean) {
  const ftyp = box("ftyp", Buffer.from("isom0000"), false);
  const mdat = Buffer.alloc(8);
  mdat.writeUInt32BE(mediaBytes + 8, 0);
  mdat.write("mdat", 4, "ascii");
  const header = Buffer.concat([ftyp, movieFirst ? movie : Buffer.alloc(0), mdat]);
  const sections: { offset: number; bytes: Buffer }[] = [{ offset: 0, bytes: header }];
  if (!movieFirst) sections.push({ offset: header.length + mediaBytes, bytes: movie });
  const size = header.length + mediaBytes + (movieFirst ? 0 : movie.length);
  const source: DriveFileSource = {
    id: "original-video-id", name: "2026-11-01_01-01-06-front.mp4",
    url: "http://drive.test/file/video/front.mp4", sizeBytes: size,
    modifiedTime: "2026-11-02T00:00:00Z",
  };
  const readRange = vi.fn(async (_source: DriveFileSource, start: number, end: number) => {
    const buffer = Buffer.alloc(end - start + 1);
    for (const section of sections) {
      const from = Math.max(start, section.offset);
      const to = Math.min(end + 1, section.offset + section.bytes.length);
      if (from < to) section.bytes.copy(buffer, from - start, from - section.offset, to - section.offset);
    }
    return buffer;
  });
  return { source, readRange, sections };
}

beforeEach(async () => { cacheDirectory = await mkdtemp(path.join(tmpdir(), "teslacam-capture-time-")); });
afterEach(async () => { await rm(cacheDirectory, { recursive: true, force: true }); });

describe("original MP4 creation time", () => {
  it("reads the UTC creation time after a large media box without downloading the video", async () => {
    const { source, readRange } = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 60_000_000, false);
    const reader = new CaptureTimeReader(readRange, cacheDirectory);
    expect(await reader.read(source)).toBe(CAPTURE_TIME);
    expect(readRange).toHaveBeenCalledTimes(2);
    expect(readRange.mock.calls.every(([, start, end]) => end - start + 1 <= 4096)).toBe(true);
    const bytes = readRange.mock.calls.reduce((total, [, start, end]) => total + end - start + 1, 0);
    expect(bytes).toBeLessThan(8192);
    expect(readRange.mock.calls[1][1]).toBeGreaterThan(60_000_000);
  });

  it("supports a version 1 movie header and a 64-bit movie box size", async () => {
    const futureTime = Date.parse("2041-11-01T09:01:34Z");
    const { source, readRange } = fixture(box("moov", movieHeader(1, futureTime), true), 8192, true);
    expect(await new CaptureTimeReader(readRange, cacheDirectory).read(source)).toBe(futureTime);
    expect(readRange).toHaveBeenCalledTimes(1);
  });

  it("does not fetch unrelated track or user metadata after reading the movie header", async () => {
    const movie = box("moov", Buffer.concat([
      movieHeader(0, CAPTURE_TIME), box("trak", Buffer.alloc(20_000), false),
      box("udta", Buffer.alloc(61), false),
    ]), false);
    const { source, readRange } = fixture(movie, 60_000_000, false);
    expect(await new CaptureTimeReader(readRange, cacheDirectory).read(source)).toBe(CAPTURE_TIME);
    expect(readRange).toHaveBeenCalledTimes(2);
  });

  it("distinguishes the two occurrences of a repeated local hour", async () => {
    const first = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 10, true);
    const secondTime = Date.parse("2026-11-01T09:01:34Z");
    const second = fixture(box("moov", movieHeader(0, secondTime), false), 10, true);
    second.source.id = "second-video-id";
    const reader = new CaptureTimeReader((source, start, end) => source.id === first.source.id
      ? first.readRange(source, start, end) : second.readRange(source, start, end), cacheDirectory);
    expect(await reader.read(second.source) - await reader.read(first.source)).toBe(3_628_000);
  });

  it.each([
    ["missing movie", box("free", Buffer.alloc(0), false), "no mvhd creation time"],
    ["missing movie header", box("moov", box("free", Buffer.alloc(0), false), false), "no mvhd creation time"],
    ["unsupported version", box("moov", movieHeader(2, CAPTURE_TIME), false), "Unsupported MP4 mvhd version: 2"],
    ["zero creation time", box("moov", movieHeader(0, MP4_EPOCH_MS), false), "no valid creation time"],
    ["short movie header", box("moov", box("mvhd", Buffer.alloc(8), false), false), "Truncated MP4 mvhd box"],
  ])("rejects %s rather than inferring a timestamp", async (_label, movie, message) => {
    const { source, readRange } = fixture(movie as Buffer, 20, true);
    await expect(new CaptureTimeReader(readRange, cacheDirectory).read(source)).rejects.toThrow(`${source.name}:`);
    await expect(new CaptureTimeReader(readRange, cacheDirectory).read(source)).rejects.toThrow(message as string);
    expect(await readdir(cacheDirectory)).toEqual([]);
  });

  it("rejects a box that extends past the source size", async () => {
    const movie = box("moov", movieHeader(0, CAPTURE_TIME), false);
    movie.writeUInt32BE(1_000_000, 0);
    const { source, readRange } = fixture(movie, 20, true);
    await expect(new CaptureTimeReader(readRange, cacheDirectory).read(source)).rejects.toThrow("Invalid MP4 moov box size");
  });

  it("rejects truncated ranges", async () => {
    const { source, readRange } = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 20, true);
    const truncated = async (file: DriveFileSource, start: number, end: number) => (await readRange(file, start, end)).subarray(1);
    await expect(new CaptureTimeReader(truncated, cacheDirectory).read(source)).rejects.toThrow("Truncated MP4 range");
  });

  it("bounds reads of a long sparse chain of boxes", async () => {
    const free = Buffer.alloc(8);
    free.writeUInt32BE(8192, 0);
    free.write("free", 4, "ascii");
    const { source } = fixture(Buffer.alloc(0), 1_000_000, true);
    const readRange = vi.fn(async (_file: DriveFileSource, _start: number, end: number) => {
      const buffer = Buffer.alloc(end - _start + 1);
      free.copy(buffer);
      return buffer;
    });
    await expect(new CaptureTimeReader(readRange, cacheDirectory).read(source)).rejects.toThrow("capture-time read budget");
    expect(readRange).toHaveBeenCalledTimes(16);
  });

  it.each([
    { id: "" }, { sizeBytes: undefined }, { sizeBytes: 0 }, { sizeBytes: 100.5 },
    { modifiedTime: undefined }, { modifiedTime: "invalid" },
  ])("requires a source revision and size: %s", async (fields) => {
    const { source, readRange } = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 20, true);
    await expect(new CaptureTimeReader(readRange, cacheDirectory).read({ ...source, ...fields })).rejects.toThrow("Cannot read capture time");
    expect(readRange).not.toHaveBeenCalled();
  });
});

describe("capture-time metadata cache", () => {
  it("coalesces concurrent reads and reuses successful metadata across reader instances", async () => {
    const { source, readRange } = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 20, true);
    const reader = new CaptureTimeReader(readRange, cacheDirectory);
    expect(await Promise.all([reader.read(source), reader.read(source)])).toEqual([CAPTURE_TIME, CAPTURE_TIME]);
    expect(readRange).toHaveBeenCalledTimes(1);
    expect(await new CaptureTimeReader(readRange, cacheDirectory).read(source)).toBe(CAPTURE_TIME);
    expect(readRange).toHaveBeenCalledTimes(1);
    const names = await readdir(cacheDirectory);
    expect(names).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(cacheDirectory, names[0]), "utf8"))).toBe(CAPTURE_TIME);
  });

  it.each([
    "id", "modifiedTime", "sizeBytes",
  ])("invalidates metadata when the source identity changes: %s", async (field) => {
    const { source, readRange, sections } = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 20, true);
    // An mdat size of zero extends to EOF, including a changed source's new size.
    sections[0].bytes.writeUInt32BE(0, sections[0].bytes.length - 8);
    const reader = new CaptureTimeReader(readRange, cacheDirectory);
    await reader.read(source);
    const changed = { ...source, [field]: field === "sizeBytes" ? source.sizeBytes! + 20
      : field === "modifiedTime" ? "2026-11-03T00:00:00Z" : "replacement-id" };
    await reader.read(changed);
    expect(readRange).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed provider read", async () => {
    const { source, readRange } = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 20, true);
    readRange.mockRejectedValueOnce(new Error("Drive read failed"));
    const reader = new CaptureTimeReader(readRange, cacheDirectory);
    await expect(reader.read(source)).rejects.toThrow("Drive read failed");
    expect(await readdir(cacheDirectory)).toEqual([]);
    expect(await reader.read(source)).toBe(CAPTURE_TIME);
  });

  it("fails explicitly on a corrupt cache entry", async () => {
    const { source, readRange } = fixture(box("moov", movieHeader(0, CAPTURE_TIME), false), 20, true);
    const reader = new CaptureTimeReader(readRange, cacheDirectory);
    await reader.read(source);
    const [name] = await readdir(cacheDirectory);
    await writeFile(path.join(cacheDirectory, name), "null");
    await expect(reader.read(source)).rejects.toThrow("Invalid cached MP4 capture time");
    expect(readRange).toHaveBeenCalledTimes(1);
  });
});
