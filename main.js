import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  region,
  terrainWidth,
  terrainDepth,
  windVolumeBaseY,
  windVolumeHeight,
  segmentsX,
  segmentsZ,
  elevationZoom,
  satelliteZoom,
  useNaipImagery,
  detailSatelliteZoom,
  detailLonSpan,
  detailLatSpan,
  csbSimplifyStep,
  csbMinPointDistance,
  mesonetStations,
} from "./src/constants.js";
import {
  setTerrainSampler,
  clamp,
  clamp01,
  fract,
  seededNoise,
  tileKey,
  lonLatToTile,
  lonLatToTileFloat,
  loadImageWithTimeout,
  sampleTerrarium,
  elevationToSceneHeight,
  proceduralElevation,
  terrainColor,
  smoothHeights,
  makeLinearCanvasTexture,
  mapProjection,
} from "./src/utils.js";
import { weatherUrl, dataUrl } from "./src/config.js";

const container = document.getElementById("terrainContainer");
const statusText = document.getElementById("terrainStatus");
const weatherStatusText = document.getElementById("weatherStatus");

let terrainSampler = null;
let satelliteTexture = null;
let vectorWaterMaskTexture = null;
let vectorWaterRoughnessTexture = null;
let waterNormalTexture = null;
let terrainMesh = null;
let detailPatch = null;
let detailPatchKey = "";
let detailPatchLoading = false;
let detailCheckTimer = 0;
let controls = null;
let camera = null;
let renderer = null;
let scene = null;
let skyLight = null;
let sunLight = null;
let fillLight = null;
let skySunPosition = new THREE.Vector3();
let skyDome = null;
let skyDomeMaterial = null;
let pmremGenerator = null;
let envRenderTarget = null;
let envBakeTimer = 0;
let lastBakedSunDir = new THREE.Vector3();
let composer = null;
let bloomPass = null;
const horizonColor = new THREE.Color(0x6da4d8);
const skyZenithColor = new THREE.Color(0x0b2a55);
const sunTintColor = new THREE.Color();
let directionLabels = null;
let stationLayer = null;
let csbLayer = null;
let cloudLayer = null;
let windLayer = null;
let windAnimationEnabled = false;
let windFlowSystem = null;
let windVolume = null;
let cloudVolumeMaterial = null;
let cloudAnimationStart = performance.now();
let weatherFrameTimes = null;
let currentWeatherAlpha = 0;
let selectedWeatherTimeMs = null;
let weatherTimeSlider = null;
let weatherTimeLabel = null;
let precipitationLayer = null;
let precipitationSystem = null;
let rainFlowSystem = null;
let rainPreview = null;
let rainLayerRebuildTimer = 0;
let lastFrameTime = performance.now();

boot();

async function boot() {
  setupScene();
  await loadWeatherManifest();
  statusText.textContent = "Loading DEM + satellite + water";

  const demPromise = loadTerrariumSampler(region, elevationZoom).catch((error) => {
    console.warn("DEM tiles failed; using procedural fallback.", error);
    return {
      sample: (lon, lat) => proceduralElevation(lon, lat),
      min: 0,
      max: 55,
      source: "fallback",
    };
  });

  const satellitePromise = (useNaipImagery
    ? loadNaipTexture(region, { width: 3072, height: 1240, statusPrefix: "Loading NAIP imagery" })
    : loadSatelliteTexture(region, satelliteZoom, {
        width: 2048, height: 1380, statusPrefix: "Loading overview satellite",
      })
  ).catch((error) => {
    console.warn("Satellite texture failed; using terrain colors.", error);
    return null;
  });

  const waterPromise = demPromise.then(async (dem) => {
    terrainSampler = dem;
    setTerrainSampler(dem);
    try {
      await loadDetailedWaterMask();
    } catch (error) {
      console.warn("Detailed water mask unavailable.", error);
    }
  });

  const [demResult, satelliteResult] = await Promise.all([demPromise, satellitePromise, waterPromise]);
  terrainSampler = demResult;
  setTerrainSampler(terrainSampler);
  satelliteTexture = satelliteResult;
  statusText.textContent = terrainSampler.source === "fallback"
    ? "Fallback terrain"
    : (satelliteTexture
      ? (useNaipImagery ? "Overview DEM + NAIP imagery" : "Overview DEM + satellite texture")
      : "Real DEM terrain");

  buildTerrain();
  if (!satelliteTexture) addWaterPlane();
  addRegionFrame();
  stationLayer = addMesonetStations();

  const [csbResult, cloudResult, windResult, rainResult] = await Promise.all([
    addCsbBoundaryLayer(),
    addHrrrCloudPreviewLayer(),
    addHrrrWindPreviewLayer(),
    loadRainPreview(),
  ]);
  csbLayer = csbResult;
  cloudLayer = cloudResult;
  windLayer = windResult;
  rainPreview = rainResult;
  if (windVolume) applyCloudWindProfile(windVolume);
  precipitationLayer = addWeatherParticleLayer();

  addScaleLabels();
  bindControls();
  updateCropLayerVisibility();
  resize();
  animate();
}

async function loadWeatherManifest() {
  if (!weatherStatusText) return;

  try {
    const response = await fetch(weatherUrl("latest.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HRRR manifest request failed: ${response.status}`);

    const latest = await response.json();
    const statuses = latest.frame_status ?? [];
    const preparedCount = statuses.filter((status) => status === "prepared").length;
    const plannedCount = statuses.filter((status) => status === "planned").length;
    const cycleLabel = latest.cycle_utc.slice(5, 13).replace("T", " ");
    await loadWeatherFrameTimes(latest);

    if (preparedCount > 0) {
      weatherStatusText.textContent = `HRRR ${cycleLabel} ready (${preparedCount} frames)`;
    } else if (plannedCount > 0) {
      weatherStatusText.textContent = `HRRR ${cycleLabel} planned`;
    } else {
      weatherStatusText.textContent = `HRRR ${cycleLabel} manifest`;
    }
  } catch (error) {
    console.warn("Weather manifest unavailable.", error);
    weatherStatusText.textContent = "HRRR volume pending";
  }
}

async function loadWeatherFrameTimes(latest) {
  if (!latest?.manifest) return;

  try {
    const response = await fetch(weatherUrl(latest.manifest), { cache: "no-store" });
    if (!response.ok) throw new Error(`HRRR frame manifest request failed: ${response.status}`);
    const manifest = await response.json();
    const frames = (manifest.frames ?? [])
      .filter((frame) => frame.status === "prepared" && frame.valid_time_utc)
      .sort((a, b) => a.forecast_hour - b.forecast_hour);
    if (frames.length < 2) return;
    weatherFrameTimes = {
      startMs: Date.parse(frames[0].valid_time_utc),
      endMs: Date.parse(frames[1].valid_time_utc),
    };
    selectedWeatherTimeMs = clamp(Date.now(), weatherFrameTimes.startMs, weatherFrameTimes.endMs);
    syncWeatherTimeControl();
    updateWeatherAlpha();
  } catch (error) {
    console.warn("Weather frame times unavailable.", error);
  }
}

function syncWeatherTimeControl() {
  if (!weatherFrameTimes || !weatherTimeSlider) return;

  const duration = Math.max(1, weatherFrameTimes.endMs - weatherFrameTimes.startMs);
  const timeMs = selectedWeatherTimeMs ?? clamp(Date.now(), weatherFrameTimes.startMs, weatherFrameTimes.endMs);
  const progress = clamp((timeMs - weatherFrameTimes.startMs) / duration, 0, 1);
  weatherTimeSlider.value = Math.round(progress * Number(weatherTimeSlider.max)).toString();
  updateWeatherTimeLabel(timeMs);
}

function updateWeatherTimeLabel(timeMs = selectedWeatherTimeMs) {
  if (!weatherTimeLabel || !timeMs) return;
  const label = new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timeMs));
  weatherTimeLabel.textContent = label;
}

function setupScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.fog = new THREE.FogExp2(0x0a0f18, 0.0018);

  camera = new THREE.PerspectiveCamera(48, 1, 0.1, 4000);
  camera.position.set(0, 150, 210);
  camera.up.set(0, 1, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0, 0);
  controls.maxDistance = 320;
  controls.minDistance = 16;
  controls.maxPolarAngle = Math.PI * 0.47;
  controls.addEventListener("change", clampCameraToTerrain);

  addSkyDome();

  pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  skyLight = new THREE.HemisphereLight(0xa8c8ee, 0x1a1a14, 0.55);
  scene.add(skyLight);

  sunLight = new THREE.DirectionalLight(0xffe4b7, 2.6);
  sunLight.target.position.set(18, 0, -22);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -150;
  sunLight.shadow.camera.right = 150;
  sunLight.shadow.camera.top = 120;
  sunLight.shadow.camera.bottom = -120;
  sunLight.shadow.camera.near = 20;
  sunLight.shadow.camera.far = 340;
  sunLight.shadow.bias = -0.00018;
  sunLight.shadow.normalBias = 0.04;
  sunLight.shadow.radius = 2.2;
  scene.add(sunLight);
  scene.add(sunLight.target);

  fillLight = new THREE.DirectionalLight(0x9fc8ff, 0.28);
  fillLight.position.set(120, 70, -135);
  scene.add(fillLight);

  scene.add(new THREE.AmbientLight(0x6b7a85, 0.18));
  updateAtmosphere(0);
  refreshEnvironment(true);
  setupComposer();

  window.addEventListener("resize", resize);
  directionLabels = {
    north: document.querySelector(".map-direction.north"),
    south: document.querySelector(".map-direction.south"),
    east: document.querySelector(".map-direction.east"),
    west: document.querySelector(".map-direction.west"),
  };
}

function clampCameraToTerrain() {
  if (!controls || !camera) return;
  const halfW = terrainWidth * 0.55;
  const halfD = terrainDepth * 0.55;
  controls.target.x = clamp(controls.target.x, -halfW, halfW);
  controls.target.z = clamp(controls.target.z, -halfD, halfD);
  controls.target.y = clamp(controls.target.y, 0, 24);
  if (camera.position.y < 2) camera.position.y = 2;
}

function setupComposer() {
  const { clientWidth, clientHeight } = container;
  const width = Math.max(clientWidth, 1);
  const height = Math.max(clientHeight, 1);

  composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(width, height);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    0.18,
    0.55,
    0.92,
  );
  composer.addPass(bloomPass);

  const smaaPass = new SMAAPass(width * renderer.getPixelRatio(), height * renderer.getPixelRatio());
  composer.addPass(smaaPass);

  composer.addPass(new OutputPass());
}

