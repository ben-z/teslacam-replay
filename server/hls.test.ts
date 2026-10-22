import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { HlsSource } from "./hls.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn,
}));

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
