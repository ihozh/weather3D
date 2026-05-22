#!/usr/bin/env python3
"""
Prepare cropped HRRR cloud fields for the South Alabama digital twin.

The first milestone is intentionally modest: confirm the run time, forecast
hours, variables, bounding box, and output manifest before wiring this into a
server job. Use --dry-run to validate the request without network access.
"""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional


DEFAULT_REGION = {
    "west": -88.75,
    "south": 30.14,
    "east": -85.65,
    "north": 31.40,
}

DEFAULT_FORECAST_HOURS = [1, 2]

# HRRR pressure-level product names vary by Herbie/cfgrib normalization, so the
# manifest keeps both display names and GRIB search fragments.
VARIABLES = {
    "cloud_water": {
        "grib_search": r":CLMR:",
        "aliases": ["clmr", "clwmr", "qcloud", "cloud_mixing_ratio"],
        "units": "kg kg-1",
    },
    "cloud_ice": {
        "grib_search": r":CIMIXR:",
        "aliases": ["cimixr", "icmr", "cice", "qice", "ice_mixing_ratio", "unknown"],
        "units": "kg kg-1",
    },
    "rain_water": {
        "grib_search": r":RWMR:",
        "aliases": ["rwmr", "qrain", "rain_mixing_ratio"],
        "units": "kg kg-1",
    },
    "u_wind": {
        "grib_search": r":UGRD:",
        "aliases": ["u", "u_wind", "ugrd"],
        "units": "m s-1",
    },
    "v_wind": {
        "grib_search": r":VGRD:",
        "aliases": ["v", "v_wind", "vgrd"],
        "units": "m s-1",
    },
    "vertical_velocity": {
        "grib_search": r":VVEL:",
        "aliases": ["w", "vvel", "vertical_velocity"],
        "units": "Pa s-1",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download and crop HRRR cloud/wind fields for the 3D weather twin.",
    )
    parser.add_argument(
        "--date",
        help="UTC model cycle as YYYY-MM-DDTHH, YYYY-MM-DD HH, or YYYYMMDDHH. Defaults to current UTC hour.",
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help="Find the latest available HRRR PRS cycle by searching backward from current UTC hour.",
    )
    parser.add_argument(
        "--latest-lookback",
        type=int,
        default=12,
        help="Hours to search backward when --latest is used.",
    )
    parser.add_argument(
        "--fxx",
        nargs="+",
        type=int,
        default=DEFAULT_FORECAST_HOURS,
        help="Forecast hours to prepare. Default: 1 2.",
    )
    parser.add_argument(
        "--region",
        nargs=4,
        type=float,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        default=[
            DEFAULT_REGION["west"],
            DEFAULT_REGION["south"],
            DEFAULT_REGION["east"],
            DEFAULT_REGION["north"],
        ],
        help="Crop bounds in lon/lat. Default: South Alabama Mesonet extent.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("data/weather/hrrr"),
        help="Output root for manifests and cropped frames.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print and write the manifest without downloading HRRR data.",
    )
    parser.add_argument(
        "--download-only",
        action="store_true",
        help="Download matching GRIB messages but skip crop/packing.",
    )
    parser.add_argument(
        "--local-grib",
        action="append",
        default=[],
        metavar="FXX=PATH",
        help="Pack an already-downloaded GRIB file for a forecast hour, e.g. --local-grib 1=/tmp/hrrr.grib2.",
    )
    return parser.parse_args()


def parse_cycle(value: Optional[str]) -> datetime:
    if not value:
        now = datetime.now(timezone.utc)
        return now.replace(minute=0, second=0, microsecond=0)

    normalized = value.strip().replace("Z", "").replace("T", " ")
    formats = ["%Y-%m-%d %H", "%Y%m%d%H"]
    for fmt in formats:
        try:
            return datetime.strptime(normalized, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    raise SystemExit(
        "--date must look like 2026-05-19T18, 2026-05-19 18, or 2026051918",
    )


def find_latest_cycle(lookback_hours: int, fxx: int, product: str) -> datetime:
    os.environ.setdefault("HERBIE_CONFIG_PATH", str(Path(".herbie_runtime").resolve()))
    try:
        from herbie import Herbie
    except ImportError as error:
        raise SystemExit("Herbie is required for --latest.") from error

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    for offset in range(lookback_hours + 1):
        candidate = now - timedelta(hours=offset)
        naive_candidate = candidate.replace(tzinfo=None)
        try:
            hrrr = Herbie(naive_candidate, model="hrrr", product=product, fxx=fxx)
            if hrrr.grib and hrrr.idx:
                return candidate
            print(f"Skipping {candidate:%Y-%m-%dT%H}: missing GRIB/IDX")
            continue
        except Exception as error:
            print(f"Skipping {candidate:%Y-%m-%dT%H}: {error.__class__.__name__}")

    raise SystemExit(f"No HRRR {product} cycle found in the last {lookback_hours} hours.")


def region_from_args(values: list[float]) -> dict[str, float]:
    west, south, east, north = values
    if west >= east or south >= north:
        raise SystemExit("--region must be WEST SOUTH EAST NORTH")
    return {"west": west, "south": south, "east": east, "north": north}


def build_manifest(cycle: datetime, fxx: list[int], region: dict[str, float]) -> dict:
    cycle_id = cycle.strftime("%Y%m%d%H")
    return {
        "schema": "hrrr-cloud-frame-manifest/v0",
        "model": "hrrr",
        "product": "prs",
        "cycle_utc": cycle.strftime("%Y-%m-%dT%H:00:00Z"),
        "cycle_id": cycle_id,
        "region": region,
        "forecast_hours": fxx,
        "variables": VARIABLES,
        "frames": [
            {
                "forecast_hour": hour,
                "valid_time_utc": None,
                "path": f"{cycle_id}/f{hour:02d}.npz",
                "status": "planned",
            }
            for hour in fxx
        ],
        "notes": [
            "Dry-run manifests are planning artifacts until frame status is prepared.",
            "Output frames are intended to become float16 cropped volumes for web ingestion.",
        ],
    }


def write_manifest(manifest: dict, out_root: Path) -> Path:
    cycle_dir = out_root / manifest["cycle_id"]
    cycle_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = cycle_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    write_latest_pointer(manifest, out_root)
    return manifest_path


def write_latest_pointer(manifest: dict, out_root: Path) -> Path:
    latest_path = out_root / "latest.json"
    latest = {
        "schema": "hrrr-cloud-latest/v0",
        "cycle_utc": manifest["cycle_utc"],
        "cycle_id": manifest["cycle_id"],
        "manifest": f"{manifest['cycle_id']}/manifest.json",
        "region": manifest["region"],
        "forecast_hours": manifest["forecast_hours"],
        "frame_status": [frame["status"] for frame in manifest["frames"]],
    }
    latest_path.parent.mkdir(parents=True, exist_ok=True)
    latest_path.write_text(json.dumps(latest, indent=2) + "\n", encoding="utf-8")
    return latest_path


def grib_search_pattern() -> str:
    return "|".join(item["grib_search"] for item in VARIABLES.values())


def parse_local_gribs(values: list[str]) -> dict[int, Path]:
    local_gribs = {}
    for value in values:
        if "=" not in value:
            raise SystemExit("--local-grib entries must look like FXX=PATH")
        hour_text, path_text = value.split("=", 1)
        try:
            hour = int(hour_text)
        except ValueError as error:
            raise SystemExit("--local-grib forecast hour must be an integer") from error
        path = Path(path_text).expanduser()
        if not path.exists():
            raise SystemExit(f"Local GRIB file does not exist: {path}")
        local_gribs[hour] = path
    return local_gribs


def prepare_with_local_gribs(manifest: dict, out_root: Path, local_gribs: dict[int, Path]) -> dict:
    for frame in manifest["frames"]:
        hour = frame["forecast_hour"]
        if hour not in local_gribs:
            continue
        pack_grib_frame(local_gribs[hour], frame, manifest, out_root)
    return manifest


def prepare_with_herbie(manifest: dict, out_root: Path, download_only: bool) -> dict:
    os.environ.setdefault("HERBIE_CONFIG_PATH", str(Path(".herbie_runtime").resolve()))

    try:
        from herbie import Herbie
    except ImportError as error:
        raise SystemExit(
            "Herbie is required for downloads. Install herbie-data, xarray, cfgrib, and eccodes, "
            "or rerun with --dry-run.",
        ) from error

    cycle = datetime.strptime(manifest["cycle_id"], "%Y%m%d%H")
    search = grib_search_pattern()

    for frame in manifest["frames"]:
        hour = frame["forecast_hour"]
        hrrr = Herbie(cycle, model="hrrr", product=manifest["product"], fxx=hour)
        grib_path = Path(
            hrrr.download(
                search=search,
                save_dir=out_root / "grib",
            ),
        )
        frame["source_grib"] = str(grib_path)
        if download_only:
            frame["status"] = "downloaded"
            frame["note"] = "Downloaded matching GRIB messages; crop/packing skipped."
        else:
            pack_grib_frame(grib_path, frame, manifest, out_root)

    return manifest


def pack_grib_frame(grib_path: Path, frame: dict, manifest: dict, out_root: Path) -> None:
    try:
        import cfgrib
        import numpy as np
    except ImportError as error:
        raise SystemExit(
            "Packing requires numpy, xarray, cfgrib, and eccodes. "
            "Install them or rerun with --download-only.",
        ) from error

    datasets = cfgrib.open_datasets(
        grib_path,
        backend_kwargs={"indexpath": ""},
    )
    try:
        arrays, coords, dims = extract_frame_arrays(datasets, manifest["region"])
        output_path = out_root / frame["path"]
        output_path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            output_path,
            **arrays,
            latitude=coords["latitude"].astype("float32"),
            longitude=coords["longitude"].astype("float32"),
            levels=coords["levels"].astype("float32"),
            variable_names=np.array(list(arrays.keys())),
        )

        frame["status"] = "prepared"
        frame["source_grib"] = str(grib_path)
        frame["shape"] = dims
        frame["dtype"] = "float16"
        frame["valid_time_utc"] = infer_valid_time(datasets)
    finally:
        for dataset in datasets:
            dataset.close()


def extract_frame_arrays(datasets: list[Any], region: dict[str, float]) -> tuple[dict, dict, dict]:
    import numpy as np

    arrays = {}
    coords = None

    for canonical_name, spec in VARIABLES.items():
        data_array = find_data_array(datasets, spec["aliases"])
        if data_array is None:
            continue

        cropped = crop_data_array(data_array, region)
        normalized = normalize_data_array(cropped)
        values = np.nan_to_num(normalized.values, nan=0.0, posinf=0.0, neginf=0.0)
        arrays[canonical_name] = values.astype("float16")

        if coords is None:
            coords = extract_coords(normalized)

    if not arrays:
        raise SystemExit("No requested HRRR variables were found in the GRIB file.")
    if coords is None:
        raise SystemExit("Unable to extract coordinates from cropped HRRR frame.")

    dims = {
        "z": int(coords["levels"].shape[0]),
        "y": int(coords["latitude"].shape[-2]),
        "x": int(coords["latitude"].shape[-1]),
        "variables_found": sorted(arrays.keys()),
        "variables_missing": sorted(set(VARIABLES) - set(arrays)),
    }
    return arrays, coords, dims


def find_data_array(datasets: list[Any], aliases: list[str]) -> Optional[Any]:
    wanted = {alias.lower() for alias in aliases}
    matches = []
    for dataset in datasets:
        for name, data_array in dataset.data_vars.items():
            candidates = {
                name.lower(),
                str(data_array.attrs.get("GRIB_shortName", "")).lower(),
                str(data_array.attrs.get("standard_name", "")).lower(),
                str(data_array.attrs.get("long_name", "")).lower(),
            }
            if candidates & wanted:
                matches.append(data_array)

    if not matches:
        return None

    matches.sort(key=data_array_priority, reverse=True)
    return matches[0]


def data_array_priority(data_array: Any) -> tuple[int, int]:
    type_of_level = str(data_array.attrs.get("GRIB_typeOfLevel", "")).lower()
    is_pressure_level = type_of_level == "isobaricinhpa"
    return (int(is_pressure_level), len(data_array.dims))


def crop_data_array(data_array: Any, region: dict[str, float]) -> Any:
    lon = data_array.coords.get("longitude")
    lat = data_array.coords.get("latitude")
    if lon is None or lat is None:
        raise SystemExit(f"{data_array.name} is missing latitude/longitude coordinates.")

    lon_values = lon
    if float(lon.max()) > 180:
        west = region["west"] % 360
        east = region["east"] % 360
    else:
        west = region["west"]
        east = region["east"]

    mask = (
        (lon_values >= west)
        & (lon_values <= east)
        & (lat >= region["south"])
        & (lat <= region["north"])
    )
    cropped = data_array.where(mask, drop=True)
    if 0 in cropped.shape:
        raise SystemExit(f"{data_array.name} crop is empty for the requested region.")
    return cropped


def normalize_data_array(data_array: Any) -> Any:
    y_dim, x_dim = horizontal_dims(data_array)
    vertical = vertical_dim(data_array, y_dim, x_dim)
    if vertical:
        return data_array.transpose(vertical, y_dim, x_dim)
    return data_array.expand_dims({"level": [0]}).transpose("level", y_dim, x_dim)


def horizontal_dims(data_array: Any) -> tuple[str, str]:
    lat = data_array.coords.get("latitude")
    if lat is not None and len(lat.dims) >= 2:
        return lat.dims[-2], lat.dims[-1]

    dims = data_array.dims
    if len(dims) < 2:
        raise SystemExit(f"{data_array.name} does not have horizontal dimensions.")
    return dims[-2], dims[-1]


def vertical_dim(data_array: Any, y_dim: str, x_dim: str) -> Optional[str]:
    for dim in data_array.dims:
        if dim not in {y_dim, x_dim}:
            return dim
    return None


def extract_coords(data_array: Any) -> dict:
    import numpy as np

    lat = data_array.coords["latitude"].values
    lon = data_array.coords["longitude"].values
    lon = np.where(lon > 180, lon - 360, lon)
    level_dim = data_array.dims[0]
    levels = data_array.coords[level_dim].values if level_dim in data_array.coords else np.array([0])
    return {"latitude": lat, "longitude": lon, "levels": levels}


def infer_valid_time(datasets: list[Any]) -> Optional[str]:
    for dataset in datasets:
        value = dataset.coords.get("valid_time")
        if value is not None:
            try:
                return str(value.values.astype("datetime64[s]")) + "Z"
            except AttributeError:
                return str(value.values)
    return None


def main() -> None:
    args = parse_args()
    cycle = (
        find_latest_cycle(args.latest_lookback, args.fxx[0], "prs")
        if args.latest
        else parse_cycle(args.date)
    )
    region = region_from_args(args.region)
    manifest = build_manifest(cycle, args.fxx, region)
    local_gribs = parse_local_gribs(args.local_grib)

    if args.dry_run:
        manifest["dry_run"] = True
    elif local_gribs:
        manifest = prepare_with_local_gribs(manifest, args.out, local_gribs)
    else:
        manifest = prepare_with_herbie(manifest, args.out, args.download_only)

    manifest_path = write_manifest(manifest, args.out)
    print(f"Cycle: {manifest['cycle_utc']}")
    print(f"Region: {region['west']}, {region['south']}, {region['east']}, {region['north']}")
    print(f"Forecast hours: {', '.join(str(hour) for hour in args.fxx)}")
    print(f"Variables: {', '.join(VARIABLES)}")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
