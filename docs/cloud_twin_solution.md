# 实时 3D 云孪生方案

> 基于 HRRR 数据 + Semi-Lagrangian 平流的小区域实时云渲染方案,适用于 Web 和平板部署。

---

## 1. 项目目标

构建一个数字孪生系统,在小区域(单个州尺度,如 Louisiana / Mississippi / Alabama)上实时渲染真实物理一致的 3D 云场。

- **区域范围**:约 500×400 km(一个州大小)
- **时间精度**:实时滚动,跟随真实天气演化
- **目标平台**:Web / 平板 / 桌面
- **视觉目标**:云的位置、形态、运动与真实大气一致

---

## 2. 数据源:HRRR

### 2.1 基本信息

- **名称**:HRRR (High-Resolution Rapid Refresh)
- **运营方**:NOAA
- **本质**:业务化运行的 WRF-ARW 模式输出
- **分辨率**:
  - 水平 3 km
  - 垂直 50 层
  - 时间 1 小时更新
- **覆盖**:CONUS(美国本土)
- **获取**:免费,AWS Open Data,`s3://noaa-hrrr-bdp-pds/`
- **推荐库**:[Herbie](https://herbie.readthedocs.io)(Python,支持 partial download)

### 2.2 关键变量

| 变量 | 含义 | 用途 |
|---|---|---|
| `CLMR` / `QCLOUD` | 云液态水混合比 | 主渲染变量 |
| `CICE` / `QICE` | 云冰混合比 | 主渲染变量 |
| `RWMR` / `QRAIN` | 雨水混合比 | 降水可视化 |
| `UGRD` / `U` | 东西风 | 平流 |
| `VGRD` / `V` | 南北风 | 平流 |
| `DZDT` / `W` | 垂直风 | 平流(对流) |
| `TMP` / `T2` | 温度 | LCL 计算 |
| `DPT` / `D2` | 露点 | LCL 计算(云底) |

### 2.3 F00 vs F01 选择

- **F00**:分析场(数据同化后的最优估计),最实时但有 spin-up 不平衡
- **F01**:1 小时预报,云场更自洽,视觉更好
- **推荐**:使用 **F01 + F02** 组合,平衡实时性和视觉质量

### 2.4 数据量估算(一个州)

- 网格数:~22,000(500×400 km / 3 km)
- 垂直层:50
- 单帧裸数据:~30 MB(含云水/冰/雨 + 风场)
- VDB 稀疏化后:**3-8 MB / 帧**
- 每小时下载:**10-20 MB**(用 Herbie partial)
- 带宽需求:**< 5 KB/s 持续**,任何网络都够

---

## 3. 时间插值:Semi-Lagrangian Advection

### 3.1 核心原理

HRRR 是 1 小时一帧,孪生需要秒级连续。通过**反向追踪平流**在两帧之间插值:

```
ρ(x, t) = trilinear_sample(ρ_source, x - v·Δt)
```

**为什么用反向追踪**:
1. 目标格点天然对齐网格,GPU trilinear 采样硬件加速
2. 无空洞、无写冲突,完美并行
3. 无条件稳定(CFL 不限制 dt)
4. 数学上对 t 连续,不会跳变

### 3.2 双向混合

```
α = (t - h0_time) / 3600

ρ(t) = (1-α) · advect(F01, +α·3600, wind) 
     + α · advect(F02, -(1-α)·3600, wind)
```

两端都有锚点,误差最小,自然吸收相变。

### 3.3 分层平流(关键)

**必须每层用自己的风场**,因为大气垂直风切变大(地面 5 m/s,高空 50 m/s 是常见的)。

每个体素 (x, y, z):
```
v = (U[z,y,x], V[z,y,x], W[z,y,x])
origin = (x, y, z) - v · Δt
ρ_new[x,y,z] = trilinear_sample(ρ_old, origin)
```

这样云会自然剪切、倾斜、形成砧状,而不是像刚体一样整体平移。

### 3.4 风场和水汽

- `U, V, W` 在 WRF 中是 staggered grid,采样前需 destagger(`wrf-python.destagger`)
- `QCLOUD`、`QICE`、`QRAIN` 都要同时平流,保持相态一致
- `QRAIN` 额外加重力下落速度(~5-10 m/s 向下)

---

## 4. 性能配置

### 4.1 解耦计算与渲染

| 任务 | 频率 | GPU 占用(128³) |
|---|---|---|
| 数据下载 | 每小时 1 次 | 网络,几秒 |
| 平流计算 | 每 20 秒 1 次(0.05 Hz) | < 0.5% |
| 渲染 | 30-60 fps | 30-50%(主要开销) |

### 4.2 计算频率选择(20 秒推荐)

| 频率 | GPU 占用 | 视觉效果 | 推荐场景 |
|---|---|---|---|
| 10 秒 | 0.03% | 完美 | 高端设备 |
| **20 秒** | **0.015%** | **几乎无差别** | **甜点配置** |
| 30 秒 | 0.01% | 仍流畅 | 低端/省电 |
| 60 秒 | < 0.01% | 略可察觉滞后 | 极限 |

20 秒间隔下,一小时算 180 个中间切片,远超 HRRR 网格分辨率所能体现的细节。

### 4.3 渲染要求

- **渲染帧率必须 ≥ 30 fps**,否则用户交互(镜头转动)有卡顿感
- 渲染端每帧在两个最近切片之间做 trilinear 插值(GPU 一条指令)
- 计算可以慢,渲染不能慢

### 4.4 平板 GPU 配置

| 设备 | 推荐配置 |
|---|---|
| iPad Pro M4 / Tab S10 Ultra | 256³ 体素 + 60fps + 多重散射 |
| iPad Air M2 / Tab S9 | 128³ + 30-60fps + 单次散射 |
| 入门平板 | 64-96³ + 30fps + Beer-Lambert |

平板特殊约束:
- 发热限频(满载 5-10 分钟后降频 30-50%)
- 共享内存(3D texture 256³ float32 = 64MB,512³ = 512MB 会爆)
- 高分屏建议降低渲染分辨率后上采样

---

## 5. 渲染管线

### 5.1 数据流

```
[NOAA AWS] ─每小时1次─> [服务器中转]
                              │
                              ├─ GRIB2 解码
                              ├─ 裁切小区域
                              ├─ 转 VDB / 二进制
                              └─ 推 CDN
                              
[CDN] ─每小时1次─> [客户端]
                       │
                       ├─ 缓存 F01, F02 两帧
                       ├─ 上传 GPU 3D texture
                       │
                       ├─ [计算线程,每 20 秒]
                       │     └─ Semi-Lagrangian 平流
                       │
                       └─ [渲染线程,每 16.7 ms]
                             └─ Raymarching 体渲染
                                   ↓
                                 屏幕
```

### 5.2 服务器中转(强烈建议)

不要让客户端直接连 NOAA AWS:
- ❌ 客户端解 GRIB2 复杂
- ❌ 整个全美文件 150 MB
- ❌ 每用户重复下载

推荐:
- 服务器每小时拉 HRRR、裁切、转 VDB / float16 二进制
- 推 CDN(CloudFront / Cloudflare)
- 客户端拉 3-8 MB 小文件

### 5.3 渲染技术栈选择

| 平台 | 推荐 |
|---|---|
| Web(主要) | **WebGPU**(2024+),fallback WebGL2 |
| 桌面应用 | Unreal Engine 5 Sparse Volume Texture / Unity HDRP Volumetric Clouds |
| 移动原生 | iOS Metal / Android Vulkan |
| 工业孪生 | NVIDIA Omniverse + USD Volumes |

### 5.4 关键渲染细节

1. **散射模型**:Henyey-Greenstein 相函数 + 至少 2-3 次散射,否则云像棉花糖
2. **太阳位置**:用 NOAA SPA / SunCalc 算,和 HRRR 时间戳对齐
3. **云底**:用 `LCL ≈ 125 × (T2 - D2)` 公式估算,或直接用 QCLOUD > 阈值的最低层
4. **细节补全**:HRRR 3km 看不到单云,叠加 3D Perlin/Worley noise 加湍流细节

---

## 6. 冷启动流程

### 6.1 用户首次打开 Web

```javascript
async function init() {
    showLoading();
    
    const now = new Date();
    const hourFloor = floorToHour(now);  // UTC
    
    // 并行下载最新 F01, F02
    const [f01, f02] = await Promise.all([
        fetchHRRR(latestRun, hourFloor),
        fetchHRRR(latestRun, hourFloor + 3600000)
    ]);
    
    // 上传 GPU
    const tex_h0 = createTexture3D(f01);
    const tex_h1 = createTexture3D(f02);
    
    // 直接跳到当前时刻(semi-Lagrangian stateless)
    const alpha = (now - hourFloor) / 3600000;
    runAdvection(tex_h0, tex_h1, alpha);
    
    hideLoading();
    startRenderLoop();    // 30-60 fps
    startComputeLoop();   // 每 20 秒
    startUpdateLoop();    // 每小时刷新
}
```

### 6.2 冷启动时间

- 数据下载:1-3 秒(从 CDN)
- 首次平流 + 上传 GPU:< 1 秒
- 总冷启动:**2-5 秒**

### 6.3 数据时区

HRRR 时间戳是 **UTC**,展示时转本地时间,内部计算用 UTC。

---

## 7. 数据刷新与连续性

### 7.1 每小时刷新

```
12:59:59 → 用 F01(12z)+ F02(13z)平流
13:00:00 → 用 F02(13z)+ F03(14z)平流
```

切换瞬间:
- F02 在两边是同一数据,自然平滑
- 加 1-2 秒淡入淡出(可选)

### 7.2 边界处理

反推位置超出区域时:
- 推荐:**Extrapolate**(用边界值外推),最平滑
- 实际:孪生区域比可视区域大 10-20%,留 buffer

### 7.3 连续性保证

数学上 `ρ(x, t) = trilinear_sample(ρ_source, x - v·Δt)` 对 t 是连续函数,只要做好:
1. 渲染端在切片间插值(必须)
2. 数据刷新时无缝过渡
3. 边界用 extrapolate 而非 zero
4. CFL 满足 `|v·Δt| < 2·dx`(20 秒 × 50m/s = 1km < 6km,远超安全)

视觉上完全平滑,无跳变。

---

## 8. 物理参考公式

### 8.1 LCL(云底高度)

```
LCL ≈ 125 × (T - Td)  米
```

- T:地面气温(°C)
- Td:地面露点(°C)
- 适用于积云类(Cu / TCu / Cb)
- 不适用于层云、卷云等

### 8.2 从混合比到密度

```python
Rd = 287.05
T_actual = (T_pert + 300) * ((P_pert + PB) / 1e5) ** (Rd/1004)
rho_air = (P_pert + PB) / (Rd * T_actual)

LWC = QCLOUD * rho_air   # kg/m³
IWC = QICE   * rho_air
```

### 8.3 消光系数

```python
r_eff_liq = 10e-6   # 液云有效粒径,米
r_eff_ice = 30e-6   # 冰云有效粒径,米
rho_water = 1000

beta_liq = 1.5 * LWC / (rho_water * r_eff_liq)
beta_ice = 1.5 * IWC / (rho_water * r_eff_ice)
beta_total = beta_liq + beta_ice   # 1/米
```

### 8.4 露点反算(从 RH)

```python
import math
a, b = 17.625, 243.04
gamma = math.log(RH/100) + a*T/(b+T)
Td = b * gamma / (a - gamma)
```

---

## 9. 局限与升级路径

### 9.1 HRRR 3km 的局限

| 现象 | HRRR 能看到? |
|---|---|
| 锋面、MCS、飑线 | ✅ |
| Cb 整体形态 | ✅ |
| 层云、卷云大范围 | ✅ |
| 单个积云(< 3km) | ❌ |
| 卷云丝缕 | ❌ |
| 雾、薄海洋层云 | ⚠️ |

### 9.2 视觉补救:程序化细节

在 HRRR 云水场上叠加 3D Perlin / Worley noise:
- 保持大尺度物理一致
- 局部加湍流细节
- 视觉上接近 500m 分辨率

### 9.3 升级到自跑 WRF

需要单云细节时:
- `dx = 500m`,水平嵌套 domain
- `e_vertical = 60-80` 层
- `mp_physics = 8`(Thompson)或 `10`(Morrison 2-moment)
- `bl_pbl_physics = 5`(MYNN2.5,海洋层云首选)
- 计算量:16-32 核 CPU,一天模拟时间约 2-6 小时

### 9.4 实时性升级

HRRR 本身滞后 1-1.5 小时(模式跑完 + 上传)。如需更"现在":
- 叠加 **GOES-16 ABI**(5-10 分钟更新,云顶高度场)做水平位置 nudging
- 接 **ML nowcasting** 模型(DGMR / MetNet-3)外推 0-60 分钟
- 未来切到 **RRFS**(HRRR 后继,15 分钟更新)

---

## 10. 实施优先级

### Phase 1:最小可行(1-2 周)

1. ✅ 用 Herbie 拉 HRRR partial,只取 LA/MS/AL 区域
2. ✅ 转 VDB,本地 Blender 渲一帧验证
3. ✅ 跑通 "数据 → 渲染" 链路

### Phase 2:实时孪生核心(2-4 周)

1. ✅ 服务器端定时下载 + 转格式 + 推 CDN
2. ✅ Web 客户端拉数据 + 上传 GPU
3. ✅ Semi-Lagrangian 平流 compute shader
4. ✅ Raymarching 体渲染 shader
5. ✅ 渲染端切片插值
6. ✅ 冷启动逻辑

### Phase 3:视觉与体验(2-4 周)

1. ✅ 多重散射
2. ✅ 太阳位置同步
3. ✅ Noise 细节补全
4. ✅ 平板适配,动态降级
5. ✅ Loading 体验优化

### Phase 4:升级路径(按需)

- GOES 校正
- ML nowcasting
- 自跑 WRF 高分辨率

---

## 11. 关键技术参数速查

| 参数 | 推荐值 | 备注 |
|---|---|---|
| 数据源 | HRRR F01 + F02 | NOAA AWS |
| 数据更新频率 | 1 小时 | HRRR 原生 |
| 区域大小 | 一个州(~500×400 km) | sweet spot |
| 水平分辨率 | 3 km | HRRR 原生 |
| 垂直层 | 50 | HRRR 原生 |
| 平流计算频率 | **每 20 秒** | 视觉无损,GPU 几乎免费 |
| 渲染帧率 | 30-60 fps | 必须流畅 |
| 体素分辨率 | 128³(中端)/ 256³(高端) | 平板 128³ |
| 单帧数据(裸) | ~30 MB | 全变量 |
| 单帧数据(VDB) | 3-8 MB | 稀疏化后 |
| 客户端带宽 | < 5 KB/s 持续 | 每小时一次小下载 |
| 冷启动时间 | 2-5 秒 | CDN 加速 |
| CFL 约束 | `\|v·Δt\| < 2·dx` | 20s × 50m/s = 1km < 6km ✅ |

---

## 12. 关键库与工具

| 用途 | 工具 |
|---|---|
| HRRR 数据拉取 | [Herbie](https://herbie.readthedocs.io)(Python) |
| GRIB2 解码 | cfgrib, xarray, wgrib2 |
| WRF 数据处理 | wrf-python(NCAR 官方) |
| 气象计算 | MetPy |
| 体积数据格式 | OpenVDB / NanoVDB |
| 科学可视化 | VAPOR(NCAR,可直接读 wrfout) |
| Web 渲染 | WebGPU + Three.js |
| 桌面渲染 | Unreal Engine 5 / Unity HDRP / NVIDIA Omniverse |
| 离线高质量 | Houdini / Blender Cycles |

---

## 13. 一句话总结

**用 HRRR 每小时拉云水场和风场作为骨架,在本地 GPU 用 Semi-Lagrangian 反向追踪平流做秒级时间插值,Raymarching 体渲染输出,小区域(一个州)在平板上 30-60 fps 实时跑得动。**

数据网络成本极低,计算可解耦到 20 秒一次,视觉上连续平滑,物理上一致。
