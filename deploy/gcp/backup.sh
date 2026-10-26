#!/usr/bin/env bash
# Nightly Postgres dump for MailTapper on the GCP VM. Keeps 14 days in ~/mailtapper-backups.
# Installed in the grok user's crontab: 15 3 * * * ~/mailtapper/deploy/gcp/backup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
dest="$HOME/mailtapper-backups"; mkdir -p "$dest"; chmod 700 "$dest"
docker compose exec -T db pg_dump -U mailtapper -d mailtapper | gzip > "$dest/mailtapper-$(date +%F).sql.gz"
find "$dest" -name 'mailtapper-*.sql.gz' -mtime +14 -delete
