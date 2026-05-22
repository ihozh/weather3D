#!/usr/bin/env python3
"""Build a compact browser volume from prepared HRRR cloud fields."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert prepared HRRR cloud_water/cloud_ice fields to a uint8 3D texture.",
    )
    parser.add_argument(
        "--frame",
        type=Path,
        default=Path("data/weather/hrrr/2026051918/f01.npz"),
        help="Prepared HRRR NPZ frame.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("data/weather/hrrr/volume"),
        help="Output directory for metadata and raw volume bytes.",
    )
    parser.add_argument(
        "--name",
        default="cloud-water-f01",
        help="Output basename without extension. Default: cloud-water-f01.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frame = np.load(args.frame)

    cloud_water = frame["cloud_water"].astype("float32")
    cloud_ice = (
        frame["cloud_ice"].astype("float32")
        if "cloud_ice" in frame.files
        else np.zeros_like(cloud_water, dtype="float32")
    )

    # Prepared HRRR pressure levels are ordered low-to-high altitude:
    # 1013 hPa near the surface through 50 hPa in the stratosphere.
    # Keep that order so texture z matches visual height and wind z.
    cloud_water = np.nan_to_num(cloud_water, nan=0.0, posinf=0.0, neginf=0.0)
    cloud_ice = np.nan_to_num(cloud_ice, nan=0.0, posinf=0.0, neginf=0.0)

    def scale_channel(values: np.ndarray) -> tuple[np.ndarray, float]:
        positive = values[values > 0]
        if positive.size == 0:
            return np.zeros_like(values, dtype="uint8"), 0.0
        density_scale = float(np.percentile(positive, 99.2))
        density_scale = max(density_scale, 1e-6)
        normalized = np.clip(values / density_scale, 0.0, 1.0)
        # A gentle gamma lifts thin cloud while preserving dense cores.
        return np.round(np.power(normalized, 0.62) * 255).astype("uint8"), density_scale

    scaled_water, water_density_scale = scale_channel(cloud_water)
    scaled_ice, ice_density_scale = scale_channel(cloud_ice)
    scaled = np.stack([scaled_water, scaled_ice], axis=-1)

    out_bin = args.out_dir / f"{args.name}.u8"
    out_meta = args.out_dir / f"{args.name}.json"
    args.out_dir.mkdir(parents=True, exist_ok=True)
    scaled.tofile(out_bin)

    levels = frame["levels"].astype("float32")
    payload = {
        "schema": "hrrr-cloud-volume/u8-v0",
        "source": str(args.frame),
        "data": out_bin.name,
        "fields": ["cloud_water"] + (["cloud_ice"] if "cloud_ice" in frame.files else []),
        "shape": {
            "z": int(cloud_water.shape[0]),
            "y": int(cloud_water.shape[1]),
            "x": int(cloud_water.shape[2]),
        },
        "dtype": "uint8",
        "channels": ["cloud_water", "cloud_ice"],
        "density_scale": {
            "cloud_water": water_density_scale,
            "cloud_ice": ice_density_scale,
        },
        "level_min_hpa": float(np.min(levels)),
        "level_max_hpa": float(np.max(levels)),
        "levels_hpa": levels.astype(float).tolist(),
    }
    out_meta.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_bin} and {out_meta}")


if __name__ == "__main__":
    main()