function addSkyDome() {
  const radius = 1600;
  const geometry = new THREE.SphereGeometry(radius, 64, 48);
  skyDomeMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      zenithColor: { value: skyZenithColor.clone() },
      horizonColor: { value: horizonColor.clone() },
      sunDirection: { value: new THREE.Vector3(0, 1, 0) },
      sunColor: { value: new THREE.Color(0xffd9a8) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 zenithColor;
      uniform vec3 horizonColor;
      uniform vec3 sunDirection;
      uniform vec3 sunColor;
      varying vec3 vWorldPos;

      void main() {
        vec3 dir = normalize(vWorldPos);
        float upper = smoothstep(-0.18, 0.45, dir.y);
        float gradient = pow(clamp(dir.y, 0.0, 1.0), 0.55);
        vec3 skyCol = mix(horizonColor, zenithColor, gradient);
        vec3 col = mix(vec3(0.0), skyCol, upper);
        float sunDot = max(dot(dir, normalize(sunDirection)), 0.0);
        col += sunColor * pow(sunDot, 320.0) * 0.22 * upper;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  skyDome = new THREE.Mesh(geometry, skyDomeMaterial);
  skyDome.renderOrder = -10;
  skyDome.frustumCulled = false;
  scene.add(skyDome);
}

function refreshEnvironment(force = false) {
  if (!pmremGenerator || !skyDome || !scene) return;
  if (!force && lastBakedSunDir.dot(skySunPosition) > 0.997) return;

  const previousTarget = envRenderTarget;
  envRenderTarget = pmremGenerator.fromScene(scene, 0.04);
  scene.environment = envRenderTarget.texture;
  lastBakedSunDir.copy(skySunPosition);
  if (previousTarget) previousTarget.dispose();
}

function updateAtmosphere(timeSeconds) {
  if (!sunLight || !skyLight || !fillLight) return;

  const pulse = Math.sin(timeSeconds * 0.035);
  const elevation = 28 + pulse * 7;
  const azimuth = 126 + Math.sin(timeSeconds * 0.021) * 12;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  skySunPosition.setFromSphericalCoords(1, phi, theta).normalize();

  sunLight.position.copy(skySunPosition).multiplyScalar(190);
  sunLight.intensity = 2.6 + Math.max(0, pulse) * 0.9;
  skyLight.intensity = 0.62 + (1 - Math.max(0, pulse)) * 0.22;
  fillLight.intensity = 0.32 + (1 - Math.max(0, pulse)) * 0.14;

  const sunHeight = Math.max(0, skySunPosition.y);
  const warmth = 1 - sunHeight;
  sunTintColor.setRGB(
    1.0,
    0.86 + sunHeight * 0.12,
    0.7 + sunHeight * 0.22,
  );
  sunLight.color.copy(sunTintColor);

  const horizonElevationMix = clamp01(sunHeight * 1.4);
  horizonColor.setRGB(
    0.32 + horizonElevationMix * 0.18 + warmth * 0.18,
    0.50 + horizonElevationMix * 0.16 + warmth * 0.06,
    0.74 + horizonElevationMix * 0.10 - warmth * 0.08,
  );
  skyZenithColor.setRGB(
    0.03 + horizonElevationMix * 0.04,
    0.10 + horizonElevationMix * 0.06,
    0.28 + horizonElevationMix * 0.10,
  );

  if (skyDomeMaterial) {
    skyDomeMaterial.uniforms.horizonColor.value.copy(horizonColor);
    skyDomeMaterial.uniforms.zenithColor.value.copy(skyZenithColor);
    skyDomeMaterial.uniforms.sunDirection.value.copy(skySunPosition);
    skyDomeMaterial.uniforms.sunColor.value.copy(sunTintColor);
  }

  if (cloudVolumeMaterial?.uniforms?.lightDir) {
    cloudVolumeMaterial.uniforms.lightDir.value.copy(skySunPosition);
  }
  if (cloudVolumeMaterial?.uniforms?.skyColor) {
    cloudVolumeMaterial.uniforms.skyColor.value.copy(horizonColor);
  }
  if (cloudVolumeMaterial?.uniforms?.sunColor) {
    cloudVolumeMaterial.uniforms.sunColor.value.copy(sunTintColor);
  }
}

function buildTerrain() {
  const columns = segmentsX + 1;
  const rows = segmentsZ + 1;
  const geometry = new THREE.PlaneGeometry(
    terrainWidth,
    terrainDepth,
    segmentsX,
    segmentsZ,
  );
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  const heightValues = new Array(positions.count);
  const colors = [];

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const { lon, lat } = mapProjection.toGeo(x, z);
    const meters = terrainSampler.sample(lon, lat);
    heightValues[i] = elevationToSceneHeight(meters);
  }

  smoothHeights(heightValues, columns, rows, 5);

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const { lon, lat, u, v } = mapProjection.toGeo(x, z);
    const meters = terrainSampler.sample(lon, lat);
    positions.setY(i, heightValues[i]);
    uvs.setXY(i, u, v);

    const color = terrainColor(u, v, meters);
    colors.push(color.r, color.g, color.b);
  }

  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  uvs.needsUpdate = true;
  geometry.computeVertexNormals();

  if (!waterNormalTexture) waterNormalTexture = buildWaterNormalTexture();
  const material = satelliteTexture
    ? new THREE.MeshPhysicalMaterial({
        map: satelliteTexture,
        roughnessMap: vectorWaterRoughnessTexture ?? null,
        roughness: 0.92,
        metalness: 0,
        envMapIntensity: 0.42,
        clearcoatMap: vectorWaterMaskTexture ?? null,
        clearcoat: 0.72,
        clearcoatRoughnessMap: vectorWaterRoughnessTexture ?? null,
        clearcoatRoughness: 0.34,
        clearcoatNormalMap: waterNormalTexture,
        clearcoatNormalScale: new THREE.Vector2(0.28, 0.28),
        specularIntensityMap: vectorWaterMaskTexture ?? null,
        specularIntensity: 0.55,
        specularColor: 0xc8d8e6,
        color: 0xffffff,
      })
    : new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.84,
        metalness: 0,
        envMapIntensity: 0.5,
        color: 0xffffff,
      });

  terrainMesh = new THREE.Mesh(geometry, material);
  terrainMesh.receiveShadow = true;
  scene.add(terrainMesh);
}

function buildWaterNormalTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const imageData = ctx.createImageData(size, size);
  const data = imageData.data;

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let h = 0;
      h += Math.sin(x * 0.18 + Math.cos(y * 0.07) * 1.3) * 0.5;
      h += Math.cos(y * 0.24 + Math.sin(x * 0.11) * 1.7) * 0.35;
      h += Math.sin((x + y) * 0.07) * 0.15;
      h += (Math.random() - 0.5) * 0.06;
      height[y * size + x] = h;
    }
  }

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const ym = (y - 1 + size) % size;
      const yp = (y + 1) % size;
      const dx = height[y * size + xp] - height[y * size + xm];
      const dy = height[yp * size + x] - height[ym * size + x];
      const nx = -dx;
      const ny = -dy;
      const nz = 2.0;
      const len = Math.hypot(nx, ny, nz);
      const idx = (y * size + x) * 4;
      data[idx + 0] = Math.round((nx / len * 0.5 + 0.5) * 255);
      data[idx + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      data[idx + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(80, 28);
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  return texture;
}


async function loadTerrariumSampler(bounds, z) {
  const minTile = lonLatToTile(bounds.west, bounds.north, z);
  const maxTile = lonLatToTile(bounds.east, bounds.south, z);
  const tiles = new Map();
  const tasks = [];

  for (let x = minTile.x; x <= maxTile.x; x += 1) {
    for (let y = minTile.y; y <= maxTile.y; y += 1) {
      tasks.push(
        loadTerrariumTile(z, x, y).then((tile) => {
          tiles.set(tileKey(x, y), tile);
        }),
      );
    }
  }

  await Promise.all(tasks);

  const samples = [];
  for (let i = 0; i <= 48; i += 1) {
    for (let j = 0; j <= 32; j += 1) {
      const lon = bounds.west + (bounds.east - bounds.west) * (i / 48);
      const lat = bounds.south + (bounds.north - bounds.south) * (j / 32);
      samples.push(sampleTerrarium(tiles, z, lon, lat));
    }
  }

  const min = Math.min(...samples);
  const max = Math.max(...samples);

  return {
    min,
    max,
    source: "aws-terrarium",
    sample: (lon, lat) => sampleTerrarium(tiles, z, lon, lat),
  };
}

async function loadTerrariumTile(z, x, y) {
  const image = await loadImageWithTimeout(
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    12000,
  );

  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);

  return {
    x,
    y,
    width: image.width,
    height: image.height,
    data: imageData.data,
  };
}

async function loadSatelliteTexture(bounds, z, options = {}) {
  const minTile = lonLatToTile(bounds.west, bounds.north, z);
  const maxTile = lonLatToTile(bounds.east, bounds.south, z);
  const canvas = document.createElement("canvas");
  canvas.width = options.width ?? 2048;
  canvas.height = options.height ?? 1380;
  const context = canvas.getContext("2d");

  context.fillStyle = "#263522";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const west = lonLatToTileFloat(bounds.west, bounds.north, z).x;
  const east = lonLatToTileFloat(bounds.east, bounds.south, z).x;
  const north = lonLatToTileFloat(bounds.west, bounds.north, z).y;
  const south = lonLatToTileFloat(bounds.east, bounds.south, z).y;

  const tasks = [];
  let loaded = 0;
  const totalTiles = (maxTile.x - minTile.x + 1) * (maxTile.y - minTile.y + 1);

  for (let x = minTile.x; x <= maxTile.x; x += 1) {
    for (let y = minTile.y; y <= maxTile.y; y += 1) {
      tasks.push(
        loadSatelliteTile(z, x, y).then((image) => {
          const dx = ((x - west) / (east - west)) * canvas.width;
          const dy = ((y - north) / (south - north)) * canvas.height;
          const dw = (1 / (east - west)) * canvas.width;
          const dh = (1 / (south - north)) * canvas.height;
          context.drawImage(image, dx, dy, dw, dh);
          loaded += 1;
          const prefix = options.statusPrefix ?? "Loading satellite";
          statusText.textContent = `${prefix} ${loaded}/${totalTiles}`;
        }),
      );
    }
  }

  await Promise.all(tasks);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

async function loadNaipTexture(bounds, options = {}) {
  const width = options.width ?? 3072;
  const height = options.height ?? 1240;
  const params = new URLSearchParams({
    bbox: `${bounds.west},${bounds.south},${bounds.east},${bounds.north}`,
    bboxSR: "4326",
    imageSR: "4326",
    size: `${width},${height}`,
    format: "jpgpng",
    f: "image",
  });

  statusText.textContent = options.statusPrefix ?? "Loading NAIP imagery";

  try {
    const image = await loadImageWithTimeout(
      `https://tnmaccess.nationalmap.gov/arcgis/rest/services/Orthoimagery/USGSNAIPImagery/ImageServer/exportImage?${params.toString()}`,
      22000,
    );
    return imageToTexture(image);
  } catch (error) {
    console.warn("USGS NAIP imagery failed; falling back to Esri World Imagery.", error);
    return loadSatelliteTexture(bounds, satelliteZoom, {
      width: 2048,
      height: 1380,
      statusPrefix: "Loading fallback satellite",
    });
  }
}

function imageToTexture(image) {
  const texture = new THREE.Texture(image);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

async function loadSatelliteTile(z, x, y) {
  return loadImageWithTimeout(
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    12000,
  );
}

function addWaterPlane() {
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(terrainWidth, terrainDepth, 1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0x2f7f8d,
      transparent: true,
      opacity: 0.24,
      roughness: 0.28,
      metalness: 0.02,
    }),
  );
  water.position.y = 0.35;
  scene.add(water);
}

async function loadDetailedWaterMask() {
  try {
    const response = await fetch(dataUrl("water/usa-detailed-water-bodies.geojson"), { cache: "no-store" });
    if (!response.ok) throw new Error(`USA Detailed Water Bodies request failed: ${response.status}`);
    const geojson = await response.json();
    const mask = createDetailedWaterMaskTexture(geojson);
    vectorWaterMaskTexture = mask.alphaMap;
    vectorWaterRoughnessTexture = mask.roughnessMap;
  } catch (error) {
    console.warn("USA Detailed Water Bodies mask unavailable.", error);
  }
}

function enqueueConnected(row, column, columns, rows, cells, connected, queue) {
  if (row < 0 || row >= rows || column < 0 || column >= columns) return;
  const index = row * columns + column;
  if (!cells[index] || connected[index]) return;
  connected[index] = 1;
  queue.push(index);
}

function isSwampFeature(feature) {
  const ftype = feature?.properties?.FTYPE ?? "";
  return ftype.includes("Swamp") || ftype.includes("Marsh");
}

function createDetailedWaterMaskTexture(geojson) {
  const width = 2048;
  const height = Math.round(width * ((region.north - region.south) / (region.east - region.west)));
  const inlandSmoothCanvas = document.createElement("canvas");
  const inlandRoughCanvas = document.createElement("canvas");
  const alphaCanvas = document.createElement("canvas");
  const coastalCanvas = document.createElement("canvas");
  const roughnessCanvas = document.createElement("canvas");
  [inlandSmoothCanvas, inlandRoughCanvas, alphaCanvas, coastalCanvas, roughnessCanvas]
    .forEach((canvas) => { canvas.width = width; canvas.height = height; });

  const inlandSmoothContext = inlandSmoothCanvas.getContext("2d");
  inlandSmoothContext.fillStyle = "black";
  inlandSmoothContext.fillRect(0, 0, width, height);
  inlandSmoothContext.fillStyle = "white";

  const inlandRoughContext = inlandRoughCanvas.getContext("2d");
  inlandRoughContext.fillStyle = "black";
  inlandRoughContext.fillRect(0, 0, width, height);
  inlandRoughContext.fillStyle = "white";

  (geojson.features ?? []).forEach((feature) => {
    const target = isSwampFeature(feature) ? inlandRoughContext : inlandSmoothContext;
    drawWaterMaskFeature(target, feature, width, height);
  });

  const coastalContext = coastalCanvas.getContext("2d");
  coastalContext.fillStyle = "black";
  coastalContext.fillRect(0, 0, width, height);
  coastalContext.fillStyle = "white";
  drawConnectedCoastalWaterMask(coastalContext, width, height);

  const alphaContext = alphaCanvas.getContext("2d");
  alphaContext.fillStyle = "black";
  alphaContext.fillRect(0, 0, width, height);
  alphaContext.drawImage(inlandSmoothCanvas, 0, 0);
  alphaContext.drawImage(inlandRoughCanvas, 0, 0);
  alphaContext.drawImage(coastalCanvas, 0, 0);

  alphaContext.save();
  alphaContext.globalCompositeOperation = "lighter";
  alphaContext.filter = "blur(1px)";
  alphaContext.drawImage(alphaCanvas, 0, 0);
  alphaContext.restore();

  buildWaterMaterialMasks({
    inlandSmoothCanvas,
    inlandRoughCanvas,
    coastalCanvas,
    alphaCanvas,
    roughnessCanvas,
  });

  return {
    alphaMap: makeLinearCanvasTexture(alphaCanvas),
    roughnessMap: makeLinearCanvasTexture(roughnessCanvas),
  };
}

