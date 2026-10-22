import { readFile } from "fs/promises";
import path from "path";
import protobuf from "protobufjs";

export interface SeiFrame {
  frameSeqNo: number;
  vehicleSpeedMps: number;
  acceleratorPedalPosition: number; // 0..1
  steeringWheelAngle: number;
  gearState: number; // 0=P, 1=D, 2=R, 3=N
  autopilotState: number; // 0=none, 1=FSD, 2=autosteer, 3=TACC
  brakeApplied: boolean;
  blinkerOnLeft: boolean;
  blinkerOnRight: boolean;
  latitudeDeg: number;
  longitudeDeg: number;
  headingDeg: number;
}

export interface TelemetryData {
  frameTimesMs: number[]; // precomputed start time for each telemetry frame
  frames: SeiFrame[];
}

// Load proto once
let seiMetadataType: protobuf.Type | null = null;
async function getProtoType(): Promise<protobuf.Type> {
  if (seiMetadataType) return seiMetadataType;
  const root = await protobuf.load(path.join(import.meta.dirname, "dashcam.proto"));
  seiMetadataType = root.lookupType("SeiMetadata");
  return seiMetadataType;
}

interface Mp4Box {
  start: number;
  end: number;
  size: number;
  type: string;
}

interface VideoSample {
  offset: number;
  size: number;
  timeMs: number;
  nalLengthSize: number;
}

class Mp4Parser {
  private view: DataView;

