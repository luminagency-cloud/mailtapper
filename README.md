# Mailtapper

**An access layer for email.** Connect any IMAP/POP mailbox and read it as clean, unified JSON through one API — built for AI agents and automations, not humans.

> ⚠️ Early development. The API and spec are still being defined; not yet released.

## Docs

- **[Build spec](spec.html)** — the full v1 architecture, schema, and API surface.
- **[Roadmap](roadmap.html)** — committed v1 scope, what's deferred, and open decisions.
- **[Runbook](docs/RUNBOOK.md)** — run it end-to-end and wire luminmail as the first client.

## What it is

Mailtapper turns scattered email accounts into one clean, queryable API. Point it at a mailbox and your agents read that mail as normalized JSON — no raw IMAP, no MIME parsing, no per-provider quirks.

It's deliberately narrow: the long tail of **non-Gmail, non-Microsoft 365** mailboxes — the hosted/cPanel IMAP boxes (GoDaddy, 20i, Bluehost, Hostinger…) that other tools ignore because they're unglamorous to support. Gmail and M365 are already solved everywhere; Mailtapper is for everything else.

## What it is *not*

- **Not a mail client / inbox app** — there's no reading UI; it's infrastructure other tools call.
- **Not a store or archive of your mail** — the mailbox is the source of truth. Mailtapper fetches on demand and caches only briefly (seconds–minutes) for speed; the *caller* owns anything it keeps.
- **Not a sender** — v1 reads mail; it does not send.

## How it works

```
[ IMAP / POP mailboxes ] ──▶ [ Mailtapper API ] ──▶ [ your agent / automation ]
   cPanel, 20i, GoDaddy…        fetch + normalize        reads clean JSON
```

- **Control plane** — register a mailbox once (host, port, explicit TLS mode, username, password). Credentials are validated before saving and encrypted at rest.
- **Data plane** — query normalized mail (by account, sender, time window, unread, full-text) and get one unified JSON shape no matter the source.
- **Live fetch + thin cache** — read from the mailbox on demand; cache briefly for speed and to stay gentle on flaky hosts. Nothing is retained long-term.

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

Node + TypeScript · Fastify · ImapFlow · Postgres · Docker + Caddy.

## Status

**v1 (in progress):** IMAP, read-only, live fetch + thin cache, per-tenant API keys.

**Later:** POP3 · webhooks/push · attachment fetch · Microsoft 365 & Gmail (OAuth).
