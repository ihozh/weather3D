#!/usr/bin/env python3
"""Build animated cloud particles from prepared HRRR cloud and wind fields."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sample HRRR cloud_water voxels into particles with wind velocities.",
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
        default=Path("data/weather/hrrr/cloud-particles.json"),
        help="Frontend JSON particle output.",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=900,
        help="Maximum particles to export.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=42,
        help="Random seed for deterministic sampling.",
    )
    return parser.parse_args()


def pressure_to_height_m(level_hpa: np.ndarray) -> np.ndarray:
    pressure = np.maximum(level_hpa.astype("float32"), 1.0)
    return 44330.0 * (1.0 - (pressure / 1013.25) ** 0.1903)


def main() -> None:
    args = parse_args()
    rng = np.random.default_rng(args.seed)
    frame = np.load(args.frame)

    cloud = frame["cloud_water"].astype("float32")
    if "cloud_ice" in frame.files:
        cloud = cloud + frame["cloud_ice"].astype("float32") * 0.85

    positive = cloud[cloud > 0]
    if positive.size == 0:
        particles = []
    else:
        threshold = max(float(np.percentile(positive, 48.0)), 1.0e-5)
        candidates = np.argwhere(cloud >= threshold)
        weights = cloud[cloud >= threshold]
        weights = np.power(weights / weights.sum(), 0.85)
        weights = weights / weights.sum()
        sample_count = args.count
        chosen = rng.choice(
            len(candidates),
            size=sample_count,
            replace=len(candidates) < sample_count,
            p=weights,
        )

        lat = frame["latitude"].astype("float32")
        lon = frame["longitude"].astype("float32")
        levels = frame["levels"].astype("float32")
        heights = pressure_to_height_m(levels)
        u = frame["u_wind"].astype("float32")
        v = frame["v_wind"].astype("float32")
        w = frame["vertical_velocity"].astype("float32")
        density_scale = max(float(np.percentile(positive, 99.0)), 1.0e-6)

        particles = []
        for particle_index, candidate_index in enumerate(chosen):
            z, y, x = candidates[candidate_index]
            density = float(cloud[z, y, x])
            jitter_lon = (rng.random() - 0.5) * 0.018
            jitter_lat = (rng.random() - 0.5) * 0.018
            particles.append(
                {
                    "lon": float(lon[y, x] + jitter_lon),
                    "lat": float(lat[y, x] + jitter_lat),
                    "height_m": float(heights[z] + (rng.random() - 0.5) * 180.0),
                    "u": float(u[z, y, x]),
                    "v": float(v[z, y, x]),
                    "w_pa_s": float(w[z, y, x]),
                    "density": density,
                    "size": float(0.7 + min(1.0, density / density_scale) * 2.4),
                    "phase": float(rng.random()),
                    "life": float(9.0 + rng.random() * 8.0),
                },
            )

    payload = {
        "schema": "hrrr-cloud-particles/v0",
        "source": str(args.frame),
        "count": len(particles),
        "particles": particles,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {len(particles)} cloud particles to {args.out}")


if __name__ == "__main__":
    main()
