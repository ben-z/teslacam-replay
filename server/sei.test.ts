import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import protobuf from "protobufjs";
import { extractTelemetryFromBuffer } from "./sei";

let metadata: protobuf.Type;

beforeAll(async () => {
  const schema = await protobuf.load(path.join(import.meta.dirname, "dashcam.proto"));
  metadata = schema.lookupType("SeiMetadata");
});

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function box(name: string, ...contents: Buffer[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([uint32(body.length + 8), Buffer.from(name), body]);
}

function nal(payload: Buffer): Buffer {
  return Buffer.concat([uint32(payload.length), payload]);
}

function escapeEmulationBytes(bytes: Uint8Array): Buffer {
  const escaped: number[] = [];
  let zeros = 0;
  for (const byte of bytes) {
    if (zeros >= 2 && byte <= 3) {
      escaped.push(3);
      zeros = 0;
    }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(escaped);
}

function teslaPayload(payload: Buffer): Buffer {
  return nal(Buffer.concat([Buffer.from([6, 5, 16, 0x42, 0x69]), payload, Buffer.from([0x80])]));
}

function teslaFrame(sequence: number, speed: number): Buffer {
  return teslaPayload(escapeEmulationBytes(metadata.encode(metadata.create({ frameSeqNo: sequence, vehicleSpeedMps: speed })).finish()));
}

interface MovieOptions {
  timescale?: number;
  composition?: number[];
  chunkSamples?: number[];
  co64?: boolean;
  fixedSize?: boolean;
  nalLengthSize?: number;
  edits?: boolean;
  editVersion?: number;
  movieTimescale?: number;
  duplicateComposition?: boolean;
}

/** A nonfragmented AVC track whose sample addresses point into its mdat. */
function movie(samples: Buffer[], durations: number[], options: MovieOptions): Buffer {
  const ftyp = box("ftyp", Buffer.from("isom"), uint32(0), Buffer.from("isomavc1"));
  const clock = Buffer.alloc(24);
  clock.writeUInt32BE(options.timescale ?? 1000, 12);
  clock.writeUInt32BE(durations.reduce((sum, duration) => sum + duration, 0), 16);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8);
  const visual = Buffer.alloc(78);
  visual.writeUInt16BE(1, 6);
  visual.writeUInt16BE(640, 24);
  visual.writeUInt16BE(480, 26);
  const avcC = box("avcC", Buffer.from([1, 66, 0, 30, 0xfc | ((options.nalLengthSize ?? 4) - 1), 0xe0, 0]));
  const stsd = box("stsd", uint32(0), uint32(1), box("avc1", visual, avcC));
  const stts = box("stts", uint32(0), uint32(durations.length), ...durations.map((duration) => Buffer.concat([uint32(1), uint32(duration)])));
  const ctts = options.composition ? box("ctts", uint32(0x01000000), uint32(options.composition.length), ...options.composition.map((offset) => {
    const signed = Buffer.alloc(4);
    signed.writeInt32BE(offset);
    return Buffer.concat([uint32(1), signed]);
  })) : null;
  const stsz = box("stsz", uint32(0), uint32(options.fixedSize ? samples[0].length : 0), uint32(samples.length),
    ...(options.fixedSize ? [] : samples.map((sample) => uint32(sample.length))));
  const chunkSamples = options.chunkSamples ?? [samples.length];
  const stsc = box("stsc", uint32(0), uint32(chunkSamples.length), ...chunkSamples.map((count, i) => Buffer.concat([uint32(i + 1), uint32(count), uint32(1)])));
  let offset = ftyp.length + 8;
  let sample = 0;
  const chunks = chunkSamples.map((count) => {
    const bytes = Buffer.alloc(options.co64 ? 8 : 4);
    if (options.co64) bytes.writeBigUInt64BE(BigInt(offset));
    else bytes.writeUInt32BE(offset);
    for (let i = 0; i < count; i++) offset += samples[sample++].length;
    return bytes;
  });
  const offsets = box(options.co64 ? "co64" : "stco", uint32(0), uint32(chunks.length), ...chunks);
  const stbl = box("stbl", stsd, stts, ...(ctts ? [ctts, ...(options.duplicateComposition ? [ctts] : [])] : []), stsz, stsc, offsets);
  const movieScale = options.movieTimescale ?? options.timescale ?? 1000;
  const movieClock = Buffer.alloc(100);
  movieClock.writeUInt32BE(movieScale, 12);
  const editDuration = durations.reduce((sum, duration) => sum + duration, 0) * movieScale / (options.timescale ?? 1000);
  const editEntry = Buffer.alloc(options.editVersion === 1 ? 20 : 12);
  if (options.editVersion === 1) {
    editEntry.writeBigUInt64BE(BigInt(editDuration));
    editEntry.writeInt16BE(1, 16);
  } else {
    editEntry.writeUInt32BE(editDuration);
    editEntry.writeInt16BE(1, 8);
  }
  const edits = options.edits ? [box("edts", box("elst", uint32((options.editVersion ?? 0) << 24), uint32(1), editEntry))] : [];
  return Buffer.concat([ftyp, box("mdat", ...samples), box("moov", box("mvhd", movieClock), box("trak", ...edits,
    box("mdia", box("mdhd", clock), box("hdlr", handler), box("minf", stbl))))]);
}

function writeTableValue(source: Buffer, name: string, offset: number, value: number): void {
  source.writeUInt32BE(value, source.indexOf(name) + 4 + offset);
}

const slice = () => nal(Buffer.from([0x65, 0x88]));

describe("Tesla vehicle data integrity", () => {
  it("preserves the recorded accelerator percentage without normalization", async () => {
    const payload = teslaPayload(escapeEmulationBytes(metadata.encode(metadata.create({
      frameSeqNo: 100,
      acceleratorPedalPosition: 17.6,
    })).finish()));
    const data = await extractTelemetryFromBuffer(movie([Buffer.concat([payload, slice()])], [40], {}));
    expect(data?.frames[0].acceleratorPedalPosition).toBe(17.600000381469727);
  });

  it("uses variable sample timing and preserves two messages in one sample", async () => {
    const source = movie([
      Buffer.concat([teslaFrame(100, 1), slice()]),
      Buffer.concat([teslaFrame(101, 2), teslaFrame(102, 3), slice()]),
      Buffer.concat([teslaFrame(103, 4), slice()]),
    ], [40, 60, 20], {});
    const data = await extractTelemetryFromBuffer(source);
    expect(data?.frameTimesMs).toEqual([0, 40, 40, 100]);
    expect(data?.frames.map((frame) => frame.vehicleSpeedMps)).toEqual([1, 2, 3, 4]);
    expect(data?.frames.map((frame) => frame.frameSeqNo)).toEqual([100, 101, 102, 103]);
    expect(data?.frames[0].gearState).toBe(0);
  });

  it("uses samples without requiring contiguous or increasing capture counters", async () => {
    const source = movie([
      Buffer.concat([teslaFrame(100, 1), slice()]),
      slice(),
      Buffer.concat([teslaFrame(500, 2), slice()]),
      Buffer.concat([teslaFrame(0, 3), slice()]),
    ], [40, 60, 20, 30], {});
    const data = await extractTelemetryFromBuffer(source);
    expect(data?.frameTimesMs).toEqual([0, 100, 120]);
    expect(data?.frames.map((frame) => frame.frameSeqNo)).toEqual([100, 500, 0]);
  });

  it("uses signed composition offsets and sorts presentation times stably", async () => {
    const source = movie([
      Buffer.concat([teslaFrame(100, 1), slice()]),
      Buffer.concat([teslaFrame(101, 2), teslaFrame(102, 3), slice()]),
      Buffer.concat([teslaFrame(103, 4), slice()]),
    ], [40, 40, 40], { composition: [80, 0, -80] });
    const data = await extractTelemetryFromBuffer(source);
    expect(data?.frameTimesMs).toEqual([0, 40, 40, 80]);
    expect(data?.frames.map((frame) => frame.frameSeqNo)).toEqual([103, 101, 102, 100]);
  });

  it("uses unsigned version-zero composition offsets", async () => {
    const source = movie([teslaFrame(1, 1), teslaFrame(2, 2)], [40, 40], { composition: [0, 100] });
    writeTableValue(source, "ctts", 0, 0);
    const data = await extractTelemetryFromBuffer(source);
    expect(data?.frameTimesMs).toEqual([0, 140]);
  });

  it("walks multiple chunks, changing samples-per-chunk, and co64 addresses", async () => {
    const source = movie([teslaFrame(10, 1), teslaFrame(20, 2), teslaFrame(30, 3)], [40, 60, 20], { chunkSamples: [2, 1], co64: true });
    expect((await extractTelemetryFromBuffer(source))?.frameTimesMs).toEqual([0, 40, 100]);
  });

  it("supports fixed sample sizes and configured two-byte NAL lengths", async () => {
    const samples = [teslaFrame(1, 1), teslaFrame(2, 1)].map((sample) => {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(sample.length - 4);
      return Buffer.concat([length, sample.subarray(4)]);
    });
    expect(samples[0].length).toBe(samples[1].length);
    const source = movie(samples, [40, 60], { fixedSize: true, nalLengthSize: 2 });
    expect((await extractTelemetryFromBuffer(source))?.frameTimesMs).toEqual([0, 40]);
  });

  it("preserves a valid final zero-duration sample", async () => {
    const source = movie([teslaFrame(100, 1), teslaFrame(101, 2), teslaFrame(102, 3)], [232, 299, 0], { timescale: 10000 });
    const data = await extractTelemetryFromBuffer(source);
    expect(data?.frameTimesMs).toEqual([0, 23.2, 53.1]);
  });

  it.each([
    { durations: [232, 0, 299], count: 1 },
    { durations: [232, 299, 0], count: 2 },
  ])("rejects invalid zero-duration runs: $durations/$count", async ({ durations, count }) => {
    const source = movie([teslaFrame(100, 1), teslaFrame(101, 2), teslaFrame(102, 3)], durations, {});
    if (count === 2) writeTableValue(source, "stts", 8 + 2 * 8, count);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("zero duration only for the final sample");
  });

  it.each([
    { table: "stsz", offset: 8, value: 100, error: "Truncated MP4 stsz" },
    { table: "stsz", offset: 12, value: 0, error: "positive sizes" },
    { table: "stts", offset: 4, value: 100, error: "Truncated MP4 stts" },
    { table: "stts", offset: 8, value: 0, error: "positive sample counts" },
    { table: "stts", offset: 8, value: 2, error: "stts count" },
    { table: "stco", offset: 4, value: 2, error: "Truncated MP4 stco" },
    { table: "stco", offset: 8, value: 0, error: "outside media data" },
    { table: "stsc", offset: 4, value: 2, error: "Truncated MP4 stsc" },
    { table: "stsc", offset: 8, value: 2, error: "sample-to-chunk" },
    { table: "stsc", offset: 12, value: 0, error: "sample-to-chunk" },
    { table: "stsc", offset: 12, value: 2, error: "chunk sample count" },
    { table: "stsc", offset: 16, value: 2, error: "sample-to-chunk" },
    { table: "stsd", offset: 4, value: 2, error: "stsd count" },
  ])("rejects inconsistent $table sample tables at $offset", async ({ table, offset, value, error }) => {
    const source = movie([teslaFrame(100, 1)], [40], {});
    writeTableValue(source, table, offset, value);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow(error);
  });

  it.each(["stsz", "stts", "stco", "stsc", "stsd"])("rejects missing %s tables", async (table) => {
    const source = movie([teslaFrame(100, 1)], [40], {});
    source.write("free", source.indexOf(table));
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow(table === "stco" ? "chunk offset table" : `${table} box`);
  });

  it("rejects a missing movie clock", async () => {
    await expect(extractTelemetryFromBuffer(box("mdat", teslaFrame(100, 1)))).rejects.toThrow("moov box");
  });

  it("rejects a zero-timescale media clock", async () => {
    const source = movie([teslaFrame(100, 1)], [40], { timescale: 0 });
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("zero timescale");
  });

  it.each([0, 1])("accepts checked full-length identity edits version%s with a different movie clock", async (editVersion) => {
    const source = movie([teslaFrame(1, 1), teslaFrame(2, 2)], [40, 60], { edits: true, editVersion, movieTimescale: 10000 });
    expect((await extractTelemetryFromBuffer(source))?.frameTimesMs).toEqual([0, 40]);
  });

  it.each([
    { offset: 8, value: 20 },
    { offset: 12, value: 1 },
    { offset: 16, value: 0x00020000 },
  ])("rejects edit trims/origin/rate changes at $offset", async ({ offset, value }) => {
    const source = movie([teslaFrame(1, 1)], [40], { edits: true });
    writeTableValue(source, "elst", offset, value);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("full-length identity edit");
  });

  it("rejects composition counts that do not match sample counts", async () => {
    const source = movie([teslaFrame(1, 1), teslaFrame(2, 2)], [40, 40], { composition: [0] });
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("ctts count");
  });

  it("rejects duplicate composition tables", async () => {
    const source = movie([teslaFrame(1, 1)], [40], { composition: [0], duplicateComposition: true });
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("duplicate ctts");
  });

  it("rejects truncated composition tables", async () => {
    const source = movie([teslaFrame(1, 1)], [40], { composition: [0] });
    writeTableValue(source, "ctts", 4, 2);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("Truncated MP4 ctts");
  });

  it("rejects unsafe co64 offsets", async () => {
    const source = movie([teslaFrame(1, 1)], [40], { co64: true });
    source.writeBigUInt64BE(2n ** 60n, source.indexOf("co64") + 12);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("safe integer");
  });

  it("rejects overlapping addressed samples", async () => {
    const source = movie([teslaFrame(1, 1), teslaFrame(2, 2)], [40, 40], { chunkSamples: [1, 1] });
    const firstOffset = source.readUInt32BE(source.indexOf("stco") + 12);
    writeTableValue(source, "stco", 12, firstOffset);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("samples overlap");
  });

  it("rejects a sample extending beyond mdat even when it fits in the file", async () => {
    const source = movie([teslaFrame(1, 1)], [40], {});
    writeTableValue(source, "stsz", 12, source.length - 40);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("outside media data");
  });

  it("returns null for a valid AVC track without Tesla telemetry", async () => {
    expect(await extractTelemetryFromBuffer(movie([slice()], [40], {}))).toBeNull();
  });

  it("distinguishes unrelated SEI from malformed Tesla telemetry", async () => {
    const unrelated = nal(Buffer.from([6, 5, 16, 0x41, 0x69, 0x80]));
    expect(await extractTelemetryFromBuffer(movie([unrelated], [40], {}))).toBeNull();
    await expect(extractTelemetryFromBuffer(movie([teslaPayload(Buffer.from([0xff]))], [40], {}))).rejects.toThrow("Cannot decode Tesla vehicle data");
  });

  it("rejects non-finite measurements and unsafe sequence values", async () => {
    await expect(extractTelemetryFromBuffer(movie([teslaFrame(100, NaN)], [40], {}))).rejects.toThrow("vehicleSpeedMps must be finite");
    await expect(extractTelemetryFromBuffer(movie([teslaFrame(2 ** 54, 1)], [40], {}))).rejects.toThrow("not a safe integer");
  });

  it.each(["stts", "stsc", "stco", "stsz", "stsd"])("rejects unsupported %s versions", async (table) => {
    const source = movie([teslaFrame(1, 1)], [40], {});
    writeTableValue(source, table, 0, 0x01000000);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("Unsupported MP4");
  });

  it("rejects trailing table entries instead of ignoring them", async () => {
    const source = movie([teslaFrame(1, 1)], [40], {});
    writeTableValue(source, "stco", 4, 0);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("table size does not match entry count");
  });

  it("rejects a truncated one-byte SEI header", async () => {
    await expect(extractTelemetryFromBuffer(movie([nal(Buffer.from([6]))], [40], {}))).rejects.toThrow("Truncated H.264 SEI header");
  });

  it("rejects NAL lengths crossing a sample boundary", async () => {
    const source = movie([Buffer.concat([uint32(10), Buffer.from([6, 5])]), slice()], [40, 40], {});
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("Invalid H.264 video data length");
  });

  it("rejects truncated NAL lengths and container boxes", async () => {
    await expect(extractTelemetryFromBuffer(movie([Buffer.from([0, 0])], [40], {}))).rejects.toThrow("Truncated H.264 video data length");
    const source = movie([teslaFrame(1, 1)], [40], {});
    await expect(extractTelemetryFromBuffer(source.subarray(0, source.length - 1))).rejects.toThrow("Invalid MP4 moov box size");
  });
});