  constructor(private buffer: Buffer) {
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  private boxes(start: number, end: number): Mp4Box[] {
    const boxes: Mp4Box[] = [];
    for (let pos = start; pos < end;) {
      if (pos + 8 > end) throw new Error("Truncated MP4 box header");
      let size = this.view.getUint32(pos);
      const type = this.buffer.toString("ascii", pos + 4, pos + 8);
      let headerSize = 8;
      if (size === 1) {
        if (pos + 16 > end) throw new Error(`Truncated MP4 ${type} box header`);
        size = Number(this.view.getBigUint64(pos + 8));
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (!Number.isSafeInteger(size) || size < headerSize || size > end - pos) {
        throw new Error(`Invalid MP4 ${type} box size`);
      }
      boxes.push({ start: pos + headerSize, end: pos + size, size: size - headerSize, type });
      pos += size;
    }
    return boxes;
  }

  private requireBox(boxes: Mp4Box[], type: string): Mp4Box {
    const matches = boxes.filter((box) => box.type === type);
    if (matches.length !== 1) throw new Error(`Vehicle data requires one MP4 ${type} box`);
    return matches[0];
  }

  private requireSize(box: Mp4Box, size: number): void {
    if (box.size < size) throw new Error(`Truncated MP4 ${box.type} box`);
  }

  private table(box: Mp4Box, width: number): number {
    this.requireSize(box, 8);
    const version = this.buffer[box.start];
    if (version !== 0 && !((box.type === "ctts" || box.type === "elst") && version === 1)) throw new Error(`Unsupported MP4 ${box.type} version: ${version}`);
    const count = this.view.getUint32(box.start + 4);
    if (count > (box.size - 8) / width) throw new Error(`Truncated MP4 ${box.type} table`);
    if (box.size !== 8 + count * width) throw new Error(`MP4 ${box.type} table size does not match entry count`);
    return count;
  }

  private timescale(box: Mp4Box): number {
    this.requireSize(box, 1);
    const version = this.buffer[box.start];
    if (version !== 0 && version !== 1) throw new Error(`Unsupported MP4 ${box.type} version: ${version}`);
    const offset = version === 1 ? 20 : 12;
    this.requireSize(box, offset + 4);
    const timescale = this.view.getUint32(box.start + offset);
    if (timescale === 0) throw new Error("MP4 media clock has zero timescale");
    return timescale;
  }

  private videoSamples(): VideoSample[] {
    const top = this.boxes(0, this.buffer.length);
    const moov = this.requireBox(top, "moov");
    const movieBoxes = this.boxes(moov.start, moov.end);
    const tracks = movieBoxes
      .filter((box) => box.type === "trak")
      .map((trak) => {
        const boxes = this.boxes(trak.start, trak.end);
        return { boxes, mdia: this.requireBox(boxes, "mdia") };
      })
      .filter(({ mdia }) => {
        const hdlr = this.requireBox(this.boxes(mdia.start, mdia.end), "hdlr");
        this.requireSize(hdlr, 12);
        return this.buffer.toString("ascii", hdlr.start + 8, hdlr.start + 12) === "vide";
      });
    if (tracks.length !== 1) throw new Error("Vehicle data requires exactly one MP4 video track");
    const track = tracks[0];
    const mediaBoxes = this.boxes(track.mdia.start, track.mdia.end);
    const timescale = this.timescale(this.requireBox(mediaBoxes, "mdhd"));
    const minf = this.requireBox(mediaBoxes, "minf");
    const stbl = this.requireBox(this.boxes(minf.start, minf.end), "stbl");
    const tables = this.boxes(stbl.start, stbl.end);

    const stsz = this.requireBox(tables, "stsz");
    this.requireSize(stsz, 12);
    if (this.buffer[stsz.start] !== 0) throw new Error("Unsupported MP4 stsz version");
    const fixedSize = this.view.getUint32(stsz.start + 4);
    const sampleCount = this.view.getUint32(stsz.start + 8);
    if (sampleCount === 0 || sampleCount > this.buffer.length) throw new Error("Invalid MP4 video sample count");
    const sizeTableLength = fixedSize === 0 ? 12 + sampleCount * 4 : 12;
    this.requireSize(stsz, sizeTableLength);
    if (stsz.size !== sizeTableLength) throw new Error("MP4 stsz table size does not match sample count");
    const sizes = Array.from({ length: sampleCount }, (_, i) => fixedSize === 0 ? this.view.getUint32(stsz.start + 12 + i * 4) : fixedSize);
    if (sizes.some((size) => size === 0)) throw new Error("MP4 video samples must have positive sizes");

    const stts = this.requireBox(tables, "stts");
    const durations: number[] = [];
    const timingCount = this.table(stts, 8);
    for (let i = 0; i < timingCount; i++) {
      const count = this.view.getUint32(stts.start + 8 + i * 8);
      const delta = this.view.getUint32(stts.start + 12 + i * 8);
      if (count === 0) throw new Error("MP4 sample timing entries must have positive sample counts");
      if (delta === 0 && (i !== timingCount - 1 || count !== 1)) {
        throw new Error("MP4 sample timing permits zero duration only for the final sample");
      }
      if (count > sampleCount - durations.length) throw new Error("MP4 stts count does not match video samples");
      for (let j = 0; j < count; j++) durations.push(delta);
    }
    if (durations.length !== sampleCount) throw new Error("MP4 stts count does not match video samples");

    const composition = Array<number>(sampleCount).fill(0);
    const compositionTables = tables.filter((box) => box.type === "ctts");
    if (compositionTables.length > 1) throw new Error("MP4 video track has duplicate ctts tables");
    const ctts = compositionTables[0];
    if (ctts) {
      const entryCount = this.table(ctts, 8);
      const version = this.buffer[ctts.start];
      let sample = 0;
      for (let i = 0; i < entryCount; i++) {
        const count = this.view.getUint32(ctts.start + 8 + i * 8);
        const offset = version === 1 ? this.view.getInt32(ctts.start + 12 + i * 8) : this.view.getUint32(ctts.start + 12 + i * 8);
        if (count === 0 || count > sampleCount - sample) throw new Error("MP4 ctts count does not match video samples");
        composition.fill(offset, sample, sample + count);
        sample += count;
      }
      if (sample !== sampleCount) throw new Error("MP4 ctts count does not match video samples");
    }

    const stsd = this.requireBox(tables, "stsd");
    this.requireSize(stsd, 8);
    if (this.buffer[stsd.start] !== 0) throw new Error("Unsupported MP4 stsd version");
    const descriptions = this.boxes(stsd.start + 8, stsd.end);
    if (descriptions.length !== this.view.getUint32(stsd.start + 4)) throw new Error("MP4 stsd count does not match sample descriptions");
    const nalLengths = descriptions.map((description) => {
      if (description.type !== "avc1" && description.type !== "avc3") throw new Error(`Unsupported MP4 video sample type: ${description.type}`);
      this.requireSize(description, 78);
      const avcC = this.requireBox(this.boxes(description.start + 78, description.end), "avcC");
      this.requireSize(avcC, 7);
      if (this.buffer[avcC.start] !== 1) throw new Error("Unsupported H.264 configuration version");
      const length = (this.buffer[avcC.start + 4] & 3) + 1;
      if (length === 3) throw new Error("Invalid H.264 NAL length size");
      return length;
    });

    const offsetTables = tables.filter((box) => box.type === "stco" || box.type === "co64");
    if (offsetTables.length !== 1) throw new Error("Vehicle data requires one MP4 chunk offset table");
    const chunkOffsets = offsetTables[0];
    const width = chunkOffsets.type === "co64" ? 8 : 4;
    const chunkCount = this.table(chunkOffsets, width);
    const stsc = this.requireBox(tables, "stsc");
    const runCount = this.table(stsc, 12);
    const runs: { firstChunk: number; samplesPerChunk: number; description: number }[] = [];
    for (let i = 0; i < runCount; i++) {
      const pos = stsc.start + 8 + i * 12;
      const firstChunk = this.view.getUint32(pos);
      const samplesPerChunk = this.view.getUint32(pos + 4);
      const description = this.view.getUint32(pos + 8);
      if ((i === 0 ? firstChunk !== 1 : firstChunk <= runs[i - 1].firstChunk) || firstChunk > chunkCount || samplesPerChunk === 0 || description < 1 || description > nalLengths.length) {
        throw new Error("Invalid MP4 sample-to-chunk mapping");
      }
      runs.push({ firstChunk, samplesPerChunk, description });
    }
    if (runs.length === 0 || chunkCount === 0) throw new Error("MP4 video sample chunks are empty");

    const mdats = top.filter((box) => box.type === "mdat");
    const samples: VideoSample[] = [];
    let decodeTime = 0;
    let runIndex = 0;
    for (let chunk = 1; chunk <= chunkCount; chunk++) {
      if (runIndex + 1 < runs.length && runs[runIndex + 1].firstChunk === chunk) runIndex++;
      const run = runs[runIndex];
      const pos = chunkOffsets.start + 8 + (chunk - 1) * width;
      let offset = width === 8 ? Number(this.view.getBigUint64(pos)) : this.view.getUint32(pos);
      if (!Number.isSafeInteger(offset)) throw new Error("MP4 chunk offset exceeds safe integer range");
      if (run.samplesPerChunk > sampleCount - samples.length) throw new Error("MP4 chunk sample count does not match video samples");
      for (let i = 0; i < run.samplesPerChunk; i++) {
        const sample = samples.length;
        const size = sizes[sample];
        if (!mdats.some((mdat) => offset >= mdat.start && offset <= mdat.end - size)) {
          throw new Error("MP4 video sample is outside media data");
        }
        const presentationTime = decodeTime + composition[sample];
        if (!Number.isSafeInteger(presentationTime) || !Number.isSafeInteger(decodeTime + durations[sample])) throw new Error("MP4 sample timing exceeds safe integer range");
        samples.push({ offset, size, timeMs: presentationTime / timescale * 1000, nalLengthSize: nalLengths[run.description - 1] });
        decodeTime += durations[sample];
        offset += size;
      }
    }
    if (samples.length !== sampleCount) throw new Error("MP4 chunk sample count does not match video samples");
    const edits = track.boxes.filter((box) => box.type === "edts");
    if (edits.length > 1) throw new Error("MP4 video track has duplicate edit lists");
    if (edits.length === 1) {
      const edit = this.requireBox(this.boxes(edits[0].start, edits[0].end), "elst");
      this.requireSize(edit, 8);
      const wide = this.buffer[edit.start] === 1;
      const count = this.table(edit, wide ? 20 : 12);
      if (count !== 1) throw new Error("MP4 vehicle data supports only a full-length identity edit");
      const pos = edit.start + 8;
      const duration = wide ? this.view.getBigUint64(pos) : BigInt(this.view.getUint32(pos));
      const mediaTime = wide ? this.view.getBigInt64(pos + 8) : BigInt(this.view.getInt32(pos + 4));
      const rate = pos + (wide ? 16 : 8);
      const movieScale = this.timescale(this.requireBox(movieBoxes, "mvhd"));
      // Tesla's full-length edit changes neither the media origin nor its rate.
      // Other edit layouts require an explicit presentation-time transform.
      if (mediaTime !== 0n || this.view.getInt16(rate) !== 1 || this.view.getInt16(rate + 2) !== 0 || duration * BigInt(timescale) !== BigInt(decodeTime) * BigInt(movieScale)) {
        throw new Error("MP4 vehicle data supports only a full-length identity edit");
      }
    }
    const byOffset = [...samples].sort((a, b) => a.offset - b.offset);
    if (byOffset.some((sample, i) => i > 0 && sample.offset < byOffset[i - 1].offset + byOffset[i - 1].size)) {
      throw new Error("MP4 video samples overlap");
    }
    return samples;
  }

  /** Strip H.264 emulation prevention bytes (0x00 0x00 0x03 -> 0x00 0x00) */
  private stripEmulationBytes(data: Uint8Array): Uint8Array {
    const out: number[] = [];
    let zeros = 0;
    for (const byte of data) {
      if (zeros >= 2 && byte === 0x03) {
        zeros = 0;
        continue;
      }
      out.push(byte);
      zeros = byte === 0 ? zeros + 1 : 0;
    }
    return Uint8Array.from(out);
  }

  /** Decode a single SEI NAL unit, looking for Tesla marker */
  private decodeSei(
    nal: Uint8Array,
    SeiMetadata: protobuf.Type
  ): SeiFrame | null {
    if (nal.length < 4) return null;

    // Scan for Tesla marker: consecutive 0x42 bytes followed by 0x69
    let i = 3;
    while (i < nal.length && nal[i] === 0x42) i++;
    if (i <= 3 || i + 1 >= nal.length || nal[i] !== 0x69) return null;

    const payload = this.stripEmulationBytes(nal.subarray(i + 1, nal.length - 1));
    let msg: Record<string, unknown>;
    try {
      msg = SeiMetadata.toObject(SeiMetadata.decode(payload), { defaults: true, longs: Number });
    } catch (error) {
      throw new Error("Cannot decode Tesla vehicle data", { cause: error });
    }
    const frame: SeiFrame = {
      frameSeqNo: msg.frameSeqNo as number,
      vehicleSpeedMps: msg.vehicleSpeedMps as number,
      acceleratorPedalPosition: msg.acceleratorPedalPosition as number,
      steeringWheelAngle: msg.steeringWheelAngle as number,
      gearState: msg.gearState as number,
      autopilotState: msg.autopilotState as number,
      brakeApplied: msg.brakeApplied as boolean,
      blinkerOnLeft: msg.blinkerOnLeft as boolean,
      blinkerOnRight: msg.blinkerOnRight as boolean,
      latitudeDeg: msg.latitudeDeg as number,
      longitudeDeg: msg.longitudeDeg as number,
      headingDeg: msg.headingDeg as number,
    };
    if (!Number.isSafeInteger(frame.frameSeqNo)) throw new Error("Vehicle data frame sequence is not a safe integer");
    for (const [field, value] of Object.entries(frame)) {
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`Vehicle data ${field} must be finite`);
    }
    return frame;
  }

  extractTelemetry(SeiMetadata: protobuf.Type): TelemetryData | null {
    const records: { frame: SeiFrame; timeMs: number }[] = [];
    for (const sample of this.videoSamples()) {
      const end = sample.offset + sample.size;
      let cursor = sample.offset;
      while (cursor < end) {
        if (sample.nalLengthSize > end - cursor) throw new Error("Truncated H.264 video data length");
        const nalSize = this.buffer.readUIntBE(cursor, sample.nalLengthSize);
        cursor += sample.nalLengthSize;
        if (nalSize === 0 || nalSize > end - cursor) throw new Error("Invalid H.264 video data length");
        if ((this.buffer[cursor] & 0x1f) === 6 && nalSize < 2) throw new Error("Truncated H.264 SEI header");
        if ((this.buffer[cursor] & 0x1f) === 6 && this.buffer[cursor + 1] === 5) {
          const frame = this.decodeSei(this.buffer.subarray(cursor, cursor + nalSize), SeiMetadata);
          if (frame) records.push({ frame, timeMs: sample.timeMs });
        }
        cursor += nalSize;
      }
    }
    if (records.length === 0) return null;
    // A sample may contain several Tesla messages. Stable sorting preserves
    // their encoded order while composition offsets determine presentation time.
    records.sort((a, b) => a.timeMs - b.timeMs);
    return { frames: records.map((record) => record.frame), frameTimesMs: records.map((record) => record.timeMs) };
  }
}

/**
 * Extract telemetry from a Tesla dashcam MP4 file.
 * Returns null if the file has no SEI telemetry data.
 */
export async function extractTelemetry(
  filePath: string
): Promise<TelemetryData | null> {
  const buf = await readFile(filePath);
  return extractTelemetryFromBuffer(buf);
}

export async function extractTelemetryFromBuffer(
  buf: Buffer
): Promise<TelemetryData | null> {
  const SeiMetadata = await getProtoType();
  const parser = new Mp4Parser(buf);
  return parser.extractTelemetry(SeiMetadata);
}