function buildWaterMaterialMasks({
  inlandSmoothCanvas,
  inlandRoughCanvas,
  coastalCanvas,
  alphaCanvas,
  roughnessCanvas,
}) {
  const width = alphaCanvas.width;
  const height = alphaCanvas.height;
  const opts = { willReadFrequently: true };
  const smoothData = inlandSmoothCanvas.getContext("2d", opts).getImageData(0, 0, width, height).data;
  const roughData = inlandRoughCanvas.getContext("2d", opts).getImageData(0, 0, width, height).data;
  const coastalData = coastalCanvas.getContext("2d", opts).getImageData(0, 0, width, height).data;
  const waterData = alphaCanvas.getContext("2d", opts).getImageData(0, 0, width, height).data;
  const roughnessContext = roughnessCanvas.getContext("2d");
  const roughnessImage = roughnessContext.createImageData(width, height);

  for (let i = 0; i < waterData.length; i += 4) {
    const smoothInland = smoothData[i] / 255;
    const roughInland = roughData[i] / 255;
    const coastal = coastalData[i] / 255;
    const materialWater = clamp(coastal * 0.78 + smoothInland * 0.78 + roughInland * 0.55, 0, 1);
    const roughness = Math.round(THREE.MathUtils.lerp(236, 58, materialWater));

    roughnessImage.data[i] = roughness;
    roughnessImage.data[i + 1] = roughness;
    roughnessImage.data[i + 2] = roughness;
    roughnessImage.data[i + 3] = 255;
  }

  roughnessContext.putImageData(roughnessImage, 0, 0);
}

function drawWaterMaskFeature(context, feature, width, height) {
  const geometry = feature.geometry;
  if (!geometry) return;
  const polygons =
    geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.type === "MultiPolygon"
        ? geometry.coordinates
        : [];

  polygons.forEach((polygon) => {
    if (!Array.isArray(polygon) || polygon.length === 0) return;
    context.beginPath();
    polygon.forEach((ring) => {
      ring.forEach(([lon, lat], index) => {
        const { x, y } = lonLatToMaskPixel(lon, lat, width, height);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.closePath();
    });
    context.fill("evenodd");
  });
}

function drawConnectedCoastalWaterMask(context, width, height) {
  if (!terrainSampler) return;

  const columns = 640;
  const rows = 320;
  const cells = new Uint8Array(columns * rows);
  const connected = new Uint8Array(columns * rows);
  const queue = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const lon = region.west + (region.east - region.west) * ((column + 0.5) / columns);
      const lat = region.south + (region.north - region.south) * ((row + 0.5) / rows);
      const elevation = terrainSampler.sample(lon, lat);
      const coastalBand = lat < region.south + 0.22;
      const bayBand = lon < -87.62 && lon > -88.38 && lat < 30.78;
      const threshold = coastalBand ? 2.8 : bayBand ? 1.7 : 0.55;
      if (elevation <= threshold) cells[row * columns + column] = 1;
    }
  }

  for (let column = 0; column < columns; column += 1) {
    enqueueConnected(0, column, columns, rows, cells, connected, queue);
  }

  while (queue.length > 0) {
    const index = queue.shift();
    const row = Math.floor(index / columns);
    const column = index - row * columns;
    enqueueConnected(row - 1, column, columns, rows, cells, connected, queue);
    enqueueConnected(row + 1, column, columns, rows, cells, connected, queue);
    enqueueConnected(row, column - 1, columns, rows, cells, connected, queue);
    enqueueConnected(row, column + 1, columns, rows, cells, connected, queue);
  }

  context.fillStyle = "white";
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!connected[row * columns + column]) continue;
      const lon0 = region.west + (region.east - region.west) * (column / columns);
      const lon1 = region.west + (region.east - region.west) * ((column + 1) / columns);
      const lat0 = region.south + (region.north - region.south) * (row / rows);
      const lat1 = region.south + (region.north - region.south) * ((row + 1) / rows);
      const p0 = lonLatToMaskPixel(lon0, lat1, width, height);
      const p1 = lonLatToMaskPixel(lon1, lat0, width, height);
      context.fillRect(p0.x, p0.y, Math.max(1, p1.x - p0.x), Math.max(1, p1.y - p0.y));
    }
  }
}

function lonLatToMaskPixel(lon, lat, width, height) {
  return {
    x: ((lon - region.west) / (region.east - region.west)) * width,
    y: (1 - (lat - region.south) / (region.north - region.south)) * height,
  };
}

function addRegionFrame() {
  const points = [
    new THREE.Vector3(-terrainWidth / 2, 2.5, -terrainDepth / 2),
    new THREE.Vector3(terrainWidth / 2, 2.5, -terrainDepth / 2),
    new THREE.Vector3(terrainWidth / 2, 2.5, terrainDepth / 2),
    new THREE.Vector3(-terrainWidth / 2, 2.5, terrainDepth / 2),
    new THREE.Vector3(-terrainWidth / 2, 2.5, -terrainDepth / 2),
  ];
  scene.add(
    new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color: 0x8fd3ff }),
    ),
  );
}

function addMesonetStations() {
  const group = new THREE.Group();

  mesonetStations.forEach((station) => {
    const p = mapProjection.toWorld(station.lon, station.lat);
    const marker =
      station.status === "archive"
        ? new THREE.Mesh(
            new THREE.ConeGeometry(1.15, 2.6, 3),
            new THREE.MeshStandardMaterial({ color: 0xff4d3d }),
          )
        : new THREE.Mesh(
            new THREE.SphereGeometry(1.05, 18, 12),
            new THREE.MeshStandardMaterial({ color: 0x2f86ff }),
          );

    marker.position.set(p.x, p.y + 1.5, p.z);
    marker.castShadow = true;
    group.add(marker);

    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.18, 5.5, 10),
      new THREE.MeshStandardMaterial({ color: 0xf4d35e }),
    );
    mast.position.set(p.x, p.y + 3.1, p.z);
    mast.castShadow = true;
    group.add(mast);

    const label = createStationLabel(station.name, station.status);
    label.position.set(p.x, p.y + 7.1, p.z);
    group.add(label);
  });

  scene.add(group);
  return group;
}

async function addCsbBoundaryLayer() {
  const layer = new THREE.Group();
  layer.name = "USDA CSB field boundaries";

  try {
    const response = await fetch(dataUrl("csb-mesonet-crops.geojson"), { cache: "no-store" });
    if (!response.ok) throw new Error(`CSB GeoJSON request failed: ${response.status}`);
    const geojson = await response.json();
    const features = geojson.features ?? [];

    const geometryByCrop = new Map();

    features.forEach((feature) => {
      const geometry = feature.geometry;
      if (!geometry) return;
      const cropName = feature.properties?.crop_name ?? "Unknown";
      if (!geometryByCrop.has(cropName)) {
        geometryByCrop.set(cropName, { segments: [], shapes: [] });
      }
      collectCsbDisplayGeometry(geometryByCrop.get(cropName), geometry);
    });

    if (geometryByCrop.size > 0) {
      geometryByCrop.forEach(({ segments, shapes }, cropName) => {
        const cropGroup = new THREE.Group();
        cropGroup.name = `CSB ${cropName}`;
        cropGroup.userData.cropCategory = cropCategory(cropName);

        if (shapes.length > 0) {
          const fillGeometry = new THREE.ShapeGeometry(shapes);
          fillGeometry.rotateX(Math.PI / 2);
          cropGroup.add(
            new THREE.Mesh(
              fillGeometry,
              new THREE.MeshBasicMaterial({
                color: cropFillColor(cropName),
                transparent: true,
                opacity: 0.36,
                side: THREE.DoubleSide,
                depthWrite: false,
                polygonOffset: true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits: -2,
              }),
            ),
          );
        }

        if (segments.length > 0) {
          const lineGeometry = new THREE.BufferGeometry();
          lineGeometry.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(segments, 3),
          );
          cropGroup.add(
            new THREE.LineSegments(
              lineGeometry,
              new THREE.LineBasicMaterial({
                color: cropBoundaryColor(cropName),
                transparent: true,
                opacity: 1,
                depthTest: false,
              }),
            ),
          );
        }

        cropGroup.position.y = 0.38;
        layer.add(cropGroup);
      });
    } else {
      layer.userData.empty = true;
    }
  } catch (error) {
    console.warn("CSB boundary layer failed.", error);
    layer.userData.error = error.message;
  }

  scene.add(layer);
  return layer;
}

function cropBoundaryColor(cropName) {
  if (cropName.includes("Cotton")) return 0xf4fbff;
  if (cropName.includes("Peanuts")) return 0xffc14a;
  if (cropName.includes("Soybeans")) return 0x2ee06a;
  if (cropName.includes("Corn")) return 0xffe04f;
  if (cropName.includes("Sorghum")) return 0xff9f43;
  if (cropName.includes("Hay") || cropName.includes("Pasture") || cropName.includes("Grassland")) return 0xd4ff62;
  if (cropName.includes("Forest")) return 0x43d169;
  if (cropName.includes("Wetlands")) return 0x58e3cc;
  if (cropName.includes("Water")) return 0x61b8ff;
  if (cropName.includes("Developed")) return 0xff6868;
  return 0xffffb8;
}

function cropFillColor(cropName) {
  if (cropName.includes("Cotton")) return 0xbfddea;
  if (cropName.includes("Peanuts")) return 0xc6882f;
  if (cropName.includes("Soybeans")) return 0x278a45;
  if (cropName.includes("Corn")) return 0xc9a62f;
  if (cropName.includes("Sorghum")) return 0xb06b2e;
  if (cropName.includes("Hay") || cropName.includes("Pasture") || cropName.includes("Grassland")) return 0x89a83e;
  if (cropName.includes("Forest")) return 0x245d34;
  if (cropName.includes("Wetlands")) return 0x367d74;
  if (cropName.includes("Water")) return 0x2e6f9e;
  if (cropName.includes("Developed")) return 0xa04747;
  return 0xb6b16a;
}

function cropCategory(cropName) {
  const name = cropName.toLowerCase();
  if (name.includes("corn")) return "corn";
  if (name.includes("cotton")) return "cotton";
  if (name.includes("peanuts")) return "peanuts";
  if (name.includes("soybeans")) return "soybeans";
  if (name.includes("hay") || name.includes("pasture") || name.includes("grassland")) return "pasture";
  return "other";
}

function collectCsbDisplayGeometry(target, geometry) {
  if (geometry.type === "Polygon") {
    geometry.coordinates.forEach((ring) => {
      collectCsbRing(target, ring);
    });
  }

  if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach((polygon) => {
      polygon.forEach((ring) => {
        collectCsbRing(target, ring);
      });
    });
  }
}

function collectCsbRing(target, ring) {
  const simplifiedRing = simplifyLonLatRing(ring);
  if (simplifiedRing.length < 4) return null;

  for (let i = 0; i < simplifiedRing.length - 1; i += 1) {
    const [lonA, latA] = simplifiedRing[i];
    const [lonB, latB] = simplifiedRing[i + 1];
    const a = mapProjection.toWorld(lonA, latA, { includeHeight: false });
    const b = mapProjection.toWorld(lonB, latB, { includeHeight: false });
    target.segments.push(a.x, 0, a.z, b.x, 0, b.z);
  }

  const points = simplifiedRing.slice(0, -1).map(([lon, lat]) => {
    const p = mapProjection.toWorld(lon, lat, { includeHeight: false });
    return new THREE.Vector2(p.x, p.z);
  });
  target.shapes.push(new THREE.Shape(points));
}

function simplifyLonLatRing(ring) {
  if (ring.length <= csbSimplifyStep + 2) return ring;

  const sampled = ring.filter((_, index) => index % csbSimplifyStep === 0);
  const lastPoint = ring[ring.length - 1];
  const firstPoint = sampled[0];

  if (
    firstPoint &&
    (lastPoint[0] !== firstPoint[0] || lastPoint[1] !== firstPoint[1])
  ) {
    sampled.push(lastPoint);
  }

  const simplified = [];
  let previousWorld = null;

  sampled.forEach(([lon, lat], index) => {
    const world = mapProjection.toWorld(lon, lat, { includeHeight: false });
    if (
      index === 0 ||
      index === sampled.length - 1 ||
      !previousWorld ||
      Math.hypot(world.x - previousWorld.x, world.z - previousWorld.z) >= csbMinPointDistance
    ) {
      simplified.push([lon, lat]);
      previousWorld = world;
    }
  });

  if (simplified.length < 4) return ring;
  return simplified;
}

