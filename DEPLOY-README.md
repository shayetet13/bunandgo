# Deploy Scripts — Server 1 & Server 2

Two independent deployment scripts for managing the LINE bot infrastructure across two servers.

## Overview

| Server | Script | Purpose |
|--------|--------|---------|
| **Server 1** (`3.112.61.130`) | `deploy-server1.sh` | Edge only — Nginx reverse proxy + static dashboard |
| **Server 2** (`172.237.8.10`) | `deploy-server2.sh` | Real backend — Bun service + database |

---

## Server 1: deploy-server1.sh

**Target:** AWS EC2 edge server running Nginx and static frontend dashboard.

### What It Does

1. **Restart Services**
   - Stops and restarts Nginx
   - Checks running Node/Bun/Go processes
   - Verifies `linebot-backend` remains **disabled** (critical safety check)

2. **Deploy Latest Commit**
   - Packages current HEAD via `git archive`
   - Uploads to Server 1 via SCP
   - Builds frontend with Bun
   - Publishes static files to `/var/www/linebot`
   - Preserves `.env` and data directories

3. **Health Checks**
   - Verifies Nginx is running
   - Tests HTTPS dashboard (`https://dakotabot.site/`)
   - Confirms API proxy to Server 2 works

### Usage

```bash
bash deploy-server1.sh
```

**Prompts:**
- Asks for confirmation before proceeding
- Warns if uncommitted changes exist

**Output:**
- Color-coded logs (green INFO, yellow WARN, red ERROR)
- Rollback command printed at end (in case you need to revert)

### Key Safety Features

- **Backend remains disabled**: Script checks `systemctl is-enabled linebot-backend` and skips restart if disabled
- **No duplicate workers**: Prevents accidental activation of two backends serving same LINE accounts
- **Rollback ready**: Provides exact `ssh` command to restore previous version

### Example Output

```
[INFO] === Server 1 Deploy & Restart Script ===
[INFO] Target: admin@3.112.61.130 (dakotabot.site)
[INFO] App dir: ~/bunandgo

Proceed with full restart and deploy? [y/N] y

[INFO] ==> Step 1: Restart Individual Services on Server 1
--- Stopping services ---
--- Restarting Nginx ---
[status output...]
--- Restarting linebot-backend (should skip if disabled) ---
[SKIPPED] linebot-backend is disabled (Server 2 serves the API)

[INFO] ==> Step 2: Deploy Latest Commit to Server 1
[INFO] Packaging source from HEAD...
[INFO] Uploading to Server 1...
[INFO] Extracting and building on Server 1...
--- Installing backend dependencies ---
[npm/bun output...]
--- Building frontend ---
[vite build output...]
--- Publishing frontend to Nginx ---

[INFO] ==> Step 3: System Status & Health Checks
--- Nginx status ---
--- Port 80/443 check ---

[INFO] ==> Step 4: HTTP Health Checks
[INFO] Dashboard: PASS (HTTP 200)
[INFO] API Proxy: PASS (HTTP 401, proxies to Server 2)

[INFO] === Server 1 Deploy & Restart Complete ===
```

---

## Server 2: deploy-server2.sh

### One-time dashboard restart helper

The admin Settings page can restart only `linebot-worker.service`. Install its
restricted systemd path helper once on Server 2 after the release is active:

```bash
sudo bash /opt/linebot/current/scripts/install-web-restart.sh
```

The backend keeps `NoNewPrivileges=true`; it writes a fixed trigger file and
the root-owned helper performs only the literal primary-worker restart.

**Target:** Linode backend server running the real Bun application and database.

### Connection Method

Server 2 is reached via **ProxyJump** through Server 1:
- Gateway: `admin@3.112.61.130` (Server 1)
- Target: `linebot@10.77.0.2` (Server 2 on private network)
- SSH key automatically copied to space-free path to avoid `ProxyCommand` quoting issues

### What It Does

1. **Restart Services**
   - Restarts the primary and every enabled owner-scoped shard
   - Verifies each selected systemd unit and process is active

2. **Deploy Latest Commit**
   - Generates deployment ID (timestamp)
   - Packages HEAD via `git archive`
   - Uploads via SCP through gateway
   - Extracts to `/opt/linebot/releases/<timestamp>-deploy`
   - Installs dependencies: `bun install --production`
   - Rejects release-local `.env` files; production config stays in
     `/etc/linebot/worker*.env`
   - Runs the test suite with automatic `.env` loading disabled
   - Validates disjoint owner scopes, control-plane routes, and shared token

3. **Switch Symlink**
   - Saves current release target to `~/.rollback_to.txt`
   - Updates `/opt/linebot/current` symlink to new release
   - Restarts `linebot-worker` and every enabled shard as one transaction
   - Restores the previous symlink and restarts all workers if any unit fails

4. **Health Checks**
   - Verifies new release is active
   - Confirms primary and shard service status
   - Checks port 8791 (control plane) and enabled shard listeners
   - Tests API via Server 1 proxy

### Usage

```bash
bash deploy-server2.sh
```

**Prompts:**
- Confirms full restart and deploy action
- Warns if uncommitted changes exist
- May ask for SSH/sudo password (if key authentication incomplete)

**Output:**
- Color-coded logs (green INFO, yellow WARN, blue DEBUG, red ERROR)
- ProxyJump connection status
- Test suite output
- Rollback command for manual revert

### Key Features

- **Atomic symlink switch**: New version only active after all tests pass
- **Whole-topology rollback**: Previous release is restored for primary and shards together
- **External configuration**: Shared releases never carry production secrets or scope
- **Production test run**: Test suite runs with `--no-env-file` before activation
- **Proper sudo scoping**: Only runs exact allowed sudo commands
- **Database preservation**: Shared DB not touched during deploy

