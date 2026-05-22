# GitHub → Oracle VPS 部署 walkthrough

完整路径:**笔记本本地 git push** → **GitHub 仓库** → **VPS git pull + 自动 reload**。

每小时 HRRR 数据由 VPS 自己跑 `scripts/build-latest-weather.sh` 生成,**不进 git**。

---

## 第 0 步:确认会推什么 / 不会推什么

仓库当前 `.gitignore` 已经排除:

- `.venv/`, `__pycache__/`, `*.pyc`,`.DS_Store`
- `*.mp4`(屏幕录像)
- `NationalCSB_2018-2025_rev23/`, `2025_30m_cdls/`(原始 GB 级数据)
- `data/csb-mesonet.geojson` + `data/csb-mesonet-simplified.geojson`(CSB 中间产物)
- `data/weather/hrrr/grib/`, `data/weather/hrrr/[cycle]/`, `*.npz`(HRRR fetch 结果)
- `dist/`(esbuild 构建产物)

会进仓库的"大文件":

| 文件 | 大小 |
|---|---|
| `data/csb-mesonet-crops.geojson` | 32 MB |
| `data/water/usa-detailed-water-bodies.geojson` | 11 MB |

GitHub 单文件硬上限 100 MB,这两个都过得去(32 MB 会有 warning 但能 push)。如果以后这些文件频繁 rebuild,**用 Git LFS 管它们更干净**:

```bash
git lfs install
git lfs track "data/csb-mesonet-crops.geojson"
git lfs track "data/water/usa-detailed-water-bodies.geojson"
git add .gitattributes
```

不用 LFS 也能正常工作,只是 git 历史会随时间膨胀。

---

## 第 1 步:本地建仓 + push

```bash
cd /Users/yihezhang/Documents/26_weather3d

# 首次 init
git init -b main
git add .gitignore .github deploy docs scripts src
git add README.md index.html main.js styles.css requirements-hrrr.txt
git add data/csb-mesonet-crops.geojson data/water/usa-detailed-water-bodies.geojson
git add UnrealWeather3D    # 如果你要带上 UE 项目
git commit -m "initial commit"

# 创建 GitHub repo(用 gh CLI)
gh repo create weather3d --public --source=. --remote=origin --push

# 或者手动:在 github.com/new 建仓 → 复制远端 URL → 然后:
# git remote add origin git@github.com:USER/weather3d.git
# git push -u origin main
```

---

## 第 2 步:VPS 拉代码

### 2a. 公开仓库(最简单)

```bash
sudo mkdir -p /opt/weather3d
sudo chown "$USER:$USER" /opt/weather3d
git clone https://github.com/USER/weather3d.git /opt/weather3d
cd /opt/weather3d
```

### 2b. 私有仓库 — 用 deploy key

在 VPS 上生成专用 ssh key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/weather3d-deploy -C "weather3d@oracle-vps" -N ''
cat ~/.ssh/weather3d-deploy.pub
```

把那个 `.pub` 内容粘到 GitHub 仓库的 **Settings → Deploy keys → Add deploy key**(read-only 即可)。

VPS 上配置 ssh 走这个 key:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github-weather3d
  HostName github.com
  User git
  IdentityFile ~/.ssh/weather3d-deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

git clone git@github-weather3d:USER/weather3d.git /opt/weather3d
cd /opt/weather3d
```

---

## 第 3 步:首次安装 + 启动

```bash
cd /opt/weather3d
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip nginx libeccodes0

python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-hrrr.txt

# 跑一遍确认能正常 fetch HRRR
./scripts/build-latest-weather.sh

# 装 systemd timer(每小时 :35 自动跑)
sudo cp deploy/systemd/weather3d-hrrr.service /etc/systemd/system/
sudo cp deploy/systemd/weather3d-hrrr.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now weather3d-hrrr.timer

# 装 nginx
sudo cp deploy/nginx/weather3d.conf /etc/nginx/sites-available/weather3d
sudo ln -sf /etc/nginx/sites-available/weather3d /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Oracle Cloud 安全组开 80/443,本机防火墙也开
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp

# 访问 http://VPS_IP/ 验证
```

---

## 第 4 步:后续更新 — 三种方式选一

### 方式 A:手动 git pull(最简,推荐起步用)

每次本地 push 完,SSH 到 VPS:

```bash
cd /opt/weather3d
./scripts/deploy.sh
```

