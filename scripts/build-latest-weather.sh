#!/usr/bin/env bash
set -euo pipefail

FORECAST_HOURS="${FORECAST_HOURS:-1 2}"
LATEST_LOOKBACK="${LATEST_LOOKBACK:-12}"
# Prefer the project venv if it exists; otherwise fall back to system python3.
if [ -z "${PYTHON_BIN:-}" ]; then
  if [ -x ".venv/bin/python" ]; then
    PYTHON_BIN=".venv/bin/python"
  else
    PYTHON_BIN="python3"
  fi
fi
CLEAN_HRRR_GRIB="${CLEAN_HRRR_GRIB:-1}"
KEEP_HRRR_CYCLES="${KEEP_HRRR_CYCLES:-2}"

${PYTHON_BIN} scripts/prepare-hrrr-clouds.py \
  --latest \
  --latest-lookback "${LATEST_LOOKBACK}" \
  --fxx ${FORECAST_HOURS}

CYCLE="$(${PYTHON_BIN} -c 'import json; print(json.load(open("data/weather/hrrr/latest.json"))["cycle_id"])')"

for FXX in ${FORECAST_HOURS}; do
  FRAME="data/weather/hrrr/${CYCLE}/f$(printf "%02d" "${FXX}").npz"

  if [ ! -f "${FRAME}" ]; then
    echo "Missing prepared frame: ${FRAME}" >&2
    exit 1
  fi

  ${PYTHON_BIN} scripts/build-cloud-volume.py \
    --frame "${FRAME}" \
    --name "cloud-water-f$(printf "%02d" "${FXX}")"

  ${PYTHON_BIN} scripts/build-wind-volume.py \
    --frame "${FRAME}" \
    --name "wind-f$(printf "%02d" "${FXX}")"
done

FIRST_FXX="$(printf "%02d" "$(printf "%s\n" ${FORECAST_HOURS} | head -n 1)")"
SECOND_FXX="$(printf "%02d" "$(printf "%s\n" ${FORECAST_HOURS} | tail -n 1)")"
${PYTHON_BIN} scripts/build-rain-preview.py \
  --frame0 "data/weather/hrrr/${CYCLE}/f${FIRST_FXX}.npz" \
  --frame1 "data/weather/hrrr/${CYCLE}/f${SECOND_FXX}.npz"

if [ "${CLEAN_HRRR_GRIB}" = "1" ]; then
  rm -rf data/weather/hrrr/grib
fi

if [ "${KEEP_HRRR_CYCLES}" -gt 0 ]; then
  OLD_CYCLES="$(find data/weather/hrrr -mindepth 1 -maxdepth 1 -type d -name '[0-9]*' \
    | sort -r \
    | tail -n +"$((KEEP_HRRR_CYCLES + 1))")"
  if [ -n "${OLD_CYCLES}" ]; then
    printf "%s\n" "${OLD_CYCLES}" | xargs rm -rf
  fi
fi

echo "Built browser weather assets for HRRR cycle ${CYCLE}"
