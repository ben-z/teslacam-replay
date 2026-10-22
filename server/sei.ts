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

class Mp4Parser {
  private buffer: Buffer;
  private view: DataView;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  private readAscii(offset: number, len: number): string {
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(this.buffer[offset + i]);
    return s;
  }

  private findBox(
    start: number,
    end: number,
    name: string
  ): { start: number; end: number; size: number } | null {
    for (let pos = start; pos + 8 <= end; ) {
      let size = this.view.getUint32(pos);
      const type = this.readAscii(pos + 4, 4);
      let headerSize = 8;

      if (size === 1) {
        if (pos + 16 > end) throw new Error(`Truncated MP4 ${type} box header`);
        // Extended size (64-bit)
        const high = this.view.getUint32(pos + 8);
        const low = this.view.getUint32(pos + 12);
        size = Number((BigInt(high) << 32n) | BigInt(low));
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }

      if (size < headerSize || pos + size > end) throw new Error(`Invalid MP4 ${type} box size`);

      if (type === name) {
        return { start: pos + headerSize, end: pos + size, size: size - headerSize };
      }
      pos += size;
    }
    return null;
  }

  /** Find mdat box and return its content bounds */
  private findMdat(): { start: number; end: number } | null {
    return this.findBox(0, this.buffer.length, "mdat");
  }

  /** Navigate moov > trak > mdia to get timescale and stts entries */
  parseFrameDurations(): number[] {
    const moov = this.findBox(0, this.buffer.length, "moov");
    if (!moov) throw new Error("Vehicle data requires the MP4 movie timing table");

    // Find first video trak (iterate traks, look for video handler)
    let trakStart = moov.start;
    while (trakStart < moov.end) {
      const trak = this.findBox(trakStart, moov.end, "trak");
      if (!trak) break;

      const mdia = this.findBox(trak.start, trak.end, "mdia");
      if (mdia) {
        // Check handler type (hdlr box)
        const hdlr = this.findBox(mdia.start, mdia.end, "hdlr");
        if (hdlr) {
          if (hdlr.size < 12) throw new Error("Truncated MP4 handler box");
          const handlerType = this.readAscii(hdlr.start + 8, 4);
          if (handlerType === "vide") {
            return this.parseStts(mdia);
          }
        }
      }

      // Move past this trak to find next
      trakStart = trak.end;
    }
    throw new Error("Vehicle data requires a video track with sample timing");
  }

  private parseStts(
    mdia: { start: number; end: number }
  ): number[] {
    // Get timescale from mdhd
    const mdhd = this.findBox(mdia.start, mdia.end, "mdhd");
    if (!mdhd) throw new Error("Vehicle data requires the MP4 media clock");

    const mdhdVersion = this.buffer[mdhd.start];
    if (mdhdVersion !== 0 && mdhdVersion !== 1) throw new Error(`Unsupported MP4 media clock version: ${mdhdVersion}`);
    const timescaleOffset = mdhdVersion === 1 ? 20 : 12;
    if (mdhd.size < timescaleOffset + 4) throw new Error("Truncated MP4 media clock");
    const timescale = this.view.getUint32(mdhd.start + timescaleOffset);
    if (timescale === 0) throw new Error("MP4 media clock has zero timescale");

    // Navigate to stts
    const stbl = this.findBox(mdia.start, mdia.end, "minf");
    if (!stbl) throw new Error("Vehicle data requires an MP4 sample table");
    const stblBox = this.findBox(stbl.start, stbl.end, "stbl");
    if (!stblBox) throw new Error("Vehicle data requires an MP4 sample table");
    const stts = this.findBox(stblBox.start, stblBox.end, "stts");
    if (!stts) throw new Error("Vehicle data requires the MP4 sample timing table");

    if (stts.size < 8) throw new Error("Truncated MP4 sample timing table");
    const entryCount = this.view.getUint32(stts.start + 4);
    if (entryCount > (stts.size - 8) / 8) throw new Error("Truncated MP4 sample timing table");
    const durations: number[] = [];
    let pos = stts.start + 8;
    for (let i = 0; i < entryCount; i++) {
      const count = this.view.getUint32(pos);
      const delta = this.view.getUint32(pos + 4);
      if (count === 0) throw new Error("MP4 sample timing entries must have positive sample counts");
      // ISO BMFF permits a zero decoding interval for the final sample only.
      if (delta === 0 && (i !== entryCount - 1 || count !== 1)) {
        throw new Error("MP4 sample timing permits zero duration only for the final sample");
      }
      if (durations.length + count > this.buffer.length) throw new Error("MP4 sample timing count exceeds video size");
      const ms = (delta / timescale) * 1000;
      for (let j = 0; j < count; j++) durations.push(ms);
      pos += 8;
    }
    if (durations.length === 0) throw new Error("MP4 sample timing table is empty");
    return durations;
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

  /** Extract all SEI messages from mdat */
  extractSeiMessages(SeiMetadata: protobuf.Type): SeiFrame[] {
    const mdat = this.findMdat();
    if (!mdat) throw new Error("Video has no MP4 media data");

    const frames: SeiFrame[] = [];
    let cursor = mdat.start;

    while (cursor + 4 <= mdat.end) {
      const nalSize = this.view.getUint32(cursor);
      cursor += 4;

      if (nalSize < 2 || cursor + nalSize > mdat.end) throw new Error("Invalid H.264 video data length");

      // NAL type 6 = SEI, payload type 5 = user data unregistered
      if (
        (this.buffer[cursor] & 0x1f) === 6 &&
        this.buffer[cursor + 1] === 5
      ) {
        const nal = new Uint8Array(
          this.buffer.buffer,
          this.buffer.byteOffset + cursor,
          nalSize
        );
        const frame = this.decodeSei(nal, SeiMetadata);
        if (frame) frames.push(frame);
      }

      cursor += nalSize;
    }
    if (cursor !== mdat.end) throw new Error("Truncated H.264 video data length");

    return frames;
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
  const frames = parser.extractSeiMessages(SeiMetadata);
  if (frames.length === 0) return null;

  const durations = parser.parseFrameDurations();

  // Build cumulative time offsets from stts durations
  // Then map each SEI frame to its video time using frameSeqNo
  // frameSeqNo values are absolute — normalize to segment-relative indices
  const minSeq = frames.reduce((m, f) => Math.min(m, f.frameSeqNo), Infinity);

  const cumulative = new Float64Array(durations.length + 1);
  for (let i = 0; i < durations.length; i++) {
    cumulative[i + 1] = cumulative[i] + durations[i];
  }
  const frameTimesMs = frames.map((frame, index) => {
    const relativeIndex = frame.frameSeqNo - minSeq;
    if (relativeIndex >= durations.length || (index > 0 && frame.frameSeqNo <= frames[index - 1].frameSeqNo)) {
      throw new Error("Vehicle data frame sequence does not match MP4 sample timing");
    }
    return cumulative[relativeIndex];
  });

  return { frameTimesMs, frames };
}
