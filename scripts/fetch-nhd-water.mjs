const bounds = {
  west: -88.75,
  south: 30.14,
  east: -85.65,
  north: 31.4,
};

const service = "https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer";
const output = new URL("../data/water/nhd-water.geojson", import.meta.url);
const queryEnvelope = lonLatBoundsToWebMercator(bounds);

const layers = [
  { id: 9, name: "NHDWaterbody", type: "waterbody", outFields: "*" },
  { id: 3, name: "NetworkNHDFlowline", type: "flowline", outFields: "*" },
  { id: 4, name: "NonNetworkNHDFlowline", type: "flowline", outFields: "*" },
];

async function fetchLayer(layer) {
  const features = new Map();
  let offset = 0;
  const pageSize = 1000;
  const tiles = tiledEnvelopes(queryEnvelope, layer.type === "flowline" ? 2 : 4);

  for (const tile of tiles) {
    offset = 0;
    while (true) {
      const params = new URLSearchParams({
        f: "json",
        where: "1=1",
        geometry: JSON.stringify(tile),
        geometryType: "esriGeometryEnvelope",
        inSR: "3857",
        outSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: layer.outFields,
        returnGeometry: "true",
        resultRecordCount: String(pageSize),
        resultOffset: String(offset),
      });

      const url = `${service}/${layer.id}/query?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`${layer.name} request failed: ${response.status} ${response.statusText}\n${message.slice(0, 1000)}`);
      }

      const pageJson = await response.json();
      if (pageJson.error) {
        throw new Error(`${layer.name} request failed: ${JSON.stringify(pageJson.error)}`);
      }

      const page = pageJson.features ?? [];
      page.forEach((feature) => {
        const geojson = esriFeatureToGeoJSON(feature, layer);
        if (geojson) features.set(`${layer.name}:${geojson.properties.OBJECTID}`, geojson);
      });

      if (page.length < pageSize) break;
      offset += pageSize;
    }
  }

  return [...features.values()];
}

function esriFeatureToGeoJSON(feature, layer) {
  const geometry = feature.geometry ?? null;
  if (!geometry) return null;

  let geojsonGeometry = null;
  if (geometry.rings) {
    geojsonGeometry = {
      type: "Polygon",
      coordinates: geometry.rings.map((ring) => ring.map(([x, y]) => [x, y])),
    };
  } else if (geometry.paths) {
    geojsonGeometry =
      geometry.paths.length === 1
        ? { type: "LineString", coordinates: geometry.paths[0].map(([x, y]) => [x, y]) }
        : { type: "MultiLineString", coordinates: geometry.paths.map((path) => path.map(([x, y]) => [x, y])) };
  }

  if (!geojsonGeometry) return null;

  return {
    type: "Feature",
    properties: {
      ...(feature.attributes ?? {}),
      nhd_layer: layer.name,
      nhd_kind: layer.type,
    },
    geometry: geojsonGeometry,
  };
}

function tiledEnvelopes(envelope, count) {
  const tiles = [];
  const width = (envelope.xmax - envelope.xmin) / count;
  const height = (envelope.ymax - envelope.ymin) / count;

  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      tiles.push({
        xmin: envelope.xmin + x * width,
        ymin: envelope.ymin + y * height,
        xmax: envelope.xmin + (x + 1) * width,
        ymax: envelope.ymin + (y + 1) * height,
        spatialReference: { wkid: 3857 },
      });
    }
  }

  return tiles;
}

function lonLatBoundsToWebMercator({ west, south, east, north }) {
  const southwest = lonLatToWebMercator(west, south);
  const northeast = lonLatToWebMercator(east, north);
  return {
    xmin: southwest.x,
    ymin: southwest.y,
    xmax: northeast.x,
    ymax: northeast.y,
    spatialReference: { wkid: 3857 },
  };
}

function lonLatToWebMercator(lon, lat) {
  const x = (lon * 20037508.34) / 180;
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const y =
    Math.log(Math.tan(((90 + clampedLat) * Math.PI) / 360)) /
    (Math.PI / 180) *
    (20037508.34 / 180);
  return { x, y };
}

const allFeatures = [];
for (const layer of layers) {
  console.log(`Fetching ${layer.name}`);
  const features = await fetchLayer(layer);
  console.log(`  ${features.length} features`);
  allFeatures.push(...features);
}

const payload = {
  type: "FeatureCollection",
  name: "NHDPlus HR water features for South Alabama weather scene",
  bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
  metadata: {
    source: service,
    layers: layers.map(({ id, name, type }) => ({ id, name, type })),
    fetched_at: new Date().toISOString(),
  },
  features: allFeatures,
};

const { writeFile } = await import("node:fs/promises");
await writeFile(output, `${JSON.stringify(payload)}\n`);
console.log(`Wrote ${allFeatures.length} features to ${output.pathname}`);