`deploy.sh` 做的事:
- `git fetch + pull --ff-only`
- 如果 `requirements-hrrr.txt` 改了,自动跑 `pip install`
- `systemctl restart weather3d-hrrr.timer`
- `nginx -t && systemctl reload nginx`
- 整个过程 < 5 秒(没有依赖变化时)

### 方式 B:cron 自动每分钟 pull(简单,无需 webhook)

```bash
crontab -e
# 加这一行:
* * * * * cd /opt/weather3d && ./scripts/deploy.sh > /tmp/weather3d-deploy.log 2>&1
```

延迟最多 1 分钟,不需要在 GitHub 上配置任何东西。

### 方式 C:GitHub Actions 推送 SSH 触发(最快、最干净)

仓库根建 `.github/workflows/deploy.yml`:

```yaml
name: Deploy to VPS
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: SSH deploy
        uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.VPS_HOST }}
          username: ${{ secrets.VPS_USER }}
          key: ${{ secrets.VPS_SSH_KEY }}
          script: |
            cd /opt/weather3d
            ./scripts/deploy.sh
```

在 GitHub 仓库 **Settings → Secrets → Actions** 添加:
- `VPS_HOST`:你的 Oracle VPS 公网 IP / 域名
- `VPS_USER`:你 SSH 用的用户名(通常 `ubuntu` 或 `opc`)
- `VPS_SSH_KEY`:**你笔记本的私钥**(全文,以 `-----BEGIN OPENSSH PRIVATE KEY-----` 开头)
  - 或者生成一对专用密钥:`ssh-keygen -t ed25519 -f gha-deploy -N ''` → 把 `gha-deploy.pub` 加到 VPS 的 `~/.ssh/authorized_keys`,把 `gha-deploy`(私钥)填进 Secret

push 到 main 触发,~30 秒内 VPS 拉完代码。

---

## 第 5 步:验证

```bash
# 在 VPS 上:
systemctl status weather3d-hrrr.timer    # 看 next run
systemctl status nginx                   # active
curl localhost/api/health                # JSON 输出 cycle_utc

# 在浏览器:
http://VPS_IP/                          # 看 3D 网站
http://VPS_IP/api/hrrr/latest.json      # 验证 API
```

---

## 常见坑

| 症状 | 原因 | 解法 |
|---|---|---|
| `git push` 失败 file > 100 MB | 不该入仓的文件没 ignore | 检查 `.gitignore`,用 `git rm --cached <file>` 再 commit |
| VPS 上 `git pull` 提示 "rebase" | 本地直接在 VPS 上改了 | 在 VPS 上别改代码,改完 commit 推回去 |
| `systemctl reload nginx` 报权限错 | `deploy.sh` 里有 `sudo`,但当前用户没 nopasswd sudo | `sudo visudo` 给 user 加 `NOPASSWD: /bin/systemctl restart weather3d-hrrr.timer, /bin/systemctl reload nginx, /usr/sbin/nginx -t` |
| 前端拉数据 CORS error | nginx 没 reload / 配置没装 | `nginx -t && systemctl reload nginx`,看 `/etc/nginx/sites-enabled/weather3d` 是否存在 |
| HRRR fetch 失败 | NOAA 当前 cycle 还没发 / 网络 | timer 是 hourly + 5min jitter,下个周期会自动重试 |

---

## 最小可工作的目录结构(VPS 上)

```text
/opt/weather3d/
├── data/
│   ├── csb-mesonet-crops.geojson           # ← 从 git 拉
│   ├── water/                              # ← 从 git 拉
│   └── weather/hrrr/                       # ← VPS 自己 fetch,git 不管
│       ├── latest.json
│       ├── 2026052201/{manifest.json,f01.npz,f02.npz}
│       ├── volume/{*.json,*.u8}
│       ├── wind-volume/{*.json,*.f32}
│       └── *-preview.json
├── deploy/
├── docs/
├── scripts/
├── src/
├── main.js, index.html, styles.css
└── .venv/                                  # ← VPS 上 install,git 不管
```

---

## 安全建议

- VPS 用普通用户(不是 root)拥有 `/opt/weather3d`
- nginx 用 `nginx`/`www-data` 用户(自动)
- `sudo` 用 NOPASSWD 限定到精确的命令(`/bin/systemctl restart weather3d-hrrr.*` + `/bin/systemctl reload nginx`)
- HTTPS 用 `certbot --nginx -d <domain>` 一键搞定
- 私有仓库的 deploy key 只给 read 权限
- 别把 `.venv` push 到 GitHub(已 ignore)
