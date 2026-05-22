# Weather Volume Data Format

This project starts the weather twin pipeline with a compact per-cycle HRRR
manifest plus cropped `.npz` frames. The format is intentionally simple so the
frontend can load a static hourly cloud field before WebGPU advection is added.

## Directory Layout

```text
data/weather/hrrr/
  grib/
    hrrr/
      20260519/
        subset_...wrfprsf01.grib2
  2026051918/
    manifest.json
    f01.npz
    f02.npz
```

## Manifest

`manifest.json` describes the model cycle, requested bounds, variables, and
frame status.

Key fields:

- `schema`: currently `hrrr-cloud-frame-manifest/v0`
- `cycle_utc`: UTC HRRR model cycle
- `region`: `west`, `south`, `east`, `north` lon/lat bounds
- `forecast_hours`: usually `[1, 2]` for the first real-time prototype
- `variables`: canonical project variable names and GRIB search fragments
- `frames`: one entry per forecast hour, pointing to `fXX.npz`

Frame `status` values:

- `planned`: dry-run only, no data file yet
- `downloaded`: GRIB was fetched, packing was skipped
- `prepared`: cropped `.npz` frame was written

## NPZ Frame

Each `fXX.npz` frame stores float16 arrays shaped as:

```text
[z, y, x]
```

Expected arrays:

- `cloud_water`
- `cloud_ice`
- `rain_water`
- `u_wind`
- `v_wind`
- `vertical_velocity`
- `latitude`
- `longitude`
- `levels`
- `variable_names`

Longitude is normalized to `[-180, 180]`. Missing values are packed as `0`.
For HRRR pressure-level files, `vertical_velocity` is currently `VVEL` in
`Pa s-1`; conversion to geometric vertical velocity can be added later when the
renderer needs physical vertical displacement.

## Browser 3D Texture

`scripts/build-cloud-volume.py` converts the prepared NPZ frame into a compact
uint8 volume for Three.js:

```text
data/weather/hrrr/volume/
  cloud-water-f01.json
  cloud-water-f01.u8
```

The raw `.u8` file is ordered as:

```text
[z, y, x]
```

The current renderer loads it as a `THREE.Data3DTexture` and raymarches the
volume in the terrain scene. This path uses `cloud_water` now and will include
`cloud_ice` automatically if that field exists in the prepared NPZ.

## Current Command

Dry-run, no network:

```bash
python3 scripts/prepare-hrrr-clouds.py --dry-run --date 2026-05-19T18
```

Download and pack, once dependencies are available:

```bash
python3 scripts/prepare-hrrr-clouds.py --date 2026-05-19T18
```

Pack an existing GRIB file:

```bash
python3 scripts/prepare-hrrr-clouds.py \
  --date 2026-05-19T18 \
  --local-grib 1=/path/to/f01.grib2 \
  --fxx 1
```
