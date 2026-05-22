#!/usr/bin/env bash
# Bundle + minify the frontend into dist/main.min.js
# Requires npx (ships with Node). esbuild is fetched on first run.
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="dist"
OUT_FILE="$OUT_DIR/main.min.js"

mkdir -p "$OUT_DIR"

echo "Bundling main.js → $OUT_FILE"
npx -y esbuild@0.23.1 main.js \
  --bundle \
  --minify \
  --format=esm \
  --target=es2020 \
  --legal-comments=none \
  --external:three \
  --external:three/addons/* \
  --outfile="$OUT_FILE"

echo "Done. Bundle size:"
du -h "$OUT_FILE"

cat <<'EOM'

To use the bundle in production:
  1. Edit index.html and replace the main.js <script> tag with:
       <script type="module" src="./dist/main.min.js?v=<cache-buster>"></script>
  2. The importmap for three/three/addons/* must stay (esbuild leaves them as externals).
  3. Local dev still uses ./main.js (un-bundled, easier to debug).
EOM
