import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import "./block-network.js";
import { HttpError } from "../src/util.js";
import { buildTransport, formatSmtpError, type SmtpCfg } from "../src/smtp/validator.js";
import {
  MAX_BODY_BYTES,
  MAX_RECIPIENTS,
  assertSendable,
  deliverMail,
  mailboxFromAddress,
  parseSendBody,
  type OutboundTransport,
  type SendInput,
} from "../src/smtp/send.js";

const cfg: SmtpCfg = {
  host: "smtp.example.com",
  port: 587,
  tlsMode: "starttls",
  allowInvalidCert: false,
  username: "david@example.com",
};

function input(
  overrides: Partial<SendInput> = {},
): SendInput & { from: { name?: string | null; address: string }; messageId?: string } {
  return {
    to: [{ email: "to@example.com" }],
    cc: [],
    bcc: [],
    replyTo: [],
    subject: "Project update",
    text: "Hello plain",
    html: "<p>Hello html</p>",
    references: [],
    from: { name: "David", address: "david@example.com" },
    messageId: "<fixed-id@example.com>",
    ...overrides,
  };
}

function fakeTransport(capture: { calls: number; closed: number; envelope?: { from?: string; to?: string[] }; raw?: Buffer }) {
  const transport: OutboundTransport = {
    async sendMail(mail) {
      capture.calls += 1;
      capture.envelope = mail.envelope;
      capture.raw = Buffer.isBuffer(mail.raw) ? mail.raw : Buffer.from(mail.raw ?? "");
      return {
        messageId: "<server-rewrote@example.com>",
        accepted: mail.envelope?.to ?? [],
        rejected: [],
        response: "250 Ok",
      };
    },
    close() {
      capture.closed += 1;
    },
  };
  return transport;
}

describe("parseSendBody", () => {
  it("accepts text, html, threading headers, and named recipients", () => {
    const parsed = parseSendBody({
      to: [{ email: "to@example.com", name: "To Person" }],
      cc: "cc@example.com",
      bcc: ["hidden.bcc@example.com"],
      subject: "Re: Project update",
      text: "Plain line",
      html: "<p>HTML</p>",
      reply_to: "reply@example.com",
      in_reply_to: "parent@example.com",
      references: "<root@example.com> parent@example.com",
    });
    assert.equal(parsed.inReplyTo, "<parent@example.com>");
    assert.deepEqual(parsed.references, ["<root@example.com>", "<parent@example.com>"]);
    assert.equal(parsed.replyTo[0]?.email, "reply@example.com");
    assert.equal(parsed.to[0]?.name, "To Person");
    assert.equal(parsed.bcc[0]?.email, "hidden.bcc@example.com");
  });

  it("rejects header injection, missing body, and too many recipients", () => {
    assert.throws(() => parseSendBody({ to: "a@example.com", subject: "hi\nBcc: x@y.com", text: "body" }), ZodError);
    assert.throws(() => parseSendBody({ to: "a@example.com", subject: "hi" }), ZodError);
    assert.throws(() => parseSendBody({ to: "not-an-email", subject: "hi", text: "body" }), ZodError);
    const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => `u${i}@example.com`);
    assert.throws(() => parseSendBody({ to: many, subject: "hi", text: "body" }), ZodError);
    assert.throws(
      () => parseSendBody({ to: "a@example.com", subject: "hi", text: "x".repeat(MAX_BODY_BYTES + 1) }),
      ZodError,
    );
  });
});

