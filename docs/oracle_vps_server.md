# Oracle VPS Server Setup

End-to-end recipe for running this project's backend on a single Oracle Cloud
Always-Free VPS (A1.Flex). One VPS does **everything**:

1. Hourly HRRR fetch + processing (systemd timer)
2. Serves the static frontend over HTTP
3. Exposes a CORS-enabled `/api/*` so the frontend can also be hosted
   elsewhere (Vercel/Netlify/etc.) and call back to this VPS as a pure data
   backend.

Raw HRRR GRIB files are deleted after each successful processing run, so disk
stays small.

---

## 0. Prerequisites

- An Oracle Cloud account with an Always-Free A1.Flex shape
- The VM has a public IP (or VNIC reserved/Network Security Group opened for
  TCP 80/443)
- A domain (optional but recommended for HTTPS), e.g. `weather3d.example.com`
- SSH access to the VM

## 1. Copy the project to the VM

```bash
sudo mkdir -p /opt/weather3d
sudo chown "$USER:$USER" /opt/weather3d
cd /opt/weather3d

# Option A — git clone
git clone https://github.com/<you>/weather3d.git .

# Option B — rsync from your laptop
# rsync -av --exclude=.venv --exclude=data/weather/hrrr/grib ./ user@VPS:/opt/weather3d/
```

## 2. Install Python runtime + system packages

Ubuntu 22.04 example (A1.Flex defaults to Oracle Linux — adjust `apt`→`dnf`
accordingly):

```bash
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip nginx libeccodes0

cd /opt/weather3d
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-hrrr.txt
```

## 3. Run the HRRR pipeline once to confirm

```bash
cd /opt/weather3d
./scripts/build-latest-weather.sh
ls -la data/weather/hrrr/
cat data/weather/hrrr/latest.json
```

You should see something like:

```json
{
  "schema": "hrrr-cloud-latest/v0",
  "cycle_utc": "2026-05-22T01:00:00Z",
  "cycle_id": "2026052201",
  "manifest": "2026052201/manifest.json",
  "frame_status": ["prepared", "prepared"]
}
```

If this works, install the timer to run it hourly automatically:

```bash
sudo cp /opt/weather3d/deploy/systemd/weather3d-hrrr.service /etc/systemd/system/
sudo cp /opt/weather3d/deploy/systemd/weather3d-hrrr.timer  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now weather3d-hrrr.timer

# Check schedule:
systemctl list-timers weather3d-hrrr.timer

# Inspect last run:
journalctl -u weather3d-hrrr.service -n 100 --no-pager
```

The timer (`*:35:00` with a 5-minute randomized delay) runs roughly :35 every
hour. The actual HRRR cycle becomes available ~50 minutes after the model
run time, so :35 catches the most recently published cycle reliably.

## 4. Install nginx (frontend + API)

```bash
sudo cp /opt/weather3d/deploy/nginx/weather3d.conf /etc/nginx/sites-available/weather3d
sudo ln -sf /etc/nginx/sites-available/weather3d /etc/nginx/sites-enabled/weather3d
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Open the Oracle Cloud security list for TCP 80 (and 443 if planning HTTPS),
plus the OS firewall:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

## 5. Verify

From your laptop:

```bash
curl http://YOUR_SERVER_IP/healthz
# → ok

curl http://YOUR_SERVER_IP/api/health
# → {"schema":"hrrr-cloud-latest/v0","cycle_utc":"...","cycle_id":"..."}

curl -I http://YOUR_SERVER_IP/api/hrrr/latest.json
# → 200, Access-Control-Allow-Origin: *

# Open the frontend in a browser:
http://YOUR_SERVER_IP/
```

## 6. HTTPS (recommended)

Point a DNS A-record at the VPS, then:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d weather3d.example.com
```

`certbot` rewrites the nginx config to listen on 443 with auto-renewal.

## 7. API contract (what the frontend hits)

All endpoints return CORS headers (`Access-Control-Allow-Origin: *`).

| Endpoint | Purpose | Cache |
|---|---|---|
| `GET /api/health` | Current HRRR cycle (alias of latest.json) | no-cache |
| `GET /api/hrrr/latest.json` | Pointer to current cycle manifest | no-cache |
| `GET /api/hrrr/{cycle_id}/manifest.json` | Frame status + variables for the cycle | no-cache |
| `GET /api/hrrr/cloud-preview.json` | Low-res cloud puff data | 5 min |
| `GET /api/hrrr/rain-preview.json` | Rain rate + top heights | 5 min |
| `GET /api/hrrr/volume/cloud-water-fNN.json` | Volume metadata (shape, scale, channels) | 5 min |
| `GET /api/hrrr/volume/cloud-water-fNN.u8` | uint8 volume bytes (x×y×z×channels) | 5 min |
| `GET /api/hrrr/wind-volume/wind-fNN.json` | Wind volume metadata | 5 min |
| `GET /api/hrrr/wind-volume/wind-{u,v,w}-fNN.f32` | float32 wind component grids | 5 min |
| `GET /api/data/csb-mesonet-crops.geojson` | Crop field boundaries (gzipped, ~1.5 MB) | 1 h |
| `GET /api/data/water/usa-detailed-water-bodies.geojson` | River/lake polygons | 1 h |

## 8. Deploying the frontend elsewhere (optional)

If you want the frontend on a CDN (Vercel/Netlify/GitHub Pages) but the data
backend on this VPS:

1. Build the bundled frontend on your laptop:
   ```bash
   ./scripts/build.sh
   ```
2. Edit `index.html` to point at this VPS:
   ```html
   <script>
     window.WEATHER3D_API_BASE  = "https://weather3d.example.com/api/hrrr";
     window.WEATHER3D_DATA_BASE = "https://weather3d.example.com/api/data";
   </script>
   <script type="module" src="./dist/main.min.js?v=prod-1"></script>
   ```
3. Upload `index.html`, `styles.css`, `dist/main.min.js` (and any local
   imagery/textures you want) to your CDN host.

Same-origin deploy (frontend served from the same VPS): leave the two `window.*`
overrides unset, defaults resolve to `./data/...` paths.

## 9. Recommended A1.Flex sizing

For the current small South Alabama HRRR crop:

| Tier | OCPU | RAM | Disk |
|---|---|---|---|
| Minimum (testing) | 1 | 6 GB | 80 GB |
| Comfortable | 2 | 12 GB | 80 GB+ |

Build script env knobs (already set in the systemd unit, override per-host as
needed):

```text
FORECAST_HOURS="1 2"      # which forecast hours to process per cycle
LATEST_LOOKBACK=12        # how many cycles back to scan when looking for the
                          # most recent publishable one
CLEAN_HRRR_GRIB=1         # delete raw .grib2 after processing
KEEP_HRRR_CYCLES=2        # retain the last N processed cycle directories
```

## 10. Monitoring

A simple uptime check on `https://weather3d.example.com/api/health` that
also asserts the JSON's `cycle_utc` is within the last 90 minutes catches
both nginx outages and stalled HRRR fetches.

Example (cron):

```bash
*/15 * * * * curl -fsS https://weather3d.example.com/api/health \
  | python3 -c 'import sys, json, datetime as d; \
                m=json.load(sys.stdin); \
                age=d.datetime.utcnow()-d.datetime.fromisoformat(m["cycle_utc"].rstrip("Z")); \
                sys.exit(1 if age.total_seconds() > 90*60 else 0)' \
  || (echo "weather3d stale" | mail -s "weather3d alert" you@example.com)
```
