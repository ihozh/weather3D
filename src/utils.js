import * as THREE from "three";
import {
  region,
  terrainWidth,
  terrainDepth,
  elevationScale,
  bathymetryScale,
} from "./constants.js";

let terrainSamplerRef = null;
export function setTerrainSampler(sampler) {
  terrainSamplerRef = sampler;
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function fract(value) {
  return value - Math.floor(value);
}

export function seededNoise(value) {
  return fract(Math.sin(value) * 43758.5453123);
}

export function tileKey(x, y) {
  return `${x}/${y}`;
}

export function lonLatToTile(lon, lat, z) {
  const exact = lonLatToTileFloat(lon, lat, z);
  return {
    x: Math.floor(exact.x),
    y: Math.floor(exact.y),
  };
}

export function lonLatToTileFloat(lon, lat, z) {
  const latRad = THREE.MathUtils.degToRad(lat);
  const n = 2 ** z;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

export function loadImageWithTimeout(src, timeoutMs) {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.decoding = "async";

  return new Promise((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      reject(new Error(`Timed out loading image: ${src}`));
    }, timeoutMs);

    image.onload = () => {
      window.clearTimeout(timeoutId);
      resolve(image);
    };

    image.onerror = () => {
      window.clearTimeout(timeoutId);
      reject(new Error(`Failed to load image: ${src}`));
    };

    image.src = src;
  });
}

export function sampleTerrarium(tiles, z, lon, lat) {
  const exact = lonLatToTileFloat(lon, lat, z);
  const x = Math.floor(exact.x);
  const y = Math.floor(exact.y);
  const tile = tiles.get(tileKey(x, y));

  if (!tile) return 0;

  const px = clamp((exact.x - x) * (tile.width - 1), 0, tile.width - 1);
  const py = clamp((exact.y - y) * (tile.height - 1), 0, tile.height - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = clamp(x0 + 1, 0, tile.width - 1);
  const y1 = clamp(y0 + 1, 0, tile.height - 1);
  const tx = px - x0;
  const ty = py - y0;

  const a = readTerrariumPixel(tile, x0, y0);
  const b = readTerrariumPixel(tile, x1, y0);
  const c = readTerrariumPixel(tile, x0, y1);
  const d = readTerrariumPixel(tile, x1, y1);
  const top = THREE.MathUtils.lerp(a, b, tx);
  const bottom = THREE.MathUtils.lerp(c, d, tx);
  return THREE.MathUtils.lerp(top, bottom, ty);
}

export function readTerrariumPixel(tile, px, py) {
  const index = (py * tile.width + px) * 4;
  const r = tile.data[index];
  const g = tile.data[index + 1];
  const b = tile.data[index + 2];
  return r * 256 + g + b / 256 - 32768;
}

export function elevationToSceneHeight(meters) {
  if (meters < 0) return Math.max(-5, meters * bathymetryScale);
  return meters * elevationScale;
}

export function proceduralElevation(lon, lat) {
  const u = (lon - region.west) / (region.east - region.west);
  const v = (lat - region.south) / (region.north - region.south);
  const ridge = Math.sin(u * Math.PI * 5.8 + v * 2.2) * 2.2;
  const longSlope = (v - 0.3) * 12;
  const mobileBay = Math.exp(-(((u - 0.35) / 0.18) ** 2 + ((v - 0.17) / 0.22) ** 2)) * -13;
  const upland = Math.exp(-(((u - 0.74) / 0.3) ** 2 + ((v - 0.74) / 0.24) ** 2)) * 10;
  return Math.max(0, ridge + longSlope + mobileBay + upland + 7);
}

export function terrainColor(u, v, elevation, seaLevel) {
  if (elevation < 0.8) return new THREE.Color(0x2d6672);

  const farmPatch = Math.abs(Math.sin(u * 38) * Math.cos(v * 32));
  const forest = new THREE.Color(0x244f2d);
  const field = new THREE.Color(0x81924a);
  const upland = new THREE.Color(0x62713e);
  const color = field.clone().lerp(forest, Math.min(0.82, farmPatch));
  color.lerp(upland, clamp(elevation / 75, 0, 1) * 0.55);
  return color;
}

export function smoothHeights(values, columns, rows, passes) {
  let current = values;

  for (let pass = 0; pass < passes; pass += 1) {
    const next = current.slice();

    for (let row = 1; row < rows - 1; row += 1) {
      for (let column = 1; column < columns - 1; column += 1) {
        const i = row * columns + column;
        next[i] =
          current[i] * 0.42 +
          (current[i - 1] + current[i + 1] + current[i - columns] + current[i + columns]) * 0.11 +
          (current[i - columns - 1] +
            current[i - columns + 1] +
            current[i + columns - 1] +
            current[i + columns + 1]) *
            0.035;
      }
    }

    current = next;
  }

  values.splice(0, values.length, ...current);
}

export function makeLinearCanvasTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export const mapProjection = {
  toUv(lon, lat, bounds = region) {
    return {
      u: (lon - bounds.west) / (bounds.east - bounds.west),
      v: (lat - bounds.south) / (bounds.north - bounds.south),
    };
  },
  toWorld(lon, lat, options = {}) {
    const bounds = options.bounds ?? region;
    const width = options.width ?? terrainWidth;
    const depth = options.depth ?? terrainDepth;
    const { u, v } = this.toUv(lon, lat, bounds);
    const x = (u - 0.5) * width;
    const z = (0.5 - v) * depth;
    const y = options.includeHeight === false ? 0 : this.heightAt(lon, lat);
    return { x, y, z, u, v };
  },
  toGeo(x, z, options = {}) {
    const bounds = options.bounds ?? region;
    const width = options.width ?? terrainWidth;
    const depth = options.depth ?? terrainDepth;
    const u = x / width + 0.5;
    const v = 0.5 - z / depth;
    return {
      lon: bounds.west + (bounds.east - bounds.west) * u,
      lat: bounds.south + (bounds.north - bounds.south) * v,
      u,
      v,
    };
  },
  heightAt(lon, lat) {
    if (!terrainSamplerRef) return 0;
    return elevationToSceneHeight(terrainSamplerRef.sample(lon, lat));
  },
};
