#!/usr/bin/env python3
"""Build a lightweight wind-vector preview from prepared HRRR 3D wind fields."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract sparse wind vectors from prepared HRRR u/v/w fields.",
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
        default=Path("data/weather/hrrr/wind-preview.json"),
        help="Frontend JSON wind preview output.",
    )
    parser.add_argument(
        "--level-hpa",
        type=float,
        default=700.0,
        help="Pressure level to preview when not exporting all levels.",
    )
    parser.add_argument(
        "--all-levels",
        action="store_true",
        help="Export every pressure level as an animation-ready sequence.",
    )
    parser.add_argument(
        "--stride",
        type=int,
        default=10,
        help="Horizontal grid stride for sparse vectors.",
    )
    return parser.parse_args()


def pressure_to_height_m(level_hpa: float) -> float:
    pressure = max(float(level_hpa), 1.0)
    return 44330.0 * (1.0 - (pressure / 1013.25) ** 0.1903)


def main() -> None:
    args = parse_args()
    frame = np.load(args.frame)

    levels = frame["levels"].astype("float32")
    level_indices = range(len(levels)) if args.all_levels else [int(np.argmin(np.abs(levels - args.level_hpa)))]

    lat = frame["latitude"].astype("float32")
    lon = frame["longitude"].astype("float32")

    layers = []
    for level_index in level_indices:
        level_hpa = float(levels[level_index])
        u = frame["u_wind"][level_index].astype("float32")
        v = frame["v_wind"][level_index].astype("float32")
        w = frame["vertical_velocity"][level_index].astype("float32")

        vectors = []
        for y in range(args.stride // 2, u.shape[0], args.stride):
            for x in range(args.stride // 2, u.shape[1], args.stride):
                speed = float(np.hypot(u[y, x], v[y, x]))
                if speed < 0.5:
                    continue
                vectors.append(
                    {
                        "lon": float(lon[y, x]),
                        "lat": float(lat[y, x]),
                        "u": float(u[y, x]),
                        "v": float(v[y, x]),
                        "w_pa_s": float(w[y, x]),
                        "speed": speed,
                    },
                )

        layers.append(
            {
                "level_index": int(level_index),
                "level_hpa": level_hpa,
                "height_m": pressure_to_height_m(level_hpa),
                "count": len(vectors),
                "vectors": vectors,
            },
        )

    payload = {
        "schema": "hrrr-wind-preview/v0",
        "source": str(args.frame),
        "mode": "all-levels" if args.all_levels else "single-level",
        "stride": args.stride,
        "level_count": len(layers),
        "levels": layers,
    }

    if not args.all_levels:
        payload.update(layers[0])

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(layers)} wind layer(s) to {args.out}")


if __name__ == "__main__":
    main()
