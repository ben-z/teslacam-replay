import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HlsSource } from "./hls.js";

const { spawn, publishManifest } = vi.hoisted(() => ({ spawn: vi.fn(), publishManifest: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));
vi.mock("fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  publishManifest.mockImplementation(fs.rename);
  return { ...fs, rename: publishManifest };
});

class Encoder extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    this.finish(null);
    return true;
  });
  closed = false;

  constructor(readonly args: string[]) { super(); }

  get manifest(): string { return this.args.at(-1)!; }

  async writeManifest(endList: boolean): Promise<void> {
    const chunk = path.basename(this.args[this.args.indexOf("-hls_segment_filename") + 1]).replace("%03d", "000");
    await writeFile(path.join(path.dirname(this.manifest), chunk), "test encoded chunk");
    await writeFile(this.manifest, `#EXTM3U\n#EXTINF:4.0,\n${chunk}\n${endList ? "#EXT-X-ENDLIST\n" : ""}`);
  }

  finish(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code);
  }
}

const source: HlsSource = { url: "http://drive.test/file/id/front.mp4", headers: {}, identity: '["id","2026-10-22T00:00:00Z",100]' };
const sourceHash = createHash("sha256").update(source.identity).digest("hex").slice(0, 16);
const chunkName = `chunk_${sourceHash}_000.ts`;
const stream = ["SavedClips", "2026-10-21_20-36-52", "2026-10-21_20-35-58", "front"] as const;
let directory: string;
let encoders: Encoder[];
let hls: typeof import("./hls.js");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "teslacam-hls-test-"));
  vi.stubEnv("CACHE_DIR", directory);
  vi.stubEnv("HLS_BITRATE", "");
  vi.stubEnv("HLS_WIDTH", "");
  encoders = [];
  spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new Encoder(args);
    encoders.push(child);
    return child;
  });
  hls = await import("./hls.js");
});

