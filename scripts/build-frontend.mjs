#!/usr/bin/env node
/*
 * Build the static frontend bundle for CDN deploy (Vercel / Netlify / Pages).
 *
 * Outputs to dist/:
 *   - index.html with WEATHER3D_API_BASE / WEATHER3D_DATA_BASE injected
 *   - main.min.js (esbuild bundled + minified)
 *   - styles.css (copied verbatim)
 *
 * Env vars (read at build time, baked into dist/index.html):
 *   BACKEND_BASE   default: "" (means same-origin / dev mode)
 *
 * Examples:
 *   # Local dev build (defaults, same-origin):
 *   npm run build
 *
 *   # Production: frontend on Vercel, backend on Oracle VPS:
 *   BACKEND_BASE=https://weather3d.example.com npm run build
 */

import { build } from "esbuild";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(root, "dist");

const BACKEND_BASE = (process.env.BACKEND_BASE ?? "").replace(/\/+$/, "");

const apiBase = BACKEND_BASE ? `${BACKEND_BASE}/api/hrrr` : "./data/weather/hrrr";
const dataBase = BACKEND_BASE ? `${BACKEND_BASE}/api/data` : "./data";

await mkdir(out, { recursive: true });

console.log(`Bundling main.js -> dist/main.min.js`);
await build({
  entryPoints: [resolve(root, "main.js")],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  legalComments: "none",
  external: ["three", "three/addons/*"],
  outfile: resolve(out, "main.min.js"),
});

console.log(`Baking dist/index.html (BACKEND_BASE="${BACKEND_BASE || "(same-origin)"}")`);
const indexHtml = await readFile(resolve(root, "index.html"), "utf8");

const cacheBuster = Date.now().toString(36);
const injection = `
    <script>
      window.WEATHER3D_API_BASE  = ${JSON.stringify(apiBase)};
      window.WEATHER3D_DATA_BASE = ${JSON.stringify(dataBase)};
    </script>`;

const swapped = indexHtml
  // Remove dev-mode comments + dev script tag.
  .replace(/\n\s*<!-- Dev:.*?-->\n\s*<!-- Prod:.*?-->/s, "")
  .replace(
    /<script type="module" src="\.\/main\.js[^"]*"><\/script>/,
    `${injection}\n    <script type="module" src="./main.min.js?v=${cacheBuster}"></script>`
  )
  // Drop the importmap version pin in favor of a single CDN URL — but in
  // practice the importmap is fine and lets three.js stay an external. Keep.
  ;

if (!swapped.includes("main.min.js")) {
  console.error("Failed to rewrite index.html script tag; check the regex against the current file.");
  process.exit(1);
}

await writeFile(resolve(out, "index.html"), swapped);

console.log(`Copying styles.css -> dist/styles.css`);
await copyFile(resolve(root, "styles.css"), resolve(out, "styles.css"));

console.log(`\nDone. Deploy contents of dist/:`);
console.log(`  index.html`);
console.log(`  main.min.js`);
console.log(`  styles.css`);
