import { randomUUID } from "node:crypto";
import { z } from "zod";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { badRequest, forbidden } from "../util.js";
import { buildTransport, type SmtpCfg } from "./validator.js";

/** Caps for one send. The HTTP route also raises its body limit to fit JSON overhead. */
export const MAX_RECIPIENTS = 50;
export const MAX_SUBJECT_CHARS = 998;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_RAW_BYTES = 2 * 1024 * 1024;
export const MAX_REFERENCES = 50;
export const SEND_ROUTE_BODY_LIMIT = 3 * 1024 * 1024;

export interface Recipient {
  email: string;
  name?: string;
}

export interface SendInput {
  to: Recipient[];
  cc: Recipient[];
  bcc: Recipient[];
  replyTo: Recipient[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references: string[];
}

export interface OutboundTransport {
  sendMail(mail: {
    raw?: Buffer | string;
    envelope?: { from?: string; to?: string[] };
  }): Promise<{
    messageId?: string;
    accepted?: Array<string | { address: string }>;
    rejected?: Array<string | { address: string }>;
    response?: string;
  }>;
  close(): void;
}

export interface Delivery {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
  raw: Buffer;
}

const singleLine = (max: number) =>
  z.string().max(max).refine((value) => !/[\r\n\0]/.test(value), "Must be a single line");

const email = z.string().trim().max(320).email();

const recipient = z.union([
  email.transform((address) => ({ email: address })),
  z
    .object({
      email,
      name: z.string().trim().max(200).optional(),
    })
    .superRefine((value, ctx) => {
      if (value.name !== undefined && /[\r\n\0]/.test(value.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Name must be a single line", path: ["name"] });
      }
    }),
]);

const recipientList = z.union([recipient, z.array(recipient)]).transform((value) => (Array.isArray(value) ? value : [value]));

function tryMessageId(raw: string): { ok: true; id: string } | { ok: false; message: string } {
  if (/[\r\n\0]/.test(raw)) return { ok: false, message: "Message id must be a single line" };
  const inner = raw.trim().replace(/^<|>$/g, "");
  if (!inner || /[\s<>]/.test(inner)) return { ok: false, message: "Invalid message id" };
  return { ok: true, id: `<${inner}>` };
}

function referenceTokens(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return value.split(/\s+/).filter(Boolean);
}

function normalizeIds(tokens: string[], ctx: z.RefinementCtx, path: string): string[] | undefined {
  if (tokens.length > MAX_REFERENCES) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Too many references (max ${MAX_REFERENCES})`, path: [path] });
    return undefined;
  }
  const ids: string[] = [];
  for (const token of tokens) {
    const parsed = tryMessageId(token);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.message, path: [path] });
      return undefined;
    }
    ids.push(parsed.id);
  }
  return ids;
}

const sendBodySchema = z
  .object({
    to: recipientList,
    cc: recipientList.optional(),
    bcc: recipientList.optional(),
    subject: singleLine(MAX_SUBJECT_CHARS),
    text: z.string().optional(),
    html: z.string().optional(),
    reply_to: recipientList.optional(),
    in_reply_to: z.string().max(998).optional(),
    references: z.union([z.string().max(50_000), z.array(z.string().max(998)).max(MAX_REFERENCES)]).optional(),
  })
  .superRefine((body, ctx) => {
    const recipients = body.to.length + (body.cc?.length ?? 0) + (body.bcc?.length ?? 0);
    if (recipients < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one recipient is required", path: ["to"] });
    }
    if (recipients > MAX_RECIPIENTS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Too many recipients (max ${MAX_RECIPIENTS})`, path: ["to"] });
    }
    const text = body.text ?? "";
    const html = body.html ?? "";
    if (!text.trim() && !html.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide a text and/or html body", path: ["text"] });
    }
    const bytes = Buffer.byteLength(text, "utf8") + Buffer.byteLength(html, "utf8");
    if (bytes > MAX_BODY_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Message body exceeds ${MAX_BODY_BYTES} bytes`,
        path: ["text"],
      });
    }
    if (body.in_reply_to !== undefined) normalizeIds([body.in_reply_to], ctx, "in_reply_to");
    normalizeIds(referenceTokens(body.references), ctx, "references");
  })
  .transform((body): SendInput => {
    const inReplyTo = body.in_reply_to === undefined ? undefined : tryMessageId(body.in_reply_to);
    const references = referenceTokens(body.references).map((token) => {
      const parsed = tryMessageId(token);
      if (!parsed.ok) throw new Error(parsed.message);
      return parsed.id;
    });
    return {
      to: cleanRecipients(body.to),
      cc: cleanRecipients(body.cc ?? []),
      bcc: cleanRecipients(body.bcc ?? []),
      replyTo: cleanRecipients(body.reply_to ?? []),
      subject: body.subject,
      text: body.text && body.text.trim() ? body.text : undefined,
      html: body.html && body.html.trim() ? body.html : undefined,
      inReplyTo: inReplyTo && inReplyTo.ok ? inReplyTo.id : undefined,
      references,
    };
  });

export function parseSendBody(input: unknown): SendInput {
  return sendBodySchema.parse(input);
}

/** From address for a mailbox: the account identity, else the SMTP login, else the IMAP login. */
export function mailboxFromAddress(connection: {
  sourceAccount: string;
  smtpUsername: string | null;
  username: string;
}): string {
  for (const candidate of [connection.sourceAccount, connection.smtpUsername, connection.username]) {
    if (candidate && email.safeParse(candidate).success) return candidate;
  }
  throw badRequest("This mailbox has no usable From address. Set source_account to an email address.");
}

export function assertSendable(connection: { sendEnabled: boolean; status: string }): void {
  if (connection.status === "paused") throw forbidden("Connection is paused");
  if (!connection.sendEnabled) {
    throw forbidden("Sending is not enabled for this mailbox. Set send_enabled after SMTP settings validate.");
  }
}

/**
 * Compose one RFC822 message and hand it to SMTP exactly once.
 * Callers inject `createTransport` in tests. There is no retry: a second attempt can deliver twice.
 * BCC stays in the SMTP envelope and is left out of the headers other recipients see.
 */
export async function deliverMail(
  cfg: SmtpCfg,
  password: string,
  message: SendInput & { from: { name?: string | null; address: string }; messageId?: string },
  deps?: { createTransport?: (cfg: SmtpCfg, password: string) => OutboundTransport },
): Promise<Delivery> {
  const fromName = message.from.name ? sanitizeDisplayName(message.from.name) : "";
  const safe: typeof message = {
    ...message,
    from: { address: message.from.address, name: fromName || null },
  };
  assertHeaderSafe(safe);
  const domain = safe.from.address.split("@")[1];
  if (!domain) throw badRequest("From address is not an email");
  const messageId = safe.messageId ?? `<${randomUUID()}@${domain}>`;
  const idCheck = tryMessageId(messageId);
  if (!idCheck.ok) throw badRequest(idCheck.message);

  const composer = new MailComposer({
    from: toAddress({ email: safe.from.address, name: safe.from.name ?? undefined }),
    to: safe.to.map(toAddress),
    cc: safe.cc.length ? safe.cc.map(toAddress) : undefined,
    bcc: safe.bcc.length ? safe.bcc.map(toAddress) : undefined,
    replyTo: safe.replyTo.length ? safe.replyTo.map(toAddress) : undefined,
    subject: safe.subject,
    text: safe.text,
    html: safe.html,
    inReplyTo: safe.inReplyTo,
    references: safe.references.length ? safe.references : undefined,
    messageId: idCheck.id,
    headers: { "X-Mailer": "mailtapper" },
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const mime = composer.compile();
  mime.keepBcc = false;
  const raw = await mime.build();
  if (raw.length > MAX_RAW_BYTES) {
    throw badRequest(`Compiled message is too large (${raw.length} bytes; max ${MAX_RAW_BYTES})`);
  }

  const envelope = mime.getEnvelope();
  const from = typeof envelope.from === "string" ? envelope.from : safe.from.address;
  const recipients = [...(envelope.to ?? [])];
  for (const addr of [...safe.to, ...safe.cc, ...safe.bcc]) {
    if (!recipients.some((item) => item.toLowerCase() === addr.email.toLowerCase())) recipients.push(addr.email);
  }
  if (!from || recipients.length === 0) throw badRequest("Message has no envelope recipients");

  const createTransport = deps?.createTransport ?? ((next, pass) => buildTransport(next, pass) as OutboundTransport);
  const transport = createTransport(cfg, password);
  try {
    const info = await transport.sendMail({ envelope: { from, to: recipients }, raw });
    const accepted = (info.accepted ?? []).map(addressText);
    const rejected = (info.rejected ?? []).map(addressText);
    if (accepted.length === 0) {
      throw new Error(info.response?.trim() || "SMTP rejected all recipients");
    }
    return {
      messageId: idCheck.id,
      accepted,
      rejected,
      response: info.response ?? "",
      raw,
    };
  } finally {
    transport.close();
  }
}

function assertHeaderSafe(message: SendInput & { from: { name?: string | null; address: string } }): void {
  assertSingleLine(message.subject, "Subject");
  assertSingleLine(message.from.address, "From");
  if (message.from.name) assertSingleLine(message.from.name, "From name");
  for (const recipient of [...message.to, ...message.cc, ...message.bcc, ...message.replyTo]) {
    assertSingleLine(recipient.email, "Address");
    if (recipient.name) assertSingleLine(recipient.name, "Name");
  }
  if (message.inReplyTo) assertSingleLine(message.inReplyTo, "In-Reply-To");
  for (const reference of message.references) assertSingleLine(reference, "References");
}

function assertSingleLine(value: string, label: string): void {
  if (/[\r\n\0]/.test(value)) throw badRequest(`${label} must be a single line`);
}

function sanitizeDisplayName(name: string): string {
  return name.replace(/[\r\n\0"]/g, " ").replace(/\s+/g, " ").trim();
}

function cleanRecipients(list: { email: string; name?: string }[]): Recipient[] {
  return list.map((recipient) => {
    const name = recipient.name ? sanitizeDisplayName(recipient.name) : "";
    return name ? { email: recipient.email, name } : { email: recipient.email };
  });
}

function toAddress(recipient: Recipient): string | { name: string; address: string } {
  return recipient.name ? { name: recipient.name, address: recipient.email } : recipient.email;
}

function addressText(value: string | { address: string }): string {
  return typeof value === "string" ? value : value.address;
}
