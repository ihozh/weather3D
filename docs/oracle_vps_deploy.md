# Oracle VPS Deployment

Use the VPS for the hourly HRRR processing job. Cloudflare Pages/Workers should
only serve frontend/static files; they are not a good fit for GRIB decoding.

## Suggested Layout

```text
/opt/weather3d
  index.html
  main.js
  styles.css
  scripts/
  data/
```

Nginx can serve `/opt/weather3d` directly, or the VPS can build the files and
sync the compact output to Cloudflare R2.

## Install

```bash
cd /opt/weather3d
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-hrrr.txt
sudo apt-get update
sudo apt-get install -y libeccodes0
```

## Systemd Timer

Copy the templates and enable the hourly job:

```bash
sudo cp deploy/systemd/weather3d-hrrr.service /etc/systemd/system/
sudo cp deploy/systemd/weather3d-hrrr.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now weather3d-hrrr.timer
```

Check status and logs:

```bash
systemctl status weather3d-hrrr.timer
journalctl -u weather3d-hrrr.service -n 100 --no-pager
```

Run once manually:

```bash
sudo systemctl start weather3d-hrrr.service
```

## Disk Behavior

`scripts/build-latest-weather.sh` defaults to:

```text
CLEAN_HRRR_GRIB=1
KEEP_HRRR_CYCLES=2
```

That means raw GRIB downloads are deleted after processing, and only the latest
two cycle folders are kept for their small `manifest.json` files and temporary
debugging. Browser-ready cloud/wind volumes remain in:

```text
data/weather/hrrr/volume/
data/weather/hrrr/wind-volume/
```

## Nginx Cache Hint

For the dynamic pointer files, keep cache short:

```text
data/weather/hrrr/latest.json
data/weather/hrrr/*/manifest.json
```

The volume files can use a longer cache, but the current filenames are reused
each hour, so start with `Cache-Control: no-cache` or a short `max-age` until
versioned filenames are added.
