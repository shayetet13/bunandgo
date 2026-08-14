#!/usr/bin/env bash
# Deploy the committed source to the AWS EC2 box: package -> upload -> build -> restart.
# Supersedes deploy.sh, which still targets the old (retired) Linode VPS.
# Run from the project root: bash deploy-aws.sh
set -euo pipefail

VPS_HOST="admin@3.112.61.130"
SSH_KEY="$(dirname "$0")/maxpc.pem"
APP_DIR="bunandgo"
DOMAIN="dakotabot.site"

cd "$(dirname "$0")"

if [[ -n "$(git status --porcelain)" ]]; then
	echo "Warning: uncommitted changes present — only the last commit gets deployed."
	read -r -p "Continue anyway? [y/N] " confirm
	[[ "$confirm" == "y" || "$confirm" == "Y" ]] || exit 1
fi

echo "==> Packaging committed source (git archive)..."
git archive --format=tar.gz -o deploy.tar.gz HEAD

echo "==> Uploading to VPS..."
scp -i "$SSH_KEY" deploy.tar.gz "$VPS_HOST:~/"
rm -f deploy.tar.gz

echo "==> Deploying on VPS..."
ssh -i "$SSH_KEY" "$VPS_HOST" bash -s <<REMOTE_SCRIPT
set -euo pipefail
export PATH="\$HOME/.bun/bin:/usr/local/go/bin:\$PATH"

rm -rf ~/${APP_DIR}_new
mkdir ~/${APP_DIR}_new
tar -xzf deploy.tar.gz -C ~/${APP_DIR}_new
rm -f deploy.tar.gz

# Carry over secrets/data that never live in the git archive.
if [ -f ~/${APP_DIR}/backend/.env ]; then
	cp ~/${APP_DIR}/backend/.env ~/${APP_DIR}_new/backend/.env
fi
if [ -d ~/${APP_DIR}/backend/data ]; then
	cp -r ~/${APP_DIR}/backend/data ~/${APP_DIR}_new/backend/data
fi

rm -rf ~/${APP_DIR}_old
if [ -d ~/${APP_DIR} ]; then
	mv ~/${APP_DIR} ~/${APP_DIR}_old
fi
mv ~/${APP_DIR}_new ~/${APP_DIR}

echo "--- backend deps ---"
cd ~/${APP_DIR}/backend
bun install

echo "--- frontend build ---"
cd ~/${APP_DIR}/frontend
bun install
bun run build

echo "--- publishing frontend ---"
sudo rm -rf /var/www/linebot/*
sudo cp -r ~/${APP_DIR}/frontend/dist/* /var/www/linebot/
sudo chown -R www-data:www-data /var/www/linebot

echo "--- backend service ---"
# Post-cutover, Nginx proxies /api and /ws to Server 2 and this host's own
# linebot-backend is deliberately stopped and disabled. Restarting it here
# would put the same LINE accounts on two workers at once, which is exactly
# what deploy/server2/README.md forbids. Only restart a unit that is still
# the live backend for this host.
if [ "\$(systemctl is-enabled linebot-backend 2>/dev/null)" = "enabled" ]; then
	sudo systemctl restart linebot-backend
	sleep 2
	sudo systemctl status linebot-backend --no-pager -l | head -10
else
	echo "skipped: linebot-backend is disabled on this host (Server 2 serves the API)."
	echo "         deploy the backend to Server 2 instead; this run published the frontend only."
fi
REMOTE_SCRIPT

echo
echo "==> Health check:"
curl -s -o /dev/null -w "  https://${DOMAIN}/  -> HTTP %{http_code}\n" "https://${DOMAIN}/" || true
curl -s -o /dev/null -w "  https://${DOMAIN}/api/health  -> HTTP %{http_code}\n" "https://${DOMAIN}/api/health" || true

echo
echo "Rollback if needed:"
echo "  ssh -i $SSH_KEY $VPS_HOST 'rm -rf ~/${APP_DIR} && mv ~/${APP_DIR}_old ~/${APP_DIR} && sudo systemctl restart linebot-backend'"
