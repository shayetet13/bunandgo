#!/usr/bin/env bash
# DEPRECATED as of the 2026-08-04 AWS migration — this targets the retired
# Linode VPS (172.237.8.177). Use deploy-aws.sh instead, which targets the
# current production host (admin@3.112.61.130 / dakotabot.site). Kept only
# as a historical reference.
#
# Deploy the committed source to the Linode VPS: package -> upload -> build -> restart.
# Run from the project root: bash deploy.sh
set -euo pipefail

VPS_HOST="root@172.237.8.177"
SSH_KEY="$HOME/.ssh/linode_bot_deploy"

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
ssh -i "$SSH_KEY" "$VPS_HOST" bash -s <<'REMOTE_SCRIPT'
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/go/bin:$PATH"

rm -rf ~/app_new
mkdir ~/app_new
tar -xzf deploy.tar.gz -C ~/app_new
rm -f deploy.tar.gz

# Carry over secrets/data that never live in the git archive.
if [ -f ~/app/backend/.env ]; then
	cp ~/app/backend/.env ~/app_new/backend/.env
fi
if [ -d ~/app/backend/data ]; then
	cp -r ~/app/backend/data ~/app_new/backend/data
fi

rm -rf ~/app_old
if [ -d ~/app ]; then
	mv ~/app ~/app_old
fi
mv ~/app_new ~/app

echo "--- backend deps ---"
cd ~/app/backend
bun install

echo "--- frontend build ---"
cd ~/app/frontend
bun install
bun run build

echo "--- publishing frontend ---"
rm -rf /var/www/linebot/*
cp -r ~/app/frontend/dist/* /var/www/linebot/
chown -R www-data:www-data /var/www/linebot

echo "--- restarting backend service ---"
systemctl restart linebot-backend
sleep 2
systemctl status linebot-backend --no-pager -l | head -10
REMOTE_SCRIPT

echo
echo "==> Health check:"
curl -s -o /dev/null -w "  http://172.237.8.177/  -> HTTP %{http_code}\n" http://172.237.8.177/ || true

echo
echo "Rollback if needed:"
echo "  ssh -i $SSH_KEY $VPS_HOST 'rm -rf ~/app && mv ~/app_old ~/app && systemctl restart linebot-backend'"
