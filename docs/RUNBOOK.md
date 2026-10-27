# mailtapper — Runbook

End-to-end: run **mailtapper** and point **luminmail** at it so luminmail's inbox is fed live through the API.

Two services on one machine: **mailtapper on `:3000`**, **luminmail on `:3001`** (both default to 3000, so move one). Commands assume the two repos are cloned side by side.

## Prereqs

Node 20+, a Postgres URL for this machine (Neon is fine locally), your mailbox's IMAP credentials, plus `openssl` and `psql`. Production uses local Postgres 16 on the VM — see the README's [Hosting & deployment](../README.md#hosting--deployment).

> **`.env` auto-loads.** mailtapper bundles `dotenv`, so a `.env` in the repo root is picked up automatically by the server, the seed script, and drizzle-kit — no shell sourcing. (In Docker, env comes from `environment:` and dotenv simply no-ops.)

> **Heads-up — types.** `npm run dev` uses **tsx**, which transpiles without type-checking, so it **boots even if `npm run typecheck` still reports the minor ImapFlow type nits**. Run `npm run typecheck` separately to clean those up; it won't block booting.

> mailtapper needs outbound IMAP (port 993) and, to send, outbound SMTP (587 or 465) to your mail host. Fine locally and on the Google Cloud VM. The HTTPS caller does not.

---

## A. Run mailtapper

```bash
git clone https://github.com/luminagency-cloud/mailtapper && cd mailtapper
npm install

# secrets
cp .env.example .env
echo "MAILTAPPER_KEK_B64=$(openssl rand -base64 32)"        # paste into .env
echo "MAILTAPPER_LOCATOR_SECRET=$(openssl rand -base64 32)" # paste into .env
# then edit .env: DATABASE_URL=<your Postgres url>, PORT=3000

npm run db:push                   # create tables: connections, api_keys, tenants, tenant_keys
npm run seed -- "personal"        # prints your API key ONCE — copy it
#   → Tenant created: <uuid> (tier=pro)
#   → API key: mtapper_live_XXXXXXXX...

npm run dev                       # boots on :3000
```

Verify (new terminal):

```bash
curl -s localhost:3000/healthz
# {"ok":true,"service":"mailtapper","version":"0.4.0"}  # version comes from package.json
```

---

## B. Register your mailbox + first live fetch

```bash
KEY="mtapper_live_XXXXXXXX..."     # the seeded key

# Register the connection. mailtapper validates IMAP BEFORE saving, then encrypts the password.
curl -sS -X POST localhost:3000/v1/connections \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{
    "label":"Me",
    "host":"mail.yourhost.com","port":993,"tls_mode":"ssl","allow_invalid_cert":false,
    "username":"you@yourdomain.com","password":"<your-imap-password>",
    "source_account":"you@yourdomain.com","provider":"cpanel"
  }'
#   → {"id":"<CONNECTION_UUID>","status":"active",...}   ← grab CONNECTION_UUID
#   → 422 {"error":"Receive (IMAP): ...","side":"receive","field":"tls_mode","hint":"..."}  ← fix the named field
```

Pull mail live through the API:

```bash
curl -sS "localhost:3000/v1/messages?limit=5" -H "authorization: Bearer $KEY"
# {"data":[ {id, internal_id, from, subject, received_at, body_text, ...} ], "next_cursor":null}

# filters: &since=2026-06-14T00:00:00Z  &unread=true  &from=jane@x.com  &subject=invoice  &q=acme%20invoice  &connection_id=<CONNECTION_UUID>
# q = full text (subject, headers and body) via IMAP TEXT; best effort, depends on the mail server
# single message:
curl -sS "localhost:3000/v1/messages/<id-from-data>" -H "authorization: Bearer $KEY"
```

If that returns your real mail as clean JSON, **mailtapper works.**

---

## C. Point luminmail at mailtapper

```bash
cd ../luminmail

# 1) DB: add the link column, then point your account at the connection
psql "$LUMINMAIL_DATABASE_URL" -f scripts/2026-06-add-mailtapper-connection-id.sql
psql "$LUMINMAIL_DATABASE_URL" -c \
  "update public.mail_accounts set mailtapper_connection_id='<CONNECTION_UUID>' where email='you@yourdomain.com';"

# 2) env: tell luminmail where mailtapper is + the key
cat >> .env.local <<'EOF'
MAILTAPPER_BASE_URL=http://localhost:3000
MAILTAPPER_API_KEY=mtapper_live_XXXXXXXX...
EOF

# 3) start luminmail on a different port (mailtapper owns 3000)
npm run dev -- -p 3001
```

Trigger the sync (luminmail's existing cron route — unchanged; it now fetches via mailtapper):

```bash
curl -sS -X POST localhost:3001/api/messages/sync \
  -H "authorization: Bearer $LUMINMAIL_CRON_SECRET"
# {"ok":true,"synced":1,"failed":[]}
```

Open **localhost:3001**, view the inbox — now populated with mail pulled **through mailtapper**. Dogfood loop closed.

---

## D. Production (Google Cloud VM)

Production runs on the always-free Google Cloud e2-micro VM `mailtapper` (project `lumin-all`, us-east1-b), with Docker Compose, a local Postgres and Caddy. Everything about it is in the README's **[Hosting & deployment](../README.md#hosting--deployment)** section: SSH, `.env`, redeploy, migrations, backups and domain. On the VM, `luminmail`'s `MAILTAPPER_BASE_URL` is `https://mailtapper.luminagency.com`.

- No new database columns for send/mark-read (smtp_* and send_enabled already exist).
- The VM allows outbound SMTP 587 (Google blocks only 25). `SMTP_DEFAULT_*` in `.env` points at `smtp.luminagency.com:587` STARTTLS.
- Keys need messages:send and messages:write, or admin.

---

## E. Sending (SMTP) and mark-read

Each connection carries its own SMTP settings. Host, port, and TLS fall back to `SMTP_DEFAULT_HOST`, `SMTP_DEFAULT_PORT`, and `SMTP_DEFAULT_TLS_MODE` when omitted. Username and password fall back to the IMAP login. Nothing is hard-coded.

`POST /v1/connections/:id/send` needs scope `messages:send` (or `admin`). `POST /v1/messages/read` needs `messages:write` (or `admin`). A read-only `messages:read` key cannot do either. Re-issue a key with those scopes if the one you have is read-only:

```bash
npx tsx src/scripts/issue-key.ts messages:read,messages:send,messages:write <tenantId>
```

```bash
npm run db:push    # adds the smtp_* / send_enabled / from_name columns (all nullable or default false)
```

Enable sending on an existing connection. Omitted SMTP host/port/TLS fall back to `SMTP_DEFAULT_*`
(StackMail: `smtp.stackmail.com:587`, STARTTLS); omitted SMTP username/password fall back to the IMAP login.
mailtapper logs in to SMTP (no message sent) before saving and returns 422 `smtp_validation_failed` if it can't.

```bash
curl -sS -X PATCH localhost:3000/v1/connections/<CONNECTION_UUID> \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"send_enabled":true,"from_name":"Newport Chess Club"}'
#   → {..., "send_enabled":true, "smtp_host":"smtp.stackmail.com", "smtp_port":587, "smtp_tls_mode":"starttls", ...}

# Re-check the SMTP login any time (nothing is sent):
curl -sS -X POST localhost:3000/v1/connections/<CONNECTION_UUID>/test-smtp -H "authorization: Bearer $KEY"
#   → {"ok":true,"message":"SMTP login succeeded.","smtp":{"host":"smtp.stackmail.com","port":587,...}}

# Send. Use the mailbox's own host when it is not the StackMail default, for example
# "smtp_host":"smtp.yourdomain.com","smtp_port":587,"smtp_tls_mode":"starttls".
curl -sS -X POST localhost:3000/v1/connections/<CONNECTION_UUID>/send \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"to":["someone@example.com"],"subject":"Hello","text":"Sent through mailtapper."}'
#   → {"ok":true,"message_id":"<…>","accepted":["someone@example.com"],"saved_to_sent":true,...}

# Mark messages read (or unread with "read": false). Ids come from GET /v1/messages.
curl -sS -X POST localhost:3000/v1/messages/read \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"ids":["<id-from-data>"],"read":true}'
#   → {"read":true,"updated":["<id-from-data>"],"failed":[]}
```

Separate SMTP login: pass `smtp_username` / `smtp_password` (send `null` to fall back to the IMAP login again).
The dashboard's mailbox form has the same fields under "Sending (SMTP)", plus a "test SMTP" button per row.
Sending appends a copy to the Sent folder when the server exposes one. `saved_to_sent: false` means the SMTP send succeeded and the copy did not.

## Gotchas recap

- `.env` auto-loads via dotenv — no shell sourcing needed.
- Ports: mailtapper `:3000`, luminmail `:3001`.
- `npm run dev` runs despite the known type nits (tsx transpiles without type-checking).
- luminmail's own compose/reply buttons stay inert until luminmail calls `POST /v1/connections/:id/send` and `POST /v1/messages/read`. Mailtapper itself can send and mark read.
- mailtapper must be network-reachable from luminmail (localhost is fine on one machine; otherwise use the deployed URL).