describe("deliverMail", () => {
  it("sends once through the injected transport and keeps bcc out of the headers", async () => {
    const capture: { calls: number; closed: number; envelope?: { from?: string; to?: string[] }; raw?: Buffer } = {
      calls: 0,
      closed: 0,
    };
    const result = await deliverMail(
      cfg,
      "from-the-connection-secret",
      input({
        cc: [{ email: "cc@example.com" }],
        bcc: [{ email: "hidden.bcc@example.com" }],
        replyTo: [{ email: "reply@example.com" }],
        inReplyTo: "<parent@example.com>",
        references: ["<root@example.com>", "<parent@example.com>"],
      }),
      {
        createTransport(gotCfg, password) {
          assert.equal(gotCfg.host, "smtp.example.com");
          assert.equal(gotCfg.port, 587);
          assert.equal(gotCfg.tlsMode, "starttls");
          assert.equal(password, "from-the-connection-secret");
          return fakeTransport(capture);
        },
      },
    );

    assert.equal(capture.calls, 1);
    assert.equal(capture.closed, 1);
    assert.equal(result.messageId, "<fixed-id@example.com>");
    assert.deepEqual(result.accepted, ["to@example.com", "cc@example.com", "hidden.bcc@example.com"]);
    assert.deepEqual(result.rejected, []);
    const raw = capture.raw?.toString("utf8") ?? "";
    assert.match(raw, /Message-ID:\s*<fixed-id@example.com>/i);
    assert.match(raw, /Subject:\s*Project update/i);
    assert.match(raw, /Hello plain/);
    assert.match(raw, /Hello html/);
    assert.match(raw, /In-Reply-To:\s*<parent@example.com>/i);
    assert.match(raw, /References:.*<root@example.com>.*<parent@example.com>/is);
    assert.match(raw, /Reply-To:.*reply@example.com/i);
    assert.equal(/hidden\.bcc@example\.com/i.test(raw), false);
    assert.equal(/^bcc:/im.test(raw), false);
    assert.ok(capture.envelope?.to?.includes("hidden.bcc@example.com"));
    assert.equal(capture.envelope?.from, "david@example.com");
  });

  it("does not retry a failed send and still closes the transport", async () => {
    let calls = 0;
    let closed = 0;
    await assert.rejects(
      () =>
        deliverMail(cfg, "secret", input(), {
          createTransport() {
            return {
              async sendMail() {
                calls += 1;
                throw new Error("Invalid login: 535 authentication failed");
              },
              close() {
                closed += 1;
              },
            };
          },
        }),
      /authentication failed/i,
    );
    assert.equal(calls, 1);
    assert.equal(closed, 1);
  });

  it("fails when every recipient is rejected and never retries", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        deliverMail(cfg, "secret", input(), {
          createTransport() {
            return {
              async sendMail() {
                calls += 1;
                return { accepted: [], rejected: ["to@example.com"], response: "550 relay denied" };
              },
              close() {},
            };
          },
        }),
      /550 relay denied/,
    );
    assert.equal(calls, 1);
  });

  it("refuses a subject that would break out of the header", async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        deliverMail(cfg, "secret", input({ subject: "hi\r\nBcc: evil@example.com" }), {
          createTransport() {
            calls += 1;
            return { async sendMail() { return { accepted: ["to@example.com"] }; }, close() {} };
          },
        }),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );
    assert.equal(calls, 0);
  });
});

describe("mailbox guards", () => {
  it("picks the configured identity and refuses a mailbox that cannot send", () => {
    assert.equal(
      mailboxFromAddress({ sourceAccount: "david@example.com", smtpUsername: "smtp-user", username: "imap-user" }),
      "david@example.com",
    );
    assert.equal(
      mailboxFromAddress({ sourceAccount: "label", smtpUsername: null, username: "david@example.com" }),
      "david@example.com",
    );
    assert.throws(
      () => mailboxFromAddress({ sourceAccount: "label", smtpUsername: null, username: "not-an-email" }),
      (err: unknown) => err instanceof HttpError && err.status === 400,
    );
    assert.throws(
      () => assertSendable({ sendEnabled: false, status: "active" }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
    assert.throws(
      () => assertSendable({ sendEnabled: true, status: "paused" }),
      (err: unknown) => err instanceof HttpError && err.status === 403,
    );
    assert.doesNotThrow(() => assertSendable({ sendEnabled: true, status: "active" }));
  });
});

describe("formatSmtpError", () => {
  it("turns an authentication failure into a generic message that omits the password", () => {
    const message = formatSmtpError(new Error("535 authentication failed for secret-password"));
    assert.equal(message, "Authentication failed. Check the email address and password.");
    assert.equal(message.includes("secret-password"), false);
  });
});

describe("buildTransport", () => {
  it("configures STARTTLS explicitly and does not connect", () => {
    const transport = buildTransport(cfg, "secret");
    try {
      const opts = transport.options as {
        host?: string;
        port?: number;
        secure?: boolean;
        requireTLS?: boolean;
        ignoreTLS?: boolean;
        auth?: { user?: string; pass?: string };
        tls?: { rejectUnauthorized?: boolean };
      };
      assert.equal(opts.host, "smtp.example.com");
      assert.equal(opts.port, 587);
      assert.equal(opts.secure, false);
      assert.equal(opts.requireTLS, true);
      assert.equal(opts.ignoreTLS, false);
      assert.equal(opts.auth?.user, "david@example.com");
      assert.equal(opts.auth?.pass, "secret");
      assert.equal(opts.tls?.rejectUnauthorized, true);
    } finally {
      transport.close();
    }

    const implicit = buildTransport({ ...cfg, port: 465, tlsMode: "ssl" }, "secret");
    try {
      assert.equal((implicit.options as { secure?: boolean }).secure, true);
    } finally {
      implicit.close();
    }
  });
});
