import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Fastify from "fastify";
import { simpleParser } from "mailparser";
import "./block-network.js";
import { HttpError } from "../src/util.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_MESSAGE_BYTES,
  attachmentHeaders,
  contentDisposition,
  listAttachments,
  parseAttachmentIndex,
  readAttachment,
} from "../src/imap/attachments.js";

process.env.DATABASE_URL ??= "postgres://user:pass@127.0.0.1:5432/mailtapper_test";
process.env.MAILTAPPER_KEK_B64 ??= Buffer.alloc(32, 2).toString("base64");
process.env.MAILTAPPER_LOCATOR_SECRET ??= "test-locator-secret-value";
process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:4321";

const ZIP = Buffer.from("PK\x03\x04MAILTAPPER-ZIP");

async function zipInsideEml(eml: Buffer): Promise<Buffer> {
  const inner = await simpleParser(eml);
  const zip = inner.attachments.find((part) => part.filename === "files.zip");
  assert.ok(zip && Buffer.isBuffer(zip.content));
  return zip.content;
}

/** Outer message with a message/rfc822 part whose body is itself a mail with a zip. */
function forwardedEml(disposition: "attachment" | "inline" | null, filename = "forwarded.eml"): Buffer {
  const inner = [
    "From: inner@example.com",
    "To: you@example.com",
    "Subject: Inner with zip",
    "MIME-Version: 1.0",
    "Content-Type: application/zip; name=\"files.zip\"",
    "Content-Disposition: attachment; filename=\"files.zip\"",
    "Content-Transfer-Encoding: base64",
    "",
    ZIP.toString("base64"),
  ].join("\r\n");
  const lines = [
    "From: sender@example.com",
    "To: you@example.com",
    "Subject: Fwd",
    "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=\"BOUND\"",
    "",
    "--BOUND",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "see attached",
    "",
    "--BOUND",
    `Content-Type: message/rfc822${filename ? `; name="${filename}"` : ""}`,
  ];
  if (disposition) lines.push(`Content-Disposition: ${disposition}${filename ? `; filename="${filename}"` : ""}`);
  lines.push("Content-Transfer-Encoding: 7bit", "", inner, "", "--BOUND--", "");
  return Buffer.from(lines.join("\r\n"));
}

function pdfMessage(): Buffer {
  const pdf = Buffer.from("%PDF-1.4 mailtapper");
  return Buffer.from(
    [
      "From: sender@example.com",
      "To: you@example.com",
      "Subject: Invoice",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=\"BOUND\"",
      "",
      "--BOUND",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "invoice attached",
      "",
      "--BOUND",
      "Content-Type: application/pdf; name=\"po.pdf\"",
      "Content-Disposition: attachment; filename=\"po.pdf\"",
      "Content-Transfer-Encoding: base64",
      "",
      pdf.toString("base64"),
      "",
      "--BOUND--",
      "",
    ].join("\r\n"),
  );
}

