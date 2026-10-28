import { simpleParser, type Attachment, type SimpleParserOptions } from "mailparser";
import { badRequest, notFound, payloadTooLarge } from "../util.js";

/**
 * Caps for one attachment download. The message is fetched live from IMAP and
 * not stored; these bounds keep a single request from buffering an unbounded MIME part
 * on the small production VM.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

export interface AttachmentInfo {
  index: number;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface AttachmentFile {
  index: number;
  filename: string;
  contentType: string;
  body: Buffer;
}

export interface AttachmentLimits {
  maxMessageBytes?: number;
  maxAttachmentBytes?: number;
}

/**
 * mailparser inlines a `message/rfc822` part when it is `Content-Disposition: inline`
 * (a forwarded `.eml`), so the `.eml` disappears and only the files inside it show up.
 * `ignoreEmbedded` keeps that part as one downloadable file. The option is a mailsplit
 * flag that the published MailParser types don't list; it is forwarded to the splitter.
 */
const ATTACHMENT_PARSE: SimpleParserOptions = { ignoreEmbedded: true } as SimpleParserOptions;

const DEFAULT_EXT: Record<string, string> = {
  "message/rfc822": ".eml",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/gzip": ".gz",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/csv": ".csv",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function mediaType(contentType: string | undefined): string | null {
  const raw = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw) ? raw : null;
}

function downloadFilename(part: Attachment, index: number): string {
  const given = part.filename?.replace(/[\r\n]/g, "").replace(/[\\/]/g, "_").trim();
  if (given) return given;
  const type = mediaType(part.contentType);
  if (type === "message/rfc822") return "message.eml";
  return `attachment-${index}${(type && DEFAULT_EXT[type]) ?? ".bin"}`;
}

async function parsedAttachments(raw: Buffer): Promise<Attachment[]> {
  const parsed = await simpleParser(raw, ATTACHMENT_PARSE);
  return parsed.attachments ?? [];
}

/** Metadata in the same order `readAttachment` uses. `index` is the download path parameter. */
export async function listAttachments(raw: Buffer): Promise<AttachmentInfo[]> {
  const list = await parsedAttachments(raw);
  return list.map((part, index) => ({
    index,
    filename: downloadFilename(part, index),
    content_type: mediaType(part.contentType) ?? "application/octet-stream",
    size_bytes: Buffer.isBuffer(part.content) ? part.content.length : part.size,
  }));
}

/** `index` from the message's `attachments` array. Bytes are the decoded MIME part. */
export async function readAttachment(raw: Buffer, index: number, limits: AttachmentLimits = {}): Promise<AttachmentFile> {
  const maxMessage = limits.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  const maxAttachment = limits.maxAttachmentBytes ?? MAX_ATTACHMENT_BYTES;
  if (!Number.isInteger(index) || index < 0) throw badRequest("Attachment index must be a non-negative integer");
  if (raw.length > maxMessage) {
    throw payloadTooLarge(`Message is ${raw.length} bytes; attachment download is limited to ${maxMessage} bytes`);
  }
  const part = (await parsedAttachments(raw))[index];
  if (!part || !Buffer.isBuffer(part.content)) throw notFound("Attachment not found");
  if (part.content.length > maxAttachment) {
    throw payloadTooLarge(`Attachment is ${part.content.length} bytes; the limit is ${maxAttachment} bytes`);
  }
  return {
    index,
    filename: downloadFilename(part, index),
    contentType: mediaType(part.contentType) ?? "application/octet-stream",
    body: part.content,
  };
}

export function parseAttachmentIndex(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) throw badRequest("Attachment index must be a non-negative integer");
  return Number(raw);
}

/** Header values for the download response. Filename is RFC 6266 / 5987 so it can't break the header. */
export function attachmentHeaders(file: AttachmentFile): Record<string, string> {
  return {
    "content-type": file.contentType,
    "content-disposition": contentDisposition(file.filename),
    "content-length": String(file.body.length),
    "cache-control": "private, no-store",
  };
}

export function contentDisposition(filename: string): string {
  const cleaned = filename.replace(/[\r\n]/g, "");
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "attachment";
  const star = encodeURIComponent(cleaned).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}
