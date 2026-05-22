#!/usr/bin/env python3
"""Shrink data/csb-mesonet-crops.geojson for the frontend.

Two-pronged compaction:
  1. Round all (lon, lat) to 5 decimal places (~1.1 m at 31° latitude).
  2. Drop all feature properties except `crop_name` (only one the JS reads).

Run from repo root:
    python3 scripts/compact-csb.py

Re-runnable: safe to invoke on an already-compacted file.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "csb-mesonet-crops.geojson"

PRECISION = 5  # decimal places retained for lon/lat

KEEP_PROPS = {"crop_name"}


def round_coords(geom):
    """Recursively round all coordinates in a GeoJSON geometry."""
    if geom is None:
        return None
    t = geom.get("type")
    coords = geom.get("coordinates")
    if coords is None:
        return geom

    def walk(value):
        if isinstance(value, (int, float)):
            return round(value, PRECISION)
        if isinstance(value, list):
            return [walk(v) for v in value]
        return value

    return {"type": t, "coordinates": walk(coords)}


def compact_feature(feature):
    props = feature.get("properties") or {}
    return {
        "type": "Feature",
        "properties": {k: props[k] for k in KEEP_PROPS if k in props},
        "geometry": round_coords(feature.get("geometry")),
    }


def main():
    if not SRC.exists():
        raise SystemExit(f"missing source file: {SRC}")

    before = SRC.stat().st_size
    print(f"Reading {SRC} ({before / 1_048_576:.1f} MB)")

    with SRC.open() as f:
        doc = json.load(f)

    features = doc.get("features", [])
    print(f"  {len(features)} features")

    compacted = {
        "type": "FeatureCollection",
        "features": [compact_feature(f) for f in features],
    }

    tmp = SRC.with_suffix(".geojson.tmp")
    with tmp.open("w") as f:
        json.dump(compacted, f, separators=(",", ":"))  # no whitespace
    after = tmp.stat().st_size
    os.replace(tmp, SRC)

    print(f"  wrote {after / 1_048_576:.1f} MB  ({100 * after / before:.1f}% of original)")


if __name__ == "__main__":
    main()
