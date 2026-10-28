#!/usr/bin/env bash
# Nightly Postgres dump for MailTapper on the GCP VM. Keeps 14 days in ~/mailtapper-backups.
# If ~/.mailtapper-offsite.env exists, also copies the dump to an S3-compatible bucket (Cloudflare R2, AWS S3).
# Installed in the grok user's crontab: 15 3 * * * ~/mailtapper/deploy/gcp/backup.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
dest="$HOME/mailtapper-backups"; mkdir -p "$dest"; chmod 700 "$dest"
file="mailtapper-$(date +%F).sql.gz"
docker compose exec -T db pg_dump -U mailtapper -d mailtapper | gzip > "$dest/$file"
find "$dest" -name 'mailtapper-*.sql.gz' -mtime +14 -delete

offsite="$HOME/.mailtapper-offsite.env"
[ -f "$offsite" ] || exit 0
# AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, BACKUP_S3_URI (s3://bucket/prefix/), optional AWS_DEFAULT_REGION
# and, for R2, BACKUP_S3_ENDPOINT (https://<account id>.r2.cloudflarestorage.com).
set -a; . "$offsite"; set +a
docker run --rm -v "$dest:/backups:ro" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}" \
  amazon/aws-cli:2.17.0 s3 cp "/backups/$file" "$BACKUP_S3_URI" ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} --only-show-errors
