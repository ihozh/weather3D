#!/usr/bin/env python3
"""Build browser-ready 3D wind volumes from prepared HRRR wind fields."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Convert HRRR 3D wind fields to compact float32 volumes.")
    parser.add_argument(
        "--frame",
        type=Path,
        default=Path("data/weather/hrrr/2026052017/f01.npz"),
        help="Prepared HRRR NPZ frame.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("data/weather/hrrr/wind-volume"),
        help="Output directory for wind volume metadata and raw arrays.",
    )
    parser.add_argument(
        "--name",
        default="wind-f01",
        help="Output metadata basename without extension. Default: wind-f01.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frame = np.load(args.frame)

    # Prepared HRRR pressure levels are ordered low-to-high altitude:
    # 1013 hPa near the surface through 50 hPa in the stratosphere.
    # Keep that order so browser z index 0 samples the bottom of the volume.
    u = frame["u_wind"].astype("float32")
    v = frame["v_wind"].astype("float32")
    w = frame["vertical_velocity"].astype("float32")
    levels = frame["levels"].astype("float32")

    speed = np.hypot(u, v)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    suffix = args.name.removeprefix("wind-")
    for name, array in [("u", u), ("v", v), ("w", w)]:
        array.tofile(args.out_dir / f"wind-{name}-{suffix}.f32")

    meta = {
        "schema": "hrrr-wind-volume/f32-v0",
        "source": str(args.frame),
        "shape": {
            "z": int(u.shape[0]),
            "y": int(u.shape[1]),
            "x": int(u.shape[2]),
        },
        "dtype": "float32",
        "components": {
            "u": f"wind-u-{suffix}.f32",
            "v": f"wind-v-{suffix}.f32",
            "w": f"wind-w-{suffix}.f32",
        },
        "level_min_hpa": float(np.min(levels)),
        "level_max_hpa": float(np.max(levels)),
        "levels_hpa": levels.astype(float).tolist(),
        "speed_min_ms": float(np.min(speed)),
        "speed_max_ms": float(np.max(speed)),
        "speed_p95_ms": float(np.percentile(speed, 95)),
    }
    (args.out_dir / f"{args.name}.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote wind volume {u.shape} to {args.out_dir}")


if __name__ == "__main__":
    main()
