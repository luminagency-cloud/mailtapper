import { ImapFlow } from "imapflow";

export interface ConnCfg {
  host: string;
  port: number;
  tlsMode: "ssl" | "starttls" | "none";
  allowInvalidCert: boolean;
  username: string;
}

/** Build an ImapFlow client with EXPLICIT TLS (never guessed from the port). */
export function buildClient(cfg: ConnCfg, password: string): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.tlsMode === "ssl", // 'starttls' -> secure:false, ImapFlow upgrades when advertised
    tls: { rejectUnauthorized: !cfg.allowInvalidCert }, // the self-signed long-tail escape hatch
    auth: { user: cfg.username, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 7_000,
    socketTimeout: 30_000,
    logger: false,
  });
}

/** Translate raw IMAP/socket errors into something a user can act on. */
export function formatMailError(error: unknown): string {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/(invalid login|authenticat|\bauth\b)/.test(msg)) return "Authentication failed. Check the email address and password.";
  if (/(timed out|timeout)/.test(msg)) return "Connection timed out. Check the host, port, and network reachability.";
  if (/(enotfound|getaddrinfo)/.test(msg)) return "Host not found. Check the server hostname.";
  if (/econnrefused/.test(msg)) return "Connection refused — is the port right? (993 = SSL, 143 = STARTTLS)";
  if (/(self.?signed|depth zero|unable to verify)/.test(msg)) return "TLS certificate not trusted. If this host uses a self-signed cert, enable allow_invalid_cert.";
  if (/(certificate|tls|ssl)/.test(msg)) return "TLS negotiation failed. Try a different tls_mode.";
  return error instanceof Error ? error.message : "Unknown connection error";
}

export type MailSide = "receive" | "send";

/** A setup error tied to the side (IMAP or SMTP) and the form/API field to fix. */
export interface MailDiagnosis {
  side: MailSide;
  /** API/form field name: host, port, tls_mode... on receive; smtp_host, smtp_port... on send. */
  field: string | null;
  /** Full sentence for the user: side label, problem, then hint. */
  message: string;
  hint: string | null;
}

const SIDES = {
  receive: { label: "Receive (IMAP)", proto: "IMAP", ssl: 993, starttls: 143, prefix: "" },
  send: { label: "Send (SMTP)", proto: "SMTP", ssl: 465, starttls: 587, prefix: "smtp_" },
} as const;

/** Hint when the port is the other TLS mode's standard port (e.g. SMTP 587 with ssl). */
function tlsModeMismatch(side: MailSide, cfg: Pick<ConnCfg, "port" | "tlsMode">): string | null {
  const s = SIDES[side];
  if (cfg.tlsMode === "ssl" && cfg.port === s.starttls) return `${s.proto} port ${cfg.port} expects STARTTLS, not SSL/TLS. Set the TLS mode to starttls.`;
  if (cfg.tlsMode !== "ssl" && cfg.port === s.ssl) {
    return `${s.proto} port ${cfg.port} expects SSL/TLS, not ${cfg.tlsMode === "none" ? "an unencrypted connection" : "STARTTLS"}. Set the TLS mode to ssl.`;
  }
  return null;
}

/**
 * Turn a connect/login failure into: which side failed, which field to fix, and a plain hint.
 * Never echoes the raw server text for auth failures (it can contain the login).
 */
export function diagnoseMailError(error: unknown, side: MailSide, cfg: Pick<ConnCfg, "port" | "tlsMode">): MailDiagnosis {
  const s = SIDES[side];
  const raw = error instanceof Error ? error.message : String(error);
  const msg = raw.toLowerCase();
  const e = error as { code?: string; authenticationFailed?: boolean };
  const mismatch = tlsModeMismatch(side, cfg);
  const portHint = `${s.proto} normally uses port ${s.ssl} with ssl, or port ${s.starttls} with starttls.`;

  const out = (field: string | null, problem: string, hint: string | null): MailDiagnosis => ({
    side,
    field: field && field !== "allow_invalid_cert" ? s.prefix + field : field,
    message: [`${s.label}:`, problem, hint].filter(Boolean).join(" "),
    hint,
  });

  if (e.authenticationFailed || e.code === "EAUTH" || /(invalid login|authenticat|\bauth\b)/.test(msg)) {
    const fallback = side === "send" ? " If the SMTP username or password is blank, the IMAP login is used." : "";
    return out("password", "Login failed.", `Check the username and password. Many hosts want the full email address as the username.${fallback}`);
  }
  if (/(enotfound|getaddrinfo|eai_again)/.test(msg)) return out("host", "Host not found.", "Check the server host name for typos.");
  if (/econnrefused/.test(msg)) return out("port", `The server refused the connection on port ${cfg.port}.`, portHint);
  if (/(self.?signed|depth zero|unable to verify|unable to get local issuer)/.test(msg)) {
    return out("allow_invalid_cert", "The server's TLS certificate is not trusted.", "If this host uses a self-signed certificate, turn on allow_invalid_cert.");
  }
  if (/certificate has expired/.test(msg)) {
    return out("allow_invalid_cert", "The server's TLS certificate has expired.", "Ask the mail host to renew it. Until then, turning on allow_invalid_cert lets the connection work.");
  }
  if (/(altnames|does not match certificate|hostname\/ip does not match)/.test(msg)) {
    return out("host", "The TLS certificate does not match this host name.", "Use the host name shown on the server's certificate (often the hosting provider's server name), or turn on allow_invalid_cert.");
  }
  if (/(wrong version number|packet length too long|unknown protocol|eproto|starttls|must issue)/.test(msg) || e.code === "ETLS") {
    return out("tls_mode", "TLS negotiation failed.", mismatch ?? portHint);
  }
  if (/(timed out|timeout|greeting never received|in required time)/.test(msg) || /timeout|etimedout/i.test(e.code ?? "")) {
    if (mismatch) return out("tls_mode", "The server did not answer.", mismatch);
    if (side === "send" && cfg.port === 25) return out("port", "The server did not answer.", "Port 25 is blocked on most cloud hosts. Use 587 with starttls or 465 with ssl.");
    return out("port", "The connection timed out.", `Check the host and port, and that the server is reachable. ${portHint}`);
  }
  if (/(certificate|tls|ssl)/.test(msg)) return out("tls_mode", "TLS negotiation failed.", mismatch ?? portHint);
  return out(null, raw || "Unknown connection error.", null);
}

/** One-shot connectivity test, run BEFORE a connection is saved. */
export async function testImapConnection(
  cfg: ConnCfg,
  password: string,
): Promise<{ ok: true } | ({ ok: false } & MailDiagnosis)> {
  const client = buildClient(cfg, password);
  try {
    await client.connect();
    return { ok: true };
  } catch (err) {
    return { ok: false, ...diagnoseMailError(err, "receive", cfg) };
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
}
