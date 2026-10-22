import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

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

async function request(path) {
  const response = await fetch(`${process.env.APP_ORIGIN}${path}`, {
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  return response;
}
assert.equal((await (await request("/api/version")).json()).version, "image-smoke");
assert.equal((await (await request("/healthz")).json()).status, "ok");
const html = await (await request("/")).text();
assert.match(html, /<div id="root">/);
const assets = [...html.matchAll(/(?:src|href)="((?:\.\/|\/)assets\/[^"?#]+)"/g)].map((match) => new URL(match[1], process.env.APP_ORIGIN).pathname);
assert(assets.some((asset) => asset.endsWith(".js")), "Frontend JavaScript is absent");
assert(assets.some((asset) => asset.endsWith(".css")), "Frontend CSS is absent");
for (const asset of assets) {
  const response = await request(asset);
  assert.equal(response.headers.get("Content-Encoding"), "gzip", `${asset} is uncompressed`);
  assert((await response.arrayBuffer()).byteLength > 0, `${asset} is empty`);
}
console.log("Packaged application, Drive connection, ffmpeg and frontend assets passed.");
process.exit(0);