describe("attachment bytes", () => {
  it("lists a forwarded .eml and returns the raw message, zip still inside", async () => {
    const raw = forwardedEml("attachment");
    const listed = await listAttachments(raw);
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], {
      index: 0,
      filename: "forwarded.eml",
      content_type: "message/rfc822",
      size_bytes: listed[0]!.size_bytes,
    });
    assert.ok(listed[0]!.size_bytes > 0);

    const file = await readAttachment(raw, 0);
    assert.equal(file.contentType, "message/rfc822");
    assert.equal(file.filename, "forwarded.eml");
    assert.equal(file.body.length, listed[0]!.size_bytes);
    assert.match(file.body.toString("utf8"), /Subject: Inner with zip/);
    assert.ok((await zipInsideEml(file.body)).equals(ZIP));

    const headers = attachmentHeaders(file);
    assert.equal(headers["content-type"], "message/rfc822");
    const disposition = headers["content-disposition"] ?? "";
    assert.match(disposition, /filename="forwarded\.eml"/);
    assert.match(disposition, /filename\*=UTF-8''forwarded\.eml/);
    assert.equal(headers["content-length"], String(file.body.length));
    assert.equal(headers["cache-control"], "private, no-store");
  });

  it("keeps an inline message/rfc822 as a downloadable .eml", async () => {
    const raw = forwardedEml("inline");
    const listed = await listAttachments(raw);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.content_type, "message/rfc822");
    assert.equal(listed[0]!.filename, "forwarded.eml");
    const file = await readAttachment(raw, 0);
    assert.ok((await zipInsideEml(file.body)).equals(ZIP));
  });

  it("names a message/rfc822 part with no filename message.eml", async () => {
    const raw = forwardedEml("attachment", "");
    const listed = await listAttachments(raw);
    assert.equal(listed[0]!.filename, "message.eml");
    assert.equal(listed[0]!.content_type, "message/rfc822");
    const file = await readAttachment(raw, 0);
    assert.equal(file.filename, "message.eml");
    assert.ok((await zipInsideEml(file.body)).equals(ZIP));
  });

  it("exposes a normal file at its index and serves those bytes over HTTP", async () => {
    const raw = pdfMessage();
    const listed = await listAttachments(raw);
    assert.equal(listed[0]!.index, 0);
    assert.equal(listed[0]!.filename, "po.pdf");
    assert.equal(listed[0]!.content_type, "application/pdf");

    const app = Fastify({ logger: false });
    app.get("/v1/messages/:id/attachments/:index", async (req, reply) => {
      const file = await readAttachment(raw, parseAttachmentIndex((req.params as { index: string }).index));
      const headers = attachmentHeaders(file);
      return reply
        .header("content-type", headers["content-type"])
        .header("content-disposition", headers["content-disposition"])
        .header("content-length", headers["content-length"])
        .header("cache-control", headers["cache-control"])
        .send(file.body);
    });
    const res = await app.inject({ method: "GET", url: "/v1/messages/any-id/attachments/0" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "application/pdf");
    assert.match(String(res.headers["content-disposition"]), /filename="po\.pdf"/);
    assert.equal(res.rawPayload.toString("utf8"), "%PDF-1.4 mailtapper");
    await app.close();
  });

  it("rejects a missing index, a bad index, and an oversize part", async () => {
    const raw = pdfMessage();
    await assert.rejects(() => readAttachment(raw, 2), (err: unknown) => err instanceof HttpError && err.status === 404 && err.code === "not_found");
    assert.throws(() => parseAttachmentIndex("nope"), (err: unknown) => err instanceof HttpError && err.status === 400);
    assert.throws(() => parseAttachmentIndex("-1"), (err: unknown) => err instanceof HttpError && err.status === 400);
    assert.equal(parseAttachmentIndex("0"), 0);

    await assert.rejects(
      () => readAttachment(raw, 0, { maxAttachmentBytes: 4 }),
      (err: unknown) => err instanceof HttpError && err.status === 413 && err.code === "payload_too_large",
    );
    await assert.rejects(
      () => readAttachment(raw, 0, { maxMessageBytes: 8 }),
      (err: unknown) => err instanceof HttpError && err.status === 413,
    );
    assert.equal(MAX_ATTACHMENT_BYTES, 25 * 1024 * 1024);
    assert.equal(MAX_MESSAGE_BYTES, 32 * 1024 * 1024);
  });

  it("does not let a filename break Content-Disposition", () => {
    const header = contentDisposition('evil"\r\nX-Injected: yes');
    assert.equal(header.includes("\r"), false);
    assert.equal(header.includes("\n"), false);
    assert.equal(header, `attachment; filename="evil_X-Injected: yes"; filename*=UTF-8''evil%22X-Injected%3A%20yes`);
  });

  it("does not retry a 413", async () => {
    const { withRetry } = await import("../src/util.js");
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          calls += 1;
          throw new HttpError(413, "too big", "payload_too_large");
        }, { tries: 3, baseMs: 1, capMs: 1 }),
      (err: unknown) => err instanceof HttpError && err.status === 413,
    );
    assert.equal(calls, 1);
  });

  it("puts the index on the normalized message and leaves forwarded text in the body", async () => {
    const { normalizeMessage } = await import("../src/imap/normalize.js");
    const message = await normalizeMessage(forwardedEml("inline"), {
      connectionId: "550e8400-e29b-41d4-a716-446655440000",
      sourceAccount: "you@example.com",
      provider: "imap_generic",
      folder: "INBOX",
      uid: 7,
      uidValidity: 3,
      isUnread: true,
    });
    assert.match(message.body_text, /see attached/);
    assert.match(message.body_text, /Inner with zip/);
    assert.equal(message.has_attachments, true);
    assert.equal(message.attachment_count, 1);
    assert.equal(message.attachments[0]?.index, 0);
    assert.equal(message.attachments[0]?.content_type, "message/rfc822");
    assert.equal(message.attachments[0]?.filename, "forwarded.eml");
    const file = await readAttachment(forwardedEml("inline"), message.attachments[0]!.index);
    assert.ok((await zipInsideEml(file.body)).equals(ZIP));
  });
});
