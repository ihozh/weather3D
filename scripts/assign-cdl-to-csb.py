from collections import Counter
from pathlib import Path

import geopandas as gpd
import numpy as np
import rasterio
from rasterio.features import geometry_mask
from rasterio.windows import from_bounds


CSB_INPUT = Path("data/csb-mesonet-simplified.geojson")
CDL_RASTER = Path("2025_30m_cdls/2025_30m_cdls.tif")
OUTPUT = Path("data/csb-mesonet-crops.geojson")


CDL_CLASSES = {
    1: "Corn",
    2: "Cotton",
    3: "Rice",
    4: "Sorghum",
    5: "Soybeans",
    6: "Sunflower",
    10: "Peanuts",
    24: "Winter Wheat",
    28: "Oats",
    36: "Alfalfa",
    37: "Other Hay/Non Alfalfa",
    42: "Dry Beans",
    43: "Potatoes",
    44: "Other Crops",
    45: "Sugarcane",
    58: "Clover/Wildflowers",
    61: "Fallow/Idle Cropland",
    62: "Pasture/Grass",
    63: "Forest",
    64: "Shrubland",
    81: "Clouds/No Data",
    82: "Developed",
    83: "Water",
    87: "Wetlands",
    88: "Nonag/Undefined",
    111: "Open Water",
    121: "Developed/Open Space",
    122: "Developed/Low Intensity",
    123: "Developed/Med Intensity",
    124: "Developed/High Intensity",
    141: "Deciduous Forest",
    142: "Evergreen Forest",
    143: "Mixed Forest",
    152: "Shrubland",
    176: "Grassland/Pasture",
    190: "Woody Wetlands",
    195: "Herbaceous Wetlands",
}


def mode_for_geometry(src, geom):
    minx, miny, maxx, maxy = geom.bounds
    window = from_bounds(minx, miny, maxx, maxy, src.transform)
    window = window.round_offsets().round_lengths()

    if window.width <= 0 or window.height <= 0:
        return None, 0

    data = src.read(1, window=window, masked=True)
    if data.size == 0:
        return None, 0

    transform = src.window_transform(window)
    mask = geometry_mask(
        [geom],
        out_shape=data.shape,
        transform=transform,
        invert=True,
        all_touched=True,
    )

    values = np.asarray(data)[mask]
    if np.ma.isMaskedArray(data):
        values = values[~np.asarray(data.mask)[mask]]
    values = values[(values > 0) & (values != 255)]

    if values.size == 0:
        return None, 0

    counts = Counter(values.astype(int).tolist())
    code, count = counts.most_common(1)[0]
    return code, count


def main():
    print(f"Reading {CSB_INPUT}")
    fields = gpd.read_file(CSB_INPUT)
    print(f"Fields: {len(fields)}")

    with rasterio.open(CDL_RASTER) as src:
      raster_crs = src.crs
      print(f"CDL CRS: {raster_crs}")
      working = fields.to_crs(raster_crs)

      crop_codes = []
      crop_names = []
      crop_pixels = []

      for index, geom in enumerate(working.geometry):
          code, pixels = mode_for_geometry(src, geom)
          crop_codes.append(code if code is not None else -1)
          crop_names.append(CDL_CLASSES.get(code, "Unknown") if code is not None else "No Data")
          crop_pixels.append(pixels)

          if (index + 1) % 2500 == 0:
              print(f"Processed {index + 1}/{len(working)}")

    fields["crop_code"] = crop_codes
    fields["crop_name"] = crop_names
    fields["crop_pixels"] = crop_pixels
    fields = fields[fields["crop_code"] != -1].copy()
    print(f"Writing {OUTPUT}, features with crop: {len(fields)}")
    fields.to_file(OUTPUT, driver="GeoJSON")


if __name__ == "__main__":
    main()