function createStationLabel(name, status) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  context.font = "700 32px Inter, Arial, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = 8;
  context.strokeStyle = "rgba(0, 0, 0, 0.82)";
  context.fillStyle = status === "archive" ? "#ffded8" : "#e7f2ff";
  context.strokeText(name, canvas.width / 2, canvas.height / 2);
  context.fillText(name, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    }),
  );
  sprite.scale.set(18, 4.5, 1);
  return sprite;
}

async function addHrrrCloudPreviewLayer() {
  const group = new THREE.Group();
  group.name = "HRRR cloud preview";

  try {
    const volume = await loadCloudVolume();
    addVolumeCloud(group, volume);
    scene.add(group);
    if (weatherStatusText) {
      const { x, y, z } = volume.meta.shape;
      weatherStatusText.textContent = `${weatherStatusText.textContent} · volume ${x}x${y}x${z}`;
    }
  } catch (volumeError) {
    console.warn("HRRR volume cloud unavailable; using cloud deck preview.", volumeError);
    await addCloudDeckPreview(group);
  }

  return group;
}

async function addCloudDeckPreview(group) {
  try {
    const response = await fetch(weatherUrl("cloud-preview.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HRRR cloud preview request failed: ${response.status}`);
    const preview = await response.json();
    const puffs = preview.puffs ?? [];

    addCloudDecks(group, puffs);

    scene.add(group);
    if (weatherStatusText && puffs.length > 0) {
      weatherStatusText.textContent = `${weatherStatusText.textContent} · ${puffs.length} puffs`;
    }
  } catch (error) {
    console.warn("HRRR cloud preview unavailable; using placeholder clouds.", error);
    addPlaceholderClouds(group);
    scene.add(group);
  }
}

async function loadCloudVolume() {
  async function loadCloudFrame(name) {
    const metaResponse = await fetch(weatherUrl(`volume/${name}.json`), {
      cache: "no-store",
    });
    if (!metaResponse.ok) throw new Error(`HRRR volume metadata request failed: ${metaResponse.status}`);
    const meta = await metaResponse.json();
    const dataResponse = await fetch(weatherUrl(`volume/${meta.data}`), { cache: "no-store" });
    if (!dataResponse.ok) throw new Error(`HRRR volume request failed: ${dataResponse.status}`);
    const bytes = new Uint8Array(await dataResponse.arrayBuffer());
    const channelCount = meta.channels?.length ?? 1;
    const expected = meta.shape.x * meta.shape.y * meta.shape.z * channelCount;
    if (bytes.length !== expected) {
      throw new Error(`HRRR volume size mismatch: ${bytes.length} bytes for ${expected} voxels`);
    }

    const texture = new THREE.Data3DTexture(bytes, meta.shape.x, meta.shape.y, meta.shape.z);
    texture.format = channelCount === 2 ? THREE.RGFormat : THREE.RedFormat;
    texture.type = THREE.UnsignedByteType;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    return { meta, texture };
  }

  const frame0 = await loadCloudFrame("cloud-water-f01");
  let frame1 = frame0;
  try {
    frame1 = await loadCloudFrame("cloud-water-f02");
  } catch (error) {
    console.warn("HRRR F02 cloud volume unavailable; falling back to F01 only.", error);
  }
  return { meta: frame0.meta, texture0: frame0.texture, texture1: frame1.texture };
}

function addVolumeCloud(group, volume) {
  const boxHeight = 78;
  const geometry = new THREE.BoxGeometry(terrainWidth, boxHeight, terrainDepth);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    uniforms: {
      volumeMap0: { value: volume.texture0 },
      volumeMap1: { value: volume.texture1 },
      boxSize: { value: new THREE.Vector3(terrainWidth, boxHeight, terrainDepth) },
      steps: { value: 128 },
      density: { value: 5.4 },
      threshold: { value: 0.012 },
      edgeFade: { value: 0.13 },
      verticalFade: { value: 0.08 },
      lightDir: { value: new THREE.Vector3(-0.55, 0.72, 0.36).normalize() },
      skyColor: { value: new THREE.Color(0x6da4d8) },
      sunColor: { value: new THREE.Color(0xfff0cc) },
      cloudTime: { value: 0 },
      cloudWindProfile: { value: createEmptyCloudWindProfile() },
      cloudWindLayerCount: { value: 0 },
      cloudWindUMap0: { value: null },
      cloudWindVMap0: { value: null },
      cloudWindUMap1: { value: null },
      cloudWindVMap1: { value: null },
      hasCloudWindVolume: { value: false },
      cloudAlpha: { value: 0 },
      cloudAdvectionSeconds: { value: 0 },
      cloudMotionScale: { value: 0.0000018 },
    },
    vertexShader: `
      varying vec3 vOrigin;
      varying vec3 vDirection;

      void main() {
        vec4 localCamera = inverse(modelMatrix) * vec4(cameraPosition, 1.0);
        vOrigin = localCamera.xyz;
        vDirection = position - vOrigin;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      precision highp sampler3D;

      uniform sampler3D volumeMap0;
      uniform sampler3D volumeMap1;
      uniform vec3 boxSize;
      uniform int steps;
      uniform float density;
      uniform float threshold;
      uniform float edgeFade;
      uniform float verticalFade;
      uniform vec3 lightDir;
      uniform vec3 skyColor;
      uniform vec3 sunColor;
      uniform float cloudTime;
      uniform vec2 cloudWindProfile[40];
      uniform int cloudWindLayerCount;
      uniform sampler3D cloudWindUMap0;
      uniform sampler3D cloudWindVMap0;
      uniform sampler3D cloudWindUMap1;
      uniform sampler3D cloudWindVMap1;
      uniform bool hasCloudWindVolume;
      uniform float cloudAlpha;
      uniform float cloudAdvectionSeconds;
      uniform float cloudMotionScale;

      varying vec3 vOrigin;
      varying vec3 vDirection;

      vec2 hitBox(vec3 origin, vec3 direction) {
        vec3 boxMin = -boxSize * 0.5;
        vec3 boxMax = boxSize * 0.5;
        vec3 invDirection = 1.0 / direction;
        vec3 tMinTemp = (boxMin - origin) * invDirection;
        vec3 tMaxTemp = (boxMax - origin) * invDirection;
        vec3 tMin = min(tMinTemp, tMaxTemp);
        vec3 tMax = max(tMinTemp, tMaxTemp);
        float t0 = max(max(tMin.x, tMin.y), tMin.z);
        float t1 = min(min(tMax.x, tMax.y), tMax.z);
        return vec2(t0, t1);
      }

      vec2 windAt(vec3 localUv) {
        float heightRatio = clamp(localUv.y, 0.0, 0.999);
        vec3 windCoord = vec3(localUv.x, 1.0 - localUv.z, heightRatio);
        if (hasCloudWindVolume) {
          vec2 wind0 = vec2(texture(cloudWindUMap0, windCoord).r, -texture(cloudWindVMap0, windCoord).r);
          vec2 wind1 = vec2(texture(cloudWindUMap1, windCoord).r, -texture(cloudWindVMap1, windCoord).r);
          return mix(wind0, wind1, cloudAlpha);
        }
        if (cloudWindLayerCount > 0) {
          int layerIndex = int(floor(heightRatio * float(cloudWindLayerCount)));
          layerIndex = clamp(layerIndex, 0, 39);
          return cloudWindProfile[layerIndex];
        }
        return vec2(0.0);
      }

      float hash31(vec3 p) {
        return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
      }

      float valueNoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
        float nx00 = mix(n000, n100, f.x);
        float nx10 = mix(n010, n110, f.x);
        float nx01 = mix(n001, n101, f.x);
        float nx11 = mix(n011, n111, f.x);
        float nxy0 = mix(nx00, nx10, f.y);
        float nxy1 = mix(nx01, nx11, f.y);
        return mix(nxy0, nxy1, f.z);
      }

      vec3 edgeFadeForUv(vec3 localUv) {
        float edgeX = smoothstep(0.0, edgeFade, localUv.x) * smoothstep(0.0, edgeFade, 1.0 - localUv.x);
        float edgeZ = smoothstep(0.0, edgeFade, localUv.z) * smoothstep(0.0, edgeFade, 1.0 - localUv.z);
        return vec3(edgeX * edgeZ, edgeX, edgeZ);
      }

      vec2 sampleCloudMap(sampler3D map, vec3 localUv, vec2 drift) {
        localUv.x = localUv.x - drift.x;
        localUv.z = localUv.z - drift.y;
        float horizontalFade = edgeFadeForUv(localUv).x;
        if (localUv.x < 0.0 || localUv.x > 1.0 || localUv.z < 0.0 || localUv.z > 1.0) {
          return vec2(0.0);
        }
        float heightRatio = clamp(localUv.y, 0.0, 0.999);
        vec3 texCoord = vec3(localUv.x, 1.0 - localUv.z, heightRatio);
        return texture(map, texCoord).rg * horizontalFade;
      }

      vec2 sampleCloud(vec3 localPosition) {
        vec3 localUv = localPosition / boxSize + 0.5;
        vec2 wind = windAt(localUv);
        vec2 forwardDrift = wind * cloudAlpha * cloudAdvectionSeconds * cloudMotionScale;
        vec2 backwardDrift = -wind * (1.0 - cloudAlpha) * cloudAdvectionSeconds * cloudMotionScale;
        vec2 fromF01 = sampleCloudMap(volumeMap0, localUv, forwardDrift);
        vec2 fromF02 = sampleCloudMap(volumeMap1, localUv, backwardDrift);
        return mix(fromF01, fromF02, cloudAlpha);
      }

      float cloudMask(vec3 localPosition) {
        vec3 uvw = localPosition / boxSize + 0.5;
        float edgeX = smoothstep(0.0, edgeFade, uvw.x) * smoothstep(0.0, edgeFade, 1.0 - uvw.x);
        float edgeZ = smoothstep(0.0, edgeFade, uvw.z) * smoothstep(0.0, edgeFade, 1.0 - uvw.z);
        float base = smoothstep(0.0, verticalFade, uvw.y);
        float top = smoothstep(0.0, verticalFade * 1.7, 1.0 - uvw.y);
        return edgeX * edgeZ * base * top;
      }

      void main() {
        vec3 rayDirection = normalize(vDirection);
        vec2 bounds = hitBox(vOrigin, rayDirection);
        if (bounds.x > bounds.y) discard;
        bounds.x = max(bounds.x, 0.0);

        float rayLength = bounds.y - bounds.x;
        float stepLength = rayLength / float(steps);
        vec3 stepVector = rayDirection * stepLength;
        vec3 position = vOrigin + rayDirection * bounds.x;

        vec3 color = vec3(0.0);
        float alpha = 0.0;

        for (int i = 0; i < 160; i++) {
          if (i >= steps) break;
          vec2 rawDensity = sampleCloud(position);
          float heightTint = clamp(position.y / boxSize.y + 0.5, 0.0, 1.0);
          float detail = valueNoise(position * 0.075 + vec3(cloudTime * 0.012, 0.0, -cloudTime * 0.009));
          float fine = valueNoise(position * 0.22 + vec3(11.7, cloudTime * 0.006, 4.1));
          float breakup = clamp(0.72 + detail * 0.42 + fine * 0.18, 0.45, 1.22);
          float water = max(rawDensity.r - threshold, 0.0) / max(1.0 - threshold, 0.001);
          float ice = max(rawDensity.g - threshold * 0.46, 0.0) / max(1.0 - threshold * 0.46, 0.001);
          water = pow(water, 0.68) * breakup;
          ice = pow(ice, 0.78) * (0.74 + detail * 0.38);
          float cloud = (water * 1.05 + ice * 0.55) * cloudMask(position);

          if (cloud > 0.001) {
            vec2 shadeSample = sampleCloud(position + lightDir * 3.6);
            float shadeDensity = rawDensity.r + rawDensity.g * 0.58;
            float shadeProbe = shadeSample.r + shadeSample.g * 0.58;
            float shade = clamp(0.74 + (shadeDensity - shadeProbe) * 1.42, 0.44, 1.12);
            vec3 ambientSky = mix(skyColor * 0.55, vec3(1.0), 0.45);
            vec3 sunLit = mix(vec3(1.0), sunColor, 0.65);
            vec3 waterColor = mix(ambientSky * 0.78, sunLit, shade);
            vec3 iceColor = mix(ambientSky * 0.92, vec3(1.0), shade * 0.92 + heightTint * 0.12);
            float iceMix = clamp(ice / max(water + ice, 0.001), 0.0, 1.0);
            vec3 cloudColor = mix(waterColor, iceColor, iceMix);
            float silver = pow(clamp(dot(normalize(lightDir), normalize(-rayDirection)), 0.0, 1.0), 5.0);
            cloudColor += silver * sunColor * 0.18;
            float sampleAlpha = 1.0 - exp(-cloud * density * stepLength / 40.0);
            sampleAlpha *= 1.0 - alpha;
            color += cloudColor * sampleAlpha;
            alpha += sampleAlpha;
            if (alpha > 0.92) break;
          }

          position += stepVector;
        }

        if (alpha < 0.012) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
  cloudVolumeMaterial = material;

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = boxHeight * 0.56;
  mesh.renderOrder = 8;
  group.add(mesh);
}

async function addHrrrWindPreviewLayer() {
  const group = new THREE.Group();
  group.name = "HRRR wind flow";
  group.visible = false;

  try {
    windVolume = await loadWindVolume();
    applyCloudWindProfile(windVolume);
    addWindVolumeTrails(group, windVolume);
    scene.add(group);
    return group;
  } catch (error) {
    console.warn("HRRR wind volume unavailable.", error);
    scene.add(group);
    return group;
  }
}

async function loadWindVolume() {
  async function loadWindFrame(name) {
    const metaResponse = await fetch(weatherUrl(`wind-volume/${name}.json`), {
      cache: "no-store",
    });
    if (!metaResponse.ok) throw new Error(`HRRR wind volume metadata request failed: ${metaResponse.status}`);
    const meta = await metaResponse.json();
    const count = meta.shape.x * meta.shape.y * meta.shape.z;

    async function loadComponent(component) {
      const response = await fetch(weatherUrl(`wind-volume/${meta.components[component]}`), {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HRRR wind ${component} request failed: ${response.status}`);
      const values = new Float32Array(await response.arrayBuffer());
      if (values.length !== count) throw new Error(`HRRR wind ${component} size mismatch`);
      return values;
    }

    const u = await loadComponent("u");
    const v = await loadComponent("v");
    const w = await loadComponent("w");
    return {
      meta,
      u,
      v,
      w,
      uTexture: createWindComponentTexture(u, meta),
      vTexture: createWindComponentTexture(v, meta),
    };
  }

  const frame0 = await loadWindFrame("wind-f01");
  let frame1 = frame0;
  try {
    frame1 = await loadWindFrame("wind-f02");
  } catch (error) {
    console.warn("HRRR F02 wind volume unavailable; falling back to F01 only.", error);
  }
  const speedP95 = Math.max(frame0.meta.speed_p95_ms, frame1.meta.speed_p95_ms);

  return {
    meta: {
      ...frame0.meta,
      speed_p95_ms: speedP95,
      speed_max_ms: Math.max(frame0.meta.speed_max_ms, frame1.meta.speed_max_ms),
    },
    frame0,
    frame1,
  };
}

