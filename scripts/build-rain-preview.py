#!/usr/bin/env python3
"""Build compact rain masks from prepared HRRR rain_water fields."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create browser rain mask JSON from HRRR rain_water.")
    parser.add_argument("--frame0", type=Path, required=True, help="Prepared HRRR F01 NPZ frame.")
    parser.add_argument("--frame1", type=Path, required=True, help="Prepared HRRR F02 NPZ frame.")
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/weather/hrrr/rain-preview.json"),
        help="Output rain preview JSON.",
    )
    return parser.parse_args()


def frame_payload(path: Path) -> dict:
    frame = np.load(path)
    rain = frame["rain_water"].astype("float32")
    levels = frame["levels"].astype("float32")
    rain = np.nan_to_num(rain, nan=0.0, posinf=0.0, neginf=0.0)
    column = rain.sum(axis=0)
    positive = column[column > 0]
    scale = float(np.percentile(positive, 98.5)) if positive.size else 0.0
    scale = max(scale, 1e-8)
    normalized = np.clip(column / scale, 0.0, 1.0)
    normalized = np.power(normalized, 0.55)
    active = rain > max(scale * 0.035, 1e-8)
    level_indices = np.arange(rain.shape[0], dtype="float32")[:, None, None]
    rain_top = np.where(active, level_indices, -1).max(axis=0)
    top_ratio = np.where(rain_top >= 0, rain_top / max(1, rain.shape[0] - 1), 0.0)
    return {
        "source": str(path),
        "shape": {"y": int(column.shape[0]), "x": int(column.shape[1])},
        "scale": scale,
        "max": float(column.max()),
        "positive_cells": int(np.count_nonzero(column > 0)),
        "levels_hpa": levels.astype(float).tolist(),
        "height_source": "rain_water_top",
        "values": np.round(normalized * 255).astype("uint8").reshape(-1).tolist(),
        "top": np.round(top_ratio * 255).astype("uint8").reshape(-1).tolist(),
    }


def main() -> None:
    args = parse_args()
    payload = {
        "schema": "hrrr-rain-preview/u8-v0",
        "frames": [frame_payload(args.frame0), frame_payload(args.frame1)],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    print(
        "Wrote",
        args.out,
        "frames",
        [frame["shape"] for frame in payload["frames"]],
        "positive",
        [frame["positive_cells"] for frame in payload["frames"]],
    )


if __name__ == "__main__":
    main()
