# WeatherTwin Unreal Port

This Unreal Engine project ports the current Three.js weather twin prototype into UE5 C++ actors.

## What Is Implemented

- Same South Alabama lon/lat extent used by the web prototype.
- Procedural terrain mesh matching the prototype's local coordinate frame.
- Mesonet station markers and labels.
- HRRR cloud volume ingestion from the existing `data/weather/hrrr/volume/cloud-water-f01.json` and `.u8` file.
- HRRR wind volume ingestion from the existing `data/weather/hrrr/wind-volume/wind-f01.json` and `.f32` component files.
- A `WeatherTwinRootActor` that spawns terrain, stations, clouds, and wind layers at runtime.

## Open In Unreal

1. Open `UnrealWeather3D/WeatherTwin.uproject` in Unreal Engine 5.4 or newer.
2. Let Unreal generate project files and compile the `WeatherTwin` module.
3. Create an empty level.
4. Drag `WeatherTwinRootActor` into the level.
5. Press Play.

The actor defaults read the existing repository data with paths relative to the Unreal project:

```text
../data/weather/hrrr/volume/cloud-water-f01.json
../data/weather/hrrr/wind-volume/wind-f01.json
```

If you move the Unreal project elsewhere, update `CloudMetaPath` and `WindMetaPath` on the actors.

## Current Rendering Approach

The first port uses practical UE primitives:

- clouds are instanced sphere voxels sampled from the HRRR `uint8` cloud density volume
- wind is drawn as persistent debug line trails sampled from the HRRR `float32` wind volume
- terrain is procedural until the DEM/satellite tile pipeline is moved from browser fetches into an offline UE import step

The next upgrade should replace the cloud instances with UE5 Sparse Volume Texture or a custom raymarch material. The data loader is already separated so that renderer swap is straightforward.

## Suggested Next Steps

- Convert the existing Terrarium/Esri tile build into an offline heightmap and satellite texture import for `Landscape`.
- Add a material instance for cloud voxels with translucent, soft additive shading.
- Replace debug wind trails with Niagara ribbons.
- Add CSB crop boundary import from `data/csb-mesonet-crops.geojson` using spline meshes or Runtime Mesh.
- Add F01/F02 time interpolation and Semi-Lagrangian advection as a compute shader.
