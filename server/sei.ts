import { readFile } from "fs/promises";
import path from "path";
import protobuf from "protobufjs";

export interface SeiFrame {
  frameSeqNo: number;
  vehicleSpeedMps: number;
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
        // Extended size (64-bit)
        const high = this.view.getUint32(pos + 8);
        const low = this.view.getUint32(pos + 12);
        size = Number((BigInt(high) << 32n) | BigInt(low));
        headerSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }

      if (size < 8 || pos + size > end) break;

      if (type === name) {
        return { start: pos + headerSize, end: pos + size, size: size - headerSize };
      }
      pos += size;
    }
    return null;
  }

  /** Find mdat box and return its content bounds */
  private findMdat(): { offset: number; size: number } | null {
    const box = this.findBox(0, this.buffer.length, "mdat");
    if (!box) return null;
    return { offset: box.start, size: box.size };
  }

  /** Navigate moov > trak > mdia to get timescale and stts entries */
  parseFrameDurations(): number[] | null {
    const moov = this.findBox(0, this.buffer.length, "moov");
    if (!moov) return null;

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
          const handlerType = this.readAscii(hdlr.start + 8, 4);
          if (handlerType === "vide") {
            return this.parseStts(mdia);
          }
        }
      }

      // Move past this trak to find next
      trakStart = trak.end;
    }
    return null;
  }

  private parseStts(
    mdia: { start: number; end: number }
  ): number[] | null {
    // Get timescale from mdhd
    const mdhd = this.findBox(mdia.start, mdia.end, "mdhd");
    if (!mdhd) return null;

    const mdhdVersion = this.buffer[mdhd.start];
    const timescale =
      mdhdVersion === 1
        ? this.view.getUint32(mdhd.start + 20)
        : this.view.getUint32(mdhd.start + 12);
    if (timescale === 0) return null;

    // Navigate to stts
    const stbl = this.findBox(mdia.start, mdia.end, "minf");
    if (!stbl) return null;
    const stblBox = this.findBox(stbl.start, stbl.end, "stbl");
    if (!stblBox) return null;
    const stts = this.findBox(stblBox.start, stblBox.end, "stts");
    if (!stts) return null;

    const entryCount = this.view.getUint32(stts.start + 4);
    const durations: number[] = [];
    let pos = stts.start + 8;
    for (let i = 0; i < entryCount; i++) {
      if (pos + 8 > stts.end) break;
      const count = this.view.getUint32(pos);
      const delta = this.view.getUint32(pos + 4);
      const ms = (delta / timescale) * 1000;
      for (let j = 0; j < count; j++) durations.push(ms);
      pos += 8;
    }
    return durations.length > 0 ? durations : null;
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

    try {
      const payload = this.stripEmulationBytes(
        nal.subarray(i + 1, nal.length - 1)
      );
      const msg = SeiMetadata.decode(payload) as protobuf.Message & Record<string, unknown>;
      return {
        frameSeqNo: Number((msg.frameSeqNo as number | bigint) || 0),
        vehicleSpeedMps: (msg.vehicleSpeedMps as number) || 0,
        steeringWheelAngle: (msg.steeringWheelAngle as number) || 0,
        gearState: (msg.gearState as number) || 0,
        autopilotState: (msg.autopilotState as number) || 0,
        brakeApplied: (msg.brakeApplied as boolean) || false,
        blinkerOnLeft: (msg.blinkerOnLeft as boolean) || false,
        blinkerOnRight: (msg.blinkerOnRight as boolean) || false,
        latitudeDeg: (msg.latitudeDeg as number) || 0,
        longitudeDeg: (msg.longitudeDeg as number) || 0,
        headingDeg: (msg.headingDeg as number) || 0,
      };
    } catch {
      return null;
    }
  }

  /** Extract all SEI messages from mdat */
  extractSeiMessages(SeiMetadata: protobuf.Type): SeiFrame[] {
    const mdat = this.findMdat();
    if (!mdat) return [];

    const frames: SeiFrame[] = [];
    let cursor = mdat.offset;
    const end = mdat.offset + mdat.size;

    while (cursor + 4 <= end) {
      const nalSize = this.view.getUint32(cursor);
      cursor += 4;

      if (nalSize < 2 || cursor + nalSize > this.buffer.length) {
        cursor += Math.max(nalSize, 0);
        continue;
      }

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
  const SeiMetadata = await getProtoType();
  const buf = await readFile(filePath);

  const parser = new Mp4Parser(buf);
  const frames = parser.extractSeiMessages(SeiMetadata);
  if (frames.length === 0) return null;

  const durations = parser.parseFrameDurations();

  // Build cumulative time offsets from stts durations
  // Then map each SEI frame to its video time using frameSeqNo
  // frameSeqNo values are absolute — normalize to segment-relative indices
  const minSeq = frames.reduce((m, f) => Math.min(m, f.frameSeqNo), Infinity);

  let frameTimesMs: number[];
  if (durations && durations.length > 0) {
    // Cumulative time for each video frame index
    const cumulative = new Float64Array(durations.length + 1);
    for (let i = 0; i < durations.length; i++) {
      cumulative[i + 1] = cumulative[i] + durations[i];
    }
    // Map each telemetry frame to its start time (segment-relative)
    frameTimesMs = frames.map((f) => {
      const relIdx = Math.min(f.frameSeqNo - minSeq, durations.length - 1);
      return cumulative[Math.max(0, relIdx)];
    });
  } else {
    // Fallback: assume ~36fps, evenly spaced by relative sequence number
    frameTimesMs = frames.map((f) => (f.frameSeqNo - minSeq) * (1000 / 36));
  }

  return { frameTimesMs, frames };
}
