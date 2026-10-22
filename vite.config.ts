import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";

const encoders = { br: promisify(brotliCompress), gz: promisify(gzip) };

export default defineConfig({
  plugins: [react(), {
    name: "precompress-assets",
    async writeBundle(options, bundle) {
      const outputDirectory = options.dir;
      if (!outputDirectory) throw new Error("Asset compression requires an output directory");
      const assets = Object.values(bundle).filter((asset) => /\.(js|css)$/.test(asset.fileName));
      if (assets.length === 0) throw new Error("No JavaScript or CSS assets were emitted for compression");
      await Promise.all(assets.map(async (asset) => {
        const source = asset.type === "chunk" ? asset.code : asset.source;
        const bytes = typeof source === "string" ? Buffer.from(source) : source;
        await Promise.all(Object.entries(encoders).map(async ([extension, encode]) => {
          await writeFile(join(outputDirectory, `${asset.fileName}.${extension}`), await encode(bytes));
        }));
      }));
    },
  }],
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
