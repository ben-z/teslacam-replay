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

function timing(durations: number[], timescale: number): Buffer {
  const clock = Buffer.alloc(16);
  clock.writeUInt32BE(timescale, 12);
  const handler = Buffer.alloc(12);
  handler.write("vide", 8);
  const entries = durations.map((duration) => Buffer.concat([uint32(1), uint32(duration)]));
  return box("moov", box("trak", box("mdia",
    box("mdhd", clock),
    box("hdlr", handler),
    box("minf", box("stbl", box("stts", uint32(0), uint32(entries.length), ...entries))),
  )));
}

describe("Tesla vehicle data integrity", () => {
  it("uses the recorded variable sample clock rather than an assumed frame rate", async () => {
    const source = Buffer.concat([
      box("mdat", teslaFrame(100, 1), teslaFrame(101, 2), teslaFrame(102, 3)),
      timing([40, 60, 20], 1000),
    ]);
    const data = await extractTelemetryFromBuffer(source);
    expect(data?.frameTimesMs).toEqual([0, 40, 100]);
    expect(data?.frames.map((frame) => frame.vehicleSpeedMps)).toEqual([1, 2, 3]);
    expect(data?.frames[0].gearState).toBe(0);
  });

  it("preserves a valid final zero-duration sample without inventing its duration", async () => {
    const source = Buffer.concat([
      box("mdat", teslaFrame(100, 1), teslaFrame(101, 2), teslaFrame(102, 3)),
      timing([232, 299, 0], 10000),
    ]);
    const data = await extractTelemetryFromBuffer(source);
    expect(data?.frameTimesMs).toHaveLength(3);
    expect(data?.frameTimesMs.slice(0, 2)).toEqual([0, 23.2]);
    expect(data?.frameTimesMs[2]).toBeCloseTo(53.1, 8);
    expect(data?.frames.map((frame) => frame.vehicleSpeedMps)).toEqual([1, 2, 3]);
  });

  it("rejects an interior zero-duration sample", async () => {
    const source = Buffer.concat([
      box("mdat", teslaFrame(100, 1), teslaFrame(101, 2), teslaFrame(102, 3)),
      timing([232, 0, 299], 10000),
    ]);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("zero duration only for the final sample");
  });

  it("rejects multiple samples with zero duration in the final entry", async () => {
    const source = Buffer.concat([box("mdat", teslaFrame(100, 1)), timing([0], 10000)]);
    source.writeUInt32BE(2, source.indexOf("stts") + 12);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("zero duration only for the final sample");
  });

  it("rejects a zero sample count instead of dropping its timing entry", async () => {
    const source = Buffer.concat([box("mdat", teslaFrame(100, 1)), timing([232], 10000)]);
    source.writeUInt32BE(0, source.indexOf("stts") + 12);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("positive sample counts");
  });

  it("returns null when video NAL units contain no Tesla telemetry", async () => {
    const source = Buffer.concat([box("mdat", nal(Buffer.from([0x65, 0x88]))), timing([1], 24)]);
    expect(await extractTelemetryFromBuffer(source)).toBeNull();
  });

  it("does not mistake unrelated SEI messages for corrupt Tesla telemetry", async () => {
    const source = Buffer.concat([box("mdat", nal(Buffer.from([6, 5, 16, 0x41, 0x69, 0x80]))), timing([1], 24)]);
    expect(await extractTelemetryFromBuffer(source)).toBeNull();
  });

  it("rejects a recognized Tesla payload that cannot be decoded", async () => {
    const source = Buffer.concat([box("mdat", teslaPayload(Buffer.from([0xff]))), timing([1], 24)]);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("Cannot decode Tesla vehicle data");
  });

  it("rejects telemetry with no original sample timing instead of inventing 36fps", async () => {
    await expect(extractTelemetryFromBuffer(box("mdat", teslaFrame(100, 1)))).rejects.toThrow("MP4 movie timing table");
  });

  it("rejects a zero-timescale media clock", async () => {
    const source = Buffer.concat([box("mdat", teslaFrame(100, 1)), timing([1], 0)]);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("zero timescale");
  });

  it("rejects truncated sample timing rather than accepting the available prefix", async () => {
    const clock = Buffer.alloc(16);
    clock.writeUInt32BE(24, 12);
    const handler = Buffer.alloc(12);
    handler.write("vide", 8);
    const truncated = box("moov", box("trak", box("mdia", box("mdhd", clock), box("hdlr", handler),
      box("minf", box("stbl", box("stts", uint32(0), uint32(2), uint32(1), uint32(1)))),
    )));
    await expect(extractTelemetryFromBuffer(Buffer.concat([box("mdat", teslaFrame(100, 1)), truncated]))).rejects.toThrow("Truncated MP4 sample timing");
  });

  it("rejects sequence numbers outside the sample clock rather than clamping them", async () => {
    const source = Buffer.concat([box("mdat", teslaFrame(100, 1), teslaFrame(102, 2)), timing([1, 1], 24)]);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("does not match MP4 sample timing");
  });

  it("rejects non-finite vehicle measurements instead of replacing them with zero", async () => {
    const source = Buffer.concat([box("mdat", teslaFrame(100, NaN)), timing([1], 24)]);
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("vehicleSpeedMps must be finite");
  });

  it("rejects truncated H.264 data instead of reporting absent telemetry", async () => {
    const source = box("mdat", uint32(10), Buffer.from([6, 5]));
    await expect(extractTelemetryFromBuffer(source)).rejects.toThrow("Invalid H.264 video data length");
  });
});
