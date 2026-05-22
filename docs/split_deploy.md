# Split Deploy: Frontend on CDN, Backend on VPS

Final architecture:

```
┌────────────────────────────┐         ┌──────────────────────────────┐
│  Vercel (or Netlify / GH)  │  HTTPS  │  Oracle VPS                  │
│  ─ index.html              │ ──────▶ │  ─ nginx /api/hrrr/*  (CORS) │
│  ─ main.min.js  (61 KB)    │         │  ─ /api/data/* (geojson)     │
│  ─ styles.css              │         │  ─ systemd timer: HRRR/h     │
│  global CDN, free          │         │  free A1.Flex tier           │
└────────────────────────────┘         └──────────────────────────────┘
```

**Why split**:
- Frontend (71 KB) lives on a global CDN → fast first paint everywhere
- Backend VPS only runs the hourly HRRR fetch + nginx → tiny traffic, free tier comfortable
- Backend outage doesn't take the frontend offline (it just shows no data); frontend build break doesn't touch the backend

---

## Step 0: Backend must be reachable first

Follow [`docs/github_deploy.md`](./github_deploy.md) to bring up the Oracle VPS until **both** URLs respond:

```
http://VPS_IP/api/health              # JSON with cycle_utc
http://VPS_IP/api/hrrr/latest.json
```

**Strongly recommended**: put HTTPS in front of the backend BEFORE the frontend deploys (browsers block HTTP API calls from HTTPS pages — "Mixed Content"). Pick one:

- Cleanest: a domain + `certbot --nginx -d weather3d.example.com` (5 minutes)
- No domain: Cloudflare Tunnel (`cloudflared`) — gives free HTTPS via Cloudflare without buying a domain

The final backend base will look like:

```
https://weather3d.example.com
```

Remember this URL.

---

## Step 1: Connect Vercel to the GitHub repo

1. Log into https://vercel.com with GitHub
2. **Add New → Project** → pick the `weather3d` repo → **Import**
3. **Framework Preset**: select **Other** (not Next.js / Vite)
4. **Build Command**: `npm run build` (auto-detected)
5. **Output Directory**: `dist`
6. **Environment Variables** → add one:
   - Key: `BACKEND_BASE`
   - Value: `https://weather3d.example.com` (your backend URL, **no trailing slash**)
   - Environments: Production + Preview
7. **Deploy**

First build takes 30-60 seconds. Vercel will:

- `npm install` (fetches esbuild)
- `npm run build` → `node scripts/build-frontend.mjs` → generates `dist/`
- Upload `dist/index.html`, `main.min.js`, `styles.css` to its CDN

You get a URL like `weather3d-abc123.vercel.app`. Open it: the 3D site loads and data is fetched from your VPS via the `/api/*` endpoints.

---

## Step 2: Custom domain (optional)

In the Vercel project page → **Settings → Domains**, add a domain like `weather3d.example.com` or `app.example.com`. Vercel tells you the DNS records to add.

---

## Step 3: Verify CORS works

Open the Vercel URL → DevTools → Network tab → look at data requests:

```
weather3d.example.com/api/hrrr/latest.json  Status 200
   Response Headers:
     access-control-allow-origin: *
```

If you see CORS errors, check the `add_header Access-Control-Allow-Origin` lines in [`deploy/nginx/weather3d.conf`](../deploy/nginx/weather3d.conf).

---

## Update workflow

```
local edit
    │
    │ git add . && git commit && git push
    ▼
GitHub repo
    │
    ├──▶ Vercel detects push → auto build & redeploy frontend  (~60s)
    │
    └──▶ VPS runs ./scripts/deploy.sh (manual or cron) → pulls updates (~5s)
```

**Independent**: a frontend shader tweak doesn't need to touch the VPS; a backend nginx-config change doesn't break the frontend.

---

## One repo, two deploy targets — how they don't conflict

- **Backend VPS** pulls the **entire repo** but only uses `scripts/`, `data/`, `deploy/`, `requirements-hrrr.txt`
- **Frontend Vercel** pulls the **entire repo** too, but `.vercelignore` excludes backend files. Only the `dist/*` output of `npm run build` ever reaches the CDN.

You push once; both deploy targets pick it up.

---

## Netlify / GitHub Pages alternatives

**Netlify** — same setup, configured in `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[build.environment]
  BACKEND_BASE = "https://weather3d.example.com"
```

**GitHub Pages** (free, no server-side, via GH Actions) — create `.github/workflows/pages.yml`:

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

Add `BACKEND_BASE` in **Settings → Secrets**. In **Settings → Pages**, set source = GitHub Actions. Push to main → auto-deploy.

---

## Local production preview

```bash
BACKEND_BASE=https://weather3d.example.com npm run build
cd dist && python3 -m http.server 4173
# Visit http://localhost:4173 — this preview talks to the real remote backend
```

---

## File responsibilities

| File | Role |
|---|---|
| `package.json` | declares the `npm run build` entry point |
| `scripts/build-frontend.mjs` | esbuild bundle + inject `BACKEND_BASE` into `dist/index.html` |
| `vercel.json` | Vercel platform config (build command + cache headers) |
| `.vercelignore` | tells Vercel which files to skip uploading (backend, data, docs) |
| `src/config.js` | runtime layer reading `window.WEATHER3D_API_BASE` |
| `deploy/nginx/weather3d.conf` | VPS nginx config with CORS for `/api/*` |
| `deploy/systemd/weather3d-hrrr.*` | VPS hourly HRRR fetch |
