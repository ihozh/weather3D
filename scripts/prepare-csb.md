# Prepare USDA NASS Crop Sequence Boundaries

The frontend reads simplified clipped CSB field boundaries from:

```text
data/csb-mesonet-simplified.geojson
```

Source:

```text
https://data.nass.usda.gov/Research_and_Science/Crop-Sequence-Boundaries/index.php
```

Workflow:

1. Download the current USDA NASS CSB zip package.
2. Extract the national / regional polygon layer.
3. Clip it to the Mesonet extent:

```text
west  = -88.75
south = 30.14
east  = -85.65
north = 31.40
```

4. Reproject to EPSG:4326.
5. Export to `data/csb-mesonet.geojson`.
6. Simplify and write display output to `data/csb-mesonet-simplified.geojson`.

Example with GDAL/OGR, adjusting input layer names as needed:

```bash
ogr2ogr \
  -f GeoJSON data/csb-mesonet.geojson \
  /path/to/csb_source.gdb \
  -t_srs EPSG:4326 \
  -spat -88.75 30.14 -85.65 31.40
```

The frontend will automatically render any polygon or multipolygon features in that file.
