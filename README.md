# South Alabama Agricultural Digital Twin

Starter local 3D terrain prototype for the South Alabama Mesonet station-coordinate region.

## Run

```bash
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

## Lowest-Cost Deployment

The deployment scaffold for hourly HRRR updates is in
[`docs/lowest_cost_deploy.md`](docs/lowest_cost_deploy.md). It uses GitHub
Actions to build the latest browser-ready HRRR assets and publishes only the
static frontend plus compact weather files, not raw GRIB data.

If you already have an Oracle VPS, use
[`docs/oracle_vps_deploy.md`](docs/oracle_vps_deploy.md) instead. The VPS is a
better fit for the hourly Python HRRR processing job.

For a single Oracle VPS that runs HRRR processing and serves the frontend/API
over nginx, use [`docs/oracle_vps_server.md`](docs/oracle_vps_server.md).

## Current Scope

- Three.js local terrain tile
- Real DEM heights loaded from AWS/Mapzen Terrarium elevation PNG tiles
- Overview satellite texture stitched from Esri World Imagery map tiles
- Automatic zoom-in detail patches with higher resolution satellite imagery
- South Alabama Mesonet extent derived from the provided station coordinate list
- Active station markers labeled by station id
- USDA CDL raster overlay loaded from the USDA/SCINet CDL ImageServer
- USDA NASS Crop Sequence Boundaries layer loaded from `data/csb-mesonet-simplified.geojson`
- CSB field boundaries assigned 2025 CDL majority crop classes in `data/csb-mesonet-crops.geojson`
- Mobile Bay / Gulf Coast bathymetry and land elevation where available
- Station anchor placeholders for future Mesonet metadata
- Cloud volumes and Mesonet station labels

## Weather Twin Roadmap

The proposed real-time 3D cloud twin architecture has been added in
[`docs/cloud_twin_solution.md`](docs/cloud_twin_solution.md). It fits this
project as the weather/atmospheric layer above the current terrain,
station, crop, and field-boundary prototype.

The first implementation contract for cropped HRRR volume frames is documented
in [`docs/weather_data_format.md`](docs/weather_data_format.md).

Recommended integration path:

- Keep the current Three.js terrain scene as the geospatial base layer
- Add HRRR-derived weather data as a server-preprocessed dataset, not direct
  client-side GRIB2 downloads
- Start with a small South Alabama extent using F01/F02 HRRR cloud water,
  cloud ice, rain water, and wind fields
- Prototype cloud density ingestion with static hourly frames before adding
  Semi-Lagrangian advection and WebGPU compute
- Replace the current placeholder cloud volumes with raymarched volumetric
  clouds once the data format and shader path are stable

Initial preprocessing scaffold:

```bash
.venv/bin/python scripts/prepare-hrrr-clouds.py --dry-run --date 2026-05-19T18
```

This writes a planning manifest under `data/weather/hrrr/`. Running without
`--dry-run` is reserved for an environment with HRRR dependencies installed
(`herbie-data`, `xarray`, `cfgrib`, and `eccodes`).

The first real HRRR cycle has been prepared locally:

```bash
.venv/bin/python scripts/prepare-hrrr-clouds.py --date 2026-05-19T18
```

Build the browser-ready 3D cloud texture from the prepared frame:

```bash
.venv/bin/python scripts/build-cloud-volume.py
```

## Next Layers

- Replace station anchors with authoritative South Alabama Mesonet station metadata
- Apply satellite imagery or land cover as the terrain texture
- Load crop masks from GeoJSON, vector tiles, or mesh overlays
- Add HRRR/WRF weather grid and time controls
- Render clouds from HRRR/WRF humidity, cloud water, or cloud ice variables
- Add a server-side weather preprocessing pipeline for cropped float16/VDB volumes
