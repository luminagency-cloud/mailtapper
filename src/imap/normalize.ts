import { createHash } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";
import { convert as htmlToText } from "html-to-text";
import { encodeLocator } from "./locator.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface NormalizeCtx {
  connectionId: string;
  sourceAccount: string;
  provider: string;
  folder: string;
  uid: number;
  uidValidity: number;
  isUnread: boolean;
}

interface Addr {
  name: string | null;
  email: string | null;
}

function addrs(a?: AddressObject | AddressObject[]): Addr[] {
  if (!a) return [];
  const groups = Array.isArray(a) ? a : [a];
  return groups.flatMap((g) => (g.value ?? []).map((v) => ({ name: v.name || null, email: v.address || null })));
}

/**
 * Stable, folder- and UID-independent content hash. Same message re-fetched or moved
 * between folders -> same id. Same message in two connections -> two ids (two deliveries).
 */
export function computeInternalId(
  connectionId: string,
  m: { messageId?: string | null; fromEmail?: string | null; receivedAt: Date; subject?: string | null; bodyText: string },
): string {
  const canonical = m.messageId?.trim()
    ? `mid:${m.messageId.trim().toLowerCase()}`
    : `fp:${sha256(`${m.fromEmail ?? ""}\n${m.receivedAt.toISOString()}\n${m.subject ?? ""}\n${sha256(m.bodyText)}`)}`;
  return sha256(`${connectionId}\n${canonical}`);
}

/** Raw RFC-822 source -> the unified message contract. */
export async function normalizeMessage(rawSource: Buffer, ctx: NormalizeCtx) {
  const p = await simpleParser(rawSource);

  // Body: prefer the plain-text part; else strip HTML. Raw HTML never lands in body_text.
  const bodyText = p.text?.trim() ? p.text : p.html ? htmlToText(p.html, { wordwrap: false }) : "";

  const receivedAt = p.date ?? new Date();
  const from = addrs(p.from)[0] ?? { name: null, email: null };
  const attachments = (p.attachments ?? []).map((a) => ({
    filename: a.filename ?? null,
    content_type: a.contentType ?? null,
    size_bytes: a.size ?? null,
  }));
  const messageId = p.messageId ?? null;

  return {
    id: encodeLocator({ connectionId: ctx.connectionId, folder: ctx.folder, uid: ctx.uid, uidValidity: ctx.uidValidity }),
    internal_id: computeInternalId(ctx.connectionId, { messageId, fromEmail: from.email, receivedAt, subject: p.subject, bodyText }),
    connection_id: ctx.connectionId,
    source_account: ctx.sourceAccount,
    provider: ctx.provider,
    folder: ctx.folder,
    message_id: messageId,
    thread_id: deriveThreadId(p.inReplyTo, p.references, p.subject),
    from,
    to: addrs(p.to),
    cc: addrs(p.cc),
    subject: p.subject ?? null,
    received_at: receivedAt.toISOString(),
    body_text: bodyText,
    has_attachments: attachments.length > 0,
    attachment_count: attachments.length,
    attachments,
    is_unread: ctx.isUnread,
    size_bytes: rawSource.length,
  };
}

export type UnifiedMessage = Awaited<ReturnType<typeof normalizeMessage>>;

function deriveThreadId(inReplyTo?: string, references?: string | string[], subject?: string): string {
  const refs = Array.isArray(references) ? references : references ? [references] : [];
  const root = refs[0] ?? inReplyTo;
  if (root) return `mid:${root.trim().toLowerCase()}`;
  const norm = (subject ?? "").replace(/^(re|fwd?):\s*/i, "").trim().toLowerCase();
  return norm ? `subj:${sha256(norm)}` : "none";
}
