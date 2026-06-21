# mailtapper — Runbook

End-to-end: run **mailtapper** and point **luminmail** at it so luminmail's inbox is fed live through the API.

Two services on one machine: **mailtapper on `:3000`**, **luminmail on `:3001`** (both default to 3000, so move one). Commands assume the two repos are cloned side by side.

## Prereqs

Node 20+, a Postgres URL (your Neon string), your mailbox's IMAP credentials, plus `openssl` and `psql`.

> **`.env` auto-loads.** mailtapper bundles `dotenv`, so a `.env` in the repo root is picked up automatically by the server, the seed script, and drizzle-kit — no shell sourcing. (In Docker, env comes from `environment:` and dotenv simply no-ops.)

> **Heads-up — types.** `npm run dev` uses **tsx**, which transpiles without type-checking, so it **boots even if `npm run typecheck` still reports the minor ImapFlow type nits**. Run `npm run typecheck` separately to clean those up; it won't block booting.

> mailtapper needs outbound IMAP (port 993) to your mail host. Fine locally and on the Ubuntu box.

---

## A. Run mailtapper

```bash
git clone https://github.com/luminagency-cloud/mailtapper && cd mailtapper
npm install

# secrets
cp .env.example .env
echo "MAILTAPPER_KEK_B64=$(openssl rand -base64 32)"        # paste into .env
echo "MAILTAPPER_LOCATOR_SECRET=$(openssl rand -base64 32)" # paste into .env
# then edit .env: DATABASE_URL=<your Neon url>, PORT=3000

npm run db:push                   # create tables: connections, api_keys, tenants, tenant_keys
npm run seed -- "personal"        # prints your API key ONCE — copy it
#   → Tenant created: <uuid> (tier=pro)
#   → API key: mtapper_live_XXXXXXXX...

npm run dev                       # boots on :3000
```

Verify (new terminal):

```bash
curl -s localhost:3000/healthz
# {"ok":true,"service":"mailtapper","version":"0.1.0"}
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
#   → 422 {"error":"Authentication failed..."}  ← fix host/port/tls_mode/creds
```

Pull mail live through the API:

```bash
curl -sS "localhost:3000/v1/messages?limit=5" -H "authorization: Bearer $KEY"
# {"data":[ {id, internal_id, from, subject, received_at, body_text, ...} ], "next_cursor":null}

# filters: &since=2026-06-14T00:00:00Z  &unread=true  &from=jane@x.com  &connection_id=<CONNECTION_UUID>
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

## D. Production (Ubuntu box)

```bash
# on the box, in mailtapper/ with .env filled:
docker compose up -d --build      # api + caddy; point the Caddyfile at your domain
# luminmail's MAILTAPPER_BASE_URL then becomes https://api.yourdomain.com
```

---

## Gotchas recap

- `.env` auto-loads via dotenv — no shell sourcing needed.
- Ports: mailtapper `:3000`, luminmail `:3001`.
- `npm run dev` runs despite the known type nits (tsx transpiles without type-checking).
- In luminmail, `delete`/`reply`/`compose` are inert now — v1 mailtapper is read-only, which is expected for the dogfood.
- mailtapper must be network-reachable from luminmail (localhost is fine on one machine; otherwise use the deployed URL).
