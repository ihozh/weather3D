#!/usr/bin/env bash
set -euo pipefail

: "${R2_BUCKET:?Set R2_BUCKET to the target bucket name.}"
: "${R2_ENDPOINT_URL:?Set R2_ENDPOINT_URL to your Cloudflare R2 S3 endpoint.}"

AWS_ARGS=(
  --endpoint-url "${R2_ENDPOINT_URL}"
)

aws "${AWS_ARGS[@]}" s3 sync . "s3://${R2_BUCKET}/" \
  --delete \
  --exclude "*" \
  --include "index.html" \
  --include "main.js" \
  --include "styles.css" \
  --include "data/csb-mesonet-crops.geojson" \
  --include "data/weather/hrrr/latest.json" \
  --include "data/weather/hrrr/*/manifest.json" \
  --include "data/weather/hrrr/cloud-preview.json" \
  --include "data/weather/hrrr/rain-preview.json" \
  --include "data/weather/hrrr/wind-preview.json" \
  --include "data/weather/hrrr/cloud-particles.json" \
  --include "data/weather/hrrr/volume/*" \
  --include "data/weather/hrrr/wind-volume/*" \
  --cache-control "public, max-age=300"

aws "${AWS_ARGS[@]}" s3 cp "data/weather/hrrr/latest.json" "s3://${R2_BUCKET}/data/weather/hrrr/latest.json" \
  --cache-control "no-cache" \
  --content-type "application/json"

CURRENT_MANIFEST="$(python -c 'import json; print("data/weather/hrrr/" + json.load(open("data/weather/hrrr/latest.json"))["manifest"])')"
aws "${AWS_ARGS[@]}" s3 cp "${CURRENT_MANIFEST}" "s3://${R2_BUCKET}/${CURRENT_MANIFEST}" \
  --cache-control "no-cache" \
  --content-type "application/json"

echo "Published static site and browser-ready weather assets to s3://${R2_BUCKET}"
