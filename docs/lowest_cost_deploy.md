# Lowest-Cost Deployment

This setup publishes only the static frontend and browser-ready HRRR assets.
Raw GRIB files are temporary build artifacts and are not uploaded.

## Architecture

```text
GitHub Actions hourly schedule
  -> download latest HRRR
  -> crop and pack F01/F02
  -> build cloud and wind browser volumes
  -> publish static files to Cloudflare R2
  -> serve through an R2 public/custom domain
```

## Required Cloudflare R2 Secrets

Add these repository secrets in GitHub:

```text
R2_BUCKET
R2_ENDPOINT_URL
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

`R2_ENDPOINT_URL` usually looks like:

```text
https://<account-id>.r2.cloudflarestorage.com
```

## Files Published

The publish script intentionally includes only:

```text
index.html
main.js
styles.css
data/csb-mesonet-crops.geojson
data/weather/hrrr/latest.json
data/weather/hrrr/<cycle>/manifest.json
data/weather/hrrr/cloud-preview.json
data/weather/hrrr/wind-preview.json
data/weather/hrrr/cloud-particles.json
data/weather/hrrr/volume/*
data/weather/hrrr/wind-volume/*
```

It excludes:

```text
data/weather/hrrr/grib/*
data/weather/hrrr/*/f*.npz
NationalCSB_2018-2025_rev23/*
2025_30m_cdls/*
```

## Local Smoke Test

```bash
python -m pip install -r requirements-hrrr.txt
scripts/build-latest-weather.sh
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Scheduling Note

The workflow runs at minute 35 of every hour. That gives the latest HRRR cycle
time to appear before the job searches backward with `--latest-lookback 12`.