afterEach(async () => {
  for (const child of encoders) child.finish(1);
  await vi.waitFor(() => expect(encoders.every((child) => child.closed)).toBe(true));
  // Process completion and derived-cache cleanup finish asynchronously.
  await new Promise((resolve) => setImmediate(resolve));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function started(index: number): Promise<Encoder> {
  await vi.waitFor(() => expect(encoders.length).toBeGreaterThan(index));
  return encoders[index];
}

async function completed(child: Encoder): Promise<void> {
  await child.writeManifest(false);
  child.finish(0);
  await vi.waitFor(async () => {
    expect(await readFile(child.manifest, "utf-8")).toContain("#EXT-X-ENDLIST");
  });
  await new Promise((resolve) => setImmediate(resolve));
}

async function removed(file: string): Promise<void> {
  await vi.waitFor(async () => {
    await expect(stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });
}

describe("HLS conversion integrity", () => {
  it.each([
    "missing chunk", "empty chunk", "byte-truncated chunk", "packet-aligned truncated chunk",
    "ENDLIST without segments", "EXTINF without URI", "unsafe URI", "wrong source chunk",
    "receipt without chunk proof", "receipt with wrong chunk name", "non-file chunk", "symlink chunk",
  ])("regenerates a completed cache with %s", async (damage) => {
    const cache = hls.hlsCacheDir(...stream);
    await mkdir(cache, { recursive: true });
    let manifest = `#EXTM3U\n#EXTINF:4.0,\n${chunkName}\n#EXT-X-ENDLIST\n`;
    const size = 188 * 4;
    if (damage !== "missing chunk") {
      if (damage === "non-file chunk") await mkdir(path.join(cache, chunkName));
      else if (damage === "symlink chunk") {
        await writeFile(path.join(cache, "target.ts"), Buffer.alloc(size));
        await symlink("target.ts", path.join(cache, chunkName));
      }
      else await writeFile(path.join(cache, chunkName), Buffer.alloc(
        damage === "empty chunk" ? 0 : damage === "byte-truncated chunk" ? size - 1
          : damage === "packet-aligned truncated chunk" ? size - 188 : size,
      ));
    }
    if (damage === "ENDLIST without segments") manifest = "#EXTM3U\n#EXT-X-ENDLIST\n";
    if (damage === "EXTINF without URI") manifest = "#EXTM3U\n#EXTINF:4.0,\n#EXT-X-ENDLIST\n";
    if (damage === "unsafe URI") manifest = manifest.replace(chunkName, `../${chunkName}`);
    if (damage === "wrong source chunk") manifest = manifest.replace(sourceHash, "0000000000000000");
    await writeFile(path.join(cache, "stream.m3u8"), manifest);
    await writeFile(path.join(cache, "source.json"), JSON.stringify({
      sourceHash,
      ...(damage === "receipt without chunk proof" ? {} : {
        chunks: [{ name: damage === "receipt with wrong chunk name" ? "other.ts" : chunkName, size }],
      }),
    }));

    const ready = hls.ensureHlsSegments(source, ...stream);
    const replacement = await started(0);
    await completed(replacement);
    expect(await ready).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(path.join(cache, "source.json"), "utf-8"))).toEqual({
      sourceHash, chunks: [{ name: chunkName, size: Buffer.byteLength("test encoded chunk") }],
    });
    expect(await hls.ensureHlsSegments(source, ...stream)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "empty", "directory", "no URI", "no segments"])(
    "does not publish a completed receipt or ENDLIST when ffmpeg leaves %s output", async (damage) => {
      hls.ensureHlsSegments(source, ...stream);
      const child = await started(0);
      const cache = path.dirname(child.manifest);
      if (damage === "directory") await mkdir(path.join(cache, chunkName));
      if (damage === "empty") await writeFile(path.join(cache, chunkName), "");
      const manifest = damage === "no segments" ? "#EXTM3U\n"
        : `#EXTM3U\n#EXTINF:4.0,\n${damage === "no URI" ? "" : `${chunkName}\n`}`;
      await writeFile(child.manifest, manifest);
      child.finish(0);
      await removed(cache);
      await expect(readFile(path.join(cache, "source.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(child.manifest)).rejects.toMatchObject({ code: "ENOENT" });
      expect(publishManifest).not.toHaveBeenCalled();
    },
  );

  it("reuses all verified chunks in manifest order and rejects a mismatched receipt", async () => {
    const cache = hls.hlsCacheDir(...stream);
    await mkdir(cache, { recursive: true });
    const names = [chunkName, chunkName.replace("_000.ts", "_001.ts")];
    await Promise.all(names.map((name, index) => writeFile(path.join(cache, name), Buffer.alloc(index + 1))));
    await writeFile(path.join(cache, "stream.m3u8"),
      `#EXTM3U\n${names.map((name) => `#EXTINF:1.0,\n${name}\n`).join("")}#EXT-X-ENDLIST\n`);
    const chunks = names.map((name, index) => ({ name, size: index + 1 }));
    await writeFile(path.join(cache, "source.json"), JSON.stringify({ sourceHash, chunks }));
    expect(await hls.ensureHlsSegments(source, ...stream)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    await writeFile(path.join(cache, "source.json"), JSON.stringify({ sourceHash, chunks: chunks.reverse() }));
    const ready = hls.ensureHlsSegments(source, ...stream);
    const replacement = await started(0);
    await completed(replacement);
    expect(await ready).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports a non-missing cache read error instead of treating it as a cache miss", async () => {
    const cache = hls.hlsCacheDir(...stream);
    await mkdir(path.join(cache, "source.json"), { recursive: true });
    await writeFile(path.join(cache, "stream.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await hls.ensureHlsSegments(source, ...stream)).toBe(false);
    await removed(cache);
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith(
      expect.stringContaining("HLS: failed"), expect.objectContaining({ code: "EISDIR" }),
    ));
    expect(spawn).not.toHaveBeenCalled();
  });

  it("shares one encoder between concurrent requests and serves progressive output without claiming completion", async () => {
    const first = hls.ensureHlsSegments(source, ...stream);
    const second = hls.ensureHlsSegments(source, ...stream);
    const child = await started(0);
    expect(first).toBe(second);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(child.args).toContain("temp_file+omit_endlist");
    await child.writeManifest(false);
    expect(await first).toBe(true);
    expect(await readFile(child.manifest, "utf-8")).not.toContain("#EXT-X-ENDLIST");
    await completed(child);
    expect(await hls.ensureHlsSegments(source, ...stream)).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("deletes a failed partial playlist even if it contains ENDLIST and regenerates on the next request", async () => {
    const first = hls.ensureHlsSegments(source, ...stream);
    const failed = await started(0);
    await failed.writeManifest(true);
    expect(await first).toBe(true);
    failed.stderr.write("Source connection ended prematurely\n");
    failed.finish(1);
    await removed(path.dirname(failed.manifest));
    const retry = hls.ensureHlsSegments(source, ...stream);
    const replacement = await started(1);
    await completed(replacement);
    expect(await retry).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not trust a preexisting manifest without a matching successful source receipt", async () => {
    const cache = hls.hlsCacheDir(...stream);
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "stream.m3u8"), "#EXTM3U\n#EXTINF:4,\nchunk_000.ts\n#EXT-X-ENDLIST\n");
    const ready = hls.ensureHlsSegments(source, ...stream);
    const child = await started(0);
    await completed(child);
    expect(await ready).toBe(true);
    const receipt = JSON.parse(await readFile(path.join(cache, "source.json"), "utf-8"));
    expect(receipt.sourceHash).toBe(createHash("sha256").update(source.identity).digest("hex").slice(0, 16));
  });

  it("isolates legacy caches whose ENDLIST cannot establish successful conversion", async () => {
    const legacy = path.join(directory, "hls", "copy", ...stream);
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "stream.m3u8"), "#EXTM3U\n#EXT-X-ENDLIST\n");
    expect(hls.hlsCacheDir(...stream)).not.toBe(legacy);
    const ready = hls.ensureHlsSegments(source, ...stream);
    const child = await started(0);
    await completed(child);
    expect(await ready).toBe(true);
  });

  it("invalidates completed media when the source identity changes and gives chunks different URLs", async () => {
    const ready = hls.ensureHlsSegments(source, ...stream);
    const original = await started(0);
    await completed(original);
    expect(await ready).toBe(true);
    const replacementSource = { ...source, identity: '["replacement","2026-10-22T01:00:00Z",101]' };
    const replaced = hls.ensureHlsSegments(replacementSource, ...stream);
    const replacement = await started(1);
    const chunkPattern = (child: Encoder) => child.args[child.args.indexOf("-hls_segment_filename") + 1];
    expect(chunkPattern(replacement)).not.toBe(chunkPattern(original));
    await completed(replacement);
    expect(await replaced).toBe(true);
  });

  it("rejects a different source during an active job instead of sharing old media", async () => {
    const original = hls.ensureHlsSegments(source, ...stream);
    const child = await started(0);
    expect(await hls.ensureHlsSegments({ ...source, identity: "changed" }, ...stream)).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    await completed(child);
    expect(await original).toBe(true);
  });

  it("reports a spawn error promptly and clears its process timeout", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const ready = hls.ensureHlsSegments(source, ...stream);
    const child = await started(0);
    child.emit("error", new Error("spawn ffmpeg ENOENT"));
    child.finish(null);
    expect(await ready).toBe(false);
    await removed(path.dirname(child.manifest));
    await vi.waitFor(() => expect(clear).toHaveBeenCalled());
  });

  it("rejects error-level ffmpeg output even when the process returns zero", async () => {
    const ready = hls.ensureHlsSegments(source, ...stream);
    const child = await started(0);
    child.stderr.write("Invalid NAL unit\n");
    child.finish(0);
    expect(await ready).toBe(false);
    await removed(path.dirname(child.manifest));
  });

  it("kills a timed-out conversion and removes its partial output", async () => {
    const realSetTimeout = globalThis.setTimeout;
    let expire!: () => void;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 120_000) expire = callback;
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout);
    const ready = hls.ensureHlsSegments(source, ...stream);
    const child = await started(0);
    expire();
    expect(await ready).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await removed(path.dirname(child.manifest));
  });
});
