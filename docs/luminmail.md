# Feeding luminmail from Mailtapper

luminmail reads its inbox through Mailtapper. To point a luminmail account at a Mailtapper mailbox:

```bash
cd ../luminmail
psql "$LUMINMAIL_DATABASE_URL" -f scripts/2026-06-add-mailtapper-connection-id.sql
psql "$LUMINMAIL_DATABASE_URL" -c \
  "update public.mail_accounts set mailtapper_connection_id='<connection id>' where email='you@yourdomain.com';"

# .env.local
MAILTAPPER_BASE_URL=https://mailtapper.luminagency.com   # or http://localhost:3000
MAILTAPPER_API_KEY=mtapper_live_...                      # needs messages:read
```

Then trigger luminmail's sync with `POST /api/messages/sync` and its cron secret. Locally, run luminmail on another port (`npm run dev -- -p 3001`), since both default to 3000.