function createWindComponentTexture(values, meta) {
  const texture = new THREE.Data3DTexture(values, meta.shape.x, meta.shape.y, meta.shape.z);
  texture.format = THREE.RedFormat;
  texture.type = THREE.FloatType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function addWindVolumeTrails(group, volume) {
  const samples = [];
  const columns = 8;
  const rows = 4;
  const levels = volume.meta.shape.z;
  const halfWidth = terrainWidth * 0.5;
  const halfDepth = terrainDepth * 0.5;
  const p95 = Math.max(1, volume.meta.speed_p95_ms * 0.52);

  for (let k = 0; k < levels; k += 1) {
    for (let j = 0; j < rows; j += 1) {
      for (let i = 0; i < columns; i += 1) {
        const u = (i + 0.5 + seededNoise(i * 19.1 + j * 7.2 + k) * 0.34) / columns;
        const v = (j + 0.5 + seededNoise(i * 5.7 + j * 17.2 + k) * 0.34) / rows;
        const z = levels <= 1 ? 0 : k / (levels - 1);
        const baseX = (u - 0.5) * terrainWidth;
        const baseY = windVolumeBaseY + z * windVolumeHeight;
        const baseZ = (0.5 - v) * terrainDepth;
        const seedWind = sampleWindVolume(volume, baseX, baseY, baseZ);
        const seedSpeed = Math.hypot(seedWind.x, seedWind.z);
        const speedFactor = clamp(seedSpeed / p95, 0, 1.8);
        const copies = 1 + Math.floor(speedFactor * 1.65);

        for (let copy = 0; copy < copies; copy += 1) {
          const scatterSeed = i * 31.7 + j * 47.3 + k * 13.9 + copy * 91.1;
          const scatterRadius = copy === 0 ? 0 : 0.28 + speedFactor * 0.42;
          samples.push({
            x: baseX + (seededNoise(scatterSeed) * 2 - 1) * terrainWidth / columns * scatterRadius,
            y: baseY + (seededNoise(scatterSeed + 5.2) * 2 - 1) * windVolumeHeight / levels * scatterRadius * 0.55,
            z: baseZ + (seededNoise(scatterSeed + 11.4) * 2 - 1) * terrainDepth / rows * scatterRadius,
            heightRatio: z,
            levelIndex: k,
            levelHpa: volume.meta.levels_hpa?.[k] ?? null,
            seedSpeed,
            speedFactor,
            phase: seededNoise(i * 11.7 + j * 29.3 + k * 3.1 + copy * 7.7),
            offsetX: seededNoise(i * 13.1 + k + copy * 4.9) * 2 - 1,
            offsetZ: seededNoise(j * 17.4 + k + copy * 8.3) * 2 - 1,
            halfWidth,
            halfDepth,
          });
        }
      }
    }
  }

  const trailLength = 34;
  const baseMaterial = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const trails = samples.map((sample) => {
    const positions = new Float32Array(trailLength * 3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const material = baseMaterial.clone();
    material.opacity = clamp(0.24 + sample.speedFactor * 0.42 + sample.heightRatio * 0.12, 0.26, 0.86);
    material.color.copy(windHeightColor(sample.heightRatio));
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 12;
    group.add(line);
    return { line, positions };
  });

  windFlowSystem = {
    volume,
    samples,
    trails,
    trailLength,
    startedAt: performance.now(),
  };
}

function updateWindAnimation() {
  if (!windAnimationEnabled || !windFlowSystem) return;
  updateWeatherAlpha();
  const elapsed = (performance.now() - windFlowSystem.startedAt) / 1000;
  const trailLength = windFlowSystem.trailLength;
  const halfWidth = terrainWidth * 0.5;
  const halfDepth = terrainDepth * 0.5;

  windFlowSystem.samples.forEach((sample, index) => {
    const trail = windFlowSystem.trails[index];
    const positions = trail.positions;
    const wind = sampleWindVolume(windFlowSystem.volume, sample.x, sample.y, sample.z);
    const speed = Math.hypot(wind.x, wind.z);
    const speedFactor = clamp(speed / Math.max(1, windFlowSystem.volume.meta.speed_p95_ms * 0.52), 0.12, 1.6);
    const cycle = 7 + speedFactor * 18;
    const trailStepSeconds = 0.1 + speedFactor * 0.7;
    const headTime = (elapsed + sample.phase * cycle) % cycle;
    let visible = true;
    let previous = null;
    for (let step = 0; step < trailLength; step += 1) {
      const t = Math.max(0, headTime - step * trailStepSeconds);
      const x = sample.x + wind.x * t + sample.offsetX * 0.5;
      const z = sample.z + wind.z * t + sample.offsetZ * 0.5;
      const curve = Math.sin(t * 0.72 + sample.phase * Math.PI * 2);
      const cross = Math.cos(t * 0.53 + sample.phase * Math.PI * 2);
      const xCurved = x + curve * 0.7;
      const zCurved = z + cross * 0.45;
      const y = sample.y + wind.y * t + Math.sin(elapsed * 0.9 + sample.phase * 6.28) * 0.28;

      if (
        xCurved < -halfWidth || xCurved > halfWidth
        || zCurved < -halfDepth || zCurved > halfDepth
        || y < windVolumeBaseY - 4 || y > windVolumeBaseY + windVolumeHeight + 8
        || (previous && Math.hypot(xCurved - previous.x, zCurved - previous.z) > terrainWidth * 0.32)
      ) {
        visible = false;
      }
      previous = { x: xCurved, z: zCurved };

      const offset = step * 3;
      positions[offset] = xCurved;
      positions[offset + 1] = y;
      positions[offset + 2] = zCurved;
    }
    trail.line.geometry.attributes.position.needsUpdate = true;
    trail.line.visible = visible;
  });

  if (statusText) {
    statusText.textContent = `3D wind volume trails | ${windFlowSystem.volume.meta.shape.z} pressure layers | F01/F02 interpolated`;
  }
}

function windHeightColor(heightRatio) {
  const low = new THREE.Color(0x67f3ff);
  const mid = new THREE.Color(0x4d8dff);
  const high = new THREE.Color(0xe6d5ff);
  if (heightRatio < 0.55) {
    return low.lerp(mid, heightRatio / 0.55);
  }
  return mid.lerp(high, (heightRatio - 0.55) / 0.45);
}

const windSampleScratch = { x: 0, y: 0, z: 0 };
function sampleWindVolume(volume, x, y, z, out = windSampleScratch) {
  const shape = volume.meta.shape;
  const ux = clamp(x / terrainWidth + 0.5, 0, 0.999);
  const uy = clamp((y - windVolumeBaseY) / windVolumeHeight, 0, 0.999);
  const uz = clamp(0.5 - z / terrainDepth, 0, 0.999);
  const ix = Math.floor(ux * shape.x);
  const iy = Math.floor(uz * shape.y);
  const iz = Math.floor(uy * shape.z);
  const index = iz * shape.y * shape.x + iy * shape.x + ix;
  const alpha = currentWeatherAlpha;
  const u = THREE.MathUtils.lerp(volume.frame0.u[index], volume.frame1.u[index], alpha);
  const v = THREE.MathUtils.lerp(volume.frame0.v[index], volume.frame1.v[index], alpha);
  const w = THREE.MathUtils.lerp(volume.frame0.w[index], volume.frame1.w[index], alpha);
  out.x = u * 0.52;
  out.y = -w * 0.52;
  out.z = -v * 0.52;
  return out;
}

function addCloudDecks(group, puffs) {
  if (puffs.length === 0) return;

  const bands = [
    puffs.filter((puff) => puff.height_m < 4200),
    puffs.filter((puff) => puff.height_m >= 4200 && puff.height_m < 5600),
    puffs.filter((puff) => puff.height_m >= 5600),
  ].filter((band) => band.length > 0);

  bands.forEach((band, index) => {
    const texture = createCloudDeckTexture(band, index);
    const opacity = [0.72, 0.6, 0.48][index] ?? 0.48;
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    const geometry = new THREE.PlaneGeometry(terrainWidth, terrainDepth, 1, 1);
    geometry.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geometry, material);
    const meanHeight = band.reduce((sum, puff) => sum + puff.height_m, 0) / band.length;
    mesh.position.y = 16 + meanHeight * 0.0105 + index * 1.8;
    mesh.renderOrder = 5 + index;
    group.add(mesh);
  });
}

function createCloudDeckTexture(puffs, bandIndex) {
  const size = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");

  puffs.forEach((puff, index) => {
    const { u, v } = mapProjection.toUv(puff.lon, puff.lat);
    const x = u * size;
    const y = (1 - v) * size;
    const rx = Math.max(36, (puff.radius_km / 310) * size);
    const ry = Math.max(24, (puff.depth_km / 130) * size);
    const alpha = Math.min(0.56, 0.2 + puff.density * 85);
    const angle = seededNoise(index * 18.37 + bandIndex * 3.1) * Math.PI;
    drawCloudLobe(ctx, x, y, rx, ry, angle, alpha);

    for (let i = 0; i < 7; i += 1) {
      const offsetAngle = seededNoise(index * 41.2 + i * 9.3) * Math.PI * 2;
      const distance = seededNoise(index * 5.9 + i * 13.4) * rx * 0.72;
      const lx = x + Math.cos(offsetAngle) * distance;
      const ly = y + Math.sin(offsetAngle) * distance * 0.55;
      const scale = 0.34 + seededNoise(index * 2.4 + i * 7.7) * 0.48;
      drawCloudLobe(ctx, lx, ly, rx * scale, ry * scale, angle + i * 0.31, alpha * 0.38);
    }
  });

  erodeCloudTexture(ctx, size, bandIndex);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function drawCloudLobe(ctx, x, y, rx, ry, angle, alpha) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(rx, ry);
  const gradient = ctx.createRadialGradient(0, 0, 0.02, 0, 0, 1);
  gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
  gradient.addColorStop(0.34, `rgba(248,252,255,${alpha * 0.74})`);
  gradient.addColorStop(0.72, `rgba(238,245,250,${alpha * 0.24})`);
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function erodeCloudTexture(ctx, size, seedOffset) {
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const alpha = data[index + 3] / 255;
      if (alpha <= 0) continue;

      const n1 = cloudValueNoise(x * 0.018, y * 0.018, seedOffset);
      const n2 = cloudValueNoise(x * 0.052 + 17.3, y * 0.052 - 8.1, seedOffset + 11);
      const breakup = 0.62 + n1 * 0.52 - n2 * 0.28;
      const newAlpha = Math.max(0, Math.min(1, alpha * breakup));
      const shade = 235 + Math.floor(n1 * 20);
      data[index] = shade;
      data[index + 1] = Math.min(255, shade + 4);
      data[index + 2] = 255;
      data[index + 3] = Math.floor(newAlpha * 255);
    }
  }

  ctx.putImageData(image, 0, 0);
}

function cloudValueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = seededNoise(ix * 12.9898 + iy * 78.233 + seed * 19.19);
  const b = seededNoise((ix + 1) * 12.9898 + iy * 78.233 + seed * 19.19);
  const c = seededNoise(ix * 12.9898 + (iy + 1) * 78.233 + seed * 19.19);
  const d = seededNoise((ix + 1) * 12.9898 + (iy + 1) * 78.233 + seed * 19.19);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, sx),
    THREE.MathUtils.lerp(c, d, sx),
    sy,
  );
}


function addPlaceholderClouds(group) {
  const texture = createCloudDeckTexture(
    [
      { lon: -87.8, lat: 30.72, height_m: 4200, density: 0.0028, radius_km: 40, depth_km: 20 },
      { lon: -87.2, lat: 30.92, height_m: 4600, density: 0.0022, radius_km: 34, depth_km: 18 },
      { lon: -86.7, lat: 30.66, height_m: 3800, density: 0.0024, radius_km: 38, depth_km: 16 },
    ],
    0,
  );
  const cloudMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.PlaneGeometry(terrainWidth, terrainDepth, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const cloud = new THREE.Mesh(geometry, cloudMaterial);
  cloud.position.y = 62;
  cloud.renderOrder = 5;
  group.add(cloud);
}

function addWeatherParticleLayer() {
  const group = new THREE.Group();
  group.name = "HRRR precipitation particles";

  const seedData = createRainParticleSeeds(150000);
  const { positions, speeds, phases, sizes, rainHints } = seedData;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("basePosition", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("speed", new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute("rainHint", new THREE.BufferAttribute(rainHints, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: {
      time: { value: 0 },
      opacity: { value: 2.25 },
      baseY: { value: 1.2 },
      topY: { value: 50 },
      wind: { value: new THREE.Vector2(-0.7, 0.28) },
      color: { value: new THREE.Color(0xd8ecff) },
      rainMap0: { value: rainPreview?.texture0 ?? createEmptyRainTexture() },
      rainMap1: { value: rainPreview?.texture1 ?? createEmptyRainTexture() },
      rainAlpha: { value: 0 },
    },
    vertexShader: `
      attribute vec3 basePosition;
      attribute float speed;
      attribute float phase;
      attribute float size;
      attribute float rainHint;

      uniform float time;
      uniform float baseY;
      uniform float topY;
      uniform vec2 wind;
      uniform sampler2D rainMap0;
      uniform sampler2D rainMap1;
      uniform float rainAlpha;

      varying float vFall;
      varying float vMist;
      varying float vRain;
      varying float vHeightFade;

      void main() {
        vec2 baseRainUv = vec2(basePosition.x / ${terrainWidth.toFixed(1)} + 0.5, 0.5 - basePosition.z / ${terrainDepth.toFixed(1)});
        float rainSeed = max(texture2D(rainMap0, baseRainUv).r, texture2D(rainMap1, baseRainUv).r);
        rainSeed = max(rainSeed, rainHint);
        float fall = fract(phase + time * speed * (0.28 + rainSeed * 0.34));
        float rainTopY = mix(14.0, topY, smoothstep(0.03, 0.72, rainSeed));
        vec3 position = basePosition;
        position.y = mix(rainTopY, baseY, fall);
        position.x += wind.x * fall * 12.0;
        position.z += wind.y * fall * 12.0;

        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vec2 rainUv = vec2(position.x / ${terrainWidth.toFixed(1)} + 0.5, 0.5 - position.z / ${terrainDepth.toFixed(1)});
        float rain0 = texture2D(rainMap0, rainUv).r;
        float rain1 = texture2D(rainMap1, rainUv).r;
        vRain = max(mix(rain0, rain1, rainAlpha), rainHint * 0.82);
        if (vRain < 0.012 || rainSeed < 0.012) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          gl_PointSize = 0.0;
          vFall = fall;
          vMist = 0.0;
          return;
        }
        gl_PointSize = size * (460.0 / max(70.0, -mvPosition.z)) * (1.04 + vRain * 1.25);
        gl_Position = projectionMatrix * mvPosition;
        vFall = fall;
        vMist = smoothstep(0.0, 0.22, fall) * smoothstep(1.0, 0.72, fall) * smoothstep(0.02, 0.16, vRain);
        vHeightFade = smoothstep(rainTopY, baseY, position.y);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform vec3 color;
      uniform float opacity;

      varying float vFall;
      varying float vMist;
      varying float vRain;
      varying float vHeightFade;

      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float streak = smoothstep(0.095, 0.0, abs(uv.x)) * smoothstep(0.64, -0.02, abs(uv.y));
        float core = smoothstep(0.046, 0.0, abs(uv.x)) * smoothstep(0.56, 0.0, abs(uv.y));
        float alpha = max(streak * 0.76, core) * opacity * vMist * (0.7 + vRain * 2.05);
        if (alpha < 0.006) discard;
        vec3 tint = mix(color * 0.7, vec3(1.0), pow(1.0 - vFall, 2.0) * 0.12);
        gl_FragColor = vec4(tint, alpha);
      }
    `,
  });

  const particles = new THREE.Points(geometry, material);
  particles.frustumCulled = false;
  particles.renderOrder = 11;
  group.add(particles);
  const streakMaterial = addRainStreakLayer(group);
  addRainFieldTrails(group);
  scene.add(group);

  precipitationSystem = { material, streakMaterial };
  return group;
}

function addRainFieldTrails(group) {
  const cells = rainParticleCells();
  if (cells.length === 0) return;

  const samples = [];
  const cumulative = [];
  let total = 0;
  cells.forEach((cell) => {
    total += cell.weight;
    cumulative.push(total);
  });

  const count = Math.min(760, Math.max(180, Math.round(cells.length * 1.8)));
  for (let i = 0; i < count; i += 1) {
    const seed = i * 23.71;
    const pick = seededNoise(seed + 5.3) * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (cumulative[mid] < pick) low = mid + 1;
      else high = mid;
    }
    const cell = cells[low] ?? cells[0];
    const u = (cell.x + seededNoise(seed + 1.1)) / cell.width;
    const v = (cell.y + seededNoise(seed + 2.2)) / cell.height;
    samples.push({
      x: (u - 0.5) * terrainWidth,
      z: (0.5 - v) * terrainDepth,
      strength: cell.strength,
      topRatio: cell.topRatio ?? 0.45,
      phase: seededNoise(seed + 7.7),
      drift: seededNoise(seed + 13.3) * 2 - 1,
      speed: 0.72 + seededNoise(seed + 19.9) * 0.82 + cell.strength * 0.55,
    });
  }

  const trailLength = 22;
  const segmentCount = trailLength - 1;
  const baseMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      color: { value: new THREE.Color(0xbcecff) },
      opacity: { value: 0.72 },
      topY: { value: 48 },
      baseY: { value: 1.4 },
    },
    vertexShader: `
      uniform float topY;
      uniform float baseY;

      attribute float fade;
      varying float vFade;
      varying float vHeightFade;

      void main() {
        vFade = fade;
        vHeightFade = smoothstep(topY, baseY, position.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform vec3 color;
      uniform float opacity;
      varying float vFade;
      varying float vHeightFade;

      void main() {
        float topFadeIn = pow(vHeightFade, 2.4);
        float alpha = opacity * vFade * topFadeIn;
        if (alpha < 0.018) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  const trails = samples.map((sample) => {
    const positions = new Float32Array(segmentCount * 2 * 3);
    const fades = new Float32Array(segmentCount * 2);
    for (let step = 0; step < segmentCount; step += 1) {
      const headFade = 1 - step / segmentCount;
      const tailFade = 1 - (step + 1) / segmentCount;
      fades[step * 2] = Math.pow(headFade, 1.35);
      fades[step * 2 + 1] = Math.pow(tailFade, 1.35);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("fade", new THREE.BufferAttribute(fades, 1));
    const material = baseMaterial.clone();
    material.uniforms = THREE.UniformsUtils.clone(baseMaterial.uniforms);
    material.uniforms.opacity.value = clamp(0.62 + sample.strength * 1.05, 0.66, 1.35);
    material.uniforms.topY.value = clamp(8 + sample.strength * 14, 10, 22);
    material.uniforms.color.value = new THREE.Color(0x8edcff).lerp(
      new THREE.Color(0xf7fdff),
      clamp(sample.strength, 0, 1) * 0.48,
    );
    const line = new THREE.LineSegments(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 13;
    group.add(line);
    return { line, positions };
  });

  rainFlowSystem = {
    samples,
    trails,
    trailLength,
    startedAt: performance.now(),
    wind: new THREE.Vector2(-0.7, 0.28),
  };
}

function addRainStreakLayer(group) {
  const seedData = createRainParticleSeeds(70000);
  const segmentCount = seedData.speeds.length;
  const positions = new Float32Array(segmentCount * 2 * 3);
  const speeds = new Float32Array(segmentCount * 2);
  const phases = new Float32Array(segmentCount * 2);
  const rainHints = new Float32Array(segmentCount * 2);
  const lineEnds = new Float32Array(segmentCount * 2);

  for (let i = 0; i < segmentCount; i += 1) {
    for (let end = 0; end < 2; end += 1) {
      const sourceIndex = i * 3;
      const targetIndex = i * 2 + end;
      positions[targetIndex * 3] = seedData.positions[sourceIndex];
      positions[targetIndex * 3 + 1] = seedData.positions[sourceIndex + 1];
      positions[targetIndex * 3 + 2] = seedData.positions[sourceIndex + 2];
      speeds[targetIndex] = seedData.speeds[i];
      phases[targetIndex] = seedData.phases[i];
      rainHints[targetIndex] = seedData.rainHints[i];
      lineEnds[targetIndex] = end;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("basePosition", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("speed", new THREE.BufferAttribute(speeds, 1));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("rainHint", new THREE.BufferAttribute(rainHints, 1));
  geometry.setAttribute("lineEnd", new THREE.BufferAttribute(lineEnds, 1));

  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      time: { value: 0 },
      opacity: { value: 1.05 },
      baseY: { value: 1.0 },
      topY: { value: 22 },
      wind: { value: new THREE.Vector2(-0.7, 0.28) },
      headColor: { value: new THREE.Color(0xeaf6ff) },
      tailColor: { value: new THREE.Color(0x7ec2ff) },
      rainMap0: { value: rainPreview?.texture0 ?? createEmptyRainTexture() },
      rainMap1: { value: rainPreview?.texture1 ?? createEmptyRainTexture() },
      rainAlpha: { value: 0 },
    },
    vertexShader: `
      attribute vec3 basePosition;
      attribute float speed;
      attribute float phase;
      attribute float rainHint;
      attribute float lineEnd;

      uniform float time;
      uniform float baseY;
      uniform float topY;
      uniform vec2 wind;
      uniform sampler2D rainMap0;
      uniform sampler2D rainMap1;
      uniform float rainAlpha;

      varying float vAlpha;
      varying float vHeightFade;
      varying float vLine;
      varying float vIntensity;

      void main() {
        vec2 baseRainUv = vec2(basePosition.x / ${terrainWidth.toFixed(1)} + 0.5, 0.5 - basePosition.z / ${terrainDepth.toFixed(1)});
        float rain0 = texture2D(rainMap0, baseRainUv).r;
        float rain1 = texture2D(rainMap1, baseRainUv).r;
        float rain = max(mix(rain0, rain1, rainAlpha), rainHint * 0.9);
        float fall = pow(fract(phase + time * speed * (0.46 + rain * 0.5)), 0.62);
        float rainTopY = mix(10.0, topY, smoothstep(0.04, 0.72, rain));
        float streakLength = 0.08 + rain * 0.28;
        vec3 position = basePosition;
        position.y = mix(rainTopY, baseY, fall) + lineEnd * streakLength;
        position.x += wind.x * fall * 2.4 - lineEnd * wind.x * 0.04;
        position.z += wind.y * fall * 2.4 - lineEnd * wind.y * 0.04;

        if (rain < 0.012 || position.y > rainTopY + 8.0) {
          gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
          vAlpha = 0.0;
          return;
        }

        float groundEmphasis = 1.0 - smoothstep(baseY + 0.5, baseY + 6.0, position.y);
        float topFadeIn = pow(smoothstep(rainTopY, rainTopY - 16.0, position.y), 2.4);
        float verticalProfile = mix(0.22, 1.0, groundEmphasis) * topFadeIn;
        vAlpha = smoothstep(0.025, 0.28, rain) * (0.32 + rain * 1.05) * verticalProfile;
        vHeightFade = smoothstep(rainTopY, baseY, position.y);
        vLine = lineEnd;
        vIntensity = rain;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;

      uniform vec3 headColor;
      uniform vec3 tailColor;
      uniform float opacity;

      varying float vAlpha;
      varying float vHeightFade;
      varying float vLine;
      varying float vIntensity;

      void main() {
        float tailFade = pow(1.0 - vLine, 1.6);
        float alpha = opacity * vAlpha * tailFade;
        if (alpha < 0.008) discard;
        vec3 color = mix(tailColor, headColor, pow(1.0 - vLine, 0.45));
        color += vec3(0.08, 0.10, 0.12) * vIntensity * tailFade;
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });

  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 12;
  group.add(lines);
  return material;
}

function createRainParticleSeeds(count) {
  const positions = new Float32Array(count * 3);
  const speeds = new Float32Array(count);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);
  const rainHints = new Float32Array(count);
  const cells = rainParticleCells();
  const cumulative = [];
  let total = 0;

  cells.forEach((cell) => {
    total += cell.weight;
    cumulative.push(total);
  });

  for (let i = 0; i < count; i += 1) {
    const seed = i * 17.17;
    const pick = seededNoise(seed + 31.7) * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (cumulative[mid] < pick) low = mid + 1;
      else high = mid;
    }
    const cell = cells[low] ?? cells[0];
    const u = (cell.x + seededNoise(seed + 1.3)) / cell.width;
    const v = (cell.y + seededNoise(seed + 2.7)) / cell.height;
    positions[i * 3] = (u - 0.5) * terrainWidth;
    positions[i * 3 + 1] = 14 + seededNoise(seed + 4.1) * 128;
    positions[i * 3 + 2] = (0.5 - v) * terrainDepth;
    speeds[i] = 0.95 + seededNoise(seed + 8.9) * 1.4 + cell.strength * 0.9;
    phases[i] = seededNoise(seed + 13.4);
    sizes[i] = 8 + cell.strength * 34 + seededNoise(seed + 19.2) * 10;
    rainHints[i] = cell.strength;
  }

  return { positions, speeds, phases, sizes, rainHints };
}

