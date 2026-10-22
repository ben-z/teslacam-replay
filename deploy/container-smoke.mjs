import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const config = { port: 3001, requestTimeoutMs: 5_000 };
const folders = ["SavedClips", "SentryClips", "RecentClips"].map((name) => ({
  id: name, name, mimeType: "application/vnd.google-apps.folder",
}));
const drive = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname === "/healthz") response.end(JSON.stringify({ status: "ok" }));
  else if (url.pathname === "/api/list") response.end(JSON.stringify({ folderId: "root", files: folders }));
  else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: `Unexpected Drive request: ${request.url}` }));
  }
});
drive.listen(0, "127.0.0.1");
await once(drive, "listening");
process.env.GDRIVE_BASE_URL = `http://127.0.0.1:${drive.address().port}`;
process.env.PORT = String(config.port);
process.env.APP_ORIGIN = `http://127.0.0.1:${config.port}`;
assert.equal(process.env.SERVE_FRONTEND, "true");
execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
await import("/app/server/index.ts");

async function request(path, headers) {
  const response = await fetch(`${process.env.APP_ORIGIN}${path}`, {
    signal: AbortSignal.timeout(config.requestTimeoutMs),
    headers,
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}
const version = await request("/api/version", { "Accept-Encoding": "br, gzip" });
assert.equal(version.headers.get("Content-Type"), "application/json");
assert.equal(version.headers.get("Content-Encoding"), null);
assert.equal((await version.json()).version, "image-smoke");
assert.equal((await (await request("/healthz")).json()).status, "ok");
const html = await (await request("/")).text();
assert.match(html, /<div id="root">/);
const assets = [...html.matchAll(/(?:src|href)="((?:\.\/|\/)assets\/[^"?#]+)"/g)].map((match) => new URL(match[1], process.env.APP_ORIGIN).pathname);
assert(assets.some((asset) => asset.endsWith(".js")), "Frontend JavaScript is absent");
assert(assets.some((asset) => asset.endsWith(".css")), "Frontend CSS is absent");
for (const asset of assets) {
  const original = await readFile(`/app/dist${asset}`);
  assert(original.length > 0, `${asset} is empty`);
  for (const [encoding, extension, decode] of [
    ["br", "br", brotliDecompressSync],
    ["gzip", "gz", gunzipSync],
  ]) {
    const encoded = await readFile(`/app/dist${asset}.${extension}`);
    assert.deepEqual(decode(encoded), original, `${asset}.${extension} changed the asset`);
    const response = await request(asset, { "Accept-Encoding": encoding });
    assert.equal(response.headers.get("Content-Encoding"), encoding);
    assert.equal(response.headers.get("Content-Length"), String(encoded.length));
    assert.match(response.headers.get("Vary"), /(?:^|,)\s*Accept-Encoding\s*(?:,|$)/i);
    assert.equal(response.headers.get("Content-Type"), asset.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), original, `${asset} was changed or compressed twice`);
  }
  const uncompressed = await request(asset, { "Accept-Encoding": "identity" });
  assert.equal(uncompressed.headers.get("Content-Encoding"), null);
  assert.equal(uncompressed.headers.get("Content-Length"), String(original.length));
  assert.deepEqual(Buffer.from(await uncompressed.arrayBuffer()), original);
}
const { hlsCacheDir } = await import("/app/server/hls.ts");
const recording = "2026-10-22_12-00-00";
const chunk = "chunk_0123456789abcdef_000.ts";
const chunkPath = join(hlsCacheDir("SavedClips", recording, recording, "front"), chunk);
const transportBytes = Buffer.alloc(188 * 64, 0x47);
await mkdir(dirname(chunkPath), { recursive: true });
await writeFile(chunkPath, transportBytes);
const media = await request(`/api/hls/SavedClips/${recording}/${recording}/front/${chunk}`, { "Accept-Encoding": "br, gzip" });
assert.equal(media.headers.get("Content-Encoding"), null);
assert.equal(media.headers.get("Content-Type"), "video/mp2t");
assert.equal(media.headers.get("Content-Length"), String(transportBytes.length));
assert.equal(media.headers.get("Cache-Control"), "public, max-age=86400");
assert.deepEqual(Buffer.from(await media.arrayBuffer()), transportBytes);
console.log("Packaged application, Drive connection, ffmpeg, exact frontend encodings and uncompressed HLS transport passed.");
process.exit(0);
