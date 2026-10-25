import nodemailer from "nodemailer";
import { formatMailError } from "../imap/validator.js";

export interface SmtpCfg {
  host: string;
  port: number;
  tlsMode: "ssl" | "starttls" | "none";
  allowInvalidCert: boolean;
  username: string;
}

/** Build a nodemailer transport with EXPLICIT TLS (never guessed from the port), mirroring buildClient. */
export function buildTransport(cfg: SmtpCfg, password: string) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tlsMode === "ssl", // implicit TLS (465)
    requireTLS: cfg.tlsMode === "starttls", // refuse to send in the clear if STARTTLS isn't offered
    ignoreTLS: cfg.tlsMode === "none",
    tls: { rejectUnauthorized: !cfg.allowInvalidCert },
    auth: { user: cfg.username, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 7_000,
    socketTimeout: 30_000,
  });
}

function formatSmtpError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/econnrefused/.test(msg)) return "Connection refused — is the SMTP port right? (465 = ssl, 587 = starttls)";
  return formatMailError(error);
}

/** One-shot SMTP login check (connect + AUTH, no message sent), run BEFORE send settings are saved. */
export async function testSmtpConnection(cfg: SmtpCfg, password: string): Promise<{ ok: boolean; message: string }> {
  const transport = buildTransport(cfg, password);
  try {
    await transport.verify();
    return { ok: true, message: "SMTP login succeeded." };
  } catch (err) {
    return { ok: false, message: formatSmtpError(err) };
  } finally {
    transport.close();
  }
}