function rainParticleCells() {
  const fallback = [{ x: 0, y: 0, width: 1, height: 1, strength: 0.25, weight: 1 }];
  const frames = rainPreview?.frames ?? [];
  if (frames.length === 0) return fallback;
  const frame0 = frames[0];
  const frame1 = frames[1] ?? frame0;
  const width = frame0.shape.x;
  const height = frame0.shape.y;
  const cells = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const strength0 = (frame0.values[index] ?? 0) / 255;
      const strength1 = (frame1.values[index] ?? 0) / 255;
      const strength = THREE.MathUtils.lerp(strength0, strength1, currentWeatherAlpha);
      if (strength <= 0.014) continue;
      const top0 = (frame0.top?.[index] ?? 0) / 255;
      const top1 = (frame1.top?.[index] ?? 0) / 255;
      cells.push({
        x,
        y,
        width,
        height,
        strength,
        topRatio: THREE.MathUtils.lerp(top0, top1, currentWeatherAlpha),
        weight: 0.05 + strength * strength * 3.8,
      });
    }
  }

  return cells.length > 0 ? cells : fallback;
}

async function loadRainPreview() {
  try {
    const response = await fetch(weatherUrl("rain-preview.json"), { cache: "no-store" });
    if (!response.ok) throw new Error(`HRRR rain preview request failed: ${response.status}`);
    const payload = await response.json();
    const [frame0, frame1 = frame0] = payload.frames ?? [];
    if (!frame0) throw new Error("HRRR rain preview has no frames");
    return {
      texture0: createRainPreviewTexture(frame0),
      texture1: createRainPreviewTexture(frame1),
      topTexture0: createRainTopTexture(frame0),
      topTexture1: createRainTopTexture(frame1),
      frames: [frame0, frame1],
    };
  } catch (error) {
    console.warn("HRRR rain preview unavailable.", error);
    return null;
  }
}

function createRainPreviewTexture(frame) {
  const width = frame.shape.x;
  const height = frame.shape.y;
  const values = new Uint8Array(frame.values);
  const texture = new THREE.DataTexture(values, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createRainTopTexture(frame) {
  const width = frame.shape.x;
  const height = frame.shape.y;
  const values = new Uint8Array(frame.top ?? new Array(width * height).fill(0));
  const texture = new THREE.DataTexture(values, width, height, THREE.RedFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function createEmptyRainTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function addScaleLabels() {
  const label = document.querySelector(".map-label") || document.createElement("div");
  label.className = "map-label";
  label.textContent = `South Alabama Mesonet coordinates | ${mesonetStations.length} stations`;
  document.body.appendChild(label);
}

function bindControls() {
  const toolPanel = document.getElementById("toolPanel");
  const toolPanelToggle = document.getElementById("toolPanelToggle");
  weatherTimeSlider = document.getElementById("weatherTimeSlider");
  weatherTimeLabel = document.getElementById("weatherTimeLabel");
  syncWeatherTimeControl();

  toolPanelToggle.addEventListener("click", () => {
    const collapsed = !toolPanel.classList.contains("is-collapsed");
    toolPanel.classList.toggle("is-collapsed", collapsed);
    toolPanelToggle.setAttribute("aria-expanded", String(!collapsed));
    toolPanelToggle.setAttribute("aria-label", collapsed ? "Expand toolbar" : "Collapse toolbar");
    const body = toolPanel.querySelector(".tool-panel-body");
    if (body) {
      body.toggleAttribute("inert", collapsed);
      body.setAttribute("aria-hidden", String(collapsed));
    }
  });

  document.getElementById("viewOverview").addEventListener("click", () => {
    setCamera([0, 150, 210], [0, 0, 0]);
  });

  document.getElementById("viewLow").addEventListener("click", () => {
    setCamera([-76, 20, 36], [-66, 2, -16], [0, 1, 0]);
    scheduleDetailPatchCheck();
  });

  document.getElementById("viewTop").addEventListener("click", () => {
    setCamera([0, 230, 6], [0, 0, 0]);
  });

  document.getElementById("toggleStations").addEventListener("change", (event) => {
    if (stationLayer) stationLayer.visible = event.target.checked;
  });

  document.getElementById("toggleCsbLayer").addEventListener("change", (event) => {
    if (csbLayer) csbLayer.visible = event.target.checked;
    updateCropLayerVisibility();
  });

  document.getElementById("toggleCloudLayer").addEventListener("change", (event) => {
    if (cloudLayer) cloudLayer.visible = event.target.checked;
  });

  document.getElementById("togglePrecipLayer").addEventListener("change", (event) => {
    if (precipitationLayer) precipitationLayer.visible = event.target.checked;
  });

  document.getElementById("toggleWindLayer").addEventListener("change", (event) => {
    windAnimationEnabled = event.target.checked;
    if (windLayer) {
      windLayer.visible = event.target.checked;
    }
    if (!event.target.checked && statusText) {
      statusText.textContent = "Overview DEM + satellite texture";
    }
  });

  document.getElementById("cloudDensity").addEventListener("input", (event) => {
    setCloudUniform("density", Number(event.target.value));
  });

  document.getElementById("cloudThreshold").addEventListener("input", (event) => {
    setCloudUniform("threshold", Number(event.target.value));
  });

  weatherTimeSlider?.addEventListener("input", (event) => {
    if (!weatherFrameTimes) return;
    const slider = event.target;
    const progress = Number(slider.value) / Math.max(1, Number(slider.max));
    selectedWeatherTimeMs = weatherFrameTimes.startMs
      + progress * (weatherFrameTimes.endMs - weatherFrameTimes.startMs);
    updateWeatherTimeLabel(selectedWeatherTimeMs);
    updateWeatherAlpha();
    if (windVolume) applyCloudWindProfile(windVolume);
    scheduleRainLayerRebuild();
  });

  ["toggleCropCorn", "toggleCropCotton", "toggleCropPeanuts", "toggleCropSoybeans", "toggleCropPasture"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      updateCropLayerVisibility();
    });
  });

  controls.addEventListener("change", scheduleDetailPatchCheck);
}

function scheduleRainLayerRebuild() {
  window.clearTimeout(rainLayerRebuildTimer);
  rainLayerRebuildTimer = window.setTimeout(rebuildRainLayer, 80);
}

function rebuildRainLayer() {
  if (!rainPreview || !precipitationLayer) return;
  const visible = document.getElementById("togglePrecipLayer")?.checked ?? precipitationLayer.visible;
  scene.remove(precipitationLayer);
  disposeObjectTree(precipitationLayer);
  precipitationSystem = null;
  rainFlowSystem = null;
  precipitationLayer = addWeatherParticleLayer();
  precipitationLayer.visible = visible;
}

function disposeObjectTree(root) {
  root.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => material.dispose?.());
    } else {
      object.material?.dispose?.();
    }
  });
}

function setCloudUniform(name, value) {
  if (!cloudVolumeMaterial?.uniforms?.[name]) return;
  cloudVolumeMaterial.uniforms[name].value = value;
}

function createEmptyCloudWindProfile() {
  return Array.from({ length: 40 }, () => new THREE.Vector2(0, 0));
}

function applyCloudWindProfile(volume) {
  if (!cloudVolumeMaterial?.uniforms?.cloudWindProfile) return;
  const profile = createLayerMeanWindProfile(volume);
  cloudVolumeMaterial.uniforms.cloudWindProfile.value = profile;
  cloudVolumeMaterial.uniforms.cloudWindLayerCount.value = profile.length;
  cloudVolumeMaterial.uniforms.cloudWindUMap0.value = volume.frame0.uTexture;
  cloudVolumeMaterial.uniforms.cloudWindVMap0.value = volume.frame0.vTexture;
  cloudVolumeMaterial.uniforms.cloudWindUMap1.value = volume.frame1.uTexture;
  cloudVolumeMaterial.uniforms.cloudWindVMap1.value = volume.frame1.vTexture;
  cloudVolumeMaterial.uniforms.hasCloudWindVolume.value = Boolean(
    volume.frame0.uTexture && volume.frame0.vTexture && volume.frame1.uTexture && volume.frame1.vTexture,
  );
}

function createLayerMeanWindProfile(volume) {
  const shape = volume.frame0.meta.shape;
  const profile = createEmptyCloudWindProfile();
  const layerCells = shape.x * shape.y;
  const layerCount = Math.min(shape.z, profile.length);
  const alpha = currentWeatherAlpha;

  for (let iz = 0; iz < layerCount; iz += 1) {
    let sumU = 0;
    let sumV = 0;
    const base = iz * layerCells;
    for (let index = 0; index < layerCells; index += 1) {
      sumU += THREE.MathUtils.lerp(volume.frame0.u[base + index], volume.frame1.u[base + index], alpha);
      sumV += THREE.MathUtils.lerp(volume.frame0.v[base + index], volume.frame1.v[base + index], alpha);
    }
    const meanU = sumU / layerCells;
    const meanV = sumV / layerCells;
    profile[iz].set(meanU, -meanV);
  }

  return profile;
}

function updateCloudAnimation() {
  if (!cloudVolumeMaterial?.uniforms?.cloudTime) return;
  const elapsed = (performance.now() - cloudAnimationStart) / 1000;
  const alpha = updateWeatherAlpha();
  cloudVolumeMaterial.uniforms.cloudTime.value = elapsed;
  cloudVolumeMaterial.uniforms.cloudAlpha.value = alpha;
  cloudVolumeMaterial.uniforms.cloudAdvectionSeconds.value = weatherFrameDurationSeconds();
}

function updateWeatherParticles() {
  if (!precipitationSystem?.material?.uniforms) return;

  const elapsed = (performance.now() - cloudAnimationStart) / 1000;
  precipitationSystem.material.uniforms.time.value = elapsed;
  precipitationSystem.material.uniforms.rainAlpha.value = currentWeatherAlpha;
  if (precipitationSystem.streakMaterial?.uniforms) {
    precipitationSystem.streakMaterial.uniforms.time.value = elapsed;
    precipitationSystem.streakMaterial.uniforms.rainAlpha.value = currentWeatherAlpha;
  }

  if (windVolume) {
    const wind = sampleWindVolume(windVolume, 0, windVolumeBaseY + windVolumeHeight * 0.38, 0);
    precipitationSystem.material.uniforms.wind.value.set(
      clamp(wind.x * 0.34, -2.4, 2.4),
      clamp(wind.z * 0.34, -2.4, 2.4),
    );
    if (precipitationSystem.streakMaterial?.uniforms?.wind) {
      precipitationSystem.streakMaterial.uniforms.wind.value.set(
        clamp(wind.x * 0.26, -1.8, 1.8),
        clamp(wind.z * 0.26, -1.8, 1.8),
      );
    }
    if (rainFlowSystem) {
      rainFlowSystem.wind.set(clamp(wind.x * 0.24, -1.6, 1.6), clamp(wind.z * 0.24, -1.6, 1.6));
    }
  }

  updateRainFieldAnimation();
}

