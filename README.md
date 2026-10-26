# Mailtapper

**An access layer for email.** Connect any IMAP/POP mailbox and read it as clean, unified JSON through one API — built for AI agents and automations, not humans.

> ⚠️ Early development. The API and spec are still being defined; not yet released.

## Docs

- **[Build spec](spec.html)** — the full v1 architecture, schema, and API surface.
- **[Roadmap](roadmap.html)** — committed v1 scope and the decision record. Future work is tracked in Linear (team LA, project Mailtapper).
- **[Runbook](docs/RUNBOOK.md)** — run it end-to-end and wire luminmail as the first client.

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