### Example Output

```
[INFO] === Server 2 Deploy & Restart Script ===
[INFO] Target: linebot@10.77.0.2 (real backend)
[INFO] Gateway: admin@3.112.61.130 (via ProxyJump)
[INFO] Release base: /opt/linebot/releases
[INFO] Current symlink: /opt/linebot/current

Proceed with full restart and deploy to Server 2? [y/N] y

[INFO] ==> Step 1: Restart Individual Services on Server 2
--- Stopping linebot-worker service ---
--- Checking running Bun/Node processes ---
--- Restarting linebot-worker service ---
[status...]

[INFO] ==> Step 2: Prepare Deploy Package
[INFO] Deploy ID: 20260809-104532-deploy
[INFO] Packaging source from HEAD...

[INFO] ==> Step 3: Transfer & Deploy to Server 2
[INFO] Uploading to Server 2...
[INFO] Extracting and deploying on Server 2...
--- Extracting new release ---
--- Installing backend dependencies ---
--- Running test suite ---
[test output...]
--- Switching symlink: /opt/linebot/current -> /opt/linebot/releases/20260809-104532-deploy ---
--- Restarting service ---

[INFO] ==> Step 4: System Status & Health Checks
--- Current Release ---
--- Service Status ---
--- Process Status ---
--- Port Listeners (8791) ---
--- Backend Source Check ---

[INFO] ==> Step 5: API Health Checks (via Server 1 proxy)
Testing API via Server 1 Nginx proxy:
[INFO] API Health: PASS (HTTP 401 — auth required, backend reachable)

[INFO] === Server 2 Deploy & Restart Complete ===
```

---

## Running Both in Sequence

```bash
# Deploy edge first (frontend + dashboard)
bash deploy-server1.sh

# Then deploy backend (live application logic)
bash deploy-server2.sh
```

---

## Rollback Procedures

### Server 1 Rollback

```bash
ssh -i maxpc.pem admin@3.112.61.130 \
  'rm -rf ~/bunandgo && mv ~/bunandgo_old ~/bunandgo && sudo systemctl restart linebot-backend'
```

### Server 2 Rollback

Manually switch symlink back:

```bash
ssh -i maxpc.pem \
  -o ProxyCommand="ssh -i maxpc.pem -W 10.77.0.2:22 admin@3.112.61.130" \
  linebot@10.77.0.2 \
  'rollback=$(cat ~/.rollback_to.txt) && test -d "$rollback" && rm -f /opt/linebot/current && ln -s "$rollback" /opt/linebot/current && sudo -n /usr/bin/systemctl restart linebot-worker && { ! systemctl is-enabled linebot-worker-shard-b >/dev/null 2>&1 || sudo -n /usr/bin/systemctl restart linebot-worker-shard-b; }'
```

---

## Troubleshooting

### "linebot-backend is enabled on Server 1!"

**Problem:** Safety check failed — backend should be disabled.

**Fix:** SSH to Server 1 and disable it:
```bash
ssh -i maxpc.pem admin@3.112.61.130 \
  'sudo systemctl stop linebot-backend && sudo systemctl disable linebot-backend'
```

### "SSH key not found at: /c/Users/..."

**Problem:** Space-free path setup failed.

**Fix:** The script attempts to copy the key automatically. If it fails, manually copy:
```bash
mkdir -p "C:\Users\ADMINI~1\AppData\Local\Temp\claude\F--webapp-bot-linejs-bun\13bc65ca-7377-45a3-88ef-c4f50fd68307\scratchpad"
copy "F:\webapp\bot linejs bun\maxpc.pem" "C:\Users\ADMINI~1\AppData\Local\Temp\claude\F--webapp-bot-linejs-bun\13bc65ca-7377-45a3-88ef-c4f50fd68307\scratchpad\maxpc.pem"
```

### "Service not reachable after deploy"

**Steps to diagnose:**

1. Check gateway connectivity:
   ```bash
   ssh -i maxpc.pem admin@3.112.61.130 "echo 'Server 1 OK'"
   ```

2. Check backend process:
   ```bash
   ssh -i maxpc.pem admin@3.112.61.130 \
     -o ProxyCommand="ssh -i maxpc.pem -W 10.77.0.2:22 admin@3.112.61.130" \
     linebot@10.77.0.2 \
     "ps aux | grep bun"
   ```

3. Check logs:
   ```bash
   ssh -i maxpc.pem admin@3.112.61.130 \
     -o ProxyCommand="ssh -i maxpc.pem -W 10.77.0.2:22 admin@3.112.61.130" \
     linebot@10.77.0.2 \
     "journalctl -u linebot-worker -u linebot-worker-shard-b -n 100"
   ```

---

## Requirements

- `bash` (v4+)
- `git` (for archive)
- `ssh` + `scp` (with key authentication)
- `maxpc.pem` in project root
- SSH key loaded (or use `ssh-agent` if prompted for password)

---

## Files

- **`deploy-server1.sh`** — 183 lines, edge deployment
- **`deploy-server2.sh`** — backend deployment and whole-topology rollback
- **`DEPLOY-README.md`** — This file

All files are in the project root: `F:\webapp\bot linejs bun\`

---

## Version Info

- **Created:** 2026-08-09
- **Target Commit:** `76d360b` (latest: "docs: record that a second Square poll worker halves, not helps, latency")
- **Tested On:** Server 1 (EC2), Server 2 (Linode)