function updateRainFieldAnimation() {
  if (!rainFlowSystem) return;

  const elapsed = (performance.now() - rainFlowSystem.startedAt) / 1000;
  const halfWidth = terrainWidth * 0.5;
  const halfDepth = terrainDepth * 0.5;
  const wind = rainFlowSystem.wind;
  const trailLength = rainFlowSystem.trailLength;
  const tailDivisor = Math.max(1, trailLength - 1);
  const samples = rainFlowSystem.samples;
  const trails = rainFlowSystem.trails;
  const baseY = 1.4;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const trail = trails[index];
    const positions = trail.positions;
    const topY = clamp(8 + sample.strength * 14, 10, 22);
    const span = topY - baseY;
    const head = topY - ((elapsed * sample.speed * 15 + sample.phase * span) % span);
    const trailRise = 0.6 + sample.strength * 1.8;
    const phaseBase = elapsed * 1.7 + sample.phase * 6.28;
    let visible = true;

    for (let step = 0; step < trailLength; step += 1) {
      const tail = step / tailDivisor;
      const y = head + tail * trailRise;
      const curve = Math.sin(phaseBase + tail * 1.4) * 0.05;
      const x = sample.x - wind.x * tail * 0.18 + sample.drift * curve;
      const z = sample.z - wind.y * tail * 0.18 + curve * 0.2;

      if (x < -halfWidth || x > halfWidth || z < -halfDepth || z > halfDepth) {
        visible = false;
      }

      if (step > 0) {
        const prevOffset = (step - 1) * 6 + 3;
        positions[prevOffset] = x;
        positions[prevOffset + 1] = y;
        positions[prevOffset + 2] = z;
      }
      if (step < trailLength - 1) {
        const offset = step * 6;
        positions[offset] = x;
        positions[offset + 1] = y;
        positions[offset + 2] = z;
      }
    }

    trail.line.geometry.attributes.position.needsUpdate = true;
    trail.line.visible = visible;
  }
}

function updateWeatherAlpha() {
  const frameDurationMs = weatherFrameTimes
    ? Math.max(1, weatherFrameTimes.endMs - weatherFrameTimes.startMs)
    : 3600000;
  const nowMs = selectedWeatherTimeMs ?? Date.now();
  const rawAlpha = weatherFrameTimes
    ? (nowMs - weatherFrameTimes.startMs) / frameDurationMs
    : 0;
  currentWeatherAlpha = clamp(rawAlpha, 0, 1);
  if (weatherFrameTimes && weatherTimeLabel) {
    updateWeatherTimeLabel(clamp(nowMs, weatherFrameTimes.startMs, weatherFrameTimes.endMs));
  }
  return currentWeatherAlpha;
}

function weatherFrameDurationSeconds() {
  if (!weatherFrameTimes) return 3600;
  return Math.max(1, weatherFrameTimes.endMs - weatherFrameTimes.startMs) / 1000;
}

function updateCropLayerVisibility() {
  if (!csbLayer) return;
  const enabled = new Set(
    [
      ["corn", "toggleCropCorn"],
      ["cotton", "toggleCropCotton"],
      ["peanuts", "toggleCropPeanuts"],
      ["soybeans", "toggleCropSoybeans"],
      ["pasture", "toggleCropPasture"],
    ]
      .filter(([, id]) => document.getElementById(id)?.checked)
      .map(([category]) => category),
  );

  csbLayer.children.forEach((child) => {
    const category = child.userData.cropCategory ?? "other";
    child.visible = enabled.has(category);
  });
}

function scheduleDetailPatchCheck() {
  window.clearTimeout(detailCheckTimer);
  detailCheckTimer = window.setTimeout(checkDetailPatch, 450);
}

async function checkDetailPatch() {
  if (detailPatchLoading || !terrainSampler) return;

  const distance = camera.position.distanceTo(controls.target);
  if (distance > 90) {
    if (statusText.textContent.startsWith("Detail satellite")) {
      statusText.textContent = "Overview DEM + satellite texture";
    }
    return;
  }

  const center = mapProjection.toGeo(controls.target.x, controls.target.z);
  const quantizedLon = Math.round(center.lon / 0.04) * 0.04;
  const quantizedLat = Math.round(center.lat / 0.03) * 0.03;
  const bounds = clampDetailBounds(quantizedLon, quantizedLat);
  const key = `${bounds.west.toFixed(3)},${bounds.south.toFixed(3)},${bounds.east.toFixed(3)},${bounds.north.toFixed(3)}`;
  if (key === detailPatchKey) return;

  detailPatchLoading = true;
  detailPatchKey = key;

  try {
    const texture = useNaipImagery
      ? await loadNaipTexture(bounds, {
          width: 2048,
          height: 1460,
          statusPrefix: "Loading detail NAIP",
        })
      : await loadSatelliteTexture(bounds, detailSatelliteZoom, {
          width: 2048,
          height: 1365,
          statusPrefix: "Loading detail satellite",
        });
    if (detailPatch) {
      scene.remove(detailPatch);
      detailPatch.geometry.dispose();
      detailPatch.material.map?.dispose();
      detailPatch.userData.cropMasks?.forEach((tex) => tex.dispose?.());
      detailPatch.material.dispose();
    }
    detailPatch = buildDetailPatch(bounds, texture);
    scene.add(detailPatch);
    statusText.textContent = useNaipImagery
      ? "Detail NAIP imagery"
      : `Detail satellite zoom ${detailSatelliteZoom}`;
  } catch (error) {
    console.warn("Detail satellite patch failed.", error);
    statusText.textContent = "Overview DEM + satellite texture";
    detailPatchKey = "";
  } finally {
    detailPatchLoading = false;
  }
}

function clampDetailBounds(centerLon, centerLat) {
  const halfLon = detailLonSpan / 2;
  const halfLat = detailLatSpan / 2;
  let west = centerLon - halfLon;
  let east = centerLon + halfLon;
  let south = centerLat - halfLat;
  let north = centerLat + halfLat;

  if (west < region.west) {
    east += region.west - west;
    west = region.west;
  }
  if (east > region.east) {
    west -= east - region.east;
    east = region.east;
  }
  if (south < region.south) {
    north += region.south - south;
    south = region.south;
  }
  if (north > region.north) {
    south -= north - region.north;
    north = region.north;
  }

  return {
    west: clamp(west, region.west, region.east),
    east: clamp(east, region.west, region.east),
    south: clamp(south, region.south, region.north),
    north: clamp(north, region.south, region.north),
  };
}

function buildDetailPatch(bounds, texture) {
  const southwest = mapProjection.toWorld(bounds.west, bounds.south);
  const northeast = mapProjection.toWorld(bounds.east, bounds.north);
  const width = Math.abs(northeast.x - southwest.x);
  const depth = Math.abs(northeast.z - southwest.z);
  const geometry = new THREE.PlaneGeometry(width, depth, 80, 54);
  geometry.rotateX(-Math.PI / 2);

  const positions = geometry.attributes.position;
  const uvs = geometry.attributes.uv;
  const centerX = (southwest.x + northeast.x) / 2;
  const centerZ = (southwest.z + northeast.z) / 2;
  const heightValues = new Array(positions.count);
  const columns = 81;
  const rows = 55;

  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i) + centerX;
    const z = positions.getZ(i) + centerZ;
    const { lon, lat } = mapProjection.toGeo(x, z);
    const { u, v } = mapProjection.toUv(lon, lat, bounds);
    heightValues[i] = mapProjection.heightAt(lon, lat) + 0.09;
    uvs.setXY(i, u, v);
  }

  smoothHeights(heightValues, columns, rows, 3);

  for (let i = 0; i < positions.count; i += 1) {
    positions.setY(i, heightValues[i]);
  }

  geometry.computeVertexNormals();
  uvs.needsUpdate = true;

  const lonRange = region.east - region.west;
  const latRange = region.north - region.south;
  const offsetX = (bounds.west - region.west) / lonRange;
  const offsetY = (bounds.south - region.south) / latRange;
  const repeatX = (bounds.east - bounds.west) / lonRange;
  const repeatY = (bounds.north - bounds.south) / latRange;

  const cropMask = (sourceTexture) => {
    if (!sourceTexture) return null;
    const clone = sourceTexture.clone();
    clone.needsUpdate = true;
    clone.offset.set(offsetX, offsetY);
    clone.repeat.set(repeatX, repeatY);
    return clone;
  };

  if (!waterNormalTexture) waterNormalTexture = buildWaterNormalTexture();
  const clearcoatMap = cropMask(vectorWaterMaskTexture);
  const clearcoatRoughnessMap = cropMask(vectorWaterRoughnessTexture);
  const specularIntensityMap = cropMask(vectorWaterMaskTexture);
  const roughnessMap = cropMask(vectorWaterRoughnessTexture);

  const material = new THREE.MeshPhysicalMaterial({
    map: texture,
    roughnessMap,
    roughness: 0.92,
    metalness: 0,
    envMapIntensity: 0.42,
    clearcoatMap,
    clearcoat: clearcoatMap ? 0.72 : 0.08,
    clearcoatRoughnessMap,
    clearcoatRoughness: 0.34,
    clearcoatNormalMap: waterNormalTexture,
    clearcoatNormalScale: new THREE.Vector2(0.28, 0.28),
    specularIntensityMap,
    specularIntensity: specularIntensityMap ? 0.55 : 1.0,
    specularColor: 0xc8d8e6,
    color: 0xffffff,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const patch = new THREE.Mesh(geometry, material);
  patch.position.set(centerX, 0, centerZ);
  patch.receiveShadow = true;
  patch.userData.cropMasks = [clearcoatMap, clearcoatRoughnessMap, specularIntensityMap, roughnessMap].filter(Boolean);
  return patch;
}

function setCamera(position, target, up = [0, 1, 0]) {
  camera.up.set(...up);
  camera.position.set(...position);
  controls.target.set(...target);
  camera.lookAt(controls.target);
  controls.update();
}

function resize() {
  if (!renderer || !camera) return;
  const { clientWidth, clientHeight } = container;
  camera.aspect = clientWidth / clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(clientWidth, clientHeight, false);
  if (composer) {
    composer.setSize(clientWidth, clientHeight);
  }
  updateDirectionLabels();
}

function animate() {
  const now = performance.now();
  const delta = (now - lastFrameTime) / 1000;
  lastFrameTime = now;
  updateAtmosphere((now - cloudAnimationStart) / 1000);

  envBakeTimer += delta;
  if (envBakeTimer > 2.5) {
    envBakeTimer = 0;
    refreshEnvironment(false);
  }

  controls.update();
  updateDirectionLabels();
  updateCloudAnimation();
  updateWeatherParticles();
  updateWindAnimation();
  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}

function updateDirectionLabels() {
  if (!directionLabels || !camera || !container) return;
  const { clientWidth: width, clientHeight: height } = container;
  if (!width || !height) return;

  const center = worldToScreen(0, 0, 0, width, height);
  const directions = {
    north: worldToScreen(0, 0, -terrainDepth * 0.48, width, height),
    south: worldToScreen(0, 0, terrainDepth * 0.48, width, height),
    east: worldToScreen(terrainWidth * 0.48, 0, 0, width, height),
    west: worldToScreen(-terrainWidth * 0.48, 0, 0, width, height),
  };
  const radius = Math.min(width, height) * 0.46;
  const margin = 28;

  Object.entries(directions).forEach(([key, point]) => {
    const label = directionLabels[key];
    if (!label) return;
    let dx = point.x - center.x;
    let dy = point.y - center.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    dx /= length;
    dy /= length;
    const left = clamp(width * 0.5 + dx * radius, margin, width - margin);
    const top = clamp(height * 0.5 + dy * radius, margin, height - margin);
    label.style.left = `${left}px`;
    label.style.top = `${top}px`;
  });
}

const worldToScreenScratch = new THREE.Vector3();
function worldToScreen(x, y, z, width, height) {
  const projected = worldToScreenScratch.set(x, y, z).project(camera);
  return {
    x: (projected.x * 0.5 + 0.5) * width,
    y: (-projected.y * 0.5 + 0.5) * height,
  };
}

