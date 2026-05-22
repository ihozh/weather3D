# 前端 CDN + 后端 VPS 分离部署

最终架构:

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Vercel (or Netlify / GH)  │  HTTPS  │  Oracle VPS                  │
│  ─ index.html              │ ──────▶ │  ─ nginx /api/hrrr/*  (CORS) │
│  ─ main.min.js  (61 KB)    │         │  ─ /api/data/* (geojson)     │
│  ─ styles.css              │         │  ─ systemd timer: HRRR/h    │
│  global CDN, free          │         │  free A1.Flex tier           │
└────────────────────────────┘         └──────────────────────────────┘
```

**为什么这样分**:
- 前端 71 KB,全 CDN 分发,全球用户首屏快
- 后端 VPS 只跑 HRRR fetch + nginx,流量小,免费 tier 够用
- 后端挂了,前端还能加载(只是没数据);前端构建坏了,后端不受影响

---

## 第 0 步:先把后端跑起来

按 [`docs/github_deploy.md`](./github_deploy.md) 部署后端到 Oracle VPS,直到这两个 URL 都能访问:

```
http://VPS_IP/api/health              # 返回 JSON 包含 cycle_utc
http://VPS_IP/api/hrrr/latest.json
```

**强烈推荐**先给后端配 HTTPS + 域名(见后端文档第 6 步用 certbot)。最终后端基地址应该是:

```
https://weather3d.example.com
```

记下来,下面要用。

---

## 第 1 步:在 Vercel 接 GitHub repo

1. 登 https://vercel.com,用 GitHub 账号登
2. **Add New → Project** → 选你的 `weather3d` 仓库 → **Import**
3. **Framework Preset** 选 **Other**(不是 Next.js / Vite 等)
4. **Build Command**:`npm run build`(应该自动检测到)
5. **Output Directory**:`dist`
6. **Environment Variables** → 加一个:
   - Key:`BACKEND_BASE`
   - Value:`https://weather3d.example.com`(你的后端 URL,**不要带尾斜杠**)
   - Environments:勾 Production + Preview
7. **Deploy**

第一次 deploy 大约 30-60 秒。Vercel 会:

- `npm install` 装 esbuild
- `npm run build` → `node scripts/build-frontend.mjs` → 生成 `dist/`
- 把 `dist/index.html` / `main.min.js` / `styles.css` 上 CDN

Vercel 给你一个 URL,比如 `weather3d-abc123.vercel.app`。打开就能看到 3D 网站,**数据自动从你 VPS 的 `/api/*` 拉**。

---

## 第 2 步:绑自己的域名(可选)

在 Vercel 项目页 **Settings → Domains** 加 `weather3d.example.com`(或者 `app.example.com` 等)。Vercel 会告诉你 DNS 怎么配。

---

## 第 3 步:验证 CORS 工作

打开 Vercel 给的 URL → DevTools → Network 选项卡 → 看数据请求:

```
weather3d.example.com/api/hrrr/latest.json  Status 200
   Response Headers:
     access-control-allow-origin: *
```

如果是 CORS 错,检查后端 nginx config 的 `add_header Access-Control-Allow-Origin` 行(在 [`deploy/nginx/weather3d.conf`](../deploy/nginx/weather3d.conf) 里已加)。

---

## 后续工作流

```
本地改代码
    │
    │ git add . && git commit && git push
    ▼
GitHub repo
    │
    ├──▶ Vercel detect push → 自动 build & redeploy 前端 (~60s)
    │
    └──▶ VPS 手动 ./scripts/deploy.sh 或 cron 自动 pull → 更新后端 (~5s)
```

**两边互不依赖**。前端只改了 shader 不需要碰 VPS,前端 redeploy 完就生效。后端改了 nginx config 不影响前端。

---

## 同一仓库,两个 deploy target 怎么不冲突

- **后端 VPS** 拉**整个 repo**,只用 `scripts/`、`data/`、`deploy/`、`requirements-hrrr.txt`
- **前端 Vercel** 也拉**整个 repo**,但 `.vercelignore` 排除了后端文件,实际上传到 CDN 的只有 `dist/*`(由 `npm run build` 生成)

你只 push 一次,两边都自动收到。

---

## 也想用 Netlify / GitHub Pages?

**Netlify**:同样配置,只需要在 `netlify.toml` 里写:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  BACKEND_BASE = "https://weather3d.example.com"
```

**GitHub Pages**(免费,无服务端,需要 GH Actions):创建 `.github/workflows/pages.yml`:

```yaml
name: Deploy frontend to Pages
on:
  push:
    branches: [main]
permissions:
  pages: write
  id-token: write
jobs:
  build-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npm run build
        env:
          BACKEND_BASE: ${{ secrets.BACKEND_BASE }}
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
      - uses: actions/deploy-pages@v4
```

在 repo Settings → Secrets 加 `BACKEND_BASE`。在 Settings → Pages 选 source = GitHub Actions。push 触发自动部署。

---

## 本地预览生产前端

```bash
BACKEND_BASE=https://weather3d.example.com npm run build
cd dist && python3 -m http.server 4173
# 访问 http://localhost:4173 — 这个本地预览会从远端 VPS 拉数据
```

---

## 各文件作用速查

| 文件 | 干什么 |
|---|---|
| `package.json` | `npm run build` 入口 |
| `scripts/build-frontend.mjs` | esbuild 打包 + 注入 BACKEND_BASE 到 index.html |
| `vercel.json` | Vercel 平台配置(build command + cache headers) |
| `.vercelignore` | 告诉 Vercel 不要上传后端 / data 文件 |
| `src/config.js` | 前端运行时读 `window.WEATHER3D_API_BASE` |
| `deploy/nginx/weather3d.conf` | VPS nginx 配置,带 CORS |
| `deploy/systemd/weather3d-hrrr.*` | VPS 每小时 HRRR fetch |
