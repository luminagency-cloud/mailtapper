# Mailtapper

Mailtapper lets AI agents read and send mail from ordinary IMAP/SMTP mailboxes, the kind on 20i, cPanel or GoDaddy hosting. Gmail and Microsoft 365 are out of scope, since agents already reach those directly.

It stores mailbox logins, encrypted, and never the mail itself. Mail is fetched live when an agent asks for it and cached for about a minute. Nothing runs in the background.

Production: `https://mailtapper.luminagency.com`. Work in progress is tracked in Linear (team LA, project Mailtapper).

## Run it locally

Needs Node 20+ and Docker.

```bash
npm install
cp .env.example .env
# set MAILTAPPER_KEK_B64 and MAILTAPPER_LOCATOR_SECRET in .env, each to: openssl rand -base64 32
docker run -d --name mailtapper-dev-pg -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine
npm run db:push               # create the tables
npm run seed -- "personal"    # prints an admin API key once; save it
npm run dev                   # http://localhost:3000
```

`.env` loads automatically. `npm test` runs the test suite with no network or database.

## Add a mailbox

Open the dashboard at `/`, paste your API key in the top bar and save. Under **Mailboxes**, add the mailbox's IMAP host, port, TLS mode, username and password. Tick **Enable sending** to let agents send from it, and set a From name.

Mailtapper logs in to IMAP, and to SMTP when sending is on, before it saves. If a login fails, the form names the setting to fix. SMTP settings you leave blank fall back to the `SMTP_DEFAULT_*` values in `.env`, and the SMTP login falls back to the IMAP login.

## Connect Claude Code

`POST /mcp` is an MCP server with two tools:

- `list_mailboxes`: each mailbox's From address, label and whether sending is on
- `send_email`: send from a mailbox, picked by id, address or label, with a copy saved to its Sent folder

Issue a key that can list and send, then add the server in Claude Code:

```bash
npm run issue-key -- connections:read,messages:send            # add the tenant id if you have more than one
claude mcp add --transport http mailtapper https://mailtapper.luminagency.com/mcp \
  --header "Authorization: Bearer mtapper_live_..."
```

On the production VM, run `issue-key` through the tools image (see [Deploy](#deploy)). claude.ai connectors need OAuth, which Mailtapper doesn't support yet, so for now this works from Claude Code and other clients that can send a header.

## API

Every route except `/healthz` and the dashboard needs `Authorization: Bearer <key>`.

| Route | Scope | What it does |
|---|---|---|
| `GET /v1/connections`, `/v1/connections/:id` | `connections:read` | List mailboxes, or get one |
| `POST /v1/connections` | `connections:write` | Add a mailbox (logins are checked first) |
| `PATCH` / `DELETE /v1/connections/:id` | `connections:write` | Change or remove a mailbox |
| `POST /v1/connections/:id/test`, `/test-smtp` | `connections:read` | Re-check the IMAP or SMTP login |
| `GET /v1/messages` | `messages:read` | Newest mail. Filters: `connection_id`, `since`, `from`, `subject`, `unread=true`, `q` (full text), `limit`, `cursor` |
| `GET /v1/messages/:id` | `messages:read` | One message |
| `GET /v1/messages/:id/attachments/:index` | `messages:read` | One attachment's raw bytes |
| `POST /v1/connections/:id/send` | `messages:send` | Send. Body: `to`, `cc`, `bcc`, `subject`, `text` and/or `html`, `reply_to`, `in_reply_to`, `references` |
| `POST /v1/messages/read` | `messages:write` | Mark messages read, or unread with `"read": false` |
| `POST /mcp` | per tool | The MCP tools above |

An `admin` key covers every scope and also manages accounts under `/v1/admin/clients`. Limits per send: 50 recipients and 1 MiB of body text. If the Sent copy fails, the send still counts and `saved_to_sent` is `false`.

```bash
curl -sS -X POST https://mailtapper.luminagency.com/v1/connections/<id>/send \
  -H "authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"to":["jane@example.com"],"subject":"Hello","text":"Sent through Mailtapper."}'
```

`npm run test:roundtrip` sends real mail between two mailboxes and checks that each one arrives. It needs `MAILTAPPER_API_KEY` set to a key with `connections:read`, `messages:read` and `messages:send`.

## Deploy

Production is a Docker Compose stack (API, Postgres 16, Caddy) on an always-free Google Cloud VM. The VM has no GitHub access, so copy the code over and rebuild:

```bash
# on a machine that can read the repo
git clone --depth 1 https://github.com/luminagency-cloud/mailtapper /tmp/mt && cd /tmp/mt
tar --exclude .git -czf /tmp/mt.tgz . && scp /tmp/mt.tgz grok@34.148.236.200:/tmp/

# on the VM
cd ~/mailtapper && tar -xzf /tmp/mt.tgz -C ~/mailtapper   # keeps the VM's .env
docker compose up -d --build
```

The running image has no dev tools. For schema changes and scripts, build the tools image and run them through it:

```bash
docker build --target build -t mailtapper-tools .
docker run --rm --network mailtapper_default --env-file .env mailtapper-tools npx drizzle-kit push
docker run --rm --network mailtapper_default --env-file .env mailtapper-tools npx tsx src/scripts/issue-key.ts connections:read,messages:send
```

SSH access, the VM's `.env`, backups, restore and DNS are in [docs/DEPLOY.md](docs/DEPLOY.md). Back up `MAILTAPPER_KEK_B64` somewhere safe. Without it, no stored mailbox password can be decrypted, even from a backup.
