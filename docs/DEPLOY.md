# Production VM

Mailtapper runs on Google Cloud: account luminagency@gmail.com, project `lumin-all`, VM `mailtapper` in `us-east1-b`. It's an always-free e2-micro (1 GB RAM plus a 2 GB swapfile, Debian 12). The free tier allows one e2-micro per billing account, so run other small apps on this VM rather than making a second one.

| | |
|---|---|
| URL | `https://mailtapper.luminagency.com` (health check: `/healthz`) |
| IP | `34.148.236.200`. Make it static in VPC network → IP addresses, or it can change when the VM stops. |
| Ports | 80 and 443 open, plus SSH. Postgres and the API port are internal only. |
| Mail | Outbound IMAP 993 and SMTP 587 work. Google blocks port 25. |

## SSH

Use the SSH button on the VM in the Cloud console, or `ssh grok@34.148.236.200` with a key added under the VM's Edit → SSH keys. Then `cd ~/mailtapper`.

## Layout

```
~/mailtapper/                    # copy of main, no git credentials
  .env                           # production secrets, chmod 600, never committed
  docker-compose.yml             # api + caddy
  deploy/gcp/compose.gcp.yml     # VM overlay: Postgres 16, memory caps, Caddy config
  deploy/gcp/Caddyfile           # the domain -> api:3000, automatic TLS
  deploy/gcp/backup.sh           # nightly database dump
~/mailtapper-backups/            # dumps, kept 14 days
```

`.env` sets `COMPOSE_FILE=docker-compose.yml:deploy/gcp/compose.gcp.yml` and `COMPOSE_PROJECT_NAME=mailtapper`, so a plain `docker compose` command uses the overlay. Its other keys: `MAILTAPPER_DOMAIN`, `POSTGRES_PASSWORD`, `DATABASE_URL` (host `db`), `MAILTAPPER_KEK_B64`, `MAILTAPPER_LOCATOR_SECRET`, `PORT=3000`, `PUBLIC_BASE_URL`, `LOG_LEVEL`, `CACHE_TTL_SECONDS`, `DEFAULT_TIER`, the three `SMTP_DEFAULT_*` values and `LOGIN_SENDER_CONNECTION_ID` (the mailbox that mails dashboard sign-in links).

Keep a copy of `MAILTAPPER_KEK_B64` in a password manager. Without it, the stored mailbox passwords can't be decrypted, from the live database or from a backup.

The stack restarts on its own after a reboot. Redeploying is in the README.

## Logs and backups

```bash
docker compose ps
docker compose logs -f api                 # or caddy, db
docker compose exec db psql -U mailtapper -d mailtapper -c 'SELECT * FROM error_events ORDER BY created_at DESC LIMIT 50;'
~/mailtapper/deploy/gcp/backup.sh          # manual dump; cron runs it nightly at 03:15 UTC
gunzip -c ~/mailtapper-backups/mailtapper-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U mailtapper -d mailtapper   # restore
```

Apply schema changes with the tools image and `drizzle-kit push` as described in the README before deploying the API. The `error_events` table records server errors and failed credential attempts without request bodies, query strings, email addresses, or keys. If Postgres is unavailable or the table has not been created, events cannot be persisted; check API logs for `could not persist error event`. Events are retained until an operator removes them.

To also copy each dump off the VM, create `~/.mailtapper-offsite.env` (chmod 600). Use a key that can only write to that bucket, and set a lifecycle rule on the bucket to expire old dumps.

```bash
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
BACKUP_S3_URI=s3://<bucket>/mailtapper/
BACKUP_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com   # Cloudflare R2; for AWS S3 leave this out and set AWS_DEFAULT_REGION
```

If the VM is lost, build a new one from this page, put the saved KEK in its `.env`, and restore the newest dump from the bucket.

## DNS

In Cloudflare (zone `luminagency.com`), `A mailtapper → 34.148.236.200` is DNS only, not proxied. It overrides the proxied `*.luminagency.com` wildcard so Caddy can get and renew its certificate, which needs ports 80 and 443 open.
