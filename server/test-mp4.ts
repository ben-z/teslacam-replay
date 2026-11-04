function box(type: string, bytes: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, bytes]);
}

export function captureTimeFromFilename(name: string): number {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!match) throw new Error(`Fixture filename has no timestamp: ${name}`);
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`);
  if (!Number.isFinite(parsed)) throw new Error(`Fixture filename has an invalid timestamp: ${name}`);
  return parsed;
}

/** A video-sized media box separates the movie header from the file header. */
export function timingMp4(captureTimeMs: number): Buffer {
  const movie = Buffer.alloc(100);
  const creationSeconds = captureTimeMs / 1000 + 2_082_844_800;
  movie.writeUInt32BE(creationSeconds, 4);
  movie.writeUInt32BE(creationSeconds, 8);
  movie.writeUInt32BE(1000, 12);
  movie.writeUInt32BE(60_000, 16);
  return Buffer.concat([
    box("ftyp", Buffer.from("isom0000")),
    box("mdat", Buffer.alloc(64 * 1024)),
    box("moov", box("mvhd", movie)),
  ]);
}

export function timingRangeResponse(bytes: Buffer, input: string | URL | Request, init: RequestInit | undefined): Response {
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("Range") ?? "");
  if (!match) throw new Error("Recording metadata fixtures require a byte range");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end >= bytes.length) throw new Error(`Fixture range exceeds the file: ${start}-${end}/${bytes.length}`);
  return new Response(new Uint8Array(bytes.subarray(start, end + 1)), {
    status: 206,
    headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(end - start + 1) },
  });
}
