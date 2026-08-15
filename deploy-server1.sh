#!/usr/bin/env bash
# Server 1 (Edge only) — Nginx + Frontend Dashboard
# Tasks: restart system/services, deploy, health check
# Usage: bash deploy-server1.sh

set -euo pipefail

SSH_KEY="$(dirname "$0")/maxpc.pem"
VPS_HOST="admin@3.112.61.130"
APP_DIR="bunandgo"
DOMAIN="dakotabot.site"

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

log_info "=== Server 1 Deploy & Restart Script ==="
log_info "Target: $VPS_HOST ($DOMAIN)"
log_info "App dir: ~/$APP_DIR"
log_info ""

# Confirm action
read -r -p "Proceed with full restart and deploy? [y/N] " confirm
[[ "$confirm" == "y" || "$confirm" == "Y" ]] || { log_error "Aborted"; exit 1; }

log_info "==> Step 1: Restart Individual Services on Server 1"
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$VPS_HOST" bash -s <<'SERVICE_RESTART'
set -euo pipefail

echo "--- Stopping services ---"
sudo systemctl stop nginx || true
sleep 1

echo "--- Checking running Node/Bun/Go processes ---"
ps aux | grep -E 'node|bun|go' | grep -v grep || true

echo "--- Restarting Nginx ---"
sudo systemctl start nginx
sleep 2
sudo systemctl status nginx --no-pager -l | head -5

echo "--- Restarting linebot-backend (should skip if disabled) ---"
if [ "$(systemctl is-enabled linebot-backend 2>/dev/null)" = "enabled" ]; then
	sudo systemctl restart linebot-backend
	sleep 2
	sudo systemctl status linebot-backend --no-pager -l | head -5
else
	echo "    [SKIPPED] linebot-backend is disabled (Server 2 serves the API)"
fi

echo "--- All services ready ---"
SERVICE_RESTART

log_info "==> Step 2: Deploy Latest Commit to Server 1"

if [[ -n "$(git status --porcelain)" ]]; then
	log_warn "Uncommitted changes present — only HEAD gets deployed"
	read -r -p "Continue? [y/N] " confirm2
	[[ "$confirm2" == "y" || "$confirm2" == "Y" ]] || { log_error "Aborted"; exit 1; }
fi

log_info "Packaging source from HEAD..."
cd "$(dirname "$0")"
git archive --format=tar.gz -o deploy.tar.gz HEAD

log_info "Uploading to Server 1..."
scp -i "$SSH_KEY" deploy.tar.gz "$VPS_HOST:~/"
rm -f deploy.tar.gz

log_info "Extracting and building on Server 1..."
ssh -i "$SSH_KEY" "$VPS_HOST" bash -s <<'DEPLOY_LOGIC'
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/go/bin:$PATH"

APP_DIR="bunandgo"

echo "--- Preparing app directory ---"
rm -rf ~/${APP_DIR}_new
mkdir ~/${APP_DIR}_new
tar -xzf deploy.tar.gz -C ~/${APP_DIR}_new
rm -f deploy.tar.gz

echo "--- Preserving secrets and data ---"
if [ -f ~/${APP_DIR}/backend/.env ]; then
	cp ~/${APP_DIR}/backend/.env ~/${APP_DIR}_new/backend/.env
fi
if [ -d ~/${APP_DIR}/backend/data ]; then
	cp -r ~/${APP_DIR}/backend/data ~/${APP_DIR}_new/backend/data
fi

echo "--- Swapping directories ---"
rm -rf ~/${APP_DIR}_old
[ -d ~/${APP_DIR} ] && mv ~/${APP_DIR} ~/${APP_DIR}_old || true
mv ~/${APP_DIR}_new ~/${APP_DIR}

echo "--- Installing backend dependencies ---"
cd ~/${APP_DIR}/backend
bun install

echo "--- Building frontend ---"
cd ~/${APP_DIR}/frontend
bun install
bun run build

echo "--- Installing tested Nginx security policy ---"
NGINX_SITE=/etc/nginx/sites-available/linebot
NGINX_BACKUP=/tmp/linebot.nginx.before-deploy
sudo cp "$NGINX_SITE" "$NGINX_BACKUP"
sudo install -m 0644 ~/${APP_DIR}/deploy/server1/nginx-security-headers.conf /etc/nginx/snippets/linebot-security-headers.conf
sudo install -m 0644 ~/${APP_DIR}/deploy/server1/nginx-linebot.conf "$NGINX_SITE"
if ! sudo nginx -t; then
	echo "--- Nginx policy invalid; restoring previous config ---"
	sudo cp "$NGINX_BACKUP" "$NGINX_SITE"
	sudo nginx -t
	exit 1
fi
sudo systemctl reload nginx

echo "--- Publishing frontend to Nginx ---"
sudo rm -rf /var/www/linebot/*
sudo cp -r ~/${APP_DIR}/frontend/dist/* /var/www/linebot/
sudo chown -R www-data:www-data /var/www/linebot

echo "--- Backend service check (must remain disabled) ---"
if [ "$(systemctl is-enabled linebot-backend 2>/dev/null)" = "enabled" ]; then
	echo "WARNING: linebot-backend is enabled! This should NOT happen on Server 1."
	exit 1
else
	echo "    [OK] linebot-backend remains disabled"
fi

echo "--- Deploy complete ---"
DEPLOY_LOGIC

log_info "==> Step 3: System Status & Health Checks"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$VPS_HOST" bash -s <<'HEALTH_CHECK'
set -euo pipefail

echo "--- Process Status ---"
echo "Nginx:"
sudo systemctl status nginx --no-pager -l | head -3

echo ""
echo "Backend (should be inactive):"
# `systemctl status` deliberately exits non-zero for an inactive unit.  That
# is the intended state on Server 1 (Server 2 owns the API), so printing it
# must not make an otherwise successful frontend deployment look failed.
sudo systemctl status linebot-backend --no-pager 2>&1 | head -3 || true

echo ""
echo "--- Port Listeners ---"
echo "Port 80/443 (Nginx):"
sudo ss -tlnp | grep -E ':(80|443)' || echo "  No HTTP ports open?"

echo ""
echo "--- App Directory ---"
ls -la ~/bunandgo/backend/src/dispatch/client.ts | head -1
ls -la ~/bunandgo/frontend/dist/index.html | head -1

echo ""
echo "--- Nginx Config Check ---"
sudo nginx -t

HEALTH_CHECK

log_info "==> Step 4: HTTP Health Checks"

echo ""
echo "Testing Dashboard & API:"
echo ""

# Test dashboard
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/" 2>&1 || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
	log_info "Dashboard: PASS (HTTP $HTTP_CODE)"
else
	log_warn "Dashboard: Unexpected HTTP $HTTP_CODE"
fi

# Test API (expect 401 since we're not authed, but connection should work)
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/health" 2>&1 || echo "000")
if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "200" ]; then
	log_info "API Proxy: PASS (HTTP $HTTP_CODE, proxies to Server 2)"
else
	log_warn "API Proxy: Unexpected HTTP $HTTP_CODE"
fi

echo ""
log_info "=== Server 1 Deploy & Restart Complete ==="
echo ""
echo "Rollback command (if needed):"
echo "  ssh -i $SSH_KEY $VPS_HOST 'rm -rf ~/bunandgo && mv ~/bunandgo_old ~/bunandgo && sudo systemctl restart linebot-backend'"
echo ""
