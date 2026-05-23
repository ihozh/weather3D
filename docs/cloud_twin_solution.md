# Real-Time 3D Cloud Twin Architecture

> Small-region, browser/tablet-deployable cloud rendering based on HRRR data with Semi-Lagrangian advection for sub-hourly time interpolation.

---

## 1. Goal

Build a digital twin that renders physically consistent 3D cloud fields over a small region (single state, e.g. Louisiana / Mississippi / Alabama) with sub-second visual updates.

- **Region**: ~500×400 km (one US state)
- **Time**: rolling real time, advances with the actual atmosphere
- **Target platforms**: Web / tablet / desktop
- **Visual goal**: cloud position, shape, and motion match real weather

---

## 2. Data Source: HRRR

### 2.1 Basics

- **Name**: HRRR (High-Resolution Rapid Refresh)
- **Operator**: NOAA
- **Model core**: operational WRF-ARW
- **Resolution**:
  - Horizontal: 3 km
  - Vertical: 50 levels
  - Temporal: hourly cycles
- **Coverage**: CONUS (continental US)
- **Access**: free, AWS Open Data, `s3://noaa-hrrr-bdp-pds/`
- **Recommended client**: [Herbie](https://herbie.readthedocs.io) (Python, supports partial download)

### 2.2 Key Variables

| Variable | Meaning | Use |
|---|---|---|
| `CLMR` / `QCLOUD` | Cloud-liquid mixing ratio | Primary render field |
| `CICE` / `QICE` | Cloud-ice mixing ratio | Primary render field |
| `RWMR` / `QRAIN` | Rain water mixing ratio | Precipitation visualization |
| `UGRD` / `U` | East-west wind | Advection |
| `VGRD` / `V` | North-south wind | Advection |
| `DZDT` / `W` | Vertical wind | Advection (convection) |
| `TMP` / `T2` | Temperature | LCL estimation |
| `DPT` / `D2` | Dew point | LCL (cloud base) |

### 2.3 F00 vs F01

- **F00**: analysis field (best estimate after data assimilation); most current but with spin-up imbalances
- **F01**: 1-hour forecast; cloud field is more self-consistent, looks better
- **Recommendation**: use **F01 + F02 paired**, balancing currency and visual quality

### 2.4 Data Volume Estimate (single state)

- Grid cells: ~22,000 (500×400 km ÷ 3 km)
- Vertical levels: 50
- Raw frame: ~30 MB (cloud water/ice/rain + wind)
- VDB-sparsified: **3-8 MB / frame**
- Hourly bandwidth: **10-20 MB** (Herbie partial download)
- Sustained bandwidth: **< 5 KB/s**, fits any network

---

## 3. Time Interpolation: Semi-Lagrangian Advection

### 3.1 Core Idea

HRRR ships one frame per hour; the twin needs second-level continuity. **Backward-trace advection** interpolates between frames:

```
ρ(x, t) = trilinear_sample(ρ_source, x − v·Δt)
```

**Why backward tracing**:
1. Destination grid is aligned, GPU trilinear is hardware-accelerated
2. No write conflicts, perfectly parallelizable
3. Unconditionally stable (CFL doesn't bound dt)
4. Mathematically continuous in t — no jumps

### 3.2 Bidirectional Blend

```
α = (t − h0_time) / 3600

ρ(t) = (1−α) · advect(F01, +α·3600, wind)
     + α · advect(F02, −(1−α)·3600, wind)
```

Two anchor points minimize error and naturally absorb phase changes.

### 3.3 Per-Layer Advection (Critical)

**Each vertical level must use its own wind field** — vertical shear is real (5 m/s near surface, 50 m/s aloft is common).

For each voxel (x, y, z):
```
v = (U[z,y,x], V[z,y,x], W[z,y,x])
origin = (x, y, z) − v · Δt
ρ_new[x,y,z] = trilinear_sample(ρ_old, origin)
```

The cloud naturally shears, tilts, and forms anvils — not a rigid translate.

### 3.4 Wind Field + Hydrometeors

- `U, V, W` in WRF are on a staggered grid — must destagger first (`wrf-python.destagger`)
- Advect `QCLOUD`, `QICE`, `QRAIN` together to keep phases consistent
- `QRAIN` adds gravitational fall velocity (~5-10 m/s downward)

---

## 4. Performance Budget

### 4.1 Decouple Compute From Render

| Task | Frequency | GPU load (128³) |
|---|---|---|
| Data download | 1× / hour | network, seconds |
| Advection step | 1× / 20 s (0.05 Hz) | < 0.5% |
| Render | 30-60 fps | 30-50% (dominant cost) |

### 4.2 Compute Cadence (20 s is the sweet spot)

| Cadence | GPU load | Visual | Suited for |
|---|---|---|---|
| 10 s | 0.03% | Perfect | High-end devices |
| **20 s** | **0.015%** | **Indistinguishable** | **Sweet spot** |
| 30 s | 0.01% | Still smooth | Low-end / battery |
| 60 s | < 0.01% | Slight lag noticeable | Extreme |

At 20 s, an hour gets 180 intermediate slices — far beyond what HRRR grid resolution can express.

### 4.3 Rendering Requirements

- **Render must hit ≥ 30 fps** — anything less feels choppy when rotating the camera
- The render samples between the two nearest computed slices via GPU trilinear (1 instruction)
- Compute can be slow; render cannot

### 4.4 Tablet GPU Tiers

| Device | Configuration |
|---|---|
| iPad Pro M4 / Tab S10 Ultra | 256³ voxels + 60 fps + multi-scatter |
| iPad Air M2 / Tab S9 | 128³ + 30-60 fps + single-scatter |
| Entry-level tablets | 64-96³ + 30 fps + Beer-Lambert only |

Tablet-specific constraints:
- Thermal throttling (sustained load → 30-50% perf drop after 5-10 min)
- Shared memory (256³ float32 3D texture = 64 MB, 512³ = 512 MB blows up)
- High-DPI screens — render at lower resolution and upscale

---

## 5. Render Pipeline

### 5.1 Data Flow

```
[NOAA AWS] ──1×/hour──▶ [Server relay]
                              │
                              ├─ GRIB2 decode
                              ├─ Crop small region
                              ├─ Convert to VDB / binary
                              └─ Push to CDN

[CDN] ──1×/hour──▶ [Client]
                       │
                       ├─ Cache F01, F02 frames
                       ├─ Upload to GPU 3D textures
                       │
                       ├─ [Compute thread, every 20 s]
                       │     └─ Semi-Lagrangian advection
                       │
                       └─ [Render thread, every 16.7 ms]
                             └─ Volumetric raymarch
                                   ↓
                                screen
```

### 5.2 Server Relay (strongly recommended)

Do NOT have clients hit NOAA AWS directly:
- ❌ GRIB2 decoding in browser is painful
- ❌ Full CONUS file is 150 MB
- ❌ Every user re-downloads the same data

Recommended:
- Server fetches HRRR hourly, crops, converts to VDB / float16 binary
- Pushes to a CDN (CloudFront / Cloudflare)
- Clients fetch 3-8 MB cropped slices

### 5.3 Render Stack Options

| Platform | Recommended |
|---|---|
| Web (primary) | **WebGPU** (2024+), fallback WebGL2 |
| Desktop app | Unreal Engine 5 Sparse Volume Texture / Unity HDRP Volumetric Clouds |
| Native mobile | iOS Metal / Android Vulkan |
| Industrial twin | NVIDIA Omniverse + USD Volumes |

### 5.4 Render Details That Matter

1. **Scattering model**: Henyey-Greenstein phase function + at least 2-3 scattering bounces, otherwise clouds look like cotton candy
2. **Sun position**: use NOAA SPA / SunCalc, aligned with HRRR timestamp
3. **Cloud base**: estimate via `LCL ≈ 125 × (T2 − D2)`, or just use the lowest level where `QCLOUD > threshold`
4. **Sub-3km detail**: HRRR can't resolve individual cumuli — overlay 3D Perlin/Worley noise for turbulent micro-structure

---

## 6. Cold Start

### 6.1 First-time Web Load

```javascript
async function init() {
    showLoading();

    const now = new Date();
    const hourFloor = floorToHour(now);  // UTC

    // Parallel-fetch the latest F01 and F02
    const [f01, f02] = await Promise.all([
        fetchHRRR(latestRun, hourFloor),
        fetchHRRR(latestRun, hourFloor + 3600000)
    ]);

    // Upload to GPU
    const tex_h0 = createTexture3D(f01);
    const tex_h1 = createTexture3D(f02);

    // Jump straight to the current moment (semi-Lagrangian is stateless)
    const alpha = (now - hourFloor) / 3600000;
    runAdvection(tex_h0, tex_h1, alpha);

    hideLoading();
    startRenderLoop();    // 30-60 fps
    startComputeLoop();   // every 20 s
    startUpdateLoop();    // every hour
}
```

### 6.2 Cold-Start Time Budget

- Data download: 1-3 s (from CDN)
- First advection + GPU upload: < 1 s
- Total: **2-5 s**

### 6.3 Time Zones

HRRR timestamps are **UTC**. Convert to local time for display only; keep math in UTC.

---

## 7. Refresh and Continuity

### 7.1 Hourly Refresh

```
12:59:59 → advect with F01(12z) + F02(13z)
13:00:00 → advect with F02(13z) + F03(14z)
```

At the swap moment, F02 is shared between both pairs → naturally smooth. A 1-2 second crossfade is optional.

### 7.2 Boundary Handling

When a traced origin falls outside the region:
- Recommended: **Extrapolate** with boundary values — smoothest
- In practice: make the twin region 10-20% larger than the visible region (buffer zone)

### 7.3 Continuity Guarantee

Mathematically, `ρ(x, t) = trilinear_sample(ρ_source, x − v·Δt)` is continuous in t. Just ensure:
1. Render interpolates between compute slices (mandatory)
2. Data refresh is seamless
3. Boundary uses extrapolate, not zero
4. CFL satisfied: `|v·Δt| < 2·dx` (20 s × 50 m/s = 1 km < 6 km — comfortable)

Result: visually smooth, no jumps.

---

## 8. Physics Reference Formulas

### 8.1 LCL (Cloud Base Height)

```
LCL ≈ 125 × (T − Td)  meters
```

- `T`: surface air temperature (°C)
- `Td`: surface dew point (°C)
- Valid for cumulus families (Cu / TCu / Cb)
- NOT valid for stratus, cirrus, etc.

### 8.2 Mixing Ratio → Density

```python
Rd = 287.05
T_actual = (T_pert + 300) * ((P_pert + PB) / 1e5) ** (Rd/1004)
rho_air = (P_pert + PB) / (Rd * T_actual)

LWC = QCLOUD * rho_air   # kg/m³
IWC = QICE   * rho_air
```

### 8.3 Extinction Coefficient

```python
r_eff_liq = 10e-6   # liquid effective particle radius, m
r_eff_ice = 30e-6   # ice  effective particle radius, m
rho_water = 1000

beta_liq = 1.5 * LWC / (rho_water * r_eff_liq)
beta_ice = 1.5 * IWC / (rho_water * r_eff_ice)
beta_total = beta_liq + beta_ice   # 1/meter
```

### 8.4 Dew Point From RH

```python
import math
a, b = 17.625, 243.04
gamma = math.log(RH/100) + a*T/(b+T)
Td = b * gamma / (a - gamma)
```

---

## 9. Limits and Upgrade Paths

### 9.1 HRRR 3 km Limitations

| Phenomenon | Resolved by HRRR? |
|---|---|
| Fronts, MCS, squall lines | ✅ |
| Cb overall shape | ✅ |
| Stratus / cirrus large-scale | ✅ |
| Individual cumulus (< 3 km) | ❌ |
| Cirrus filaments | ❌ |
| Fog, thin marine stratus | ⚠️ |

### 9.2 Visual Patch: Procedural Detail

Overlay 3D Perlin / Worley noise on the HRRR cloud field:
- Keeps large-scale physics intact
- Adds turbulent detail locally
- Approximates ~500 m visual resolution

### 9.3 Upgrade to Self-Run WRF

If you need single-cloud detail:
- `dx = 500m`, nested horizontal domain
- `e_vertical = 60-80` levels
- `mp_physics = 8` (Thompson) or `10` (Morrison 2-moment)
- `bl_pbl_physics = 5` (MYNN2.5, best for marine stratus)
- Compute: 16-32 CPU cores, ~2-6 hours of compute per simulated day

### 9.4 Latency Upgrade

HRRR itself lags 1-1.5 hours (model run + upload). For "now":
- Overlay **GOES-16 ABI** (5-10 min cadence, cloud-top height) for horizontal nudging
- Drive **ML nowcasting** (DGMR / MetNet-3) for 0-60 min extrapolation
- Migrate to **RRFS** (HRRR successor, 15-min cadence)

---

## 10. Implementation Priority

### Phase 1: Minimum Viable (1-2 weeks)

1. ✅ Herbie pulls HRRR partial, crop to LA/MS/AL
2. ✅ Convert to VDB, render one frame in Blender to validate
3. ✅ End-to-end "data → render" smoke test

### Phase 2: Real-Time Twin Core (2-4 weeks)

1. ✅ Server downloads + converts + pushes to CDN on schedule
2. ✅ Web client fetches + uploads to GPU
3. ✅ Semi-Lagrangian advection compute shader
4. ✅ Raymarching volume render shader
5. ✅ Render-side slice interpolation
6. ✅ Cold-start logic

### Phase 3: Polish (2-4 weeks)

1. ✅ Multi-scattering
2. ✅ Sun position sync
3. ✅ Procedural noise detail
4. ✅ Tablet adaptation, dynamic quality
5. ✅ Loading UX

### Phase 4: Upgrades (when needed)

- GOES correction
- ML nowcasting
- Self-run high-res WRF

---

## 11. Cheat Sheet

| Parameter | Recommended | Notes |
|---|---|---|
| Data source | HRRR F01 + F02 | NOAA AWS |
| Update cadence | 1 hour | HRRR-native |
| Region | one state (~500×400 km) | sweet spot |
| Horizontal res | 3 km | HRRR-native |
| Vertical levels | 50 | HRRR-native |
| Advection cadence | **20 s** | Visually free, GPU near-zero |
| Render frame rate | 30-60 fps | Must stay smooth |
| Voxel res | 128³ (mid) / 256³ (high) | tablets stay at 128³ |
| Raw frame | ~30 MB | all variables |
| VDB frame | 3-8 MB | sparsified |
| Client bandwidth | < 5 KB/s sustained | hourly small fetch |
| Cold start | 2-5 s | CDN-accelerated |
| CFL constraint | `\|v·Δt\| < 2·dx` | 20 s × 50 m/s = 1 km < 6 km ✅ |

---

## 12. Key Libraries and Tools

| Use | Tool |
|---|---|
| HRRR fetch | [Herbie](https://herbie.readthedocs.io) (Python) |
| GRIB2 decode | cfgrib, xarray, wgrib2 |
| WRF data processing | wrf-python (NCAR official) |
| Meteorological math | MetPy |
| Volume format | OpenVDB / NanoVDB |
| Scientific viz | VAPOR (NCAR, reads wrfout directly) |
| Web render | WebGPU + Three.js |
| Desktop render | Unreal Engine 5 / Unity HDRP / NVIDIA Omniverse |
| Offline high-quality | Houdini / Blender Cycles |

---

## 13. One-Sentence Summary

**Pull HRRR cloud water and wind fields hourly as the skeleton, do Semi-Lagrangian backward-trace advection on the local GPU for second-level interpolation, render with raymarching — a single state runs at 30-60 fps on a tablet.**

Network cost is tiny, compute can run every 20 s, time is visually continuous and physically consistent.
