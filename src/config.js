// Frontend → backend configuration.
//
// Override at runtime by setting window.WEATHER3D_API_BASE (and optionally
// WEATHER3D_DATA_BASE) BEFORE main.js loads, e.g. in index.html:
//
//   <script>
//     window.WEATHER3D_API_BASE = "https://weather3d.example.com/api/hrrr";
//     window.WEATHER3D_DATA_BASE = "https://weather3d.example.com/data";
//   </script>
//
// When unset, falls back to same-origin relative paths so a single VPS that
// serves both the frontend and the data files works out of the box.

const globalScope = typeof window !== "undefined" ? window : {};

function trimTrailingSlash(value) {
  return typeof value === "string" ? value.replace(/\/+$/, "") : value;
}

export const config = {
  weatherApiBase:
    trimTrailingSlash(globalScope.WEATHER3D_API_BASE) ?? "./data/weather/hrrr",
  dataBase: trimTrailingSlash(globalScope.WEATHER3D_DATA_BASE) ?? "./data",
};

export function weatherUrl(path) {
  return `${config.weatherApiBase}/${path.replace(/^\/+/, "")}`;
}

export function dataUrl(path) {
  return `${config.dataBase}/${path.replace(/^\/+/, "")}`;
}
