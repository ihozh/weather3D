const bounds = {
  west: -88.75,
  south: 30.14,
  east: -85.65,
  north: 31.4,
};

const service =
  "https://services.arcgis.com/P3ePLMYs2RVChkJx/arcgis/rest/services/USA_Detailed_Water_Bodies/FeatureServer/0";
const output = new URL("../data/water/usa-detailed-water-bodies.geojson", import.meta.url);

const pageSize = 1000;
const tiles = tiledBounds(bounds, 6);
const features = new Map();

for (const [tileIndex, tile] of tiles.entries()) {
  let offset = 0;
  while (true) {
    const params = new URLSearchParams({
      f: "geojson",
      where: "1=1",
      geometry: `${tile.west},${tile.south},${tile.east},${tile.north}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "OBJECTID,NAME,FTYPE,FCODE,FCODE_DESC,SQKM,SQMI",
      returnGeometry: "true",
      resultRecordCount: String(pageSize),
      resultOffset: String(offset),
    });

    const url = `${service}/query?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`USA Detailed Water Bodies request failed: ${response.status} ${response.statusText}\n${message.slice(0, 1000)}`);
    }

    const geojson = await response.json();
    if (geojson.error) {
      throw new Error(`USA Detailed Water Bodies request failed: ${JSON.stringify(geojson.error)}`);
    }

    const page = geojson.features ?? [];
    page.forEach((feature) => {
      feature.properties = {
        ...(feature.properties ?? {}),
        water_source: "USA_Detailed_Water_Bodies",
      };
      features.set(String(feature.properties.OBJECTID), feature);
    });

    console.log(`tile ${tileIndex + 1}/${tiles.length}, offset ${offset}: ${page.length}`);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
}

const payload = {
  type: "FeatureCollection",
  name: "USA Detailed Water Bodies clipped to South Alabama weather scene",
  bbox: [bounds.west, bounds.south, bounds.east, bounds.north],
  metadata: {
    source: service,
    fetched_at: new Date().toISOString(),
  },
  features: [...features.values()],
};

const { writeFile } = await import("node:fs/promises");
await writeFile(output, `${JSON.stringify(payload)}\n`);
console.log(`Wrote ${payload.features.length} features to ${output.pathname}`);

function tiledBounds(bounds, count) {
  const tiles = [];
  const lonStep = (bounds.east - bounds.west) / count;
  const latStep = (bounds.north - bounds.south) / count;
  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      tiles.push({
        west: bounds.west + x * lonStep,
        south: bounds.south + y * latStep,
        east: bounds.west + (x + 1) * lonStep,
        north: bounds.south + (y + 1) * latStep,
      });
    }
  }
  return tiles;
}
