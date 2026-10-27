# Mailtapper

**An access layer for email.** Connect any IMAP/POP mailbox and read it as clean, unified JSON through one API — built for AI agents and automations, not humans.

> ⚠️ Early development. The API and spec are still being defined; not yet released.

## Docs

- **[Build spec](spec.html)** — the full v1 architecture, schema, and API surface.
- **[Roadmap](roadmap.html)** — committed v1 scope and the decision record. Future work is tracked in Linear (team LA, project Mailtapper).
- **[Runbook](docs/RUNBOOK.md)** — run it end-to-end and wire luminmail as the first client.
- **[Hosting & deployment](#hosting--deployment)** — where production runs (Google Cloud e2-micro) and how to update it.

## What it is

Mailtapper turns scattered email accounts into one clean, queryable API. Point it at a mailbox and your agents read that mail as normalized JSON — no raw IMAP, no MIME parsing, no per-provider quirks. The same API can send as that mailbox and write the read/unread flag back, so a caller that cannot open SMTP or IMAP ports can still do both over HTTPS.

It's deliberately narrow: the long tail of **non-Gmail, non-Microsoft 365** mailboxes — the hosted/cPanel IMAP boxes (GoDaddy, 20i, Bluehost, Hostinger…) that other tools ignore because they're unglamorous to support. Gmail and M365 are already solved everywhere; Mailtapper is for everything else.

## What it is *not*

- **Not a mail client / inbox app** — there's no reading UI; it's infrastructure other tools call.
- **Not a store or archive of your mail** — the mailbox is the source of truth. Mailtapper fetches on demand and caches only briefly (seconds–minutes) for speed; the *caller* owns anything it keeps.

## How it works

```
[ IMAP / POP mailboxes ] ──▶ [ Mailtapper API ] ──▶ [ your agent / automation ]
   cPanel, 20i, GoDaddy…        fetch + normalize        reads clean JSON
```

- **Control plane** — register a mailbox once (host, port, explicit TLS mode, username, password). Credentials are validated before saving and encrypted at rest.
- **Data plane** — query normalized mail (by account, sender, time window, unread, full-text) and get one unified JSON shape no matter the source.
- **Send + mark-read** — deliver mail through the mailbox's SMTP settings, and write the IMAP `\Seen` flag back for one or more messages.
- **Live fetch + thin cache** — read from the mailbox on demand; cache briefly for speed and to stay gentle on flaky hosts. Nothing is retained long-term. A mark-read drops that tenant's cache so the next read sees the new flag.

## Unified message (shape)

```json
{
  "id": "opaque-locator",
  "internal_id": "…",
  "source_account": "you@yourdomain.com",
  "provider": "imap_generic",
  "from": { "name": "Jane", "email": "jane@example.com" },
  "subject": "Project update",
  "received_at": "2026-06-21T11:30:00Z",
  "body_text": "Clean, HTML-stripped text…",
  "has_attachments": true
}
```

## Security posture

Mailtapper holds mailbox **credentials**, not mailbox **contents**. Secrets are encrypted at rest (AES-256-GCM, envelope-encrypted with per-tenant keys); mail is fetched live, not stored. Access is via per-tenant API keys.

## Stack

Node + TypeScript · Fastify · ImapFlow · Nodemailer · Postgres · Docker + Caddy.

## Hosting & deployment

**Where it runs:** Google Cloud, Google account **luminagency@gmail.com**, project **lumin-all**, VM **`mailtapper`** in zone **us-east1-b**. It's an **e2-micro** (2 shared vCPU, 1 GB RAM + 2 GB swapfile), Debian 12, 30 GB standard disk, on the **always-free tier**. Set up 2026-10-26. It replaced the Oracle Cloud plan, which was dropped as too fiddly. Render, Koyeb and similar hosts were skipped because free plans sleep or have a cold start.

| | |
|---|---|
| Public URL | `https://mailtapper.luminagency.com` |
| Health check | `GET /healthz` → `{"ok":true,...}` |
| External IP | `34.148.236.200` (internal `10.142.0.2`). Make it a **static** IP in VPC network → IP addresses, or it can change if the VM is stopped. |
| Open ports | 80/443 only (GCP firewall `default-allow-http` / `default-allow-https`, plus SSH 22). Postgres and the API port 3000 are not published. |
| Outbound | IMAP 993 and SMTP 587 to `*.luminagency.com` (StackMail) work. Google blocks outbound 25, so never use port 25. |

**Free-tier note:** the free allowance is **one e2-micro per billing account**, not per project. Don't create a second free VM. Run other small apps on this VM as extra compose stacks behind the same Caddy, or add a site block to a shared Caddy. Billing is attached, so anything beyond the free limits (a bigger VM, a second VM, premium network egress over 1 GB/month) is charged. Setting a budget alert on the billing account is a good idea.

### Layout on the VM

```
/home/grok/mailtapper/            # this repo (plain copy of main, no git creds on the VM)
  .env                            # production secrets, chmod 600, NEVER committed
  docker-compose.yml              # base: api + caddy
  deploy/gcp/compose.gcp.yml      # VM overlay: local Postgres 16, memory caps, Caddy config
  deploy/gcp/Caddyfile            # {$MAILTAPPER_DOMAIN} -> api:3000, automatic Let's Encrypt TLS
  deploy/gcp/backup.sh            # nightly pg_dump
/home/grok/mailtapper-backups/    # mailtapper-YYYY-MM-DD.sql.gz, kept 14 days
```

`.env` sets `COMPOSE_FILE=docker-compose.yml:deploy/gcp/compose.gcp.yml` and `COMPOSE_PROJECT_NAME=mailtapper`, so a plain `docker compose ...` in `~/mailtapper` uses the overlay. Services are `api` (Node, 384 MB cap), `db` (postgres:16-alpine, 256 MB cap, volume `mailtapper_pg_data`) and `caddy` (128 MB cap, certs in volume `mailtapper_caddy_data`). All are `restart: unless-stopped` and Docker is enabled at boot, so the stack comes back on reboot (tested). Unattended security upgrades are on.

`.env` keys: `COMPOSE_FILE`, `COMPOSE_PROJECT_NAME`, `MAILTAPPER_DOMAIN=mailtapper.luminagency.com`, `POSTGRES_PASSWORD`, `DATABASE_URL` (`postgres://mailtapper:…@db:5432/mailtapper?sslmode=disable`), `MAILTAPPER_KEK_B64`, `MAILTAPPER_LOCATOR_SECRET`, `PORT=3000`, `PUBLIC_BASE_URL=https://mailtapper.luminagency.com/`, `LOG_LEVEL`, `CACHE_TTL_SECONDS`, `DEFAULT_TIER`, `SMTP_DEFAULT_HOST=smtp.luminagency.com`, `SMTP_DEFAULT_PORT=587`, `SMTP_DEFAULT_TLS_MODE=starttls`. Secrets were generated on the VM with `openssl rand`.

> **Back up `MAILTAPPER_KEK_B64`** (for example in a password manager). If it's lost, every stored mailbox password becomes unreadable, and the database backups can't be decrypted either.

### SSH

- Easiest: Google Cloud console → Compute Engine → VM instances → `mailtapper` → **SSH** button (browser SSH, no keys needed).
- From a terminal: `ssh grok@34.148.236.200`, using a key listed in the VM's metadata (Edit → SSH keys). To add your own, paste your public key there.
- Then run `cd ~/mailtapper`. The `grok` user is in the `docker` group.

### Redeploy / update

The VM has no GitHub credentials. Copy a fresh tree from a machine that can read the private repo:

```bash
# on a machine with repo access
git clone --depth 1 https://github.com/luminagency-cloud/mailtapper /tmp/mt && cd /tmp/mt
tar --exclude .git -czf /tmp/mt.tgz . && scp /tmp/mt.tgz grok@34.148.236.200:/tmp/
# on the VM
cd ~/mailtapper && tar -xzf /tmp/mt.tgz -C ~/mailtapper   # .env is not in the tarball, so it is kept
docker compose up -d --build                              # ~5 min on the e2-micro
```

Another option is a read-only GitHub deploy key on the VM, then `git pull` there.

**Schema changes (drizzle):** the runtime image has no dev deps, so use the build stage:

```bash
docker build --target build -t mailtapper-tools .
docker run --rm --network mailtapper_default --env-file .env mailtapper-tools npx drizzle-kit push
```

The `npm run db:push / seed / issue-key` scripts wrap `doppler`, which isn't used on the VM. Call the tools directly as above, for example `... mailtapper-tools npx tsx src/scripts/issue-key.ts messages:read,messages:send,messages:write`.

### Logs, backups, restore

```bash
docker compose ps
docker compose logs -f api        # or caddy / db
~/mailtapper/deploy/gcp/backup.sh # manual dump; cron runs it nightly at 03:15 VM time (UTC)
gunzip -c ~/mailtapper-backups/mailtapper-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U mailtapper -d mailtapper   # restore
```

Backups stay on the VM's own disk. Copy them off now and then, together with the KEK, if the data matters.

### Domain / TLS

Public URL is `https://mailtapper.luminagency.com`. Cloudflare (zone `luminagency.com`) has `A mailtapper → 34.148.236.200`, **DNS only** (not proxied). That overrides the proxied `*.luminagency.com` wildcard so Caddy can obtain the certificate. On the VM, `.env` sets `MAILTAPPER_DOMAIN=mailtapper.luminagency.com` and `PUBLIC_BASE_URL=https://mailtapper.luminagency.com/`. Caddy serves that name and renews the Let's Encrypt certificate itself (ports 80 and 443 must stay open).

## Sending and mark-read

Both routes use the same Bearer API key as the read endpoints. A key needs `messages:send` to send and `messages:write` to mark read or unread (`admin` includes both). A `messages:read` key cannot do either. Unauthenticated calls are rejected.

SMTP is never hard-coded. Host, port, and TLS mode come from the connection, and fall back to `SMTP_DEFAULT_HOST`, `SMTP_DEFAULT_PORT`, and `SMTP_DEFAULT_TLS_MODE`. The SMTP username and password come from the connection (encrypted at rest), and fall back to the IMAP login. The mailbox must have `send_enabled` set.

```bash
# Send as a mailbox. `text` and/or `html` is required.
curl -sS -X POST localhost:3000/v1/connections/<CONNECTION_UUID>/send \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{
    "to": ["jane@example.com"],
    "cc": ["boss@example.com"],
    "bcc": ["archive@example.com"],
    "subject": "Re: Project update",
    "text": "Plain text body",
    "html": "<p>HTML body</p>",
    "reply_to": "you@yourdomain.com",
    "in_reply_to": "<original-id@mail.example>",
    "references": ["<root-id@mail.example>", "<original-id@mail.example>"]
  }'
# → {"ok":true,"connection_id":"…","message_id":"<…@yourdomain.com>","accepted":[…],"rejected":[],"saved_to_sent":true,"sent_folder":"Sent","sent_error":null}

# Mark one or more messages read. "read": false clears \Seen (marks unread).
curl -sS -X POST localhost:3000/v1/messages/read \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"ids":["<id-from-GET-/v1/messages>"],"read":true}'
# → {"read":true,"updated":["…"],"failed":[]}
```

Limits: 50 recipients, 1 MiB combined text+html, 100 ids per mark-read call. Header fields reject CR/LF. A successful send appends the same bytes to the IMAP Sent folder when the server has one (`\Sent`, or a folder named Sent). If that copy fails, the send result is still success and `saved_to_sent` is false.

## Status

**v1 (in progress):** IMAP read, SMTP send, mark-read write-back, live fetch + thin cache, per-tenant API keys.

**Later:** POP3 · webhooks/push · attachment fetch · Microsoft 365 & Gmail (OAuth).
