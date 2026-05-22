#!/usr/bin/env python3
"""Build a lightweight browser cloud preview from a prepared HRRR NPZ frame."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract visible cloud puffs from a prepared HRRR cloud_water frame.",
    )
    parser.add_argument(
        "--frame",
        type=Path,
        default=Path("data/weather/hrrr/2026051918/f01.npz"),
        help="Prepared HRRR NPZ frame.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/weather/hrrr/cloud-preview.json"),
        help="Frontend JSON preview output.",
    )
    parser.add_argument(
        "--max-puffs",
        type=int,
        default=120,
        help="Maximum cloud puffs to export.",
    )
    return parser.parse_args()


def pressure_to_height_m(level_hpa: np.ndarray) -> np.ndarray:
    pressure = np.maximum(level_hpa.astype("float32"), 1.0)
    return 44330.0 * (1.0 - (pressure / 1013.25) ** 0.1903)


def main() -> None:
    args = parse_args()
    frame = np.load(args.frame)
    cloud = frame["cloud_water"].astype("float32")
    lat = frame["latitude"].astype("float32")
    lon = frame["longitude"].astype("float32")
    levels = frame["levels"].astype("float32")

    column_density = cloud.max(axis=0)
    values = column_density[column_density > 0]
    if values.size == 0:
        puffs = []
    else:
        threshold = max(float(np.percentile(values, 62.0)), 1.5e-5)
        candidates = np.argwhere(column_density >= threshold)
        scores = column_density[column_density >= threshold]
        order = np.argsort(scores)[::-1]

        heights = pressure_to_height_m(levels)
        puffs = []
        used_cells = set()

        for candidate_index in order:
            y, x = candidates[candidate_index]
            key = (int(y), int(x))
            if key in used_cells:
                continue
            used_cells.add(key)

            column = cloud[:, y, x]
            z = int(np.argmax(column))
            density = float(column[z])
            normalized = min(1.0, density / max(threshold * 4.0, 1e-6))
            puffs.append(
                {
                    "lon": float(lon[y, x]),
                    "lat": float(lat[y, x]),
                    "height_m": float(heights[z]),
                    "density": density,
                    "radius_km": 16.0 + normalized * 26.0,
                    "depth_km": 8.0 + normalized * 14.0,
                },
            )
            if len(puffs) >= args.max_puffs:
                break

    payload = {
        "schema": "hrrr-cloud-preview/v0",
        "source": str(args.frame),
        "count": len(puffs),
        "puffs": puffs,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(puffs)} cloud puffs to {args.out}")


if __name__ == "__main__":
    main()
